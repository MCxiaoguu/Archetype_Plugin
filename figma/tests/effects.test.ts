import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InitPayload, StudyRecord, TraceRecord, UiToMain } from '../src/lib/messages';
import { DEFAULT_SETTINGS } from '../src/lib/messages';
import { indexFrames } from '../src/lib/frames';
import { start } from '../src/lib/proto/engine';
import type { LibraryVariant } from '../src/lib/proto/model';
import { personaRows } from '../src/lib/runs';
import { fixtureDoc, fixtureReport, protoAt } from './helpers';
import { mainThread, type MainThread } from './trace-fakes';

const sent: UiToMain[] = [];
vi.mock('../src/ui/bridge', () => ({ toMain: (m: UiToMain) => sent.push(m), onMain: () => () => undefined }));

const { createEffects } = await import('../src/ui/effects');
const { createStore } = await import('../src/ui/store');

type Route = (method: string, path: string, body: unknown, auth: string | null) => [number, unknown];

/**
 * Each study's flow map, as the backend keeps it: a commit stores version 1
 * at once (its candidates every one a gap) and answers it again after.
 */
function flowMaps(): Route {
  const maps = new Map<string, Record<string, unknown>>();
  return (method, path, body) => {
    const m = /^\/api\/studies\/([^/]+)\/flow-map$/.exec(path);
    if (!m) return [0, null];
    const held = maps.get(m[1] as string);
    if (method === 'GET') return held ? [200, { map: held }] : [404, { error: 'flow_map_not_found', message: 'No flow map yet.' }];
    const commit = body as { docHash: string };
    const map = held ?? { studyId: m[1], version: 1, baseVersion: null, inputHash: 'h', docHash: commit.docHash, nodes: [], edges: [], readings: [], dropped: [], completedAt: '2026-11-10T10:00:00Z', model: null, buildId: null };
    maps.set(m[1] as string, map);
    return [200, { status: 'ready', map }];
  };
}

/** `maps`: the study's flow map answers as `flowMaps` gives them; false leaves them to `route`. */
function installFetch(route: Route, { maps: withMaps = true }: { maps?: boolean } = {}) {
  const calls: string[] = [];
  const maps = withMaps ? flowMaps() : (): [number, unknown] => [0, null];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    const method = init.method ?? 'GET';
    calls.push(`${method} ${path}`);
    const headers = (init.headers ?? {}) as Record<string, string>;
    const parsed = init.body ? JSON.parse(String(init.body)) : null;
    const mapped = maps(method, path, parsed, headers.Authorization ?? null);
    const [status, body] = mapped[0] ? mapped : route(method, path, parsed, headers.Authorization ?? null);
    return new Response(JSON.stringify(body), { status });
  });
  return calls;
}

/** The panel over a main thread that reads and renders the Farside prototype. */
function initStore(token: string | null, main?: MainThread, over: Partial<InitPayload> = {}) {
  const store = createStore();
  const fx = createEffects(store, main ? { bridge: main.bridge } : {});
  fx.handleMain({
    type: 'init',
    settings: { ...DEFAULT_SETTINGS, apiBase: 'http://backend.test' },
    token,
    fileKey: null,
    doc: fixtureDoc(),
    selection: null,
    studies: [],
    lastStudyId: null,
    draft: null,
    pluginVersion: '9.9.9',
    ...over,
  });
  return { store, fx };
}

const KEY = 'AbCdEfGh1234567890XyZ';

function fillForm(store: ReturnType<typeof createStore>, link = `https://www.figma.com/design/${KEY}/Farside`) {
  store.dispatch({ type: 'pick', role: 'goal', nodeId: '2:50' });
  store.dispatch({ type: 'field', field: 'goal', value: 'Connect a bank account' });
  store.dispatch({ type: 'field', field: 'who', value: 'Founders who do their own books' });
  store.dispatch({ type: 'field', field: 'link', value: link });
}

const savedStudies = () => sent.filter((m): m is Extract<UiToMain, { type: 'save-study' }> => m.type === 'save-study').map((m) => m.record);

const TURN_STATE = { seq: 1, maxSteps: 22, unproductive: 0, maxUnproductiveSteps: 5, progress: 30, sentimentTrend: 'steady', reviewGiveUp: false, ended: false, endedReason: null };
const BRIEFING = { sessionId: 'sess', claimedAt: '2026-11-10T10:00:00Z', brief: '', persona: { name: 'Baseline founder' }, instructions: { targetUrl: '', goal: '' }, flowMapVersion: 1 };

/** Fake time that runs the panel's waits (polls, retries) at once, until `cond` holds. */
async function runUntil(cond: () => boolean, limitMs = 120_000, stepMs = 250) {
  for (let t = 0; !cond(); t += stepMs) {
    if (t > limitMs) throw new Error('timed out');
    await vi.advanceTimersByTimeAsync(stepMs);
  }
}

const TRACE: TraceRecord = { owner: 'p_0123456789abcdef01234567', pageId: '0:1', pageName: 'Prototype', startFrameId: '1:2', shareKey: null, importLibraryVariants: false };
const traceStudy = (studyId: string, status: string, trace: TraceRecord = TRACE): StudyRecord => ({
  studyId,
  title: 't',
  startName: 'Dashboard',
  goalName: 'Bank connected',
  size: 'quick',
  launchedAt: 0,
  status,
  trace,
});
const traceCalls = (main: MainThread) => main.call.mock.calls.map(([type]) => type as string);

const lastOf = <T,>(items: readonly T[]): T => items[items.length - 1] as T;

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

