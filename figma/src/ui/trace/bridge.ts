/**
 * Request and response over the panel's postMessage channel to the main
 * thread, for the trace runner (spec, Plugin units). Every request carries a
 * `requestId`, and the main thread answers `trace-result` or `trace-error`
 * with the same id, so the parallel sessions of a wave each get their own
 * replies. The transport is injected: the panel uses `panelTransport()`,
 * tests and the end-to-end test an in-process main thread.
 *
 * The request and reply payloads are defined here; lib/messages.ts and the
 * main thread's controller use them for the other end (task P7).
 */

import type { TurnLast } from '../../lib/api';
import type { ProtoDoc, RawLayer, Size, TraceState } from '../../lib/proto/model';

export const BRIDGE_TIMEOUT_MS = 30_000;

// --- What each call sends and gets back --------------------------------

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
  /** The viewport as JPEG bytes. */
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

/** The launch gate: whether a scratch container can be made and removed (edit access). */
export interface ScratchCheckReply {
  ok: boolean;
  reason: string | null;
}

export interface TraceCalls {
  'trace-read': { request: TraceReadRequest; reply: ProtoDoc };
  'trace-render': { request: TraceRenderRequest; reply: TraceRenderReply };
  'trace-save': { request: TraceSaveRequest; reply: null };
  'trace-load': { request: TraceLoadRequest; reply: TraceLoadReply };
  'trace-scratch-check': { request: Record<string, never>; reply: ScratchCheckReply };
}

export type TraceCallType = keyof TraceCalls;

// --- On the wire ---------------------------------------------------------

export type TraceRequestMessage = {
  [K in TraceCallType]: { type: K; requestId: string } & TraceCalls[K]['request'];
}[TraceCallType];

export type TraceReplyMessage =
  | { type: 'trace-result'; requestId: string; result: unknown }
  | { type: 'trace-error'; requestId: string; message: string };

export interface BridgeTransport {
  send(message: TraceRequestMessage): void;
  /** Subscribes to the main thread's trace replies; returns the unsubscribe. */
  listen(handler: (message: TraceReplyMessage) => void): () => void;
}

function isReply(value: unknown): value is TraceReplyMessage {
  if (!value || typeof value !== 'object') return false;
  const msg = value as { type?: unknown; requestId?: unknown; message?: unknown };
  if (typeof msg.requestId !== 'string') return false;
  return msg.type === 'trace-result' || (msg.type === 'trace-error' && typeof msg.message === 'string');
}

/** Where the panel posts to (the main thread's `parent`) and listens on (its `window`). */
export interface PostTarget {
  postMessage(message: unknown, targetOrigin: string): void;
}

export interface MessageSource {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

/** The panel's channel to the main thread, in the envelope ui/bridge.ts uses. */
export function panelTransport(target: PostTarget = parent, source: MessageSource = window): BridgeTransport {
  return {
    send: (message) => target.postMessage({ pluginMessage: message }, '*'),
    listen: (handler) => {
      const listener = (event: MessageEvent) => {
        const data = event.data as { pluginMessage?: unknown } | null;
        if (data && typeof data === 'object' && isReply(data.pluginMessage)) handler(data.pluginMessage);
      };
      source.addEventListener('message', listener);
      return () => source.removeEventListener('message', listener);
    },
  };
}

// --- Errors ------------------------------------------------------------

/** The main thread answered the call with an error, or the bridge was closed. */
export class BridgeError extends Error {
  readonly type: TraceCallType;

  constructor(type: TraceCallType, message: string) {
    super(message);
    this.name = 'BridgeError';
    this.type = type;
  }
}

/** The main thread did not answer in time. */
export class BridgeTimeout extends Error {
  readonly type: TraceCallType;
  readonly timeoutMs: number;

  constructor(type: TraceCallType, timeoutMs: number) {
    super(`The Figma document did not answer ${type} within ${Math.round(timeoutMs / 1000)} s.`);
    this.name = 'BridgeTimeout';
    this.type = type;
    this.timeoutMs = timeoutMs;
  }
}

// --- The bridge --------------------------------------------------------

export interface Bridge {
  call<K extends TraceCallType>(type: K, payload: TraceCalls[K]['request'], options?: { timeoutMs?: number }): Promise<TraceCalls[K]['reply']>;
  /** Stops listening and rejects every call still waiting. */
  close(): void;
}

interface Waiting {
  type: TraceCallType;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createBridge(transport: BridgeTransport): Bridge {
  // Unique across bridges and panel reloads: a reply meant for another one never matches.
  const prefix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let next = 0;
  let closed = false;
  const waiting = new Map<string, Waiting>();

  const stop = transport.listen((msg) => {
    const call = waiting.get(msg.requestId);
    // No one waits: the call timed out (and was rejected then) or is another bridge's.
    if (!call) return;
    waiting.delete(msg.requestId);
    clearTimeout(call.timer);
    if (msg.type === 'trace-result') call.resolve(msg.result);
    else call.reject(new BridgeError(call.type, msg.message));
  });

  return {
    call<K extends TraceCallType>(type: K, payload: TraceCalls[K]['request'], options: { timeoutMs?: number } = {}) {
      if (closed) return Promise.reject(new BridgeError(type, 'The trace bridge is closed.'));
      const timeoutMs = options.timeoutMs ?? BRIDGE_TIMEOUT_MS;
      const requestId = `${prefix}-${++next}`;
      return new Promise<TraceCalls[K]['reply']>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(requestId);
          reject(new BridgeTimeout(type, timeoutMs));
        }, timeoutMs);
        waiting.set(requestId, { type, resolve: resolve as (result: unknown) => void, reject, timer });
        try {
          transport.send({ type, requestId, ...payload } as TraceRequestMessage);
        } catch (err) {
          waiting.delete(requestId);
          clearTimeout(timer);
          reject(err instanceof Error ? err : new BridgeError(type, String(err)));
        }
      });
    },
    close() {
      closed = true;
      stop();
      for (const [requestId, call] of waiting) {
        clearTimeout(call.timer);
        call.reject(new BridgeError(call.type, 'The trace bridge was closed before the Figma document answered.'));
        waiting.delete(requestId);
      }
    },
  };
}
