/**
 * The panel's world for the session and runner tests: the Farside prototype
 * read and rendered for real on the fake Figma, a persona that walks its
 * billing path, and a clock that only moves when the panel waits.
 */

import { vi } from 'vitest';
import fixtureJson from '../harness/fixtures/farside-proto.json';
import type { TurnBody, TurnEnded } from '../src/lib/api';
import type { RenderNote, SavedSession, ScratchCheckReply, TraceRenderReply } from '../src/lib/messages';
import type { ProtoDoc, TraceAction, TraceState } from '../src/lib/proto/model';
import { readFlow } from '../src/main/flowMap';
import { readProtoWithKeys } from '../src/main/protoReader';
import { createRenderer } from '../src/main/renderer';
import { exclusive } from '../src/main/scratch';
import { BridgeError, BridgeTimeout, type Bridge } from '../src/ui/trace/bridge';
import { fakeFromFixture, type ProtoFixture } from './fake-figma';

export type Fake = ReturnType<typeof fakeFromFixture>;

/** The main thread over the Farside prototype: reads and renders for real, keeps saved sessions, cleans up. */
export async function mainThread(edit: (fake: Fake) => void = () => {}, log: string[] = []) {
  const fake = fakeFromFixture(structuredClone(fixtureJson) as unknown as ProtoFixture);
  edit(fake);
  const { doc, frameOf } = await readProtoWithKeys(fake.api, fake.api.currentPage, { importLibraryVariants: true });
  const renderer = createRenderer(fake.api);
  /** The docs the main thread read, by hash: the launch's read, and every trace-read it answered. */
  const docs = new Map<string, ProtoDoc>([[doc.docHash, doc]]);
  const saves: Array<SavedSession | null> = [];
  /** What clientStorage holds, by study and run. */
  const stored = new Map<string, Map<string, SavedSession>>();
  /** `failures` renders fail as an empty export; `errors` fail with these messages first. */
  const renders = { failures: 0, errors: [] as string[], notes: null as RenderNote[] | null, change: null as ((r: TraceRenderReply) => TraceRenderReply) | null };
  /** Saves fail with these messages, one per save, before they succeed again. */
  const saveErrors: string[] = [];
  /** Loads fail with this, as the main thread answers progress it can't read, until the study is forgotten. */
  const loads = { error: null as { message: string; code: 'saved_progress_unreadable' } | null };
  /** The launch gate's view of the file, and each read's importLibraryVariants. */
  /** `readErrors`: reads that fail with these messages first. */
  /** `readTimeouts`: reads the bridge gives up on first, as it does on a main thread that hasn't answered in time. */
  const gate = { scratch: { ok: true, reason: null } as ScratchCheckReply, reads: [] as boolean[], readErrors: [] as string[], readTimeouts: 0, readAs: null as ((importLibraryVariants: boolean) => ProtoDoc) | null };
  const call = vi.fn(async (type: string, payload: Record<string, unknown>) => {
    if (type === 'trace-scratch-check') return gate.scratch;
    if (type === 'trace-read') {
      const importLibraryVariants = payload.importLibraryVariants as boolean;
      gate.reads.push(importLibraryVariants);
      log.push('read');
      if (gate.readTimeouts > 0) {
        gate.readTimeouts--;
        throw new BridgeTimeout('trace-read', 120_000);
      }
      const error = gate.readErrors.shift();
      if (error) throw new BridgeError('trace-read', error);
      const read = gate.readAs ? gate.readAs(importLibraryVariants) : structuredClone(doc);
      docs.set(read.docHash, read);
      return read;
    }
    if (type === 'trace-render') {
      const error = renders.errors.shift();
      if (error) throw new BridgeError('trace-render', error);
      if (renders.failures > 0) {
        renders.failures--;
        throw new BridgeError('trace-render', 'The export of the screen came back empty');
      }
      // The main thread renders a doc it read, by hash; it answers a render that throws with trace-error, which the bridge rejects as a BridgeError.
      const known = docs.get(payload.docHash as string);
      if (!known) throw new BridgeError('trace-render', `The panel sent a render of prototype ${String(payload.docHash)}, which this plugin has not read`);
      let r = await renderer.render(known, payload.state as TraceState).catch((err: Error) => {
        throw new BridgeError('trace-render', err.message);
      });
      if (renders.notes) r = { ...r, notes: renders.notes };
      return renders.change ? renders.change(r) : r;
    }
    if (type === 'trace-save') {
      const error = saveErrors.shift();
      if (error) throw new BridgeError('trace-save', error);
      const session = structuredClone(payload.session) as SavedSession | null;
      const study = stored.get(payload.studyId as string) ?? new Map<string, SavedSession>();
      stored.set(payload.studyId as string, study);
      if (session) study.set(payload.runId as string, session);
      else study.delete(payload.runId as string);
      saves.push(session);
      log.push(`save ${payload.runId as string} ${session ? session.turn : 'null'}`);
      return null;
    }
    if (type === 'trace-load') {
      if (loads.error) throw new BridgeError('trace-load', loads.error.message, loads.error.code);
      return { sessions: [...(stored.get(payload.studyId as string)?.values() ?? [])] };
    }
    if (type === 'trace-forget') {
      stored.delete(payload.studyId as string);
      loads.error = null;
      log.push(`forget ${payload.studyId as string}`);
      return null;
    }
    if (type === 'trace-cleanup') {
      log.push('cleanup');
      return { removed: 0 };
    }
    if (type === 'trace-candidates') {
      const known = docs.get(payload.docHash as string);
      if (!known) throw new BridgeError('trace-candidates', `The panel sent a read of the flow of prototype ${String(payload.docHash)}, which this plugin has not read`);
      log.push('candidates');
      return exclusive(fake.api, () => readFlow(fake.api, known, frameOf));
    }
    throw new Error(`The panel should not ask for ${type}`);
  });
  // The in-process main thread answers the bridge's calls, whatever their type.
  const bridge = { call: call as unknown as Bridge['call'], close: vi.fn() };
  return { fake, doc, bridge, call, saves, saveErrors, loads, stored, renders, gate, log };
}

