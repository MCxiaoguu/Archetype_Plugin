import { afterEach, describe, expect, it, vi } from 'vitest';
import fixtureJson from '../harness/fixtures/farside-proto.json';
import { ApiError, type AbortBody, type TurnBody, type TurnEnded, type TurnView } from '../src/lib/api';
import type { RenderNote, SavedSession, TraceRenderReply } from '../src/lib/messages';
import { listElements } from '../src/lib/proto/elements';
import { apply, start } from '../src/lib/proto/engine';
import { EngineError, type EngineErrorCode } from '../src/lib/proto/errors';
import type { ProtoDoc, TraceAction, TraceState } from '../src/lib/proto/model';
import { readProto } from '../src/main/protoReader';
import { createRenderer } from '../src/main/renderer';
import { BridgeError, type Bridge } from '../src/ui/trace/bridge';
import { NOTICE, runSession, type SessionRun, type SessionStatus } from '../src/ui/trace/session';
import { fakeFromFixture, type FakeNode, type ProtoFixture } from './fake-figma';

// The engine runs for real; a test can make `apply` throw an EngineError the
// engine has no way to raise yet (doc_changed lands with the engine review).
const hooks = vi.hoisted(() => ({ applyError: null as Error | null }));
vi.mock('../src/lib/proto/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/proto/engine')>();
  return {
    ...actual,
    apply: (...args: Parameters<typeof actual.apply>) => {
      if (hooks.applyError) throw hooks.applyError;
      return actual.apply(...args);
    },
  };
});

afterEach(() => {
  hooks.applyError = null;
});

function lastOf<T>(items: readonly T[]): T {
  if (!items.length) throw new Error('Nothing was recorded');
  return items[items.length - 1] as T;
}

// --- The main thread: the Farside prototype, read and rendered for real ------

type Fake = ReturnType<typeof fakeFromFixture>;

async function mainThread(edit: (fake: Fake) => void = () => {}) {
  const fake = fakeFromFixture(structuredClone(fixtureJson) as unknown as ProtoFixture);
  edit(fake);
  const doc = await readProto(fake.api, fake.api.currentPage, { importLibraryVariants: true });
  const renderer = createRenderer(fake.api);
  const saves: Array<SavedSession | null> = [];
  const renders = { failures: 0, notes: null as RenderNote[] | null, change: null as ((r: TraceRenderReply) => TraceRenderReply) | null };
  const call = vi.fn(async (type: string, payload: Record<string, unknown>) => {
      if (type === 'trace-render') {
        if (renders.failures > 0) {
          renders.failures--;
          throw new BridgeError('trace-render', 'The export of the screen came back empty');
        }
        let r = await renderer.render(payload.doc as ProtoDoc, payload.state as TraceState);
        if (renders.notes) r = { ...r, notes: renders.notes };
        return renders.change ? renders.change(r) : r;
      }
      if (type === 'trace-save') {
        saves.push(structuredClone(payload.session) as SavedSession | null);
        return null;
      }
      throw new Error(`The session should not ask for ${type}`);
  });
  // The in-process main thread answers the bridge's calls, whatever their type.
  const bridge = { call: call as unknown as Bridge['call'] };
  return { fake, doc, bridge, saves, renders };
}

// --- The backend: turns answered by a scripted brain --------------------------

type Decision = { action: TraceAction | null; ended?: TurnEnded } | { failed: { code: string; message: string }; ended: TurnEnded };

const STATE = { seq: 1, maxSteps: 22, unproductive: 0, maxUnproductiveSteps: 5, progress: 30, sentimentTrend: 'steady' as const, reviewGiveUp: false, ended: false, endedReason: null };

