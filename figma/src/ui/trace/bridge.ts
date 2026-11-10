/**
 * Request and response over the panel's postMessage channel to the main
 * thread, for the trace runner (spec, Plugin units). Every request carries a
 * `requestId`, and the main thread answers `trace-result` or `trace-error`
 * with the same id, so the parallel sessions of a wave each get their own
 * replies. The transport is injected: the panel uses `panelTransport()`,
 * tests and the end-to-end test an in-process main thread.
 *
 * The request and reply payloads live in lib/messages.ts, which the main
 * thread's controller answers them from.
 */

import type {
  MainToUi,
  TraceCalls,
  TraceCallType,
  TraceErrorCode,
  TraceReplyMessage,
  TraceRequestMessage,
  UiToMain,
} from '../../lib/messages';
import { onMain, toMain } from '../bridge';

export type {
  RenderNote,
  SavedSession,
  ScratchCheckReply,
  TraceCalls,
  TraceCallType,
  TraceLoadReply,
  TraceLoadRequest,
  TraceReadRequest,
  TraceRenderReply,
  TraceRenderRequest,
  TraceReplyMessage,
  TraceRequestMessage,
  TraceSaveRequest,
} from '../../lib/messages';

export const BRIDGE_TIMEOUT_MS = 30_000;

export interface BridgeTransport {
  send(message: TraceRequestMessage): void;
  /** Subscribes to the main thread's trace replies; returns the unsubscribe. */
  listen(handler: (message: TraceReplyMessage) => void): () => void;
}

function isReply(msg: MainToUi): msg is TraceReplyMessage {
  if (msg.type !== 'trace-result' && msg.type !== 'trace-error') return false;
  const reply = msg as { requestId?: unknown; message?: unknown; code?: unknown };
  if (typeof reply.requestId !== 'string') return false;
  return msg.type === 'trace-result' || (typeof reply.message === 'string' && (reply.code === undefined || typeof reply.code === 'string'));
}

/** The panel's typed channel to the main thread (ui/bridge.ts), passing on only trace replies. */
export function panelTransport(
  send: (msg: UiToMain) => void = toMain,
  subscribe: (handler: (msg: MainToUi) => void) => () => void = onMain,
): BridgeTransport {
  return {
    send: (message) => send(message),
    listen: (handler) => subscribe((msg) => {
      if (isReply(msg)) handler(msg);
    }),
  };
}

// --- Errors ------------------------------------------------------------

/** The main thread answered the call with an error, or the bridge was closed. */
export class BridgeError extends Error {
  readonly type: TraceCallType;
  /** The main thread's reason, when the panel acts on it. */
  readonly code: TraceErrorCode | null;

  constructor(type: TraceCallType, message: string, code: TraceErrorCode | null = null) {
    super(message);
    this.name = 'BridgeError';
    this.type = type;
    this.code = code;
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
    else call.reject(new BridgeError(call.type, msg.message, msg.code ?? null));
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
