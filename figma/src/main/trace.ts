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
import { exclusive, heldContainers, isScratch, recordScratchNode, SCRATCH_KEY, SCRATCH_VALUE } from './scratch';
import * as store from './storage';
import { changedProtoFrames } from './watch';

/** What the panel tells the designer when the file can't be edited (spec, Data flow 1). */
export const SCRATCH_CHECK_REASON = 'Duplicate to your drafts to test';

const isText = (v: unknown): v is string => typeof v === 'string';
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

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

function checkState(state: unknown): TraceState {
  const problem = store.traceStateProblem(state);
  if (problem) bad(`a state that is not a trace state (${problem})`);
  return state as TraceState;
}

function checkId(value: unknown, what: string): string {
  if (!isText(value) || !value) bad(`no ${what} id`);
  return value;
}

function checkSession(session: unknown, runId: string): SavedSession | null {
  if (session === null) return null;
  const problem = store.savedSessionProblem(session, runId);
  if (problem) bad(`a session for ${runId} where ${problem}`);
  return session as SavedSession;
}

export interface TraceMain {
  handle(msg: TraceRequestMessage): Promise<void>;
  /** Removes the scratch containers renders hold now and those a crash left on the current page. Returns how many. */
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
    // A reaction key can name a hidden layer inside an instance, which Figma gives by id only with invisible instance children reachable.
    await exclusive(api, () => learn(doc));
    return doc;
  }

  /** The frames to watch and the node ids the trace knows, from a ProtoDoc just read. */
  async function learn(doc: ProtoDoc): Promise<void> {
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

  /**
   * Makes and removes an empty container: a view only file refuses the
   * first step. Any other failure is not a view only file, so it goes back
   * as a trace-error.
   */
  function scratchCheck(): ScratchCheckReply {
    let container: FrameNode;
    try {
      container = api.createFrame();
    } catch (err) {
      return { ok: false, reason: SCRATCH_CHECK_REASON, detail: messageOf(err) };
    }
    recordScratchNode(container.id);
    try {
      container.setPluginData(SCRATCH_KEY, SCRATCH_VALUE);
      container.locked = true;
      return { ok: true, reason: null };
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
      case 'trace-forget':
        await store.forgetTraceSessions(api, checkId(msg.studyId, 'study'));
        return null;
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
      // Saved progress it can't read carries its code: the panel offers to forget it.
      if (err instanceof store.SavedProgressError) post({ type: 'trace-error', requestId, message: err.message, code: err.code });
      else post({ type: 'trace-error', requestId, message: messageOf(err) });
    }
  }

  /**
   * Removes the containers renders are drawing in (the plugin is closing
   * mid-render), wherever they are, and marked ones a crash left on this
   * page. Synchronous, so the close handler can run it.
   */
  function removeLeftovers(): number {
    // By id: Figma can give the same node back as another object.
    const leftovers = new Map<string, SceneNode>();
    for (const node of heldContainers()) if (!node.removed) leftovers.set(node.id, node);
    for (const node of api.currentPage.children) if (!leftovers.has(node.id) && isScratch(node)) leftovers.set(node.id, node);
    let removed = 0;
    for (const node of leftovers.values()) {
      // Gone already when it was removed through another object for it.
      if (node.removed) continue;
      node.remove();
      removed++;
    }
    if (removed) api.commitUndo();
    return removed;
  }

  return { handle, removeLeftovers };
}