function backend(brain: (body: TurnBody) => Decision, opts: { thinking?: number; postErrors?: unknown[]; getErrors?: unknown[]; aborts?: unknown[] } = {}) {
  const posted: TurnBody[] = [];
  const aborted: AbortBody[] = [];
  const decisions = new Map<number, Decision>();
  const polls = new Map<number, number>();
  const view = (n: number): TurnView => {
    const d = decisions.get(n) as Decision;
    if ('failed' in d) return { turn: n, status: 'failed', error: d.failed, ended: d.ended };
    return { turn: n, status: 'ready', action: d.action, state: STATE, ended: d.ended ?? null };
  };
  const api = {
    postTurn: vi.fn(async (_runId: string, body: TurnBody, _options?: { timeoutMs?: number }): Promise<TurnView> => {
      const error = opts.postErrors?.shift();
      if (error) throw error;
      posted.push(structuredClone(body));
      if (!decisions.has(body.turn)) decisions.set(body.turn, brain(body));
      return { turn: body.turn, status: 'thinking' };
    }),
    getTurn: vi.fn(async (_runId: string, n: number): Promise<TurnView> => {
      const error = opts.getErrors?.shift();
      if (error) throw error;
      const count = (polls.get(n) ?? 0) + 1;
      polls.set(n, count);
      if (!decisions.has(n) || count <= (opts.thinking ?? 0)) return { turn: n, status: 'thinking' };
      return view(n);
    }),
    abortRun: vi.fn(async (runId: string, body: AbortBody) => {
      const error = opts.aborts?.shift();
      if (error) throw error;
      aborted.push(body);
      return { runId, status: 'aborted' as const, abortReason: body.code };
    }),
  };
  return { api, posted, aborted, decisions };
}

const click = (body: TurnBody, label: string): TraceAction => {
  const element = body.elements.find((e) => e.label === label);
  if (!element) throw new Error(`No "${label}" on ${body.screen.title}: ${body.elements.map((e) => e.label).join(', ')}`);
  return { type: 'click', element: element.id };
};

const DONE: Decision = { action: { type: 'done', claim: 'My bank is connected.' }, ended: { status: 'finalizing', reason: 'done' } };

/** A persona that takes the Farside billing path, with one misclick, to the end. */
function farside(body: TurnBody): Decision {
  switch (body.screen.title) {
    case 'Dashboard':
      return { action: click(body, 'Billing') };
    case 'Billing settings':
      return { action: click(body, 'Connect a bank') };
    case 'Connect bank':
      if (body.last?.outcome === 'nothing_happened') return { action: { type: 'scroll', direction: 'down' } };
      if (body.last?.outcome === 'scrolled') return { action: click(body, 'Continue') };
      return { action: click(body, 'Use routing number instead') };
    case 'Verify phone':
      return { action: click(body, 'Send code') };
    case 'Bank connected':
      return DONE;
    default:
      throw new Error(`The persona got lost on ${body.screen.title}`);
  }
}

// --- Time: a clock that only moves when the session waits --------------------

function clock(late: (ms: number) => number = () => 0) {
  let t = Date.parse('2026-11-10T10:00:00Z');
  const waits: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      waits.push(ms);
      t += ms + late(ms);
    },
    waits,
    at: () => t,
  };
}

async function play(
  brain: (body: TurnBody) => Decision,
  options: {
    thinking?: number;
    postErrors?: unknown[];
    getErrors?: unknown[];
    aborts?: unknown[];
    edit?: (fake: Fake) => void;
    run?: (doc: ProtoDoc) => Partial<SessionRun>;
    late?: (ms: number) => number;
    main?: Awaited<ReturnType<typeof mainThread>>;
    watchFile?: (onChange: (frameIds: string[]) => void) => () => void;
    postTurnTimeoutMs?: number;
  } = {},
) {
  const main = options.main ?? (await mainThread(options.edit));
  const server = backend(brain, options);
  const time = clock(options.late);
  const statuses: SessionStatus[] = [];
  const run: SessionRun = {
    runId: 'r1',
    studyId: 's1',
    owner: 'p_7f3a',
    doc: main.doc,
    shareKey: null,
    startFrameId: '1:2',
    resume: null,
    ...options.run?.(main.doc),
  };
  const result = await runSession(run, {
    bridge: main.bridge,
    api: server.api,
    now: time.now,
    sleep: time.sleep,
    onStatus: (s) => statuses.push(s),
    watchFile: options.watchFile,
    postTurnTimeoutMs: options.postTurnTimeoutMs,
  });
  return { result, statuses, ...server, ...main, time };
}