export type MainThread = Awaited<ReturnType<typeof mainThread>>;

// --- A persona ------------------------------------------------------------------

export type Decision = { action: TraceAction | null; ended?: TurnEnded } | { failed: { code: string; message: string }; ended: TurnEnded };

export const click = (body: TurnBody, label: string): TraceAction => {
  const element = body.elements.find((e) => e.label === label);
  if (!element) throw new Error(`No "${label}" on ${body.screen.title}: ${body.elements.map((e) => e.label).join(', ')}`);
  return { type: 'click', element: element.id };
};

export const DONE: Decision = { action: { type: 'done', claim: 'My bank is connected.' }, ended: { status: 'finalizing', reason: 'done' } };

/** A persona that takes the Farside billing path, with one misclick, to the end. */
export function farside(body: TurnBody): Decision {
  switch (body.screen.title) {
    case 'Dashboard':
      return { action: click(body, 'Billing') };
    case 'Billing settings':
      return { action: click(body, 'Connect a bank') };
    case 'Connect bank':
      if (body.last?.outcome === 'nothing_happened') return { action: { type: 'scroll', direction: 'down' } };
      if (body.last?.outcome === 'scrolled') return { action: click(body, 'Continue') };
      return { action: click(body, 'Use routing number instead') };
    case 'Verify phone':
      return { action: click(body, 'Send code') };
    case 'Bank connected':
      return DONE;
    default:
      throw new Error(`The persona got lost on ${body.screen.title}`);
  }
}

// --- Time: a clock that only moves when the panel waits -------------------------

export function clock(late: (ms: number) => number = () => 0) {
  let t = Date.parse('2026-11-10T10:00:00Z');
  const waits: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      waits.push(ms);
      t += ms + late(ms);
    },
    waits,
    at: () => t,
  };
}

export function lastOf<T>(items: readonly T[]): T {
  if (!items.length) throw new Error('Nothing was recorded');
  return items[items.length - 1] as T;
}
