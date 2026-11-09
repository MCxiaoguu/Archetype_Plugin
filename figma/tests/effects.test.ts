import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UiToMain } from '../src/lib/messages';
import { DEFAULT_SETTINGS } from '../src/lib/messages';
import { indexFrames } from '../src/lib/frames';
import { personaRows } from '../src/lib/runs';
import { fixtureDoc, fixtureReport, protoAt } from './helpers';

const sent: UiToMain[] = [];
vi.mock('../src/ui/bridge', () => ({ toMain: (m: UiToMain) => sent.push(m), onMain: () => () => undefined }));

const { createEffects } = await import('../src/ui/effects');
const { createStore } = await import('../src/ui/store');

type Route = (method: string, path: string, body: unknown, auth: string | null) => [number, unknown];

function installFetch(route: Route) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    const method = init.method ?? 'GET';
    calls.push(`${method} ${path}`);
    const headers = (init.headers ?? {}) as Record<string, string>;
    const [status, body] = route(method, path, init.body ? JSON.parse(String(init.body)) : null, headers.Authorization ?? null);
    return new Response(JSON.stringify(body), { status });
  });
  return calls;
}

function initStore(token: string | null) {
  const store = createStore();
  const fx = createEffects(store);
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
  });
  return { store, fx };
}

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
afterEach(() => vi.unstubAllGlobals());

describe('panel effects', () => {
  it('launches a study, walks every step, and lands on the report', async () => {
    let status = 'draft';
    let created: unknown = null;
    const calls = installFetch((method, path, body) => {
      if (method === 'POST' && path === '/api/studies') {
        created = body;
        return [201, { studyId: 's1', title: 'Connect a bank', status: 'draft' }];
      }
      if (path === '/api/studies/s1/status') return [200, { studyId: 's1', status, runs: { allTerminal: true, byStatus: {}, terminal: 0, total: 0 } }];
      if (path === '/api/studies/s1/factors') return (status = 'factors_ready'), [200, {}];
      if (path === '/api/studies/s1/archetypes') return (status = 'archetypes_ready'), [200, {}];
      if (method === 'POST' && path === '/api/studies/s1/runs') return (status = 'complete'), [201, {}];
      if (path === '/api/studies/s1/runs') return [200, { studyId: 's1', status, runs: [] }];
      if (path === '/api/studies/s1/report') return [200, fixtureReport()];
      return [404, { error: 'x', message: path }];
    });
    const { store, fx } = initStore('tok');
    store.dispatch({ type: 'pick', role: 'goal', nodeId: '2:50' });
    for (const [field, value] of [
      ['goal', 'Connect a bank account'],
      ['who', 'Founders who do their own books'],
      ['link', 'https://www.figma.com/design/AbCdEfGh1234567890XyZ/Farside'],
    ] as const) store.dispatch({ type: 'field', field, value });

    await fx.launch();
    await until(() => store.get().screen === 'report');

    expect(calls).toEqual([
      'POST /api/studies',
      'GET /api/studies/s1/status',
      'POST /api/studies/s1/factors',
      'GET /api/studies/s1/status',
      'POST /api/studies/s1/archetypes',
      'GET /api/studies/s1/status',
      'POST /api/studies/s1/runs',
      'GET /api/studies/s1/status',
      'GET /api/studies/s1/status',
      'GET /api/studies/s1/runs',
      'GET /api/studies/s1/report',
    ]);
    expect(created).toMatchObject({ source: 'figma', execution: 'remote', figma: { targetNodeId: '2:50', pluginVersion: '9.9.9' } });
    expect(sent.map((m) => m.type)).toContain('save-draft');
    const saved = sent.filter((m): m is Extract<UiToMain, { type: 'save-study' }> => m.type === 'save-study');
    expect(saved[0]?.record).toMatchObject({ studyId: 's1', startName: 'Dashboard', goalName: 'Bank connected' });
    expect(saved[saved.length - 1]?.record.outcome).toBe('6 of 15 reached the goal');
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
    const { store, fx } = initStore('tok');
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
    const { store, fx } = initStore('tok');
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
    const { store, fx } = initStore('expired');
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