// --- The loop -------------------------------------------------------------------

describe('one persona session', () => {
  it('plays the Farside path turn by turn and stops where the backend ends the run', async () => {
    const { result, posted, saves, aborted, doc, statuses, api } = await play(farside);
    expect(posted.map((b) => b.screen.title)).toEqual([
      'Dashboard', 'Billing settings', 'Connect bank', 'Connect bank', 'Connect bank', 'Verify phone', 'Bank connected',
    ]);
    expect(posted.map((b) => b.turn)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(result).toEqual({ runId: 'r1', ended: { status: 'finalizing', reason: 'done' }, stop: 'ended', message: null });
    expect(aborted).toEqual([]);

    // Turn 1: the screen, the image, what can be acted on, the visible text.
    const [first] = posted as [TurnBody];
    expect(first).toMatchObject({
      owner: 'p_7f3a',
      turn: 1,
      screen: { url: 'figma-trace://Prototype/1-2?node-id=1-2', title: 'Dashboard', frameId: '1:2', overlays: [], viewport: [1280, 800], scroll: { x: 0, y: 0, maxX: 0, maxY: 0 } },
      last: null,
      flags: [],
      elapsed_s: 0,
      client_ts: '2026-11-10T10:00:00.000Z',
    });
    expect(first.flag_details).toBeUndefined();
    expect(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(first.screenshot_b64), (c) => c.charCodeAt(0))))).toMatchObject({ name: 'Archetype trace (scratch)' });
    expect(first.elements.map((e) => e.label)).toEqual(['Welcome back, Mara', 'Dark mode', 'Billing', 'unlabeled area', "What's new"]);
    expect(first.visible_text_excerpt.split(' · ').sort()).toEqual(["Billing", "Dark mode", "Welcome back, Mara", "What's new"]);

    // What each action did comes with the next turn, as the backend reads it.
    expect(posted[1]!.last).toEqual({ action: { type: 'click', element: 'e3' }, outcome: 'navigated', target: 'Billing (e3)' });
    expect(posted[3]!.last).toEqual({ action: { type: 'click', element: 'e8' }, outcome: 'nothing_happened', target: 'Use routing number instead (e8)' });
    expect(posted[4]!.last).toEqual({ action: { type: 'scroll', direction: 'down' }, outcome: 'scrolled', target: null });
    // The tall frame scrolled: "Continue" was below the fold until then.
    expect(posted[2]!.screen.scroll).toEqual({ x: 0, y: 0, maxX: 0, maxY: 800 });
    expect(posted[4]!.screen.scroll.y).toBeGreaterThan(0);
    expect(posted[4]!.elements.map((e) => e.label)).toContain('Continue');
    expect(posted.every((b) => b.screenshot_b64.length > 0 && Array.isArray(b.flags))).toBe(true);

    // Saved after every applied turn, forgotten when the run ended.
    expect(saves.slice(0, -1).map((s) => s?.turn)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(lastOf(saves)).toBeNull();
    const second = saves[1] as SavedSession;
    expect(second).toMatchObject({ owner: 'p_7f3a', runId: 'r1', turn: 2, lastOutcome: { outcome: 'navigated', target: 'Connect a bank (e2)' } });
    expect(second.state.frameId).toBe('2:20');
    expect(second.state.docHash).toBe(doc.docHash);
    expect(api.postTurn.mock.calls.every((c) => c[2]?.timeoutMs === 60_000)).toBe(true);

    // The Running screen's view of it.
    expect(statuses.map((s) => s.phase)).toContain('thinking');
    expect(lastOf(statuses)).toMatchObject({ phase: 'ended', frameName: 'Bank connected', turn: 7, ended: { status: 'finalizing', reason: 'done' } });
    expect(statuses.some((s) => s.phase === 'acting' && s.frameName === 'Connect bank' && s.turn === 4)).toBe(true);
  });

  it('polls every second, backing off to three', async () => {
    const { time } = await play(() => DONE, { thinking: 6 });
    expect(time.waits).toEqual([1000, 1500, 2250, 3000, 3000, 3000, 3000]);
  });

  it('uses the share link for step URLs when there is one, and a longer post timeout when asked', async () => {
    const { posted, api } = await play(() => DONE, { run: () => ({ shareKey: 'AbCdEf123' }), postTurnTimeoutMs: 180_000 });
    expect(posted[0]!.screen.url).toBe('https://www.figma.com/proto/AbCdEf123/Prototype?node-id=1-2');
    expect(api.postTurn.mock.calls[0]![2]).toEqual({ timeoutMs: 180_000 });
  });

  it('reports a misclick, an unsupported action and its detail with the next turn', async () => {
    const edit = (fake: Fake) => {
      (fake.nodes.get('1:10') as FakeNode).reactions = [
        { trigger: { type: 'ON_CLICK' }, actions: [{ type: 'UPDATE_MEDIA_RUNTIME', destinationId: null, mediaAction: 'PLAY' }] },
      ];
    };
    const { posted } = await play((b) => (b.turn === 1 ? { action: click(b, "What's new") } : DONE), { edit });
    expect(posted[1]!.last).toEqual({
      action: { type: 'click', element: 'e5' },
      outcome: 'unsupported',
      target: "What's new (e5)",
      unsupported: 'UPDATE_MEDIA_RUNTIME',
    });
  });
});