beforeEach(() => {
  sent.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('panel effects', () => {
  it('launches a plugin-mode study, runs its personas in the panel, and lands on the report', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const main = await mainThread();
    let status = 'draft';
    let created: Record<string, unknown> | null = null;
    const run = { runId: 'r1', archetypeId: 'a', archetypeName: 'Baseline founder', role: 'baseline', status: 'queued' };
    const claims: unknown[] = [];
    const turns: Array<Record<string, any>> = [];
    const calls = installFetch((method, path, body) => {
      if (method === 'POST' && path === '/api/studies') {
        created = body as Record<string, unknown>;
        return [201, { studyId: 's1', title: 'Connect a bank', status: 'draft' }];
      }
      if (path === '/api/studies/s1/status') return [200, { studyId: 's1', status }];
      if (path === '/api/studies/s1/factors') return (status = 'factors_ready'), [200, {}];
      if (path === '/api/studies/s1/archetypes') return (status = 'archetypes_ready'), [200, {}];
      if (method === 'POST' && path === '/api/studies/s1/runs') return (status = 'running'), [201, {}];
      if (path === '/api/studies/s1/runs') return [200, { studyId: 's1', status, runs: [run] }];
      if (path === '/api/plugin/runs/r1/claim') {
        claims.push(body);
        run.status = 'running';
        return [200, { runId: 'r1', ...BRIEFING }];
      }
      if (method === 'POST' && path === '/api/plugin/runs/r1/turn') {
        turns.push(body as Record<string, any>);
        return [202, { turn: (body as { turn: number }).turn, status: 'thinking' }];
      }
      if (path === '/api/plugin/runs/r1/turn/1') {
        run.status = 'completed';
        return [200, { turn: 1, status: 'ready', action: { type: 'done', claim: 'I connected my bank.' }, state: TURN_STATE, ended: { status: 'completed', reason: 'done' } }];
      }
      if (path === '/api/studies/s1/runs/next') return (status = 'complete'), [200, { studyId: 's1', done: true, reason: 'every wave ran', wave: 1 }];
      if (path === '/api/studies/s1/report') return [200, fixtureReport()];
      return [404, { error: 'x', message: path }];
    });
    const { store, fx } = initStore('tok', main);
    fillForm(store);

    await fx.launch();
    await runUntil(() => store.get().screen === 'report');
    vi.useRealTimers();

    expect(created).toMatchObject({
      source: 'figma',
      execution: 'plugin',
      task: { url: expect.stringContaining(KEY) },
      figma: { fileKey: KEY, targetNodeId: '2:50', pluginVersion: '9.9.9', fileName: 'Farside billing', pageName: 'Prototype' },
    });
    // The study remembers who runs it here and on what.
    const record = savedStudies()[0] as StudyRecord;
    expect(record).toMatchObject({ studyId: 's1', startName: 'Dashboard', goalName: 'Bank connected' });
    expect(record.trace).toEqual({ owner: expect.stringMatching(/^p_[0-9a-f]{24}$/), pageId: '0:1', pageName: 'Prototype', startFrameId: '1:2', shareKey: KEY, importLibraryVariants: false });
    // The gate's read, then the runner's, as the file is when the study runs; the gate already checked edit access.
    expect(main.gate.reads).toEqual([false, false]);
    expect(traceCalls(main).filter((t) => t === 'trace-scratch-check')).toHaveLength(1);
    // The panel claims the run under that owner and runs it.
    // On the flow map version the panel committed just before.
    expect(claims).toEqual([{ owner: record.trace?.owner, browser: { engine: 'figma-trace', version: '9.9.9', viewport: [1280, 800] }, flowMapVersion: 1 }]);
    expect(turns.map((t) => [t.turn, t.owner, t.screen.title])).toEqual([[1, record.trace?.owner, 'Dashboard']]);
    expect(turns[0]?.screen.url).toContain(`https://www.figma.com/proto/${KEY}/`);
    // The Running screen read the persona's screen and step from the session, polling nothing new for it.
    expect(store.get().study?.live.r1).toMatchObject({ phase: 'ended', frameName: 'Dashboard', turn: 1 });
    // Besides the reads of the study's flow map: the runner's, to commit on it, and the Flow map card's.
    expect(calls.filter((c) => c.startsWith('GET ') && !/\/(status|runs|report|turn\/\d+)$/.test(c))).toEqual(['GET /api/studies/s1/flow-map', 'GET /api/studies/s1/flow-map']);
    // The card has the map the runner committed, and the screen the persona saw.
    expect(store.get().study?.flow.map).toMatchObject({ version: 1 });
    expect(Object.keys(store.get().study?.flow.shots ?? {})).toEqual(['1:2']);
    expect(store.get().study?.live.r1).toMatchObject({ node: '1:2', ended: { status: 'completed', reason: 'done' } });
    expect(main.log).toContain('cleanup');
    expect(sent.map((m) => m.type)).toContain('save-draft');
    expect(lastOf(savedStudies()).outcome).toBe('6 of 15 reached the goal');
  });

  it('reads the prototype again to run the study, and flags its sessions when the file changed after that read', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const main = await mainThread();
    let status = 'draft';
    const run = { runId: 'r1', archetypeId: 'a', archetypeName: 'Baseline founder', role: 'baseline', status: 'queued' };
    const turns: Array<Record<string, any>> = [];
    installFetch((method, path, body) => {
      if (method === 'POST' && path === '/api/studies') return [201, { studyId: 's7', title: 'Connect a bank', status: 'draft' }];
      if (path === '/api/studies/s7/status') return [200, { studyId: 's7', status }];
      if (path === '/api/studies/s7/factors') return (status = 'factors_ready'), [200, {}];
      if (path === '/api/studies/s7/archetypes') return (status = 'archetypes_ready'), [200, {}];
      if (method === 'POST' && path === '/api/studies/s7/runs') return (status = 'running'), [201, {}];
      if (path === '/api/studies/s7/runs') return [200, { studyId: 's7', status, runs: [run] }];
      if (path === '/api/plugin/runs/r1/claim') return (run.status = 'running'), [200, { runId: 'r1', ...BRIEFING }];
      if (method === 'POST' && path === '/api/plugin/runs/r1/turn') {
        turns.push(body as Record<string, any>);
        return [202, { turn: (body as { turn: number }).turn, status: 'thinking' }];
      }
      if (path === '/api/plugin/runs/r1/turn/1') {
        run.status = 'completed';
        return [200, { turn: 1, status: 'ready', action: { type: 'done', claim: 'Done.' }, state: TURN_STATE, ended: { status: 'completed', reason: 'done' } }];
      }
      if (path === '/api/studies/s7/runs/next') return (status = 'complete'), [200, { studyId: 's7', done: true, reason: 'every wave ran', wave: 1 }];
      if (path === '/api/studies/s7/report') return [200, fixtureReport()];
      return [404, { error: 'x', message: path }];
    });
    const { store, fx } = initStore('tok', main);
    // The designer edits the start screen while the runner's read is under way, before any session listens.
    main.gate.readAs = () => {
      if (main.gate.reads.length === 2) fx.handleMain({ type: 'trace-file-changed', frameIds: ['1:2'] });
      return structuredClone(main.doc);
    };
    fillForm(store);
    await fx.launch();
    await runUntil(() => store.get().screen === 'report');
    vi.useRealTimers();
    // One read for the launch gate, one for the runner.
    expect(main.gate.reads).toEqual([false, false]);
    expect(turns.map((t) => t.flags)).toEqual([['file_changed']]);
  });

  it('keeps one runner per study through a sign in or a retry while it runs', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const main = await mainThread();
    const trace: TraceRecord = { owner: 'p_0123456789abcdef01234567', pageId: '0:1', pageName: 'Prototype', startFrameId: '1:2', shareKey: null, importLibraryVariants: false };
    const run = { runId: 'r1', archetypeId: 'a', archetypeName: 'Baseline founder', role: 'baseline', status: 'queued' };
    let decided = false;
    let status = 'running';
    const calls = installFetch((method, path, body) => {
      if (path === '/api/studies/s6/status') return [200, { studyId: 's6', status }];
      if (path === '/api/studies/s6/runs') return [200, { studyId: 's6', status, runs: [run] }];
      if (path === '/api/plugin/runs/r1/claim') return (run.status = 'running'), [200, { runId: 'r1', ...BRIEFING }];
      if (method === 'POST' && path === '/api/plugin/runs/r1/turn') return [202, { turn: (body as { turn: number }).turn, status: 'thinking' }];
      if (path === '/api/plugin/runs/r1/turn/1') {
        if (!decided) return [200, { turn: 1, status: 'thinking' }];
        run.status = 'completed';
        return [200, { turn: 1, status: 'ready', action: { type: 'done', claim: 'Done.' }, state: TURN_STATE, ended: { status: 'completed', reason: 'done' } }];
      }
      if (path === '/api/studies/s6/runs/next') return (status = 'complete'), [200, { studyId: 's6', done: true, reason: 'every wave ran', wave: 1 }];
      if (path === '/api/studies/s6/report') return [200, fixtureReport()];
      return [404, { error: 'x', message: path }];
    });
    const record: StudyRecord = { studyId: 's6', title: 't', startName: 'Dashboard', goalName: 'Bank connected', size: 'quick', launchedAt: 0, status: 'running', trace };
    const { store, fx } = initStore('tok', main, { studies: [record], lastStudyId: 's6' });
    await runUntil(() => calls.includes('POST /api/plugin/runs/r1/turn'));
    fx.acceptToken('fresh');
    await fx.retry();
    await vi.advanceTimersByTimeAsync(10_000);
    decided = true;
    await runUntil(() => store.get().screen === 'report');
    vi.useRealTimers();
    expect(calls.filter((c) => c === 'POST /api/plugin/runs/r1/claim')).toHaveLength(1);
    expect(calls.filter((c) => c === 'POST /api/plugin/runs/r1/turn')).toHaveLength(1);
    expect(main.call.mock.calls.filter(([type]) => type === 'trace-load')).toHaveLength(1);
  });

  it('stops the sessions when the panel closes, without aborting or forgetting their runs', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const main = await mainThread();
    const trace: TraceRecord = { owner: 'p_0123456789abcdef01234567', pageId: '0:1', pageName: 'Prototype', startFrameId: '1:2', shareKey: null, importLibraryVariants: false };
    const run = { runId: 'r1', archetypeId: 'a', archetypeName: 'Baseline founder', role: 'baseline', status: 'queued' };
    const calls = installFetch((method, path, body) => {
      if (path === '/api/studies/s7/status') return [200, { studyId: 's7', status: 'running' }];
      if (path === '/api/studies/s7/runs') return [200, { studyId: 's7', status: 'running', runs: [run] }];
      if (path === '/api/plugin/runs/r1/claim') return (run.status = 'running'), [200, { runId: 'r1', ...BRIEFING }];
      if (method === 'POST' && path === '/api/plugin/runs/r1/turn') return [202, { turn: (body as { turn: number }).turn, status: 'thinking' }];
      if (path === '/api/plugin/runs/r1/turn/1') return [200, { turn: 1, status: 'thinking' }];
      return [404, { error: 'x', message: path }];
    });
    const record: StudyRecord = { studyId: 's7', title: 't', startName: 'Dashboard', goalName: 'Bank connected', size: 'quick', launchedAt: 0, status: 'running', trace };
    const { fx } = initStore('tok', main, { studies: [record], lastStudyId: 's7' });
    await runUntil(() => calls.includes('GET /api/plugin/runs/r1/turn/1'));
    fx.closePanel();
    await vi.advanceTimersByTimeAsync(600_000);
    vi.useRealTimers();
    expect(main.bridge.close).toHaveBeenCalled();
    expect(calls).not.toContain('POST /api/plugin/runs/r1/abort');
    expect(main.saves).not.toContain(null);
    // Nothing more goes out once the panel closed.
    const after = calls.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(after);
  });

  it('only shows a finished plugin-mode study: it reads nothing, imports nothing and asks for no next wave', async () => {
    const main = await mainThread();
    const calls = installFetch((_m, path) => {
      if (path === '/api/studies/s8/status') return [200, { studyId: 's8', status: 'complete' }];
      if (path === '/api/studies/s8/runs') return [200, { studyId: 's8', status: 'complete', runs: [] }];
      if (path === '/api/studies/s8/report') return [200, fixtureReport()];
      return [404, { error: 'x', message: path }];
    });
    const { store } = initStore('tok', main, { studies: [traceStudy('s8', 'complete')], lastStudyId: 's8' });
    await until(() => store.get().screen === 'report');
    await new Promise((r) => setTimeout(r, 20));
    expect(traceCalls(main)).toEqual([]);
    expect(calls.filter((c) => c.startsWith('POST '))).toEqual([]);
    expect(store.get().study?.runner).toBeNull();
  });

  it('says when the next round does not start, and Try again runs the study on', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const main = await mainThread();
    const run = { runId: 'r1', archetypeId: 'a', archetypeName: 'Baseline founder', role: 'baseline', status: 'queued' };
    let open = true;
    let status = 'running';
    const calls = installFetch((method, path, body) => {
      if (path === '/api/studies/s9/status') return [200, { studyId: 's9', status }];
      if (path === '/api/studies/s9/runs') return [200, { studyId: 's9', status, runs: [run] }];
      if (path === '/api/plugin/runs/r1/claim') return (run.status = 'running'), [200, { runId: 'r1', ...BRIEFING }];
      if (method === 'POST' && path === '/api/plugin/runs/r1/turn') return [202, { turn: (body as { turn: number }).turn, status: 'thinking' }];
      if (path === '/api/plugin/runs/r1/turn/1') {
        run.status = 'completed';
        return [200, { turn: 1, status: 'ready', action: { type: 'done', claim: 'Done.' }, state: TURN_STATE, ended: { status: 'completed', reason: 'done' } }];
      }
      if (path === '/api/studies/s9/runs/next') {
        if (open) return [409, { error: 'wave_in_progress', message: 'wave 1 still has open runs' }];
        return (status = 'complete'), [200, { studyId: 's9', done: true, reason: 'every wave ran', wave: 1 }];
      }
      if (path === '/api/studies/s9/report') return [200, fixtureReport()];
      return [404, { error: 'x', message: path }];
    });
    const { store, fx } = initStore('tok', main, { studies: [traceStudy('s9', 'running')], lastStudyId: 's9' });
    await runUntil(() => !!store.get().study?.error, 600_000, 5_000);
    expect(store.get().study).toMatchObject({ error: expect.stringMatching(/hasn't started the next round.*Try again/), runner: { phase: 'stuck' } });

    open = false;
    await fx.retry();
    await runUntil(() => store.get().screen === 'report', 600_000, 1_000);
    vi.useRealTimers();
    expect(traceCalls(main).filter((t) => t === 'trace-load')).toHaveLength(2);
    expect(calls.filter((c) => c === 'POST /api/plugin/runs/r1/claim')).toHaveLength(1);
  });

  it('follows a persona on the canvas, once per node it reaches, until the designer stops', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const main = await mainThread();
    const run = { runId: 'r1', archetypeId: 'a', archetypeName: 'Baseline founder', role: 'baseline', status: 'queued' };
    let status = 'running';
    let decide = false;
    installFetch((method, path, body) => {
      if (path === '/api/studies/s12/status') return [200, { studyId: 's12', status }];
      if (path === '/api/studies/s12/runs') return [200, { studyId: 's12', status, runs: [run] }];
      if (path === '/api/plugin/runs/r1/claim') return (run.status = 'running'), [200, { runId: 'r1', ...BRIEFING }];
      if (method === 'POST' && path === '/api/plugin/runs/r1/turn') return [202, { turn: (body as { turn: number }).turn, status: 'thinking' }];
      if (path === '/api/plugin/runs/r1/turn/1') {
        if (!decide) return [200, { turn: 1, status: 'thinking' }];
        return [200, { turn: 1, status: 'ready', action: { type: 'click', element: 'e3' }, state: TURN_STATE, ended: null }];
      }
      if (path === '/api/plugin/runs/r1/turn/2') {
        run.status = 'completed';
        return [200, { turn: 2, status: 'ready', action: { type: 'done', claim: 'Done.' }, state: TURN_STATE, ended: { status: 'completed', reason: 'done' } }];
      }
      if (path === '/api/studies/s12/runs/next') return (status = 'complete'), [200, { studyId: 's12', done: true, reason: 'every wave ran', wave: 1 }];
      if (path === '/api/studies/s12/report') return [200, fixtureReport()];
      return [404, { error: 'x', message: path }];
    });
    const { store, fx } = initStore('tok', main, { studies: [traceStudy('s12', 'running')], lastStudyId: 's12' });
    await runUntil(() => store.get().study?.live.r1?.phase === 'thinking', 60_000, 250);
    fx.followPersona('r1');
    expect(store.get().study?.flow.following).toBe('r1');
    decide = true;
    await runUntil(() => store.get().screen === 'report', 600_000, 1_000);
    vi.useRealTimers();
    // The Dashboard when following began, then Billing settings after the click: viewport moves only.
    expect(main.log.filter((l) => l.startsWith('follow'))).toEqual(['follow 1:2', 'follow 2:10']);
    expect(store.get().study?.flow.followNote).toBeNull();

    fx.followPersona(null);
    expect(store.get().study?.flow.following).toBeNull();
    fx.clearPaths();
    expect(store.get().study?.flow).toMatchObject({ cleared: true, following: null });
  });

  it("says when the flow map couldn't be completed, tries again, and launches with drawn connections only when asked", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const main = await mainThread();
    const run = { runId: 'r1', archetypeId: 'a', archetypeName: 'Baseline founder', role: 'baseline', status: 'queued' };
    let status = 'running';
    const failed = { status: 'failed', buildId: 'b1', error: 'flow_map_unavailable', node: '2:20', nodeName: 'Connect bank', reason: 'k2 has no reading', message: "Couldn't read the flow of 'Connect bank': k2 has no reading." };
    const commits: Array<Record<string, unknown>> = [];
    const claims: Array<Record<string, unknown>> = [];
    let held: Record<string, unknown> | null = null;
    const calls = installFetch((method, path, body) => {
      if (path === '/api/studies/s11/status') return [200, { studyId: 's11', status }];
      if (path === '/api/studies/s11/runs') return [200, { studyId: 's11', status, runs: [run] }];
      if (path === '/api/studies/s11/flow-map' && method === 'GET') return held ? [200, { map: held }] : [404, { error: 'flow_map_not_found', message: 'No flow map yet.' }];
      if (path === '/api/studies/s11/flow-map' && method === 'POST') {
        const commit = body as Record<string, unknown>;
        commits.push(commit);
        if (!commit.drawnOnly) return [202, { status: 'building', buildId: 'b1' }];
        held = { studyId: 's11', version: 1, baseVersion: null, inputHash: 'h', docHash: commit.docHash, nodes: [], edges: [], readings: [], dropped: [], completedAt: '2026-11-10T10:00:00Z', model: null, buildId: null };
        return [200, { status: 'ready', map: held }];
      }
      if (path === '/api/studies/s11/flow-map/builds/b1') return [200, failed];
      if (path === '/api/plugin/runs/r1/claim') {
        claims.push(body as Record<string, unknown>);
        return (run.status = 'running'), [200, { runId: 'r1', ...BRIEFING }];
      }
      if (method === 'POST' && path === '/api/plugin/runs/r1/turn') return [202, { turn: (body as { turn: number }).turn, status: 'thinking' }];
      if (path === '/api/plugin/runs/r1/turn/1') {
        run.status = 'completed';
        return [200, { turn: 1, status: 'ready', action: { type: 'done', claim: 'Done.' }, state: TURN_STATE, ended: { status: 'completed', reason: 'done' } }];
      }
      if (path === '/api/studies/s11/runs/next') return (status = 'complete'), [200, { studyId: 's11', done: true, reason: 'every wave ran', wave: 1 }];
      if (path === '/api/studies/s11/report') return [200, fixtureReport()];
      return [404, { error: 'x', message: path }];
    }, { maps: false });
    const { store, fx } = initStore('tok', main, { studies: [traceStudy('s11', 'running')], lastStudyId: 's11' });
    await runUntil(() => store.get().study?.runner?.phase === 'map_failed', 60_000, 500);
    // The backend's words, as they are; nothing was claimed on a map it couldn't read.
    expect(store.get().study?.runner).toEqual({ phase: 'map_failed', notice: failed.message });
    expect(claims).toEqual([]);

    // Try again: the same flow, committed again, fails the same way.
    fx.retryMap(false);
    await runUntil(() => commits.length === 2 && store.get().study?.runner?.phase === 'map_failed', 60_000, 500);
    expect(claims).toEqual([]);

    fx.retryMap(true);
    await runUntil(() => store.get().screen === 'report', 600_000, 1_000);
    vi.useRealTimers();
    expect(commits.map((c) => c.drawnOnly ?? false)).toEqual([false, false, true]);
    expect(claims).toEqual([expect.objectContaining({ flowMapVersion: 1 })]);
    expect(calls.filter((c) => c === 'POST /api/plugin/runs/r1/claim')).toHaveLength(1);
  });

  it('tries again with the read and the confirmed import of the first try, when creating the study failed', async () => {
    const main = await mainThread();
    const variant = (status: LibraryVariant['status']): LibraryVariant => ({ variantId: '5:1', key: 'k-open', name: 'State=Open', status, error: null });
    main.gate.readAs = (imported) => ({ ...structuredClone(main.doc), libraryVariants: [variant(imported ? 'imported' : 'needs_import')] });
    let creates = 0;
    const calls = installFetch((method, path) => {
      if (method === 'POST' && path === '/api/studies') return ++creates === 1 ? [500, { error: 'internal_error', message: 'Unexpected.' }] : [201, { studyId: 's10', status: 'draft' }];
      return [404, { error: 'x', message: path }];
    });
    const { store, fx } = initStore('tok', main);
    fillForm(store, '');
    await fx.launch();
    await fx.confirmImport();
    expect(store.get().study?.error).toBe('Unexpected.');
    await fx.retry();
    await until(() => savedStudies().length > 0);
    expect(calls.filter((c) => c === 'POST /api/studies')).toHaveLength(2);
    expect(main.gate.reads).toEqual([false, true]);
    expect(store.get().gate).toBeNull();
    expect(savedStudies()[0]?.trace).toMatchObject({ importLibraryVariants: true });
    fx.newTest();
  });

  it('asks for the page a reopened test runs on, and runs it once the designer goes there', async () => {
    const main = await mainThread();
    main.gate.readAs = () => ({ ...structuredClone(main.doc), pageId: '0:2', pageName: 'Archive' });
    installFetch((_m, path) => {
      if (path === '/api/studies/s11/status') return [200, { studyId: 's11', status: 'running' }];
      if (path === '/api/studies/s11/runs') return [200, { studyId: 's11', status: 'running', runs: [] }];
      return [409, { error: 'wave_in_progress', message: 'still open' }];
    });
    const trace = { ...TRACE, pageId: '0:2', pageName: 'Archive' };
    const { store, fx } = initStore('tok', main, { studies: [traceStudy('s11', 'running', trace)], lastStudyId: 's11' });
    await until(() => !!store.get().study?.runner);
    expect(store.get().study?.runner).toEqual({ phase: 'other_page', notice: 'This test runs on page Archive.' });
    expect(traceCalls(main)).toEqual([]);
    fx.goToTestPage();
    expect(sent).toContainEqual({ type: 'show-node', nodeId: '1:2' });
    fx.handleMain({ type: 'doc', doc: { ...fixtureDoc(), pageId: '0:2', pageName: 'Archive' } });
    await until(() => traceCalls(main).includes('trace-load'));
    expect(main.gate.reads).toEqual([false]);
    fx.newTest();
  });

  it('shows the library components the confirmed import could not add, and launches only if the designer still wants to', async () => {
    const main = await mainThread();
    const variant = (name: string, status: LibraryVariant['status'], error: string | null = null): LibraryVariant => ({ variantId: `5:${name.length}`, key: `k-${name}`, name, status, error });
    main.gate.readAs = (imported) => ({
      ...structuredClone(main.doc),
      libraryVariants: imported
        ? [variant('State=Open', 'imported'), variant('State=Closed', 'failed', 'The library is not enabled for this file')]
        : [variant('State=Open', 'needs_import'), variant('State=Closed', 'needs_import')],
    });
    const calls = installFetch((method, path) => (method === 'POST' && path === '/api/studies' ? [201, { studyId: 's12', status: 'draft' }] : [404, { error: 'x', message: path }]));
    const { store, fx } = initStore('tok', main);
    fillForm(store, '');
    await fx.launch();
    await fx.confirmImport();
    expect(store.get().gate).toEqual({ kind: 'import-failed', failures: [{ component: 'State=Closed', error: 'The library is not enabled for this file' }] });
    expect(calls).toEqual([]);
    fx.cancelImport();
    expect(store.get().gate).toBeNull();

    await fx.launch();
    await fx.confirmImport();
    await fx.launchAnyway();
    expect(calls[0]).toBe('POST /api/studies');
    expect(main.gate.reads).toEqual([false, true, false, true]);
    expect(savedStudies()[0]?.trace).toMatchObject({ importLibraryVariants: true });
    fx.newTest();
  });

  it('reads the prototype again once when a read fails, and says why when it fails twice', async () => {
    const main = await mainThread();
    main.gate.readErrors.push('The Figma document did not answer trace-read within 120 s.');
    const calls = installFetch((method, path) => (method === 'POST' && path === '/api/studies' ? [201, { studyId: 's13', status: 'draft' }] : [404, { error: 'x', message: path }]));
    const { store, fx } = initStore('tok', main);
    fillForm(store, '');
    await fx.launch();
    expect(main.gate.reads).toEqual([false, false]);
    expect(calls[0]).toBe('POST /api/studies');
    fx.newTest();

    main.gate.readErrors.push('first', 'second');
    fillForm(store, '');
    const before = calls.length;
    await fx.launch();
    expect(calls.length).toBe(before);
    expect(store.get()).toMatchObject({ gate: null, notice: { kind: 'error', text: expect.stringMatching(/second.*first/) } });
  });

  it('does not read again while a read that timed out may still be running, and says so', async () => {
    const main = await mainThread();
    main.gate.readTimeouts = 1;
    const calls = installFetch((method, path) => [404, { error: 'x', message: `${method} ${path}` }]);
    const { store, fx } = initStore('tok', main);
    fillForm(store, '');
    await fx.launch();
    expect(main.gate.reads).toEqual([false]);
    expect(calls).toEqual([]);
    expect(store.get()).toMatchObject({ gate: null, notice: { kind: 'error', text: 'The Figma document did not answer trace-read within 120 s.' } });
    fx.newTest();
  });

  it('offers to forget saved progress it cannot read, and then runs the test on without it', async () => {
    const main = await mainThread();
    main.loads.error = { message: "This test's saved progress was made by another version of the plugin.", code: 'saved_progress_unreadable' };
    const run = { runId: 'r1', archetypeId: 'a', archetypeName: 'Baseline founder', role: 'baseline', status: 'queued' };
    // The run whose saved progress that was: this panel's, running, with nothing saved once it is forgotten.
    const ours = { runId: 'r0', archetypeId: 'b', archetypeName: 'Low trust founder', role: 'variant', status: 'running' };
    const calls = installFetch((method, path, body) => {
      if (path === '/api/studies/s14/status') return [200, { studyId: 's14', status: 'running' }];
      if (path === '/api/studies/s14/runs') return [200, { studyId: 's14', status: 'running', runs: [ours, run] }];
      if (path === '/api/plugin/runs/r1/claim') return (run.status = 'running'), [200, { runId: 'r1', ...BRIEFING }];
      if (path === '/api/plugin/runs/r0/claim') return [200, { runId: 'r0', ...BRIEFING }];
      if (method === 'POST' && path === '/api/plugin/runs/r0/turn') return [202, { turn: (body as { turn: number }).turn, status: 'thinking' }];
      if (path === '/api/plugin/runs/r0/turn/1') return [200, { turn: 1, status: 'thinking' }];
      return [404, { error: 'x', message: path }];
    });
    const { store, fx } = initStore('tok', main, { studies: [traceStudy('s14', 'running')], lastStudyId: 's14' });
    await until(() => store.get().study?.runner?.phase === 'progress_unreadable');
    expect(store.get().study?.runner).toEqual({ phase: 'progress_unreadable', notice: "This test's saved progress was made by another version of the plugin." });
    // Its own banner, with the way out: not a Try again that would fail the same way.
    expect(store.get().study?.error).toBeNull();
    expect(calls).not.toContain('POST /api/plugin/runs/r1/claim');
    expect(calls).not.toContain('POST /api/plugin/runs/r0/claim');

    await fx.forgetProgress();
    await until(() => calls.includes('POST /api/plugin/runs/r1/claim'));
    expect(main.log).toContain('forget s14');
    // Nothing saved for it any more: claimed again, it is this panel's, and goes on from its first turn.
    await until(() => calls.includes('POST /api/plugin/runs/r0/turn'));
    expect(calls).toContain('POST /api/plugin/runs/r0/claim');
    fx.newTest();
  });

  it('blocks the launch where the file cannot be edited', async () => {
    const main = await mainThread();
    main.gate.scratch = { ok: false, reason: 'Duplicate to your drafts to test', detail: 'Cannot create nodes in a read-only document' };
    const calls = installFetch(() => [500, {}]);
    const { store, fx } = initStore('tok', main);
    fillForm(store);
    await fx.launch();
    expect(store.get()).toMatchObject({ screen: 'new', study: null, gate: { kind: 'blocked', reason: 'Duplicate to your drafts to test', detail: 'Cannot create nodes in a read-only document' } });
    expect(calls).toEqual([]);
    expect(main.gate.reads).toEqual([]);
  });

  it('asks before testing adds library components to the file, and launches only once the designer confirms', async () => {
    const main = await mainThread();
    const variant = (name: string, status: LibraryVariant['status']): LibraryVariant => ({ variantId: `5:${name.length}`, key: `k-${name}`, name, status, error: null });
    main.gate.readAs = (imported) => ({
      ...structuredClone(main.doc),
      libraryVariants: imported ? [variant('State=Open', 'imported'), variant('State=Closed', 'imported')] : [variant('State=Open', 'needs_import'), variant('State=Closed', 'needs_import')],
    });
    const calls = installFetch((method, path) => (method === 'POST' && path === '/api/studies' ? [201, { studyId: 's9', status: 'draft' }] : [404, { error: 'study_not_found', message: path }]));
    const { store, fx } = initStore('tok', main);
    fillForm(store, '');

    await fx.launch();
    expect(store.get().gate).toEqual({ kind: 'confirm-import', components: ['State=Open', 'State=Closed'] });
    expect(calls).toEqual([]);
    fx.cancelImport();
    expect(store.get().gate).toBeNull();

    await fx.launch();
    expect(store.get().gate?.kind).toBe('confirm-import');
    await fx.confirmImport();
    // Only the confirmed read may import.
    expect(main.gate.reads).toEqual([false, false, true]);
    expect(calls[0]).toBe('POST /api/studies');
    expect(savedStudies()[0]?.trace).toMatchObject({ shareKey: null, importLibraryVariants: true });
    fx.newTest();
  });

  it('resumes the runs it owns when the panel reopens on a plugin-mode study', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const main = await mainThread();
    const trace: TraceRecord = { owner: 'p_0123456789abcdef01234567', pageId: '0:1', pageName: 'Prototype', startFrameId: '1:2', shareKey: null, importLibraryVariants: false };
    const saved = {
      owner: trace.owner,
      runId: 'r1',
      turn: 2,
      state: start(main.doc, '1:2'),
      lastOutcome: { action: { type: 'click' as const, element: 'e1' }, outcome: 'nothing_happened' as const, target: 'Welcome back, Mara (e1)' },
      timerEffects: [],
      loopFrames: [],
      flowMapVersion: null,
      mapMisses: [],
      version: 2,
    };
    main.stored.set('s5', new Map([['r1', saved]]));
    const run = { runId: 'r1', archetypeId: 'a', archetypeName: 'Baseline founder', role: 'baseline', status: 'running' };
    let status = 'running';
    const turns: Array<Record<string, any>> = [];
    const calls = installFetch((method, path, body) => {
      if (path === '/api/studies/s5/status') return [200, { studyId: 's5', status }];
      if (path === '/api/studies/s5/runs') return [200, { studyId: 's5', status, runs: [run] }];
      if (method === 'POST' && path === '/api/plugin/runs/r1/turn') {
        turns.push(body as Record<string, any>);
        return [202, { turn: (body as { turn: number }).turn, status: 'thinking' }];
      }
      if (path === '/api/plugin/runs/r1/turn/3') {
        run.status = 'completed';
        return [200, { turn: 3, status: 'ready', action: { type: 'done', claim: 'Done.' }, state: TURN_STATE, ended: { status: 'completed', reason: 'done' } }];
      }
      if (path === '/api/studies/s5/runs/next') return (status = 'complete'), [200, { studyId: 's5', done: true, reason: 'every wave ran', wave: 1 }];
      if (path === '/api/studies/s5/report') return [200, fixtureReport()];
      return [404, { error: 'x', message: path }];
    });
    const record: StudyRecord = { studyId: 's5', title: 't', startName: 'Dashboard', goalName: 'Bank connected', size: 'quick', launchedAt: 0, status: 'running', trace };
    const { store, fx } = initStore('tok', main, { studies: [record], lastStudyId: 's5' });
    await runUntil(() => store.get().screen === 'report');
    vi.useRealTimers();
    expect(turns.map((t) => [t.turn, t.owner])).toEqual([[3, trace.owner]]);
    expect(calls).not.toContain('POST /api/plugin/runs/r1/claim');
    expect(main.gate.reads).toEqual([false]);
    expect(main.stored.get('s5')?.size).toBe(0);
    fx.newTest();
  });

  it('checks the file can still be edited before resuming, and resumes nothing when it cannot', async () => {
    const main = await mainThread();
    main.gate.scratch = { ok: false, reason: 'Duplicate to your drafts to test', detail: 'Cannot create nodes in a read-only file' };
    const calls = installFetch((method, path) => {
      if (path === '/api/studies/s6/status') return [200, { studyId: 's6', status: 'running' }];
      if (path === '/api/studies/s6/runs') return [200, { studyId: 's6', status: 'running', runs: [] }];
      return [404, { error: 'x', message: `${method} ${path}` }];
    });
    const { store, fx } = initStore('tok', main, { studies: [traceStudy('s6', 'running')], lastStudyId: 's6' });
    await until(() => store.get().study?.runner?.phase === 'failed');
    expect(store.get().study?.runner?.notice).toBe('Duplicate to your drafts to test (Cannot create nodes in a read-only file)');
    expect(traceCalls(main)).toContain('trace-scratch-check');
    expect(traceCalls(main)).not.toContain('trace-read');
    expect(calls.filter((c) => c.includes('/api/plugin/'))).toEqual([]);
    fx.newTest();
  });

  it('does not call the backend when the form is incomplete', async () => {
    const calls = installFetch(() => [500, {}]);
    const { store, fx } = initStore('tok');
    await fx.launch();
    expect(calls).toEqual([]);
    expect(store.get().touched).toBe(true);
    expect(store.get().notice?.kind).toBe('error');
  });

  it('shows a launch error with the request id and retries from the failed step', async () => {
    let fail = true;
    let status = 'draft';
    installFetch((method, path) => {
      if (method === 'POST' && path === '/api/studies') return [201, { studyId: 's2', status: 'draft' }];
      if (path === '/api/studies/s2/status') return [200, { status }];
      if (path === '/api/studies/s2/factors') {
        if (fail) return [500, { error: 'internal_error', message: 'Unexpected.', request_id: 'req-1' }];
        status = 'running';
        return [200, {}];
      }
      if (path === '/api/studies/s2/runs') return [200, { runs: [{ runId: 'r', archetypeId: 'a', archetypeName: 'A', status: 'queued' }] }];
      return [404, {}];
    });
    const { store, fx } = initStore('tok', await mainThread());
    store.dispatch({ type: 'pick', role: 'goal', nodeId: '2:50' });
    store.dispatch({ type: 'field', field: 'goal', value: 'Pay' });
    store.dispatch({ type: 'field', field: 'who', value: 'Founders' });
    store.dispatch({ type: 'field', field: 'link', value: 'https://www.figma.com/design/AbCdEfGh1234567890XyZ/x' });
    await fx.launch();
    await until(() => !!store.get().study?.error);
    expect(store.get().study?.error).toBe('Unexpected. (reference req-1)');
    fail = false;
    await fx.retry();
    await until(() => store.get().study?.runs.length === 1);
    expect(store.get().study?.stage).toBe('watching');
    fx.newTest();
  });

  it('shows an error when the created study comes back without an id', async () => {
    const calls = installFetch((method, path) => {
      if (method === 'POST' && path === '/api/studies') return [201, { title: 'Pay', status: 'draft' }];
      return [404, {}];
    });
    const { store, fx } = initStore('tok', await mainThread());
    store.dispatch({ type: 'pick', role: 'goal', nodeId: '2:50' });
    store.dispatch({ type: 'field', field: 'goal', value: 'Pay' });
    store.dispatch({ type: 'field', field: 'who', value: 'Founders' });
    store.dispatch({ type: 'field', field: 'link', value: 'https://www.figma.com/design/AbCdEfGh1234567890XyZ/x' });
    await fx.launch();
    expect(store.get().study?.error).toMatch(/did not return the study/);
    expect(calls).toEqual(['POST /api/studies']);
    expect(sent.map((m) => m.type)).not.toContain('save-study');
  });

  it('stops watching and shows the error when the study is gone', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let reads = 0;
    const calls = installFetch((_m, path) => {
      if (path === '/api/studies/s4/status' && reads++ === 0) return [200, { studyId: 's4', status: 'running' }];
      return [404, { error: 'study_not_found', message: 'No study s4 for this user.' }];
    });
    const { store, fx } = initStore('tok');
    store.dispatch({ type: 'open-study', record: { studyId: 's4', title: 't', startName: 'a', goalName: 'b', size: 'quick', launchedAt: 0, status: 'running' }, now: 0 });
    fx.watch();
    await vi.advanceTimersByTimeAsync(100);
    expect(store.get().study?.error).toBe('No study s4 for this user.');
    const before = calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();
    expect(calls.length).toBe(before);
  });

  it('reads the screen each persona is on from the runs list alone', async () => {
    const calls = installFetch((_m, path) => {
      if (path === '/api/studies/s6/status') return [200, { studyId: 's6', status: 'running' }];
      if (path === '/api/studies/s6/runs') {
        return [
          200,
          {
            studyId: 's6',
            status: 'running',
            runs: [
              { runId: 'r1', archetypeId: 'a', archetypeName: 'Baseline founder', role: 'baseline', status: 'running', lastStep: null },
              { runId: 'r2', archetypeId: 'v', archetypeName: 'Low trust founder', role: 'variant', status: 'running', lastStep: { seq: 3, url: protoAt('2-20') } },
            ],
          },
        ];
      }
      return [404, { error: 'not_found', message: path }];
    });
    const { store, fx } = initStore('tok');
    store.dispatch({ type: 'open-study', record: { studyId: 's6', title: 't', startName: 'a', goalName: 'b', size: 'quick', launchedAt: 0, status: 'running' }, now: 0 });
    fx.watch();
    await until(() => (store.get().study?.runs.length ?? 0) === 2);
    await new Promise((r) => setTimeout(r, 20));
    const st = store.get();
    fx.newTest();
    expect(calls.filter((c) => !c.startsWith('GET /api/studies/s6/'))).toEqual([]);
    const rows = personaRows(st.study?.runs ?? [], indexFrames(st.doc));
    expect(rows.map((r) => [r.name, r.statusText, r.steps])).toEqual([
      ['Baseline founder', 'Clicking through', null],
      ['Low trust founder', 'On Connect bank', 3],
    ]);
  });

  it('says so when the runs list is missing instead of waiting for tries forever', async () => {
    installFetch((_m, path) => {
      if (path === '/api/studies/s7/status') return [200, { studyId: 's7', status: 'running' }];
      if (path === '/api/studies/s7/runs') return [200, { studyId: 's7', status: 'running' }];
      return [404, {}];
    });
    const { store, fx } = initStore('tok');
    store.dispatch({ type: 'open-study', record: { studyId: 's7', title: 't', startName: 'a', goalName: 'b', size: 'quick', launchedAt: 0, status: 'running' }, now: 0 });
    fx.watch();
    await until(() => !!store.get().study?.pollError);
    fx.newTest();
    expect(store.get().study).toBeNull();
  });

  it('keeps the token and keeps watching through a sign in service outage', async () => {
    let polls = 0;
    installFetch((_m, path) => {
      if (path === '/api/studies/s8/status' && polls++ === 0) return [200, { studyId: 's8', status: 'running' }];
      return [503, { error: 'auth_unavailable', message: 'The sign in service is unavailable. Try again in a minute.' }];
    });
    const { store, fx } = initStore('tok');
    store.dispatch({ type: 'open-study', record: { studyId: 's8', title: 't', startName: 'a', goalName: 'b', size: 'quick', launchedAt: 0, status: 'running' }, now: 0 });
    fx.watch();
    await until(() => !!store.get().study?.pollError);
    expect(store.get()).toMatchObject({ token: 'tok', screen: 'progress', study: { error: null, pollError: 'The sign in service is unavailable. Try again in a minute.' } });
    expect(sent.map((m) => m.type)).not.toContain('save-token');
    fx.newTest();
  });

  it('a 401 while watching signs out and clears the stored token', async () => {
    installFetch(() => [401, { error: 'Invalid token', message: 'bad' }]);
    const { store, fx } = initStore('tok');
    store.dispatch({ type: 'open-study', record: { studyId: 's3', title: 't', startName: 'a', goalName: 'b', size: 'quick', launchedAt: 0, status: 'running' }, now: 0 });
    fx.watch();
    await until(() => store.get().screen === 'signin');
    expect(store.get().token).toBeNull();
    expect(sent).toContainEqual({ type: 'save-token', token: null });
  });

  it('returns to the form after a sign in that interrupted creating the study', async () => {
    installFetch(() => [401, { error: 'Invalid token', message: 'Token validation failed' }]);
    const { store, fx } = initStore('expired', await mainThread());
    store.dispatch({ type: 'pick', role: 'goal', nodeId: '2:50' });
    store.dispatch({ type: 'field', field: 'goal', value: 'Pay' });
    store.dispatch({ type: 'field', field: 'who', value: 'Founders' });
    store.dispatch({ type: 'field', field: 'link', value: 'https://www.figma.com/design/AbCdEfGh1234567890XyZ/x' });
    await fx.launch();
    expect(store.get().screen).toBe('signin');
    fx.acceptToken('fresh');
    expect(store.get()).toMatchObject({ screen: 'new', study: null, form: { goal: 'Pay', goalId: '2:50' } });
  });

  it('refuses a sign in page that is not https', async () => {
    const calls = installFetch(() => [200, { device_code: 'd', user_code: 'WDJB-MJHT', verification_uri: 'http://auth.example/activate', verification_uri_complete: 'http://auth.example/activate?user_code=WDJB-MJHT', expires_in: 600, interval: 1 }]);
    const { store, fx } = initStore(null);
    await fx.signIn();
    expect(store.get().auth).toMatchObject({ phase: 'error', error: expect.stringMatching(/not https/) });
    expect(sent.map((m) => m.type)).not.toContain('open-url');
    expect(calls).toEqual(['POST /api/oauth/device/code']);
  });

  it('signs in with the device flow and opens the verification page', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let polls = 0;
    installFetch((_m, path) => {
      if (path === '/api/oauth/device/code') return [200, { device_code: 'd', user_code: 'WDJB-MJHT', verification_uri: 'https://a/v', verification_uri_complete: 'https://a/v?c=1', expires_in: 600, interval: 1 }];
      polls++;
      return polls < 2 ? [403, { error: 'authorization_pending' }] : [200, { access_token: 'jwt' }];
    });
    const { store, fx } = initStore(null);
    const done = fx.signIn();
    await vi.advanceTimersByTimeAsync(3000);
    await done;
    vi.useRealTimers();
    expect(sent).toContainEqual({ type: 'open-url', url: 'https://a/v?c=1' });
    expect(sent).toContainEqual({ type: 'save-token', token: 'jwt' });
    expect(store.get()).toMatchObject({ token: 'jwt', screen: 'new' });
  });
});
