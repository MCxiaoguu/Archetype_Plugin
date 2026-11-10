/**
 * One persona's run in the panel (spec, Data flow 4 to 10): the panel is the
 * browser, the backend the brain. Each turn settles the prototype's timers,
 * renders the screen on the main thread, lists what the persona can act on,
 * posts the turn, polls for the decision, applies it with the engine and
 * saves where the run is, until the backend says the run ended.
 *
 * Every failure is visible (spec, Error handling): a failure that is not the
 * persona's doing aborts the run with its code; losing the network or the
 * sign in pauses and retries, never aborting on its own; once the backend
 * has set `ended` the session never aborts. When the panel closes (the
 * signal), the session stops where it is, so the run can resume.
 */

import { ApiError, TURN_TIMEOUT_MS, type AbortCode, type ApiClient, type TimerEffect, type TurnBody, type TurnEnded, type TurnFlag, type TurnLast, type TurnView } from '../../lib/api';
import { SAVED_SESSION_VERSION, type SavedSession, type TraceRenderReply } from '../../lib/messages';
import { listElements } from '../../lib/proto/elements';
import { apply, settle, start, type EngineEffect } from '../../lib/proto/engine';
import { isCandidate, readingLookup, type FlowMap } from '../../lib/proto/flow';
import { EngineError, type EngineErrorCode } from '../../lib/proto/errors';
import { indexLayers } from '../../lib/proto/hitTest';
import type { Element, ElementTarget, ProtoDoc, RawLayer, TraceAction, TraceOutcome, TraceState } from '../../lib/proto/model';
import { outcomeOf } from '../../lib/proto/outcome';
import { measuredPageRange, pageOffset } from '../../lib/proto/scroll';
import { stepUrl } from '../../lib/proto/url';
import { RenderStuck, type Bridge } from './bridge';

/** Polls start at 1 s and back off to 3 s (spec, Data flow 6). */
export const POLL_FIRST_MS = 1_000;
export const POLL_MAX_MS = 3_000;
/** Thinking for longer than this aborts the run with turn_timeout (spec, Error handling). */
export const THINKING_LIMIT_MS = 180_000;
/** A timer that fires this late means the browser throttles the panel's tab. */
export const LATE_TIMER_MS = 10_000;
/** Retries through network loss and sign in trouble back off from 2 s to 30 s. */
export const RETRY_FIRST_MS = 2_000;
export const RETRY_MAX_MS = 30_000;
const MAX_TEXT_EXCERPT = 300;
/** The longest frame name a turn carries (the backend's screen.title); a longer one is cut, ending in an ellipsis. */
const MAX_TITLE = 300;
/** The most overlays a turn carries (the backend's screen.overlays). */
const MAX_OVERLAYS = 20;
const MAX_DETAIL = 200;
const MAX_TIMER_EFFECTS = 10;
const MAX_FLAG_DETAILS = 50;

export const NOTICE = {
  offline: 'Lost touch with Archetype. Retrying.',
  signIn: 'Sign in to Archetype again to continue this test.',
  hiddenTab: 'Keep this tab visible, or use the desktop app.',
  fileChanged: 'This file changed while the test ran, so its later steps may not match the flow it started with.',
  notSaved: 'Could not save this test\'s progress on this machine, so it can\'t resume if the plugin closes.',
} as const;

export interface SessionRun {
  runId: string;
  studyId: string;
  /** This panel's id, sent with the claim. */
  owner: string;
  /** The prototype, read at launch (or again on resume). */
  doc: ProtoDoc;
  /** The share link's file key; null in plugin mode without a link, when step URLs are figma-trace://. */
  shareKey: string | null;
  /** The frame a new run starts on. */
  startFrameId: string;
  /** Where a run this panel owns stopped, when the panel reopened; null for a new claim. */
  resume: SavedSession | null;
  /** The main thread reported the file changed since `doc` was read: every turn is flagged from the first. */
  fileChanged: boolean;
  /** The flow map version the run plays (its claim's); null for a run claimed with no map. */
  map: FlowMap | null;
}