describe('what timers did', () => {
  // A link that opens on its own half a second after the Dashboard shows.
  const autoLink = (fake: Fake) => {
    (fake.nodes.get('1:2') as FakeNode).reactions = [
      { trigger: { type: 'AFTER_TIMEOUT', timeout: 0.5 }, actions: [{ type: 'URL', url: 'https://help.example.com/bank' }] },
    ];
  };
  // Two frames that swap to each other forever.
  const flicker = (fake: Fake) => {
    (fake.nodes.get('1:2') as FakeNode).reactions = [{ trigger: { type: 'AFTER_TIMEOUT', timeout: 0.1 }, actions: [{ type: 'NODE', destinationId: '4:1', navigation: 'SWAP', transition: null }] }];
    (fake.nodes.get('4:1') as FakeNode).reactions = [{ trigger: { type: 'AFTER_TIMEOUT', timeout: 0.1 }, actions: [{ type: 'NODE', destinationId: '1:2', navigation: 'SWAP', transition: null }] }];
  };

  it('carries the effects of timers to the next turn\'s last, including the first turn\'s', async () => {
    const { posted } = await play((b) => (b.turn === 1 ? { action: click(b, 'Billing') } : DONE), { edit: autoLink });
    expect(posted[0]!.last).toBeNull();
    expect(posted[1]!.last).toMatchObject({ outcome: 'navigated', timer_effects: [{ type: 'left_prototype', detail: 'https://help.example.com/bank' }] });
  });

  it('flags a timer loop with its frames on the turn it settled into', async () => {
    const { posted } = await play(() => DONE, { edit: flicker });
    expect(posted[0]!.flags).toEqual(['timer_loop']);
    expect(posted[0]!.flag_details).toEqual({ timer_loop: { frames: expect.arrayContaining(['1:2', '4:1']) } });
  });

  it('reports what a wait fired as timer effects', async () => {
    const waitLink = (fake: Fake) => {
      (fake.nodes.get('1:2') as FakeNode).reactions = [{ trigger: { type: 'AFTER_TIMEOUT', timeout: 5 }, actions: [{ type: 'URL', url: 'https://help.example.com/late' }] }];
    };
    const { posted } = await play((b) => (b.turn === 1 ? { action: { type: 'wait', seconds: 6 } } : DONE), { edit: waitLink });
    expect(posted[1]!.last?.timer_effects).toEqual([{ type: 'left_prototype', detail: 'https://help.example.com/late' }]);
  });
});

