/**
 * The trace turn contract's types (the backend's services/trace_turn_service.py),
 * shared by the panel's API client and the main thread's saved sessions.
 * Types only, free of DOM types, so the main thread's ES2017 check can read them.
 */

import type { Element, TraceAction, TraceOutcome } from './proto/model';

export interface TraceBrowser {
  engine: 'figma-trace';
  version: string;
  viewport: [width: number, height: number];
}

export interface ClaimBody {
  browser: TraceBrowser;
  /** This panel's id; every turn and abort of the run must carry it. */
  owner: string;
}

/** The claim's briefing (only the fields the panel uses). */
export interface RunBriefing {
  runId: string;
  sessionId: string;
  claimedAt: string;
  brief: string;
  persona: { name: string };
  instructions: { targetUrl: string; goal: string };
}

export type TurnFlag = 'file_changed' | 'timer_loop' | 'missing_font';

/** What a timer fired during settle or wait that the outcome does not say. */
export interface TimerEffect {
  type: 'left_prototype' | 'unsupported';
  detail: string;
}

/** What the action turn n-1 answered did, as the engine saw it. */
export interface TurnLast {
  action: TraceAction;
  outcome: TraceOutcome;
  /** The element's label and id, such as "Continue (e4)"; null when the action had no element. */
  target: string | null;
  /** Required with the unsupported outcome, and only then: what did nothing, at most 200 characters. */
  unsupported?: string;
  /** At most 10. */
  timer_effects?: TimerEffect[];
}

export interface TurnScreen {
  url: string;
  title: string;
  frameId: string;
  overlays: string[];
  viewport: [width: number, height: number];
  scroll: { x: number; y: number; maxX: number; maxY: number };
}

export interface TurnBody {
  owner: string;
  turn: number;
  screen: TurnScreen;
  /** The viewport as a base64 JPEG, at most 1.5 MiB decoded. */
  screenshot_b64: string;
  /** At most 80, ids unique in the turn. */
  elements: Element[];
  visible_text_excerpt: string;
  /** Null on turn 1, required after it. */
  last: TurnLast | null;
  /** Required, [] when nothing applies. */
  flags: TurnFlag[];
  /** Each detail only with its flag in `flags`. */
  flag_details?: { timer_loop?: { frames: string[] }; missing_font?: { fonts: string[] } };
  elapsed_s: number;
  client_ts: string;
}

export interface TurnState {
  seq: number;
  maxSteps: number;
  unproductive: number;
  maxUnproductiveSteps: number;
  progress: number;
  sentimentTrend: 'falling' | 'steady' | 'rising';
  reviewGiveUp: boolean;
  ended: boolean;
  endedReason: string | null;
}

/** How the run ends: finalizing while the debrief is made, then its final status. */
export interface TurnEnded {
  status: 'finalizing' | 'completed' | 'abandoned' | 'aborted';
  reason: string | null;
}

/** A turn as the poll sees it. Once `ended` is set the session stops and never aborts. */
export type TurnView =
  | { turn: number; status: 'thinking' }
  /** `action` is null when patience ended the run on the step before. */
  | { turn: number; status: 'ready'; action: TraceAction | null; state: TurnState; ended: TurnEnded | null }
  | { turn: number; status: 'failed'; error: { code: string; message: string }; ended: TurnEnded };

/** The abort codes the panel may send (the backend's own finalize_failed is not one). */
export type AbortCode =
  | 'render_failed'
  | 'turn_timeout'
  | 'panel_state_lost'
  | 'file_changed'
  | 'brain_invalid_action'
  | 'model_unavailable'
  | 'debrief_invalid'
  | 'engine_error';

export interface AbortBody {
  owner: string;
  code: AbortCode;
  /** What went wrong, in a sentence; required. */
  detail: string;
}

export interface AbortResult {
  runId: string;
  status: 'aborted';
  abortReason: AbortCode;
}
