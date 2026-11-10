import type { RunSize, StudyForm } from './form';
import type { ProtoDoc, RawLayer, Size, TraceState } from './proto/model';
import type { TimerEffect, TurnLast } from './turn';
import type { DocSnapshot, NodeRef, Pin } from './types';

export interface Settings {
  apiBase: string;
  webBase: string;
}

export const DEFAULT_SETTINGS: Settings = {
  apiBase: 'https://api.syntheticarchetype.com',
  webBase: 'https://www.syntheticarchetype.com',
};

/**
 * An address the plugin may call or open: https anywhere, plain http only on
 * this machine (a local backend). Written without URL, which Figma's main
 * thread sandbox does not have.
 */
export function isSafeWebUrl(url: string): boolean {
  return (
    /^https:\/\/[^\s/?#@]+([/?#]\S*)?$/i.test(url) ||
    /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#]\S*)?$/i.test(url)
  );
}

export function studyWebUrl(webBase: string, studyId: string): string {
  return `${webBase.trim().replace(/\/+$/, '')}/workspace/studies/${encodeURIComponent(studyId)}`;
}

/** What the plugin remembers about a test it launched from this file. */
export interface StudyRecord {
  studyId: string;
  title: string;
  startName: string;
  goalName: string;
  size: RunSize;
  launchedAt: number;
  /** Last known study status, for the history list. */
  status: string;
  /** "3 of 5 reached the goal", once a report was seen. */
  outcome?: string | null;
  /** A plugin-mode study this panel runs itself; absent for one a runner service runs. */
  trace?: TraceRecord;
}

/** Who runs a plugin-mode study's personas here, and on what (spec, Data flow 2 and 10). */
export interface TraceRecord {
  /** This panel's id for the study's runs, kept so a reopened panel resumes the runs it owns. */
  owner: string;
  /** The page the flow is on: the prototype is read from the current page. */
  pageId: string;
  pageName: string;
  startFrameId: string;
  /** The share link's file key; null without a link. */
  shareKey: string | null;
  /** The designer agreed that reading the flow imports its library components. */
  importLibraryVariants: boolean;
}

export type Draft = Pick<StudyForm, 'goal' | 'who' | 'product' | 'link' | 'size'>;

export interface InitPayload {
  settings: Settings;
  token: string | null;
  fileKey: string | null;
  doc: DocSnapshot;
  selection: NodeRef | null;
  studies: StudyRecord[];
  lastStudyId: string | null;
  draft: Partial<Draft> | null;
  pluginVersion: string;
}

// --- The trace runner's calls to the main thread (ui/trace/bridge.ts) ----
//
// Every request carries a requestId; the main thread answers it with
// trace-result or trace-error carrying the same id, so parallel sessions
// get their own replies.

export interface TraceReadRequest {
  /** Whether the read may import library variants, which adds them to the designer's file. */
  importLibraryVariants: boolean;
}

export interface TraceRenderRequest {
  doc: ProtoDoc;
  state: TraceState;
}

/** A font the render could not load: its text was left as designed. */
export interface RenderNote {
  missing_font: string[];
}

/** One render of a state (main/renderer.ts, spec "One render"). */
export interface TraceRenderReply {
  /** The viewport as JPEG bytes; postMessage's structured clone keeps the Uint8Array. */
  image: Uint8Array;
  /** Measured off the copies, in paint order. */
  layers: RawLayer[];
  viewport: Size;
  notes: RenderNote[];
}

/** What resuming a persona needs (spec, Data flow 7 and 10). */
export interface SavedSession {
  owner: string;
  runId: string;
  /** The last turn the panel applied. */
  turn: number;
  /** Carries the docHash of the ProtoDoc the run started on. */
  state: TraceState;
  /** What the next turn reports as `last`; null before the first action. */
  lastOutcome: TurnLast | null;
  /** What timers did since that turn (a wait's), for the next turn's `last.timer_effects`. */
  timerEffects: TimerEffect[];
  /** Frames a loop of timers ran through since that turn, for the next turn's `timer_loop` flag. */
  loopFrames: string[];
}

export interface TraceSaveRequest {
  studyId: string;
  runId: string;
  /** Null forgets the run (it ended). */
  session: SavedSession | null;
}

export interface TraceLoadRequest {
  studyId: string;
}

export interface TraceLoadReply {
  sessions: SavedSession[];
}

/** Scratch containers removed from the page once no session renders any more. */
export interface TraceCleanupReply {
  removed: number;
}

/** The launch gate: whether a scratch container can be made and removed (edit access). */
/** `reason` is what the designer reads; `detail` is what Figma said. */
export type ScratchCheckReply = { ok: true; reason: null } | { ok: false; reason: string; detail: string };

export interface TraceCalls {
  'trace-read': { request: TraceReadRequest; reply: ProtoDoc };
  'trace-render': { request: TraceRenderRequest; reply: TraceRenderReply };
  'trace-save': { request: TraceSaveRequest; reply: null };
  'trace-load': { request: TraceLoadRequest; reply: TraceLoadReply };
  'trace-scratch-check': { request: Record<string, never>; reply: ScratchCheckReply };
  'trace-cleanup': { request: Record<string, never>; reply: TraceCleanupReply };
}

export type TraceCallType = keyof TraceCalls;

export type TraceRequestMessage = {
  [K in TraceCallType]: { type: K; requestId: string } & TraceCalls[K]['request'];
}[TraceCallType];

export type TraceReplyMessage =
  | { type: 'trace-result'; requestId: string; result: unknown }
  | { type: 'trace-error'; requestId: string; message: string };

export const TRACE_CALLS: readonly TraceCallType[] = ['trace-read', 'trace-render', 'trace-save', 'trace-load', 'trace-scratch-check', 'trace-cleanup'];

export function isTraceRequest(msg: { type: string }): msg is TraceRequestMessage {
  return (TRACE_CALLS as readonly string[]).includes(msg.type);
}

export type MainToUi =
  | ({ type: 'init' } & InitPayload)
  | { type: 'doc'; doc: DocSnapshot }
  | { type: 'selection'; selection: NodeRef | null }
  | { type: 'studies'; studies: StudyRecord[]; lastStudyId: string | null }
  | { type: 'pin-result'; ok: boolean; count: number; message: string }
  | { type: 'show-result'; ok: boolean; message: string | null }
  | TraceReplyMessage
  /** A frame of the ProtoDoc read last changed in the file (spec, Error handling: flow edited mid-run). */
  | { type: 'trace-file-changed'; frameIds: string[] };

export type UiToMain =
  | TraceRequestMessage
  | { type: 'ready' }
  | { type: 'resize'; width: number; height: number }
  | { type: 'refresh' }
  | { type: 'save-settings'; settings: Settings }
  | { type: 'save-token'; token: string | null }
  | { type: 'save-study'; record: StudyRecord }
  | { type: 'forget-last' }
  | { type: 'save-draft'; draft: Partial<Draft> }
  | { type: 'open-url'; url: string }
  | { type: 'show-node'; nodeId: string }
  | { type: 'pin'; pins: Pin[] }
  | { type: 'clear-pins' }
  | { type: 'notify'; text: string };

export const PIN_PREFIX = 'Archetype:';