describe('flags', () => {
  it('flags a missing font from the render, with the fonts, and tells the designer', async () => {
    const main = await mainThread();
    main.renders.notes = [{ missing_font: ['Inter Display', 'Inter Display'] }];
    const { posted, statuses } = await play(() => DONE, { main });
    expect(posted[0]!.flags).toEqual(['missing_font']);
    expect(posted[0]!.flag_details).toEqual({ missing_font: { fonts: ['Inter Display'] } });
    expect(lastOf(statuses).notices.some((n) => n.includes('Inter Display'))).toBe(true);
  });

  it('flags every turn after the main thread says the file changed', async () => {
    let tell: (ids: string[]) => void = () => {};
    const unwatch = vi.fn();
    const watchFile = (onChange: (ids: string[]) => void) => {
      tell = onChange;
      return unwatch;
    };
    const brain = (b: TurnBody): Decision => {
      if (b.turn === 2) tell(['2:10']);
      return b.turn < 3 ? { action: click(b, b.turn === 1 ? 'Billing' : 'Connect a bank') } : DONE;
    };
    const { posted, statuses } = await play(brain, { watchFile });
    expect(posted.map((b) => b.flags)).toEqual([[], [], ['file_changed']]);
    expect(lastOf(statuses).notices).toContain(NOTICE.fileChanged);
    expect(unwatch).toHaveBeenCalled();
  });
});

describe('resuming a run this panel owns', () => {
  async function saved(main: Awaited<ReturnType<typeof mainThread>>, change: Partial<TraceState> = {}): Promise<SavedSession> {
    return {
      owner: 'p_7f3a',
      runId: 'r1',
      turn: 4,
      state: { ...start(main.doc, '2:10'), ...change },
      lastOutcome: { action: { type: 'click', element: 'e1' }, outcome: 'nothing_happened', target: 'Back (e1)' },
    };
  }

  it('posts the next turn with the saved outcome', async () => {
    const main = await mainThread();
    const resume = await saved(main);
    const { posted } = await play(() => DONE, { main, run: () => ({ resume }) });
    expect(posted[0]).toMatchObject({ turn: 5, screen: { title: 'Billing settings' }, last: resume.lastOutcome, flags: [] });
  });

  it('flags a file that changed since, and goes on in it as it is now', async () => {
    const main = await mainThread();
    const resume = await saved(main, { docHash: 'an older hash' });
    const { posted, statuses, aborted } = await play(() => DONE, { main, run: () => ({ resume }) });
    expect(posted[0]!.flags).toEqual(['file_changed']);
    expect(lastOf(statuses).notices).toContain(NOTICE.fileChanged);
    expect(aborted).toEqual([]);
  });

  it('aborts with file_changed when the frame it was on is gone', async () => {
    const main = await mainThread();
    const resume = await saved(main, { frameId: '9:99' });
    const { result, aborted, posted, saves } = await play(() => DONE, { main, run: () => ({ resume }) });
    expect(aborted).toEqual([{ owner: 'p_7f3a', code: 'file_changed', detail: expect.stringContaining('9:99') }]);
    expect(result).toMatchObject({ stop: 'aborted', ended: { status: 'aborted', reason: 'file_changed' } });
    expect(posted).toEqual([]);
    expect(saves).toEqual([null]);
  });
});

// --- Recovery -------------------------------------------------------------------

const offline = () => new ApiError(0, 'network', 'Could not reach Archetype.');

