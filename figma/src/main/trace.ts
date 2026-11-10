/**
 * The main thread's half of the trace runner: it answers the panel's trace
 * requests (read the prototype, render a state, keep a session, check edit
 * access, clean up), watches the ProtoDoc's frames for edits, and removes
 * scratch containers left behind. Every request is answered with its requestId,
 * `trace-result` or `trace-error`: a bad payload is the panel's to handle,
 * not an exception that only reaches figma.notify.
 */

import type { MainToUi, SavedSession, ScratchCheckReply, TraceRequestMessage } from '../lib/messages';
import type { ProtoDoc, RawLayer, TraceState } from '../lib/proto/model';
import { pageOf, topFrameOf } from './document';
import { readProto } from './protoReader';
import { createRenderer } from './renderer';
import { exclusive, isScratch, recordScratchNode, SCRATCH_KEY, SCRATCH_VALUE } from './scratch';
import * as store from './storage';
import { changedProtoFrames } from './watch';

/** What the panel tells the designer when the file can't be edited (spec, Data flow 1). */
export const SCRATCH_CHECK_REASON = 'Duplicate to your drafts to test';

const isText = (v: unknown): v is string => typeof v === 'string';
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isSize = (v: unknown): boolean => isObject(v) && Number.isFinite(v.width) && Number.isFinite(v.height);

/** A payload the main thread can't use: `handle` answers it with trace-error. */
function bad(what: string): never {
  throw new Error(`The panel sent ${what}.`);
}

function checkDoc(doc: unknown): ProtoDoc {
  if (!isObject(doc) || !isText(doc.docHash) || !Array.isArray(doc.frames) || !isObject(doc.reactions)) {
    bad('a doc that is not a ProtoDoc (it needs docHash, frames and reactions)');
  }
  return doc as unknown as ProtoDoc;
}

function checkState(state: unknown, what = 'state'): TraceState {
  if (!isObject(state) || !isText(state.frameId) || !isText(state.docHash) || !Array.isArray(state.overlays) || !isSize(state.viewport)) {
    bad(`a ${what} that is not a trace state (it needs frameId, docHash, overlays and viewport)`);
  }
  return state as unknown as TraceState;
}

function checkId(value: unknown, what: string): string {
  if (!isText(value) || !value) bad(`no ${what} id`);
  return value;
}

function checkSession(session: unknown, runId: string): SavedSession | null {
  if (session === null) return null;
  if (!isObject(session)) bad('a session that is not an object or null');
  if (!isText(session.owner) || !session.owner) bad('a session without its owner');
  if (session.runId !== runId) bad(`a session whose runId is not the run it is saved under (${runId})`);
  if (!Number.isInteger(session.turn) || (session.turn as number) < 0) bad('a session whose turn is not a whole number from 0');
  checkState(session.state, 'session state');
  if (session.lastOutcome !== null && !isObject(session.lastOutcome)) bad('a session whose lastOutcome is not an object or null');
  return session as unknown as SavedSession;
}

export interface TraceMain {
  handle(msg: TraceRequestMessage): Promise<void>;
  /** Removes scratch containers a crash left on the current page. Returns how many. */
  removeLeftovers(): number;
}

