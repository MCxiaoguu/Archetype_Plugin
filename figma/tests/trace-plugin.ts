/**
 * The plugin as Figma runs it, in process, for the live trace run
 * (trace-live.test.ts): the fake Farside file, the real main thread
 * (trace.ts) on it, and the panel's bridge to it, plus what the run checks
 * the file against. The same harness as trace-e2e's, without the hooks
 * that test holds saves back with.
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
  const failures: unknown[] = [];
  let open = true;
  const main = createTraceMain(fake.api, (msg) => {
    posted.push(msg);
    const copy = structuredClone(msg);
    setTimeout(() => {
      if (open) for (const listener of [...listeners]) listener(copy);
    }, 0);
  });
  const toMain = (msg: UiToMain) => {
    const copy = structuredClone(msg) as TraceRequestMessage;
    setTimeout(() => {
      // handle answers every request itself; a throw means a request it could not answer at all.
      if (open) main.handle(copy).catch((err: unknown) => failures.push(err));
    }, 0);
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
    failures,
    watchFile,
    signal: closing.signal,
    /** The plugin closes: the sessions are told, then the panel's bridge and the main thread stop together. */
    close() {
      closing.abort();
      bridge.close();
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

export const scratchOn = (fake: Fake) =>
  fake.api.root.children.flatMap((page) => (page as unknown as FakeNode).children.filter((n) => isScratch(n as unknown as BaseNode)));