export type SessionPhase = 'acting' | 'thinking' | 'paused' | 'ended';

/** What the Running screen shows for a persona. */
export interface SessionStatus {
  runId: string;
  phase: SessionPhase;
  /** The frame the persona is on. */
  frameName: string;
  /** The turn the persona is on. */
  turn: number;
  /** Everything the designer should know, each once. */
  notices: string[];
  ended: TurnEnded | null;
}

export interface SessionResult {
  runId: string;
  /** How the run ended: as the backend said, or as this panel aborted it. Null when the session stopped without one. */
  ended: TurnEnded | null;
  /**
   * `ended`: the backend ended the run. `aborted`: this panel aborted it.
   * `cancelled`: the panel closed, and the run resumes when it reopens. The
   * rest stop without aborting.
   */
  stop: 'ended' | 'aborted' | 'cancelled' | 'not_owner' | 'run_ended' | 'run_not_found';
  message: string | null;
}

export interface SessionDeps {
  bridge: Pick<Bridge, 'call'>;
  api: Pick<ApiClient, 'postTurn' | 'getTurn' | 'abortRun'>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  onStatus: (status: SessionStatus) => void;
  /** Subscribes to the main thread's trace-file-changed; returns the unsubscribe. */
  watchFile: (onChange: (frameIds: string[]) => void) => () => void;
  /** How long a turn post may take; a backend deciding inside the request needs longer. */
  postTurnTimeoutMs?: number;
  /** Fires when the panel closes: the session stops without aborting or forgetting the run. */
  signal?: AbortSignal;
}

type DecidedView = Exclude<TurnView, { status: 'thinking' }>;

/** Thrown inside the loop to abort the run with a code. */
class Abort extends Error {
  readonly code: AbortCode;

  constructor(code: AbortCode, detail: string) {
    super(detail);
    this.code = code;
  }
}

/** Thrown inside the loop when the run stopped on the backend's word. */
class Stop extends Error {
  readonly result: Omit<SessionResult, 'runId'>;

  constructor(result: Omit<SessionResult, 'runId'>) {
    super(result.message ?? result.stop);
    this.result = result;
  }
}

/** Why a run the backend is ahead of can't go on when this panel has nothing saved for it. */
const LOST_PROGRESS = "This panel lost its saved progress for this run, so it can't safely continue it.";

/** The panel is closing: stop where the run is. */
class Cancel extends Error {
  constructor() {
    super('The panel closed.');
  }
}

/** EngineError codes, as the run is aborted for them. */
const ENGINE_ABORT: Record<EngineErrorCode, AbortCode> = {
  doc_changed: 'file_changed',
  invalid_doc: 'engine_error',
  invalid_layers: 'engine_error',
  unknown_element: 'brain_invalid_action',
  invalid_action: 'brain_invalid_action',
  run_ending_action: 'brain_invalid_action',
};

const ELEMENT_ACTIONS: ReadonlySet<string> = new Set(['click', 'hover', 'drag', 'type']);

/** Outcomes of an action that changed nothing; what the settle after it shows can still come of it. */
const UNCHANGED: ReadonlySet<TraceOutcome> = new Set<TraceOutcome>(['nothing_happened', 'typed_nothing', 'scroll_at_end', 'back_empty', 'waited']);

const cap = (text: string, limit: number) => (text.length > limit ? text.slice(0, limit) : text);
/** Text cut to `limit` characters, the cut marked by an ellipsis, as element labels are. */
const cut = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text);
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

function engineAbort(err: unknown, what: string): Abort {
  if (err instanceof EngineError) return new Abort(ENGINE_ABORT[err.code], `${what}: ${err.message}`);
  return new Abort('engine_error', `${what}: ${messageOf(err)}`);
}