export function createTraceMain(api: PluginAPI, post: (msg: MainToUi) => void): TraceMain {
  const renderer = createRenderer(api);
  /** The frames of the ProtoDoc read last, which the file-change watcher reports on. */
  let frames: ReadonlySet<string> = new Set();
  /**
   * Every original node id the trace knows, with the ProtoDoc frame it
   * belongs to (null when unknown): a deleted node can only be matched by id.
   */
  let known = new Map<string, string | null>();
  const watchedPages = new Set<string>();

  function remember(id: string, frameId: string | null) {
    if (!known.has(id) || known.get(id) === null) known.set(id, frameId);
  }

  function watch(page: PageNode) {
    if (watchedPages.has(page.id)) return;
    watchedPages.add(page.id);
    page.on('nodechange', (event) => {
      const changed = changedProtoFrames(event.nodeChanges, frames, known);
      if (changed.length) post({ type: 'trace-file-changed', frameIds: changed });
    });
  }

  async function read(importLibraryVariants: unknown): Promise<ProtoDoc> {
    if (typeof importLibraryVariants !== 'boolean') bad('importLibraryVariants that is not true or false');
    const doc = await readProto(api, api.currentPage, { importLibraryVariants });
    frames = new Set(doc.frames.map((f) => f.id));
    known = new Map();
    for (const frame of doc.frames) {
      known.set(frame.id, frame.id);
      // Frames reached on other pages are watched on their own page.
      const node = await api.getNodeByIdAsync(frame.id);
      const page = node ? pageOf(node) : null;
      if (page) watch(page);
    }
    for (const key of Object.keys(doc.reactions)) {
      // Path keys inside swapped variants are not node ids: no node, no frame.
      const node = await api.getNodeByIdAsync(key);
      const frameId = node ? (topFrameOf(node)?.id ?? null) : null;
      remember(key, frameId && frames.has(frameId) ? frameId : null);
    }
    for (const [instanceKey, set] of Object.entries(doc.variantSets)) {
      remember(instanceKey, set.frameId);
      for (const variant of set.variants) {
        remember(variant.id, set.frameId);
        if (variant.componentId) remember(variant.componentId, set.frameId);
      }
    }
    return doc;
  }

  /** The layers a render measured, under the frame each was drawn in. */
  function rememberLayers(layers: readonly RawLayer[]) {
    const parentOf = new Map(layers.map((l) => [l.key, l.parentKey]));
    for (const layer of layers) {
      let frameId: string | null = null;
      // Bounded by the keys seen, so inconsistent layers can't loop.
      const seen = new Set<string>();
      for (let key: string | null = layer.key; key !== null && frameId === null && !seen.has(key); key = parentOf.get(key) ?? null) {
        seen.add(key);
        if (frames.has(key)) frameId = key;
      }
      remember(layer.key, frameId);
    }
  }

  /** Makes and removes an empty container: a view only file refuses the first step. */
  function scratchCheck(): ScratchCheckReply {
    let container: FrameNode;
    try {
      container = api.createFrame();
    } catch {
      return { ok: false, reason: SCRATCH_CHECK_REASON };
    }
    recordScratchNode(container.id);
    try {
      container.setPluginData(SCRATCH_KEY, SCRATCH_VALUE);
      container.locked = true;
      return { ok: true, reason: null };
    } catch {
      return { ok: false, reason: SCRATCH_CHECK_REASON };
    } finally {
      container.remove();
      api.commitUndo();
    }
  }

  async function answer(msg: TraceRequestMessage): Promise<unknown> {
    switch (msg.type) {
      case 'trace-read':
        return read(msg.importLibraryVariants);
      case 'trace-render': {
        const result = await renderer.render(checkDoc(msg.doc), checkState(msg.state));
        rememberLayers(result.layers);
        return result;
      }
      case 'trace-save': {
        const studyId = checkId(msg.studyId, 'study');
        const runId = checkId(msg.runId, 'run');
        await store.saveTraceSession(api, studyId, runId, checkSession(msg.session, runId));
        return null;
      }
      case 'trace-load':
        return { sessions: await store.loadTraceSessions(api, checkId(msg.studyId, 'study')) };
      case 'trace-scratch-check':
        return scratchCheck();
      case 'trace-cleanup':
        // In the renders' queue, so a render under way (another study's) keeps its container.
        return exclusive(api, async () => ({ removed: removeLeftovers() }));
      default:
        return bad(`a trace request the plugin does not know (${String((msg as { type?: unknown }).type)})`);
    }
  }

  async function handle(msg: TraceRequestMessage) {
    const { requestId } = msg;
    // Without its id the reply would reach no one: refuse the request out loud instead.
    if (!isText(requestId) || !requestId) throw new Error(`The panel sent a ${msg.type} request without a request id.`);
    try {
      post({ type: 'trace-result', requestId, result: await answer(msg) });
    } catch (err) {
      post({ type: 'trace-error', requestId, message: err instanceof Error ? err.message : String(err) });
    }
  }

  function removeLeftovers(): number {
    const leftovers = api.currentPage.children.filter((n) => isScratch(n));
    for (const node of leftovers) node.remove();
    if (leftovers.length) api.commitUndo();
    return leftovers.length;
  }

  return { handle, removeLeftovers };
}
