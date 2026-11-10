/**
 * The plugin as Figma runs it, in process, for the trace end-to-end tests
 * (trace-e2e against the mock backend, trace-live against the local live
 * backend): the fake Farside file, the real main thread (trace.ts) on it,
 * and the panel's channel to it, plus what the tests check the file
 * against.
 */

import { expect } from 'vitest';
import fixtureJson from '../harness/fixtures/farside-proto.json';
import type { MainToUi, TraceRequestMessage, UiToMain } from '../src/lib/messages';
import { isScratch } from '../src/main/scratch';
import { createTraceMain } from '../src/main/trace';
import { createBridge, panelTransport } from '../src/ui/trace/bridge';
import { fakeFromFixture, type FakeNode, type ProtoFixture } from './fake-figma';

export type Fake = ReturnType<typeof fakeFromFixture>;

/** The Farside billing file, exporting in a later task as Figma does. */
export function fakeFile(): Fake {
  const fake = fakeFromFixture(structuredClone(fixtureJson) as unknown as ProtoFixture);
  fake.world.exportsLater = true;
  return fake;
}

export const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

/**
 * The plugin as Figma runs it: the real main thread on the fake file, and
 * the panel's channel to it. postMessage copies what it carries and
 * delivers it in a later task, both ways.
 */
export function openPlugin(fake: Fake) {
  const listeners = new Set<(msg: MainToUi) => void>();
  const posted: MainToUi[] = [];
  /** The type of every request the panel sent, in order. */
  const sent: string[] = [];
  const failures: unknown[] = [];
  /** The requests the main thread is answering, also after the plugin closed: the fake can't stop them as Figma does. */
  const answering = new Set<Promise<void>>();
  let open = true;
  /** trace-save requests held back, to reach the main thread together. */
  let held: { count: number; which: (msg: TraceRequestMessage) => boolean; saves: TraceRequestMessage[] } | null = null;
  /** When set, the other trace-saves reach the main thread one at a time, each after the one before was answered. */
  let serial: Promise<void> | null = null;
  const answer = (msg: TraceRequestMessage): Promise<void> => {
    // handle answers every request itself; a throw means a request it could not answer at all.
    const work = main.handle(msg).catch((err: unknown) => void failures.push(err));
    answering.add(work);
    void work.then(() => answering.delete(work));
    return work;
  };
  const deliver = (msgs: TraceRequestMessage[]) =>
    setTimeout(() => {
      if (open) for (const msg of msgs) void answer(msg);
    }, 0);
  const main = createTraceMain(fake.api, (msg) => {
    posted.push(msg);
    const copy = structuredClone(msg);
    setTimeout(() => {
      if (open) for (const listener of [...listeners]) listener(copy);
    }, 0);
  });
  const toMain = (msg: UiToMain) => {
    const copy = structuredClone(msg) as TraceRequestMessage;
    sent.push(copy.type);
    if (held && copy.type === 'trace-save' && held.which(copy)) {
      held.saves.push(copy);
      if (held.saves.length < held.count) return;
      const together = held.saves;
      held = null;
      deliver(together);
      return;
    }
    if (serial && copy.type === 'trace-save') {
      serial = serial.then(() => (open ? answer(copy) : undefined));
      return;
    }
    deliver([copy]);
  };
  const onMain = (handler: (msg: MainToUi) => void) => {
    listeners.add(handler);
    return () => void listeners.delete(handler);
  };
  const bridge = createBridge(panelTransport(toMain, onMain));
  // Fires as the plugin closes, before the bridge goes: the sessions stop where they are.
  const closing = new AbortController();
  const watchFile = (onChange: (frameIds: string[]) => void) =>
    onMain((msg) => {
      if (msg.type === 'trace-file-changed') onChange(msg.frameIds);
    });
  return {
    main,
    bridge,
    posted,
    sent,
    failures,
    watchFile,
    signal: closing.signal,
    /** Resolves once the main thread answered every request it took, the ones under way when the plugin closed too. */
    async settled() {
      while (answering.size) await Promise.all([...answering]);
    },
    /** Holds the next `count` trace-saves (of those `which` picks) until all of them are sent, then delivers them in one task. */
    holdSaves(count: number, which: (msg: TraceRequestMessage) => boolean = () => true) {
      held = { count, which, saves: [] };
    },
    /** Sends every trace-save not held on its own, after the one before it was answered. */
    serialSaves() {
      serial = Promise.resolve();
    },
    /**
     * The plugin closes, as Figma closes it: the panel fires its signal and
     * shuts the bridge (effects.closePanel), then the main thread's close
     * handler removes what renders hold (figma.on('close') in code.ts), and
     * nothing more reaches either side.
     */
    close() {
      if (!open) return;
      closing.abort();
      bridge.close();
      main.removeLeftovers();
      open = false;
    },
  };
}

export type Plugin = ReturnType<typeof openPlugin>;

/** Every node of the file as it stands, by id, without the fake's links. */
export function snapshot(fake: Fake): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [id, node] of fake.world.nodes) {
    const own: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === 'world' || typeof value === 'function' || typeof value === 'symbol') continue;
      if (key === 'parent') own.parent = (value as FakeNode | null)?.id ?? null;
      else if (key === 'kids') own.kids = (value as FakeNode[]).map((k) => k.id);
      else if (value instanceof Map) own[key] = [...value];
      else own[key] = structuredClone(value);
    }
    out.set(id, own);
  }
  return out;
}

/**
 * The file as the runs left it, against `before`: the same nodes, unchanged,
 * except the file id the plugin keeps in the document's plugin data
 * (storage.ts), written with the first save.
 */
export function expectUntouched(fake: Fake, before: Map<string, unknown>) {
  const after = snapshot(fake);
  const root = after.get('0:0') as { pluginData: Array<[string, string]> };
  expect(root.pluginData).toEqual([['archetypeFileId', expect.any(String)]]);
  root.pluginData = [];
  expect(after).toEqual(before);
}

/** The scratch containers on the file's pages. */
export const scratchOn = (fake: Fake) =>
  fake.api.root.children.flatMap((page) => (page as unknown as FakeNode).children.filter((n) => isScratch(n as unknown as BaseNode)));