describe('when things go wrong', () => {
  it('retries a render once, and aborts with render_failed when it fails twice', async () => {
    const once = await mainThread();
    once.renders.failures = 1;
    const ok = await play(() => DONE, { main: once });
    expect(ok.aborted).toEqual([]);
    expect(ok.posted).toHaveLength(1);

    const twice = await mainThread();
    twice.renders.failures = 2;
    const failed = await play(() => DONE, { main: twice });
    expect(failed.aborted).toEqual([{ owner: 'p_7f3a', code: 'render_failed', detail: 'The export of the screen came back empty' }]);
    expect(failed.result).toMatchObject({ stop: 'aborted', ended: { status: 'aborted', reason: 'render_failed' } });
    expect(failed.posted).toEqual([]);
    expect(failed.saves).toEqual([null]);
  });

  it('aborts with turn_timeout after 180 s of thinking', async () => {
    const { aborted, result, time } = await play(() => DONE, { thinking: Infinity });
    expect(aborted).toMatchObject([{ code: 'turn_timeout' }]);
    expect(result.stop).toBe('aborted');
    expect(time.waits.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(180_000);
    expect(time.waits.reduce((a, b) => a + b, 0)).toBeLessThan(184_000);
  });

  it('never aborts once the backend set ended, and stops on a failed turn', async () => {
    const ending = await play(() => ({ action: null, ended: { status: 'abandoned', reason: 'patience_exhausted_twice' } }));
    expect(ending.result).toEqual({ runId: 'r1', ended: { status: 'abandoned', reason: 'patience_exhausted_twice' }, stop: 'ended', message: null });
    expect(ending.aborted).toEqual([]);
    expect(ending.saves).toEqual([null]);

    const failed = await play(() => ({ failed: { code: 'brain_invalid_action', message: 'action.element must be one of e1, e2' }, ended: { status: 'aborted', reason: 'brain_invalid_action' } }));
    expect(failed.result).toEqual({ runId: 'r1', ended: { status: 'aborted', reason: 'brain_invalid_action' }, stop: 'ended', message: 'action.element must be one of e1, e2' });
    expect(failed.aborted).toEqual([]);
  });

  it('stops without aborting when another panel owns the run or it already ended', async () => {
    for (const code of ['not_owner', 'run_ended'] as const) {
      const r = await play(() => DONE, { postErrors: [new ApiError(409, code, `run r1: ${code}`)] });
      expect(r.result).toEqual({ runId: 'r1', ended: null, stop: code, message: `run r1: ${code}` });
      expect(r.aborted).toEqual([]);
      expect(r.saves).toEqual([null]);
    }
  });

  it('catches up with turns the backend already holds after turn_out_of_order', async () => {
    // The panel reopened on turn 1's save, but turn 2 is decided and turn 3 posted.
    const main = await mainThread();
    const dash = start(main.doc, '1:2');
    const shown = await main.bridge.call('trace-render', { doc: main.doc, state: dash });
    const listed = listElements(shown.layers, dash);
    const billing = listed.elements.find((e) => e.label === 'Billing')!;
    const after1 = apply(main.doc, dash, { type: 'click', element: billing.id }, shown.layers, listed.targets).state;
    const resume: SavedSession = { owner: 'p_7f3a', runId: 'r1', turn: 1, state: after1, lastOutcome: { action: { type: 'click', element: billing.id }, outcome: 'navigated', target: `Billing (${billing.id})` } };

    const server = backend((b) => (b.turn === 3 ? DONE : { action: null }));
    server.decisions.set(2, { action: { type: 'click', element: 'e2' } }); // "Connect a bank", decided before the panel closed
    server.api.postTurn.mockImplementationOnce(async () => {
      throw new ApiError(409, 'turn_out_of_order', 'turn 2 is out of order: this run takes turn 3 next.', { expected: 3 });
    });
    const time = clock();
    const result = await runSession(
      { runId: 'r1', studyId: 's1', owner: 'p_7f3a', doc: main.doc, shareKey: null, startFrameId: '1:2', resume },
      { bridge: main.bridge, api: server.api, now: time.now, sleep: time.sleep, onStatus: () => {} },
    );
    expect(result.stop).toBe('ended');
    // Turn 2 was read, not posted again; turn 3 was posted on the screen turn 2's action led to.
    expect(server.api.getTurn.mock.calls.map((c) => c[1])).toEqual([2, 3]);
    expect(server.posted.map((b) => [b.turn, b.screen.title, b.last?.target])).toEqual([[3, 'Connect bank', 'Connect a bank (e2)']]);
    expect(server.aborted).toEqual([]);
  });

  it('aborts with panel_state_lost when the backend expects a turn this panel already passed', async () => {
    const r = await play(() => DONE, { postErrors: [new ApiError(409, 'turn_out_of_order', 'out of order', { expected: 0 })] });
    expect(r.aborted).toMatchObject([{ code: 'panel_state_lost' }]);
  });

  it('pauses through network loss and a sign in outage, retrying with backoff, and never aborts for them', async () => {
    const auth = new ApiError(503, 'auth_unavailable', 'Archetype cannot check sign ins right now. You are still signed in; try again in a minute.');
    const getErrors = [offline(), offline(), auth, offline(), offline(), offline(), offline(), offline(), offline(), offline()];
    // The persona goes on thinking after the outage, so a pause counted as thinking would time it out.
    const { result, aborted, statuses, time } = await play(() => DONE, { getErrors, thinking: 3 });
    expect(result.stop).toBe('ended');
    expect(aborted).toEqual([]);
    // The first poll, the retries backing off to 30 s (210 s paused, none of it counted
    // as thinking: 180 s of that would be turn_timeout), then the polls going on.
    expect(time.waits).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, 30000, 1500, 2250, 3000]);
    expect(statuses.some((s) => s.phase === 'paused')).toBe(true);
    const notices = lastOf(statuses).notices ?? [];
    expect(notices).toContain(NOTICE.offline);
    expect(notices).toContain(auth.message);
  });

  it('pauses on a signed out panel and goes on once signed in again', async () => {
    const { result, statuses } = await play(() => DONE, { postErrors: [new ApiError(401, 'signed_out', 'Sign in to Archetype first.')] });
    expect(result.stop).toBe('ended');
    expect(lastOf(statuses).notices).toContain(NOTICE.signIn);
  });

  it('aborts with brain_invalid_action when the decision names an element that is not on the screen', async () => {
    const { aborted, result } = await play(() => ({ action: { type: 'click', element: 'e99' } }));
    expect(aborted).toMatchObject([{ code: 'brain_invalid_action', detail: expect.stringContaining('e99') }]);
    expect(result.ended).toEqual({ status: 'aborted', reason: 'brain_invalid_action' });
  });

  it.each([
    ['doc_changed', 'file_changed'],
    ['invalid_doc', 'engine_error'],
    ['invalid_layers', 'engine_error'],
  ])('aborts an EngineError %s with %s', async (code, abortCode) => {
    hooks.applyError = new EngineError(code as EngineErrorCode, `engine says ${code}`);
    const { aborted } = await play((b) => (b.turn === 1 ? { action: click(b, 'Billing') } : DONE));
    expect(aborted).toEqual([{ owner: 'p_7f3a', code: abortCode, detail: expect.stringContaining(`engine says ${code}`) }]);
  });

  it('aborts with engine_error when the measured layers are inconsistent', async () => {
    const main = await mainThread();
    main.renders.change = (r) => ({ ...r, layers: [...r.layers, { ...r.layers[1]! }] });
    const { aborted, posted } = await play(() => DONE, { main });
    expect(aborted).toMatchObject([{ code: 'engine_error' }]);
    expect(posted).toEqual([]);
  });

  it('asks the designer to keep the tab visible, once, when timers fire late', async () => {
    const { statuses, result } = await play((b) => (b.turn < 3 ? { action: click(b, b.turn === 1 ? 'Billing' : 'Connect a bank') } : DONE), { late: () => 11_000 });
    expect(result.stop).toBe('ended');
    const last = lastOf(statuses);
    expect(last.notices.filter((n) => n === NOTICE.hiddenTab)).toHaveLength(1);
  });
});
