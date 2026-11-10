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
 * has set `ended` the session never aborts.
 */

import { ApiError, TURN_TIMEOUT_MS, type AbortCode, type ApiClient, type TimerEffect, type TurnBody, type TurnEnded, type TurnFlag, type TurnLast, type TurnView } from '../../lib/api';
import type { SavedSession, TraceRenderReply } from '../../lib/messages';
import { listElements } from '../../lib/proto/elements';
import { apply, settle, start, type EngineEffect } from '../../lib/proto/engine';
import { EngineError } from '../../lib/proto/errors';
import type { Element, ElementTarget, ProtoDoc, RawLayer, TraceAction, TraceState } from '../../lib/proto/model';
import { pageOffset, pageRange } from '../../lib/proto/scroll';
import { stepUrl } from '../../lib/proto/url';
import type { Bridge } from './bridge';

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
  /** `ended`: the backend ended the run. `aborted`: this panel aborted it. The rest stop without aborting. */
  stop: 'ended' | 'aborted' | 'not_owner' | 'run_ended' | 'run_not_found';
  message: string | null;
}

export interface SessionDeps {
  bridge: Pick<Bridge, 'call'>;
  api: Pick<ApiClient, 'postTurn' | 'getTurn' | 'abortRun'>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  onStatus: (status: SessionStatus) => void;
  /** Subscribes to the main thread's trace-file-changed; returns the unsubscribe. */
  watchFile?: (onChange: (frameIds: string[]) => void) => () => void;
  /** How long a turn post may take; a backend deciding inside the request needs longer. */
  postTurnTimeoutMs?: number;
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

/** EngineError codes, as the run is aborted for them. */
const ENGINE_ABORT: Record<string, AbortCode> = {
  doc_changed: 'file_changed',
  invalid_doc: 'engine_error',
  invalid_layers: 'engine_error',
  unknown_element: 'brain_invalid_action',
  invalid_action: 'brain_invalid_action',
  run_ending_action: 'brain_invalid_action',
};

const ELEMENT_ACTIONS: ReadonlySet<string> = new Set(['click', 'hover', 'drag', 'type']);

const cap = (text: string, limit: number) => (text.length > limit ? text.slice(0, limit) : text);

function engineAbort(err: unknown, what: string): Abort {
  if (err instanceof EngineError) return new Abort(ENGINE_ABORT[err.code as string] ?? 'engine_error', `${what}: ${err.message}`);
  return new Abort('engine_error', `${what}: ${err instanceof Error ? err.message : String(err)}`);
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
  if (err.status >= 500) return NOTICE.offline;
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

function targetOf(action: TraceAction, elements: readonly Element[]): string | null {
  if (!('element' in action) || !action.element) return null;
  const label = elements.find((e) => e.id === action.element)?.label;
  return label ? `${label} (${action.element})` : action.element;
}

export async function runSession(run: SessionRun, deps: SessionDeps): Promise<SessionResult> {
  const { api, bridge } = deps;
  const doc = run.doc;
  const startedAt = deps.now();
  const notices: string[] = [];
  let phase: SessionPhase = 'acting';
  let lateNoticed = false;
  let fileChanged = false;
  /** Effects timers fired since the last turn posted, reported with the next `last`. */
  let pendingEffects: TimerEffect[] = [];
  /** Frames a loop of timers ran through since the last turn posted. */
  let loopFrames: string[] = [];
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
  const setPhase = (next: SessionPhase) => {
    phase = next;
    status();
  };

  /** A wait that notices when the browser fires timers late (a hidden tab). Returns how long it really took. */
  async function wait(ms: number): Promise<number> {
    const before = deps.now();
    await deps.sleep(ms);
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
    for (;;) {
      try {
        const result = await work();
        if (phase === 'paused') setPhase(before);
        return result;
      } catch (err) {
        const why = pauseFor(err);
        if (!why) throw err;
        notice(why);
        if (phase !== 'paused') setPhase('paused');
        await wait(delay);
        delay = Math.min(delay * 2, RETRY_MAX_MS);
      }
    }
  }

  async function render(): Promise<TraceRenderReply> {
    try {
      return await bridge.call('trace-render', { doc, state });
    } catch {
      // One retry (spec, Error handling): the second failure aborts with its reason.
      try {
        return await bridge.call('trace-render', { doc, state });
      } catch (second) {
        throw new Abort('render_failed', second instanceof Error ? second.message : String(second));
      }
    }
  }

  async function save(session: SavedSession | null): Promise<void> {
    const payload = { studyId: run.studyId, runId: run.runId, session };
    try {
      await bridge.call('trace-save', payload);
    } catch {
      try {
        await bridge.call('trace-save', payload);
      } catch {
        notice(NOTICE.notSaved);
      }
    }
  }

  function body(rendered: TraceRenderReply, elements: Element[]): TurnBody {
    const frame = doc.frames.find((f) => f.id === state.frameId);
    if (!frame) throw new EngineError('invalid_doc', `The frame ${state.frameId} isn't in the prototype`);
    const offset = pageOffset(state, state.frameId);
    const range = pageRange(frame, state.viewport);
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
    return {
      owner: run.owner,
      turn,
      screen: {
        url: stepUrl(run.shareKey, doc.pageName, { frameId: state.frameId, overlays }),
        title: frame.name,
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

  /** Posts the turn, or for a turn the backend already holds, only reads it. */
  async function post(turnBody: TurnBody): Promise<TurnView> {
    if (turn < backendHas) return call(() => api.getTurn(run.runId, turn));
    try {
      return await call(() => api.postTurn(run.runId, turnBody, { timeoutMs: deps.postTurnTimeoutMs ?? TURN_TIMEOUT_MS }));
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      if (err.code === 'turn_out_of_order' && err.expected !== null) {
        // The backend is ahead (a panel before this one posted those turns):
        // read the turns it holds, from this one on, instead of posting them.
        if (err.expected > turn) {
          backendHas = err.expected;
          return call(() => api.getTurn(run.runId, turn));
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
      throw new Abort('engine_error', `The backend refused turn ${turn}: ${err.message}`);
    }
    throw err;
  }

  async function oneTurn(): Promise<void> {
    setPhase('acting');
    let settled;
    try {
      settled = settle(doc, state);
    } catch (err) {
      throw engineAbort(err, 'Settling the screen failed');
    }
    state = settled.state;
    addEffects(settled.effects);
    addLoop(settled.looped);
    status();

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
      applied = apply(doc, state, action, rendered.layers, listed.targets);
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
    };
    await save({ owner: run.owner, runId: run.runId, turn, state, lastOutcome: last });
    turn += 1;
    status();
  }

  async function abort(code: AbortCode, detail: string): Promise<SessionResult> {
    try {
      await call(() => api.abortRun(run.runId, { owner: run.owner, code, detail: cap(detail, 500) }));
    } catch (err) {
      // Ended meanwhile (the watchdog, another abort): the run is over either way.
      if (!(err instanceof ApiError && (err.code === 'run_ended' || err.code === 'not_owner'))) throw err;
    }
    return { runId: run.runId, ended: { status: 'aborted', reason: code }, stop: 'aborted', message: detail };
  }

  const unwatch = deps.watchFile?.(() => {
    fileChanged = true;
    notice(NOTICE.fileChanged);
  });
  try {
    if (run.resume) {
      if (run.resume.owner !== run.owner || run.resume.runId !== run.runId) {
        throw new Error(`The saved session of ${run.resume.runId} belongs to another panel or run.`);
      }
      state = run.resume.state;
      const missing = [state.frameId, ...state.overlays.map((o) => o.frameId)].filter((id) => !doc.frames.some((f) => f.id === id));
      if (missing.length) {
        const result = await abort('file_changed', `The frames this persona was on are gone from the file (${missing.join(', ')}).`);
        await save(null);
        return result;
      }
      if (state.docHash !== doc.docHash) {
        // The flow changed while the panel was closed: go on in it as it is now, and say so.
        fileChanged = true;
        notice(NOTICE.fileChanged);
        state = { ...state, docHash: doc.docHash };
      }
    } else {
      try {
        state = start(doc, run.startFrameId);
      } catch (err) {
        const failure = engineAbort(err, 'Starting the prototype failed');
        const result = await abort(failure.code, failure.message);
        ended = result.ended;
        setPhase('ended');
        return result;
      }
    }
    status();

    for (;;) {
      try {
        await oneTurn();
      } catch (err) {
        if (err instanceof Stop) {
          ended = err.result.ended;
          await save(null);
          setPhase('ended');
          return { runId: run.runId, ...err.result };
        }
        if (err instanceof Abort) {
          const result = await abort(err.code, err.message);
          ended = result.ended;
          await save(null);
          setPhase('ended');
          return result;
        }
        throw err;
      }
    }
  } finally {
    unwatch?.();
  }
}
