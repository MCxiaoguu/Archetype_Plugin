import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BridgeError,
  BridgeTimeout,
  createBridge,
  panelTransport,
  type BridgeTransport,
  type TraceReplyMessage,
  type TraceRequestMessage,
} from '../src/ui/trace/bridge';
import type { ProtoDoc } from '../src/lib/proto/model';

/** An in-process main thread: it records requests and answers when told to. */
function fakeMain(): { transport: BridgeTransport; sent: TraceRequestMessage[]; reply: (msg: TraceReplyMessage) => void; listeners: () => number } {
  const sent: TraceRequestMessage[] = [];
  const handlers = new Set<(msg: TraceReplyMessage) => void>();
  return {
    sent,
    transport: {
      send: (msg) => {
        sent.push(msg);
      },
      listen: (handler) => {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
    },
    reply: (msg) => handlers.forEach((h) => h(msg)),
    listeners: () => handlers.size,
  };
}

const DOC = { docHash: 'h1', pageId: '0:1', pageName: 'Billing flow' } as unknown as ProtoDoc;

afterEach(() => {
  vi.useRealTimers();
});

describe('trace bridge', () => {
  it('sends the type, a request id and the payload, and resolves on the matching result', async () => {
    const main = fakeMain();
    const bridge = createBridge(main.transport);
    const pending = bridge.call('trace-read', { importLibraryVariants: false });
    expect(main.sent).toHaveLength(1);
    const [msg] = main.sent;
    expect(msg).toEqual({ type: 'trace-read', requestId: expect.any(String), importLibraryVariants: false });
    main.reply({ type: 'trace-result', requestId: msg!.requestId, result: DOC });
    await expect(pending).resolves.toBe(DOC);
  });

  it('gives two parallel calls their own replies, even out of order', async () => {
    const main = fakeMain();
    const bridge = createBridge(main.transport);
    const first = bridge.call('trace-load', { studyId: 's1' });
    const second = bridge.call('trace-load', { studyId: 's2' });
    const [a, b] = main.sent;
    expect(a!.requestId).not.toBe(b!.requestId);
    main.reply({ type: 'trace-result', requestId: b!.requestId, result: { sessions: [{ runId: 'from-s2' }] } });
    main.reply({ type: 'trace-result', requestId: a!.requestId, result: { sessions: [{ runId: 'from-s1' }] } });
    await expect(first).resolves.toEqual({ sessions: [{ runId: 'from-s1' }] });
    await expect(second).resolves.toEqual({ sessions: [{ runId: 'from-s2' }] });
  });

  it('rejects on trace-error with the main thread message, as a BridgeError', async () => {
    const main = fakeMain();
    const bridge = createBridge(main.transport);
    const pending = bridge.call('trace-render', { doc: DOC, state: {} as never });
    main.reply({ type: 'trace-error', requestId: main.sent[0]!.requestId, message: 'exportAsync failed: node was removed' });
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeError);
    expect(err).toMatchObject({ type: 'trace-render', message: 'exportAsync failed: node was removed' });
  });

  it('times out after 30 s by default with a BridgeTimeout, and ignores the late reply', async () => {
    vi.useFakeTimers();
    const main = fakeMain();
    const bridge = createBridge(main.transport);
    const slow = bridge.call('trace-scratch-check', {});
    const other = bridge.call('trace-scratch-check', {});
    let settled = false;
    slow.catch(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    main.reply({ type: 'trace-result', requestId: main.sent[1]!.requestId, result: { ok: true, reason: null } });
    await expect(other).resolves.toEqual({ ok: true, reason: null });
    await vi.advanceTimersByTimeAsync(1);
    const err = await slow.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeTimeout);
    expect(err).toMatchObject({ type: 'trace-scratch-check', timeoutMs: 30_000 });
    // A reply that comes after the timeout has nobody left to answer.
    expect(() => main.reply({ type: 'trace-result', requestId: main.sent[0]!.requestId, result: { ok: true, reason: null } })).not.toThrow();
  });

  it('takes a timeout per call', async () => {
    vi.useFakeTimers();
    const main = fakeMain();
    const bridge = createBridge(main.transport);
    const pending = bridge.call('trace-render', { doc: DOC, state: {} as never }, { timeoutMs: 5_000 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toMatchObject({ name: 'BridgeTimeout', timeoutMs: 5_000 });
  });

  it('rejects a call whose message cannot be sent, and forgets it', async () => {
    vi.useFakeTimers();
    const transport: BridgeTransport = {
      send: () => {
        throw new DOMException('could not be cloned', 'DataCloneError');
      },
      listen: () => () => undefined,
    };
    const bridge = createBridge(transport);
    await expect(bridge.call('trace-save', { studyId: 's1', runId: 'r1', session: null })).rejects.toMatchObject({ name: 'DataCloneError' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('close rejects the calls still waiting and stops listening', async () => {
    const main = fakeMain();
    const bridge = createBridge(main.transport);
    const pending = bridge.call('trace-read', { importLibraryVariants: true });
    expect(main.listeners()).toBe(1);
    bridge.close();
    await expect(pending).rejects.toBeInstanceOf(BridgeError);
    expect(main.listeners()).toBe(0);
    await expect(bridge.call('trace-read', { importLibraryVariants: true })).rejects.toBeInstanceOf(BridgeError);
  });
});

describe('panel transport', () => {
  it('posts in the plugin message envelope and passes on only trace replies', () => {
    const posted: unknown[] = [];
    const listeners = new Set<(event: MessageEvent) => void>();
    const target = { postMessage: (message: unknown, origin: string) => posted.push({ message, origin }) };
    const source = {
      addEventListener: (_type: 'message', l: (event: MessageEvent) => void) => listeners.add(l),
      removeEventListener: (_type: 'message', l: (event: MessageEvent) => void) => listeners.delete(l),
    };
    const transport = panelTransport(target, source);
    transport.send({ type: 'trace-load', requestId: 'q1', studyId: 's1' });
    expect(posted).toEqual([{ message: { pluginMessage: { type: 'trace-load', requestId: 'q1', studyId: 's1' } }, origin: '*' }]);

    const got: TraceReplyMessage[] = [];
    const stop = transport.listen((msg) => got.push(msg));
    const deliver = (data: unknown) => listeners.forEach((l) => l({ data } as MessageEvent));
    deliver({ pluginMessage: { type: 'doc', doc: {} } });
    deliver({ pluginMessage: { type: 'trace-result', result: 1 } });
    deliver(null);
    deliver({ pluginMessage: { type: 'trace-result', requestId: 'q1', result: { sessions: [] } } });
    deliver({ pluginMessage: { type: 'trace-error', requestId: 'q2', message: 'no' } });
    expect(got).toEqual([
      { type: 'trace-result', requestId: 'q1', result: { sessions: [] } },
      { type: 'trace-error', requestId: 'q2', message: 'no' },
    ]);
    stop();
    expect(listeners.size).toBe(0);
  });
});
