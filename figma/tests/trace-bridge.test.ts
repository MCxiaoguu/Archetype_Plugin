import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BridgeError,
  BridgeTimeout,
  RenderStuck,
  createBridge,
  panelTransport,
  type BridgeTransport,
  type TraceReplyMessage,
  type TraceRequestMessage,
} from '../src/ui/trace/bridge';
import type { MainToUi, UiToMain } from '../src/lib/messages';
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
    const pending = bridge.call('trace-render', { docHash: DOC.docHash, state: {} as never });
    main.reply({ type: 'trace-error', requestId: main.sent[0]!.requestId, message: 'exportAsync failed: node was removed' });
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeError);
    expect(err).toMatchObject({ type: 'trace-render', message: 'exportAsync failed: node was removed', code: null });
  });

  it('keeps the code of a trace-error that has one', async () => {
    const main = fakeMain();
    const bridge = createBridge(main.transport);
    const pending = bridge.call('trace-load', { studyId: 's1' });
    main.reply({ type: 'trace-error', requestId: main.sent[0]!.requestId, message: "This test's saved progress was made by another version of the plugin.", code: 'saved_progress_unreadable' });
    expect(await pending.catch((e: unknown) => e)).toMatchObject({ type: 'trace-load', code: 'saved_progress_unreadable' });
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
    const pending = bridge.call('trace-render', { docHash: DOC.docHash, state: {} as never }, { timeoutMs: 5_000 }).catch((e: unknown) => e);
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

describe('renders through the bridge', () => {
  const render = (bridge: ReturnType<typeof createBridge>, n: number) => bridge.call('trace-render', { docHash: DOC.docHash, state: { frameId: `f${n}` } as never });
  const renderIds = (main: ReturnType<typeof fakeMain>) => main.sent.filter((m) => m.type === 'trace-render').map((m) => m.requestId);

  /** A main thread that takes `ms` per render, one at a time, as its queue does. */
  function slowMain(ms: number) {
    const main = fakeMain();
    let busy = Promise.resolve();
    const send = main.transport.send;
    main.transport.send = (msg) => {
      send(msg);
      if (msg.type !== 'trace-render') return;
      busy = busy.then(() => new Promise<void>((done) => setTimeout(() => {
        main.reply({ type: 'trace-result', requestId: msg.requestId, result: { image: new Uint8Array([1]), layers: [], viewport: { width: 1, height: 1 }, notes: [] } });
        done();
      }, ms)));
    };
    return main;
  }

  it('sends one render at a time, timing each from when it is sent, so five sessions with slow renders all get theirs', async () => {
    vi.useFakeTimers();
    // Each render takes 10 s on the main thread: the fifth would wait 40 s there, past the 30 s timeout, if all went at once.
    const main = slowMain(10_000);
    const bridge = createBridge(main.transport);
    const done: unknown[] = [];
    const renders = [1, 2, 3, 4, 5].map((n) => render(bridge, n).then((r) => done.push(r), (err: unknown) => done.push(err)));
    expect(renderIds(main)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(50_000);
    await Promise.all(renders);
    expect(done).toHaveLength(5);
    expect(done.filter((r) => r instanceof Error)).toEqual([]);
    expect(renderIds(main)).toHaveLength(5);
  });

  it('lets other calls through while a render is under way', async () => {
    const main = fakeMain();
    const bridge = createBridge(main.transport);
    void render(bridge, 1);
    void render(bridge, 2);
    const load = bridge.call('trace-load', { studyId: 's1' });
    expect(main.sent.map((m) => m.type)).toEqual(['trace-render', 'trace-load']);
    main.reply({ type: 'trace-result', requestId: main.sent[1]!.requestId, result: { sessions: [] } });
    await expect(load).resolves.toEqual({ sessions: [] });
  });

  it('sends nothing more after a render that timed out until its answer comes, so a retry never runs beside it', async () => {
    vi.useFakeTimers();
    const main = fakeMain();
    const bridge = createBridge(main.transport);
    const first = render(bridge, 1).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await first).toBeInstanceOf(BridgeTimeout);
    // The session tries again: queued behind the render the main thread is still on.
    const retry = render(bridge, 1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(renderIds(main)).toHaveLength(1);
    // Its late answer reaches no one, and lets the retry go, timed from now.
    main.reply({ type: 'trace-error', requestId: renderIds(main)[0]!, message: 'Export failed' });
    expect(renderIds(main)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(29_999);
    main.reply({ type: 'trace-result', requestId: renderIds(main)[1]!, result: { image: new Uint8Array([1]), layers: [], viewport: { width: 1, height: 1 }, notes: [] } });
    await expect(retry).resolves.toMatchObject({ viewport: { width: 1, height: 1 } });
  });

  it('gives up on a render Figma never answers 2 minutes after it was sent, rejecting the renders queued behind it', async () => {
    vi.useFakeTimers();
    const main = fakeMain();
    const bridge = createBridge(main.transport);
    const first = render(bridge, 1).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await first).toBeInstanceOf(BridgeTimeout);
    const queued = [render(bridge, 1).catch((e: unknown) => e), render(bridge, 2).catch((e: unknown) => e)];
    await vi.advanceTimersByTimeAsync(89_999);
    expect(renderIds(main)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    for (const err of await Promise.all(queued)) {
      expect(err).toBeInstanceOf(RenderStuck);
      expect(err).toMatchObject({ message: "Figma hasn't answered a render for 2 minutes; its main thread may be stuck." });
    }
    // The slot is free: a render after that is sent, and the stuck one's late answer changes nothing.
    const later = render(bridge, 3);
    expect(renderIds(main)).toHaveLength(2);
    main.reply({ type: 'trace-error', requestId: renderIds(main)[0]!, message: 'Export failed' });
    main.reply({ type: 'trace-result', requestId: renderIds(main)[1]!, result: { image: new Uint8Array([1]), layers: [], viewport: { width: 1, height: 1 }, notes: [] } });
    await expect(later).resolves.toMatchObject({ viewport: { width: 1, height: 1 } });
  });

  it('keeps no ceiling on a render that was answered', async () => {
    vi.useFakeTimers();
    const main = fakeMain();
    const bridge = createBridge(main.transport);
    const first = render(bridge, 1);
    main.reply({ type: 'trace-result', requestId: renderIds(main)[0]!, result: { image: new Uint8Array([1]), layers: [], viewport: { width: 1, height: 1 }, notes: [] } });
    await first;
    const second = render(bridge, 2).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(90_000);
    // The second timed out on its own 30 s, and its ceiling counts from when it was sent, not from the first.
    expect(await second).toBeInstanceOf(BridgeTimeout);
    const third = render(bridge, 3).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(renderIds(main)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await third).toBeInstanceOf(RenderStuck);
  });

  it('rejects the queued renders too when it closes', async () => {
    const main = fakeMain();
    const bridge = createBridge(main.transport);
    const sent = render(bridge, 1).catch((e: unknown) => e);
    const queued = render(bridge, 2).catch((e: unknown) => e);
    bridge.close();
    expect(await sent).toBeInstanceOf(BridgeError);
    expect(await queued).toBeInstanceOf(BridgeError);
    expect(renderIds(main)).toHaveLength(1);
  });

  it('frees the slot when a render cannot be sent', async () => {
    let fail = true;
    const sent: TraceRequestMessage[] = [];
    const bridge = createBridge({
      send: (msg) => {
        if (fail) throw new DOMException('could not be cloned', 'DataCloneError');
        sent.push(msg);
      },
      listen: () => () => undefined,
    });
    await expect(render(bridge, 1)).rejects.toMatchObject({ name: 'DataCloneError' });
    fail = false;
    void render(bridge, 2).catch(() => undefined);
    expect(sent).toHaveLength(1);
    bridge.close();
  });
});

describe('panel transport', () => {
  it('sends on the typed channel and passes on only well formed trace replies', () => {
    const sent: UiToMain[] = [];
    const subscribers = new Set<(msg: MainToUi) => void>();
    const transport = panelTransport(
      (msg) => sent.push(msg),
      (handler) => {
        subscribers.add(handler);
        return () => subscribers.delete(handler);
      },
    );
    transport.send({ type: 'trace-load', requestId: 'q1', studyId: 's1' });
    expect(sent).toEqual([{ type: 'trace-load', requestId: 'q1', studyId: 's1' }]);

    const got: TraceReplyMessage[] = [];
    const stop = transport.listen((msg) => got.push(msg));
    const deliver = (msg: unknown) => subscribers.forEach((h) => h(msg as MainToUi));
    deliver({ type: 'doc', doc: {} });
    deliver({ type: 'trace-file-changed', frameIds: ['1:2'] });
    deliver({ type: 'trace-result', result: 1 });
    deliver({ type: 'trace-error', requestId: 'q3' });
    deliver({ type: 'trace-result', requestId: 'q1', result: { sessions: [] } });
    deliver({ type: 'trace-error', requestId: 'q2', message: 'no' });
    expect(got).toEqual([
      { type: 'trace-result', requestId: 'q1', result: { sessions: [] } },
      { type: 'trace-error', requestId: 'q2', message: 'no' },
    ]);
    stop();
    expect(subscribers.size).toBe(0);
  });
});
