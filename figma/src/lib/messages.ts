import type { RunSize, StudyForm } from './form';
import type { FlowCandidate, FlowEdge, FlowNode } from './proto/flow';
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

/** Whether an address is on this computer: a local backend or web app. Written without URL, as isSafeWebUrl is. */
export function isLocalUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#]\S*)?$/i.test(url.trim());
}

/**
 * Why Open in Archetype would look a study up in the wrong place: the API
 * and the web app are not both on this computer, or both away from it, so
 * the web app reads another database than the one the tests are in. Null
 * when they match.
 */
export function webAppMismatch(settings: Settings): string | null {
  const api = isLocalUrl(settings.apiBase);
  const web = isLocalUrl(settings.webBase);
  if (api && !web) {
    return "Your API is on this computer, so tests live there; Open in Archetype needs the local web app too (demo-local's ./start.sh --with-web serves it on http://localhost:5173).";
  }
  if (!api && web) {
    return `Your API isn't on this computer, so tests live on that server; Open in Archetype needs its web app too, not the one on this computer (Archetype's is ${DEFAULT_SETTINGS.webBase}).`;
  }
  return null;
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

/** The panel's view choices, kept across sessions. */
export interface Prefs {
  /** The Flow map card on the Running screen is open (it starts as one line). */
  flowMapOpen: boolean;
}

export const DEFAULT_PREFS: Prefs = { flowMapOpen: false };

export interface InitPayload {
  settings: Settings;
  token: string | null;
  fileKey: string | null;
  doc: DocSnapshot;
  selection: NodeRef | null;
  studies: StudyRecord[];
  lastStudyId: string | null;
  draft: Partial<Draft> | null;
  prefs: Prefs;
  pluginVersion: string;
}

// --- The trace runner's calls to the main thread (ui/trace/bridge.ts) ----
//
// Every request carries a requestId; the main thread answers it with
// trace-result or trace-error carrying the same id, so parallel sessions
// get their own replies.

/** The flow of a read ProtoDoc, by its hash: nodes, drawn edges and candidates for the flow map (main/flowMap.ts). */
export interface TraceCandidatesRequest {
  docHash: string;
}

/** Follow persona: bring a frame into view, moving nothing but the viewport (main/canvas.ts). */
export interface TraceFollowRequest {
  frameId: string;
}

/** Null when the viewport moved to the frame; the name of its page when that isn't the current one, and the viewport stayed. */
export interface TraceFollowReply {
  otherPage: string | null;
}

export interface TraceReadRequest {
  /** Whether the read may import library variants, which adds them to the designer's file. */
  importLibraryVariants: boolean;
}

export interface TraceRenderRequest {
  /** The ProtoDoc to render with, by its hash: one the main thread answered a trace-read with. */
  docHash: string;
  state: TraceState;
}

/** What the panel commits to the backend for a study's flow map (spec, Commit). */
export interface FlowRead {
  docHash: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  candidates: FlowCandidate[];
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

/** The shape of SavedSession (and the TraceState in it) this plugin saves and can resume from. */
export const SAVED_SESSION_VERSION = 2;

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
  /** The flow map version the run plays (its claim's); null for a run claimed with no map. */
  flowMapVersion: number | null;
  /** The labels of the elements that turn's click hit that the map has no reading for, for the next turn's `map_miss` flag. */
  mapMisses: string[];
  /** SAVED_SESSION_VERSION when it was saved: another version's saved state isn't resumed. */
  version: number;
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

/** Forgets every saved session of a study: the designer's way out of saved progress the plugin can't read. */
export interface TraceForgetRequest {
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
  'trace-forget': { request: TraceForgetRequest; reply: null };
  'trace-candidates': { request: TraceCandidatesRequest; reply: FlowRead };
  'trace-follow': { request: TraceFollowRequest; reply: TraceFollowReply };
}

export type TraceCallType = keyof TraceCalls;

export type TraceRequestMessage = {
  [K in TraceCallType]: { type: K; requestId: string } & TraceCalls[K]['request'];
}[TraceCallType];

/** Why a trace request failed, when the panel acts on the reason: `saved_progress_unreadable` offers to forget it. */
export type TraceErrorCode = 'saved_progress_unreadable';

export type TraceReplyMessage =
  | { type: 'trace-result'; requestId: string; result: unknown }
  | { type: 'trace-error'; requestId: string; message: string; code?: TraceErrorCode };

export const TRACE_CALLS: readonly TraceCallType[] = ['trace-read', 'trace-render', 'trace-save', 'trace-load', 'trace-scratch-check', 'trace-cleanup', 'trace-forget', 'trace-candidates', 'trace-follow'];

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
  | { type: 'save-prefs'; prefs: Prefs }
  | { type: 'open-url'; url: string }
  | { type: 'show-node'; nodeId: string }
  | { type: 'pin'; pins: Pin[] }
  | { type: 'clear-pins' }
  | { type: 'notify'; text: string };

export const PIN_PREFIX = 'Archetype:';