/**
 * Network loss, a throttled sign in service, a signed out panel or a backend
 * error: wait, then try again. Returns the notice to show, or null for an
 * error that waiting can't fix.
 */
export function pauseFor(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  if (err.code === 'network' || err.code === 'timeout') return NOTICE.offline;
  if (err.code === 'auth_unavailable') return err.message;
  if (err.status === 401) return NOTICE.signIn;
  // Throttled, or an answer the panel couldn't read (a proxy's page): the backend's words say which.
  if (err.status === 429 || err.code === 'bad_response') return `${err.message} Retrying.`;
  if (err.status >= 500) return `${err.message}${err.requestId ? ` (reference ${err.requestId})` : ''} Retrying.`;
  return null;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** The visible text of the screen, in reading order, as the persona reads it. */
function textExcerpt(layers: readonly RawLayer[], state: TraceState): string {
  const { width, height } = state.viewport;
  const shown = layers.filter((l) => l.type === 'TEXT' && l.visible && l.text && l.box.width > 0 && l.box.height > 0
    && l.box.x < width && l.box.y < height && l.box.x + l.box.width > 0 && l.box.y + l.box.height > 0);
  shown.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  return cap(shown.map((l) => (l.text as string).trim()).filter(Boolean).join(' · '), MAX_TEXT_EXCERPT);
}

/** What the screen couldn't show, as the backend's timer_effects say it. */
function timerEffect(effect: EngineEffect): TimerEffect {
  if (effect.type === 'url') return { type: 'left_prototype', detail: cap(effect.url, MAX_DETAIL) };
  if (effect.type === 'unsupported') return { type: 'unsupported', detail: cap(effect.action, MAX_DETAIL) };
  return { type: 'unsupported', detail: cap(`${effect.action}: ${effect.message}`, MAX_DETAIL) };
}

function unsupportedDetail(effects: readonly EngineEffect[]): string {
  const effect = effects.find((e) => e.type === 'unsupported' || e.type === 'expr_error');
  if (!effect) throw new EngineError('invalid_doc', 'The engine said unsupported without saying what was');
  return timerEffect(effect).detail;
}

/**
 * What the person saw come of the last action once the screen settled. An
 * action that changed nothing itself can still have: a delayed MOUSE_ENTER
 * fires at the settle after the hover (spec, Pointer model), and a wait can
 * end just before a timer the settle fires. The person waited for that
 * before acting again, so it is what the action did.
 */
function settledOutcome(last: TurnLast, before: TraceState, after: TraceState): TurnLast {
  if (!UNCHANGED.has(last.outcome)) return last;
  // What timers did that the screen can't show is reported as timer_effects.
  const seen = outcomeOf(before, after, [], last.outcome);
  if (seen === last.outcome) return last;
  return { ...last, outcome: last.outcome === 'waited' ? 'timers_fired' : seen };
}

function targetOf(action: TraceAction, elements: readonly Element[]): string | null {
  if (!('element' in action) || !action.element) return null;
  const label = elements.find((e) => e.id === action.element)?.label;
  return label ? `${label} (${action.element})` : action.element;
}

export async function runSession(run: SessionRun, deps: SessionDeps): Promise<SessionResult> {
  const { api, bridge } = deps;
  const doc = run.doc;
  const reads = run.map ? readingLookup(run.map) : null;
  const startedAt = deps.now();
  const notices: string[] = [];
  let phase: SessionPhase = 'acting';
  let lateNoticed = false;
  let fileChanged = run.fileChanged;
  /** Effects timers fired since the last turn posted, reported with the next `last`. */
  let pendingEffects: TimerEffect[] = [];
  /** Frames a loop of timers ran through since the last turn posted. */
  let loopFrames: string[] = [];
  /** What the last click hit that the run's map has no reading for, for the next turn's map_miss flag. */
  let mapMisses: string[] = [];
  /** Turns the backend already holds (after a turn_out_of_order): polled, never posted again. */
  let backendHas = 0;

  // Set before the first turn: from the saved session, or the start frame.
  let state!: TraceState;
  let turn = run.resume ? run.resume.turn + 1 : 1;
  let last: TurnLast | null = run.resume ? run.resume.lastOutcome : null;
  let ended: TurnEnded | null = null;

  const frameName = (id: string) => doc.frames.find((f) => f.id === id)?.name ?? id;
  const shownFrame = () => (state as TraceState | undefined)?.frameId ?? run.resume?.state.frameId ?? run.startFrameId;
  const status = () => deps.onStatus({ runId: run.runId, phase, frameName: frameName(shownFrame()), turn, notices: [...notices], ended });
  const notice = (text: string) => {
    if (!notices.includes(text)) {
      notices.push(text);
      status();
    }
  };
  /** A notice that no longer holds: Archetype answers again, a save went through. */
  const clearNotice = (text: string | null) => {
    const i = text === null ? -1 : notices.indexOf(text);
    if (i >= 0) {
      notices.splice(i, 1);
      status();
    }
  };
  const checkCancel = () => {
    if (deps.signal?.aborted) throw new Cancel();
  };
  /** Set while a save fails: what the designer is told about it. */
  let saveNotice: string | null = null;
  const setPhase = (next: SessionPhase) => {
    phase = next;
    status();
  };

  /** A wait that notices when the browser fires timers late (a hidden tab). Returns how long it really took. */
  async function wait(ms: number): Promise<number> {
    const before = deps.now();
    await deps.sleep(ms);
    checkCancel();
    const took = deps.now() - before;
    if (took - ms > LATE_TIMER_MS && !lateNoticed) {
      lateNoticed = true;
      notice(NOTICE.hiddenTab);
    }
    return took;
  }

  /** Calls the API until it answers or fails for good, pausing through network loss and sign in trouble. */
  async function call<T>(work: () => Promise<T>): Promise<T> {
    let delay = RETRY_FIRST_MS;
    const before = phase;
    let shown: string | null = null;
    for (;;) {
      checkCancel();
      try {
        const result = await work();
        clearNotice(shown);
        if (phase === 'paused') setPhase(before);
        return result;
      } catch (err) {
        checkCancel();
        const why = pauseFor(err);
        if (!why) throw err;
        if (why !== shown) {
          clearNotice(shown);
          shown = why;
          notice(why);
        }
        if (phase !== 'paused') setPhase('paused');
        await wait(delay);
        delay = Math.min(delay * 2, RETRY_MAX_MS);
      }
    }
  }

  /**
   * One render, retried once (spec, Error handling); the second failure
   * aborts with both reasons. The bridge sends renders one at a time and
   * times each from when it is sent, so the time a render waits behind
   * other sessions' renders doesn't count; a retry after a timeout waits
   * until the main thread answered the first, or until the bridge gives up
   * on it two minutes after it was sent (RenderStuck), which aborts the run.
   */
  async function render(): Promise<TraceRenderReply> {
    let first: unknown;
    try {
      return await bridge.call('trace-render', { docHash: doc.docHash, state });
    } catch (err) {
      // A bridge the closing panel shut: no retry.
      checkCancel();
      // A main thread stuck on an earlier render won't answer a retry either.
      if (err instanceof RenderStuck) throw new Abort('render_failed', err.message);
      first = err;
    }
    try {
      return await bridge.call('trace-render', { docHash: doc.docHash, state });
    } catch (second) {
      if (second instanceof RenderStuck) throw new Abort('render_failed', second.message);
      const [a, b] = [messageOf(first), messageOf(second)];
      throw new Abort('render_failed', a === b ? b : `${b} (the first try: ${a})`);
    }
  }

  /** Saves where the run is, retried once; a save that fails says why, until one goes through. */
  async function save(session: SavedSession | null): Promise<void> {
    const payload = { studyId: run.studyId, runId: run.runId, session };
    let failure: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await bridge.call('trace-save', payload);
        clearNotice(saveNotice);
        saveNotice = null;
        return;
      } catch (err) {
        // The panel is closing: the run resumes from the save before this one.
        if (deps.signal?.aborted) return;
        failure = err;
      }
    }
    const text = `${NOTICE.notSaved} ${messageOf(failure)}`;
    if (text !== saveNotice) {
      clearNotice(saveNotice);
      saveNotice = text;
      notice(text);
    }
  }

  function body(rendered: TraceRenderReply, elements: Element[]): TurnBody {
    const frame = doc.frames.find((f) => f.id === state.frameId);
    if (!frame) throw new EngineError('invalid_doc', `The frame ${state.frameId} isn't in the prototype`);
    const offset = pageOffset(state, state.frameId);
    const root = rendered.layers.find((l) => l.key === state.frameId && l.parentKey === null);
    if (!root) throw new EngineError('invalid_layers', `The render measured no root layer for the frame ${state.frameId}`);
    const range = measuredPageRange(root, state.viewport);
    const overlays = state.overlays.map((o) => o.frameId);
    const fonts = [...new Set(rendered.notes.flatMap((n) => n.missing_font))];
    if (fonts.length) notice(`A font isn't available here (${fonts.join(', ')}): its text shows as designed.`);
    const flags: TurnFlag[] = [];
    const details: NonNullable<TurnBody['flag_details']> = {};
    if (fileChanged) flags.push('file_changed');
    if (loopFrames.length) {
      flags.push('timer_loop');
      details.timer_loop = { frames: loopFrames.slice(0, MAX_FLAG_DETAILS) };
    }
    if (fonts.length) {
      flags.push('missing_font');
      details.missing_font = { fonts: fonts.slice(0, MAX_FLAG_DETAILS).map((f) => cap(f, MAX_DETAIL)) };
    }
    // A run note only while the click still reports nothing happening (a settle may have changed that).
    if (mapMisses.length && last?.outcome === 'nothing_happened') {
      flags.push('map_miss');
      details.map_miss = { labels: mapMisses.slice(0, MAX_FLAG_DETAILS) };
    }
    return {
      owner: run.owner,
      turn,
      screen: {
        url: stepUrl(run.shareKey, doc.pageName, { frameId: state.frameId, overlays }),
        title: cut(frame.name, MAX_TITLE),
        frameId: state.frameId,
        overlays,
        viewport: [rendered.viewport.width, rendered.viewport.height],
        scroll: { x: offset.x, y: offset.y, maxX: range.maxX, maxY: range.maxY },
      },
      screenshot_b64: base64(rendered.image),
      elements,
      visible_text_excerpt: textExcerpt(rendered.layers, state),
      last,
      flags,
      ...(Object.keys(details).length ? { flag_details: details } : {}),
      elapsed_s: Math.round((deps.now() - startedAt) / 100) / 10,
      client_ts: new Date(deps.now()).toISOString(),
    };
  }

  function addEffects(effects: readonly EngineEffect[]) {
    for (const effect of effects.map(timerEffect)) {
      const seen = pendingEffects.some((e) => e.type === effect.type && e.detail === effect.detail);
      if (!seen && pendingEffects.length < MAX_TIMER_EFFECTS) pendingEffects.push(effect);
    }
  }

  function addLoop(frames: readonly string[] | null) {
    for (const id of frames ?? []) if (!loopFrames.includes(id)) loopFrames.push(id);
  }

  /**
   * A turn the backend already holds, read instead of posted. Its decision
   * names elements of the screen as it was then: once the file changed,
   * those ids may name other layers, so it can't be replayed.
   */
  function held(): Promise<TurnView> {
    if (fileChanged) throw new Abort('file_changed', `The backend holds turn ${turn}, decided on the file before it changed, so the panel can't replay it.`);
    return call(() => api.getTurn(run.runId, turn));
  }

  /** Posts the turn, or for a turn the backend already holds, only reads it. */
  async function post(turnBody: TurnBody): Promise<TurnView> {
    if (turn < backendHas) return held();
    try {
      return await call(() => api.postTurn(run.runId, turnBody, { timeoutMs: deps.postTurnTimeoutMs ?? TURN_TIMEOUT_MS }));
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      if (err.code === 'turn_out_of_order' && err.expected !== null) {
        // The backend is ahead (a panel before this one posted those turns):
        // read the turns it holds, from this one on, instead of posting them.
        if (err.expected > turn) {
          // Started without saved state (a run claimed again), nothing says whether the file
          // changed since those turns, so their actions can't be replayed safely.
          if (!run.resume) throw new Abort('panel_state_lost', LOST_PROGRESS);
          backendHas = err.expected;
          return held();
        }
        throw new Abort('panel_state_lost', `The backend expects turn ${err.expected}, but this panel is on turn ${turn}.`);
      }
      throw err;
    }
  }

  /** Polls until the turn is decided, backing off from 1 s to 3 s; thinking for 180 s aborts. */
  async function decided(view: TurnView): Promise<DecidedView> {
    let delay = POLL_FIRST_MS;
    let thinking = 0;
    setPhase('thinking');
    while (view.status === 'thinking') {
      if (thinking >= THINKING_LIMIT_MS) throw new Abort('turn_timeout', `Turn ${turn} had no answer after ${THINKING_LIMIT_MS / 1000} s.`);
      thinking += await wait(delay);
      delay = Math.min(delay * 1.5, POLL_MAX_MS);
      view = await call(() => api.getTurn(run.runId, turn));
    }
    return view;
  }

  /** The turn's API errors that stop the session without an abort, or abort it. */
  function stopFor(err: unknown): never {
    if (err instanceof ApiError) {
      if (err.code === 'not_owner') throw new Stop({ ended: null, stop: 'not_owner', message: err.message });
      if (err.code === 'run_ended') throw new Stop({ ended: null, stop: 'run_ended', message: err.message });
      if (err.code === 'run_not_found') throw new Stop({ ended: null, stop: 'run_not_found', message: err.message });
      if (err.code === 'turn_not_found') throw new Abort('panel_state_lost', err.message);
      // The backend refused the turn (a 400), or answered with a code the panel has no rule for: its words are the reason.
      throw new Abort('engine_error', err.message);
    }
    throw err;
  }

  async function oneTurn(): Promise<void> {
    checkCancel();
    setPhase('acting');
    let settled;
    try {
      settled = settle(doc, state);
    } catch (err) {
      throw engineAbort(err, 'Settling the screen failed');
    }
    if (last && settled.fired) last = settledOutcome(last, state, settled.state);
    state = settled.state;
    addEffects(settled.effects);
    addLoop(settled.looped);
    status();
    // Leaving overlays out would misstate the screen: a run this deep in overlays can't go on.
    if (state.overlays.length > MAX_OVERLAYS) throw new Abort('engine_error', `More than ${MAX_OVERLAYS} overlays are open, more than a turn can carry.`);

    const rendered = await render();
    let listed: { elements: Element[]; targets: Record<string, ElementTarget> };
    let turnBody: TurnBody;
    try {
      listed = listElements(rendered.layers, state);
      if (last) last = { ...last, ...(pendingEffects.length ? { timer_effects: pendingEffects } : {}) };
      turnBody = body(rendered, listed.elements);
    } catch (err) {
      throw engineAbort(err, 'Reading the screen failed');
    }
    // Turn 1 has no `last` to carry what timers did: that waits for turn 2.
    if (last) pendingEffects = [];
    loopFrames = [];
    mapMisses = [];

    let view: DecidedView;
    try {
      view = await decided(await post(turnBody));
    } catch (err) {
      if (err instanceof Abort || err instanceof Stop) throw err;
      stopFor(err);
    }
    if (view.status === 'failed') throw new Stop({ ended: view.ended, stop: 'ended', message: view.error.message });
    if (view.ended) throw new Stop({ ended: view.ended, stop: 'ended', message: null });
    const action = view.action;
    if (!action) throw new Abort('brain_invalid_action', `Turn ${turn} was ready without an action or an end.`);
    if ((ELEMENT_ACTIONS.has(action.type) || (action.type === 'scroll' && action.element)) && !('element' in action && action.element && action.element in listed.targets)) {
      // The backend checks this too; the panel doesn't take it on trust.
      throw new Abort('brain_invalid_action', `Turn ${turn} chose ${JSON.stringify(action)}, but that element isn't on this screen.`);
    }

    setPhase('acting');
    let applied;
    try {
      applied = apply(doc, state, action, rendered.layers, listed.targets, reads?.lookup ?? null);
    } catch (err) {
      throw engineAbort(err, `Playing turn ${turn}'s ${action.type}`);
    }
    state = applied.state;
    if (action.type === 'wait') {
      // What a wait fires is a timer's doing, reported with the next turn.
      addEffects(applied.effects);
      addLoop(applied.looped);
    }
    last = {
      action,
      outcome: applied.outcome,
      target: targetOf(action, listed.elements),
      ...(applied.outcome === 'unsupported' ? { unsupported: unsupportedDetail(applied.effects) } : {}),
      ...(applied.reading ? { reading: applied.reading.id } : {}),
    };
    if (reads && action.type === 'click' && applied.outcome === 'nothing_happened') mapMisses = missedBy(action.element, listed, rendered.layers);
    await save({
      owner: run.owner,
      runId: run.runId,
      turn,
      state,
      lastOutcome: last,
      timerEffects: [...pendingEffects],
      loopFrames: [...loopFrames],
      flowMapVersion: run.map?.version ?? null,
      mapMisses: [...mapMisses],
      version: SAVED_SESSION_VERSION,
    });
    turn += 1;
    status();
  }

  /**
   * Aborts the run. The backend refuses an abort of a run that ended, is
   * finalizing, or is another panel's: then the run's turn says how it
   * ended, if it has one, and the session stops with that.
   */
  async function abort(code: AbortCode, detail: string): Promise<SessionResult> {
    try {
      await call(() => api.abortRun(run.runId, { owner: run.owner, code, detail: cap(detail, 500) }));
      return { runId: run.runId, ended: { status: 'aborted', reason: code }, stop: 'aborted', message: detail };
    } catch (err) {
      if (!(err instanceof ApiError && (err.code === 'run_ended' || err.code === 'not_owner'))) throw err;
      const view = await call(() => api.getTurn(run.runId, turn)).catch((readErr: unknown) => {
        // A turn the panel never posted (a render that failed first).
        if (readErr instanceof ApiError && readErr.code === 'turn_not_found') return null;
        throw readErr;
      });
      if (view && view.status !== 'thinking' && view.ended) {
        return { runId: run.runId, ended: view.ended, stop: 'ended', message: view.status === 'failed' ? view.error.message : null };
      }
      return { runId: run.runId, ended: null, stop: err.code === 'not_owner' ? 'not_owner' : 'run_ended', message: err.message };
    }
  }

  /**
   * The element a click hit that nothing handled, when it is one the flow
   * map should have read (a candidate) and has no reading of: a run note
   * that the map missed it.
   */
  function missedBy(element: string, listed: { elements: Element[]; targets: Record<string, ElementTarget> }, layers: readonly RawLayer[]): string[] {
    const e = listed.elements.find((x) => x.id === element) as Element;
    const target = listed.targets[element] as ElementTarget;
    const index = indexLayers(layers as RawLayer[]);
    const layer = index.byKey.get(target.layerKey);
    if (!layer) throw new EngineError('invalid_layers', `The element ${element} names layer ${target.layerKey}, which the render didn't measure`);
    const read = reads?.lookup(index.rootOf.get(layer.key) as string, layer.key) ?? null;
    return isCandidate(layer, e.role, e.label) && read === null ? [e.label] : [];
  }

  /** Sets the first state: the saved one of a run this panel owns, or the start frame's. */
  function begin() {
    const resume = run.resume;
    if (!resume) {
      try {
        state = start(doc, run.startFrameId);
      } catch (err) {
        throw engineAbort(err, 'Starting the prototype failed');
      }
      return;
    }
    // The run plays its claim's map version for its whole life.
    if (resume.flowMapVersion !== (run.map?.version ?? null)) {
      throw new Error(`Run ${run.runId} was saved playing flow map version ${resume.flowMapVersion ?? 'none'}, but was resumed with ${run.map?.version ?? 'none'}.`);
    }
    state = resume.state;
    pendingEffects = [...resume.timerEffects];
    loopFrames = [...resume.loopFrames];
    mapMisses = [...resume.mapMisses];
    const missing = [state.frameId, ...state.overlays.map((o) => o.frameId)].filter((id) => !doc.frames.some((f) => f.id === id));
    if (missing.length) throw new Abort('file_changed', `The frames this persona was on are gone from the file (${missing.join(', ')}).`);
    // The backend refuses a turn after the first without `last`: this save can't go on.
    if (resume.turn >= 1 && !resume.lastOutcome) throw new Abort('panel_state_lost', `The save of turn ${resume.turn} has no outcome for the next turn to report.`);
    if (state.docHash !== doc.docHash) {
      // The flow changed while the panel was closed: go on in it as it is now, and say so.
      fileChanged = true;
      notice(NOTICE.fileChanged);
      state = { ...state, docHash: doc.docHash };
    }
  }

  const cancelled = (): SessionResult => ({ runId: run.runId, ended: null, stop: 'cancelled', message: null });

  /**
   * How the session ends. A Stop is the backend's word; anything else is not
   * the persona's doing and aborts the run: an Abort with its code, or the
   * panel itself breaking (a bug) with engine_error, after which the error
   * is thrown on, so it stays loud. An abort the backend refuses for good is
   * thrown too, naming both.
   */
  async function end(err: unknown): Promise<SessionResult> {
    if (err instanceof Cancel) return cancelled();
    if (err instanceof Stop) {
      ended = err.result.ended;
      await save(null);
      setPhase('ended');
      return { runId: run.runId, ...err.result };
    }
    const failure = err instanceof Abort ? err : new Abort('engine_error', `The panel failed on turn ${turn}: ${messageOf(err)}`);
    let result: SessionResult;
    try {
      result = await abort(failure.code, failure.message);
    } catch (abortErr) {
      if (abortErr instanceof Cancel) return cancelled();
      await save(null);
      setPhase('ended');
      throw new Error(`${failure.message} Aborting run ${run.runId} failed too, so it stays open until Archetype's watchdog ends it: ${messageOf(abortErr)}`);
    }
    ended = result.ended;
    await save(null);
    setPhase('ended');
    if (!(err instanceof Abort)) throw err;
    return result;
  }

  const unwatch = deps.watchFile(() => {
    fileChanged = true;
    notice(NOTICE.fileChanged);
  });
  try {
    if (fileChanged) notice(NOTICE.fileChanged);
    if (run.resume && (run.resume.owner !== run.owner || run.resume.runId !== run.runId)) {
      throw new Error(`The saved session of ${run.resume.runId} belongs to another panel or run.`);
    }
    try {
      begin();
      status();
      for (;;) await oneTurn();
    } catch (err) {
      return await end(err);
    }
  } finally {
    unwatch();
  }
}
