import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError, normaliseBase, pollDeviceFlow, TURN_TIMEOUT_MS, type DeviceCode, type FetchLike, type TurnBody } from '../src/lib/api';

type Call = { url: string; init: RequestInit };

function mockFetch(responses: Array<{ status: number; body?: unknown } | Error>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init: init ?? {} });
    const next = queue.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return new Response(next.body === undefined ? '' : JSON.stringify(next.body), { status: next.status });
  };
  return { fetch, calls };
}

describe('api client', () => {
  it('sends the bearer token and JSON to the right URL', async () => {
    const { fetch, calls } = mockFetch([{ status: 201, body: { studyId: 'abc', status: 'draft' } }]);
    const api = new ApiClient({ baseUrl: 'http://localhost:5013/', getToken: () => 'tok', fetch });
    const study = await api.createStudy({ title: 't' });
    expect(study).toEqual({ studyId: 'abc', status: 'draft' });
    expect(calls[0]?.url).toBe('http://localhost:5013/api/studies');
    expect(calls[0]?.init.method).toBe('POST');
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect((calls[0]?.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(calls[0]?.init.body).toBe('{"title":"t"}');
  });

  it('hits every study route', async () => {
    const { fetch, calls } = mockFetch(Array.from({ length: 7 }, () => ({ status: 200, body: {} })));
    const api = new ApiClient({ baseUrl: 'https://api.x.com', getToken: () => 't', fetch });
    await api.identifyFactors('s1');
    await api.buildArchetypes('s1');
    await api.startRuns('s1');
    await api.getStatus('s1');
    await api.getRuns('s1');
    await api.getReport('s1');
    await api.getStudy('s1');
    expect(calls.map((c) => `${c.init.method} ${c.url.replace('https://api.x.com', '')}`)).toEqual([
      'POST /api/studies/s1/factors',
      'POST /api/studies/s1/archetypes',
      'POST /api/studies/s1/runs',
      'GET /api/studies/s1/status',
      'GET /api/studies/s1/runs',
      'GET /api/studies/s1/report',
      'GET /api/studies/s1',
    ]);
    expect(calls[0]?.init.body).toBe('{}');
  });

  it('clears the session on 401 and reports it once', async () => {
    const onUnauthorized = vi.fn();
    const { fetch } = mockFetch([{ status: 401, body: { error: 'Invalid token', message: 'bad' } }]);
    const api = new ApiClient({ baseUrl: 'http://x', getToken: () => 't', fetch, onUnauthorized });
    await expect(api.getStatus('s')).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('refuses to call without a token', async () => {
    const onUnauthorized = vi.fn();
    const { fetch, calls } = mockFetch([]);
    const api = new ApiClient({ baseUrl: 'http://x', getToken: () => null, fetch, onUnauthorized });
    await expect(api.getRuns('s')).rejects.toMatchObject({ status: 401, code: 'signed_out' });
    expect(calls).toHaveLength(0);
    expect(onUnauthorized).toHaveBeenCalled();
  });

  it('surfaces the contract error body, fields and request id', async () => {
    const { fetch } = mockFetch([
      { status: 400, body: { error: 'invalid_study', message: 'task.url: must be a full address', fields: { 'task.url': 'must be' } } },
      { status: 500, body: { error: 'internal_error', message: 'Unexpected.', request_id: 'req-9' } },
      { status: 502, body: undefined },
    ]);
    const api = new ApiClient({ baseUrl: 'http://x', getToken: () => 't', fetch });
    const e1 = (await api.createStudy({}).catch((e) => e)) as ApiError;
    expect(e1).toBeInstanceOf(ApiError);
    expect(e1).toMatchObject({ status: 400, code: 'invalid_study', fields: { 'task.url': 'must be' } });
    const e2 = (await api.getStudy('s').catch((e) => e)) as ApiError;
    expect(e2).toMatchObject({ status: 500, code: 'internal_error', requestId: 'req-9' });
    const e3 = (await api.getStudy('s').catch((e) => e)) as ApiError;
    expect(e3.code).toBe('http_502');
    expect(e3.message).toMatch(/problem on its side/);
  });

  it('reads RFC 9457 problem documents and OAuth error bodies', async () => {
    const { fetch } = mockFetch([
      {
        status: 404,
        body: { type: 'https://docs.syntheticarchetype.com/api#errors', title: 'Not Found', status: 404, detail: 'No route matches POST /api/studies.', code: 'not_found', error: 'No route matches POST /api/studies.' },
      },
      { status: 403, body: { error: 'unauthorized_client', error_description: 'Grant type device_code not allowed for the client.' } },
    ]);
    const api = new ApiClient({ baseUrl: 'http://x', getToken: () => 't', fetch });
    const e1 = (await api.createStudy({}).catch((e) => e)) as ApiError;
    expect(e1).toMatchObject({ status: 404, code: 'not_found', message: 'No route matches POST /api/studies.' });
    const e2 = (await api.startDeviceFlow().catch((e) => e)) as ApiError;
    expect(e2).toMatchObject({ status: 403, code: 'unauthorized_client', message: 'Grant type device_code not allowed for the client.' });
  });

  it('reads problem documents that carry error and message', async () => {
    const { fetch } = mockFetch([
      { status: 405, body: { type: 'https://docs.syntheticarchetype.com/api#errors', title: 'Method Not Allowed', status: 405, detail: '/api/studies does not accept PUT; it accepts GET, POST.', error: 'method_not_allowed', message: '/api/studies does not accept PUT; it accepts GET, POST.' } },
    ]);
    const api = new ApiClient({ baseUrl: 'http://x', getToken: () => 't', fetch });
    const e = (await api.createStudy({}).catch((err) => err)) as ApiError;
    expect(e).toMatchObject({ status: 405, code: 'method_not_allowed', message: '/api/studies does not accept PUT; it accepts GET, POST.' });
  });

  it('keeps the session when the sign in service is down', async () => {
    const onUnauthorized = vi.fn();
    const { fetch } = mockFetch([{ status: 503, body: { error: 'auth_unavailable' } }]);
    const api = new ApiClient({ baseUrl: 'http://x', getToken: () => 't', fetch, onUnauthorized });
    const e = (await api.getStatus('s').catch((err) => err)) as ApiError;
    expect(e).toMatchObject({ status: 503, code: 'auth_unavailable' });
    expect(e.message).toMatch(/still signed in/);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('refuses a success answer it cannot read', async () => {
    const fetch: FetchLike = async () => new Response('<html>Gateway login</html>', { status: 200 });
    const api = new ApiClient({ baseUrl: 'http://x', getToken: () => 't', fetch });
    await expect(api.getStatus('s')).rejects.toMatchObject({ status: 200, code: 'bad_response' });
  });

  it('turns network failures into a plain message', async () => {
    const { fetch } = mockFetch([new TypeError('Failed to fetch')]);
    const api = new ApiClient({ baseUrl: 'http://localhost:5013', getToken: () => 't', fetch });
    await expect(api.getStatus('s')).rejects.toMatchObject({ status: 0, code: 'network' });
  });

  it('times out slow calls', async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
    const api = new ApiClient({ baseUrl: 'http://x', getToken: () => 't', fetch, timeoutMs: 10 });
    await expect(api.getStatus('s')).rejects.toMatchObject({ code: 'timeout' });
  });

  it('times out a body that stops arriving after the headers', async () => {
    // A real fetch aborts the body stream with the signal; this fake does the same.
    const fetch: FetchLike = async (_url, init) =>
      ({
        ok: true,
        status: 200,
        text: () => new Promise<string>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))),
      }) as unknown as Response;
    const api = new ApiClient({ baseUrl: 'http://x', getToken: () => 't', fetch, timeoutMs: 10 });
    await expect(api.getStatus('s')).rejects.toMatchObject({ code: 'timeout' });
  });

  it('normalises the base URL', () => {
    expect(normaliseBase('https://api.x.com/')).toBe('https://api.x.com');
    expect(normaliseBase(' https://api.x.com/api ')).toBe('https://api.x.com');
  });
});

describe('device flow', () => {
  const code: DeviceCode = {
    device_code: 'dev-1',
    user_code: 'ABCD-EFGH',
    verification_uri: 'https://auth/activate',
    verification_uri_complete: 'https://auth/activate?user_code=ABCD-EFGH',
    expires_in: 600,
    interval: 5,
  };

  it('starts without a bearer token', async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: code }]);
    const api = new ApiClient({ baseUrl: 'http://x', getToken: () => null, fetch });
    expect(await api.startDeviceFlow()).toEqual(code);
    expect(calls[0]?.url).toBe('http://x/api/oauth/device/code');
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('polls through pending and slow_down until a token arrives', async () => {
    // Status codes as Auth0 sends them through the backend: 403 while
    // pending, 429 Too Many Requests for slow_down.
    const { fetch, calls } = mockFetch([
      { status: 403, body: { error: 'authorization_pending', error_description: 'waiting' } },
      { status: 429, body: { error: 'slow_down', error_description: 'You are polling faster than allowed. Try again in 10 seconds.' } },
      { status: 403, body: { error: 'authorization_pending' } },
      { status: 200, body: { access_token: 'jwt', refresh_token: 'r', expires_in: 86400 } },
    ]);
    const api = new ApiClient({ baseUrl: 'http://x', getToken: () => null, fetch });
    const waits: number[] = [];
    let t = 0;
    const result = await pollDeviceFlow(api, code, {
      sleep: async (ms) => {
        waits.push(ms);
        t += ms;
      },
      now: () => t,
    });
    expect(result).toEqual({ kind: 'token', token: { access_token: 'jwt', refresh_token: 'r', expires_in: 86400 } });
    expect(waits).toEqual([5000, 5000, 10000, 10000]);
    expect(calls.every((c) => c.url === 'http://x/api/oauth/device/token')).toBe(true);
    expect(calls[0]?.init.body).toBe('{"device_code":"dev-1"}');
  });

  it('stops on denial, expiry and cancellation', async () => {
    const denied = mockFetch([{ status: 403, body: { error: 'access_denied' } }]);
    const api1 = new ApiClient({ baseUrl: 'http://x', getToken: () => null, fetch: denied.fetch });
    const hooks = { sleep: async () => undefined, now: () => 0 };
    expect(await pollDeviceFlow(api1, code, hooks)).toMatchObject({ kind: 'failed', code: 'access_denied' });

    const expired = mockFetch([{ status: 400, body: { error: 'expired_token' } }]);
    const api2 = new ApiClient({ baseUrl: 'http://x', getToken: () => null, fetch: expired.fetch });
    expect(await pollDeviceFlow(api2, code, hooks)).toMatchObject({ kind: 'failed', code: 'expired_token' });

    const pending = mockFetch(Array.from({ length: 5 }, () => ({ status: 403, body: { error: 'authorization_pending' } })));
    const api3 = new ApiClient({ baseUrl: 'http://x', getToken: () => null, fetch: pending.fetch });
    let n = 0;
    expect(await pollDeviceFlow(api3, code, { ...hooks, cancelled: () => ++n > 2 })).toEqual({ kind: 'cancelled' });

    let t = 0;
    const api4 = new ApiClient({ baseUrl: 'http://x', getToken: () => null, fetch: mockFetch(Array.from({ length: 200 }, () => ({ status: 403, body: { error: 'authorization_pending' } }))).fetch });
    const r = await pollDeviceFlow(api4, { ...code, expires_in: 30 }, { sleep: async (ms) => void (t += ms), now: () => t });
    expect(r).toMatchObject({ kind: 'failed', code: 'expired_token' });
  });

  it('keeps polling through network blips and gateway errors', async () => {
    const { fetch } = mockFetch([new TypeError('offline'), { status: 502, body: { error: 'auth0_unreachable' } }, { status: 200, body: { access_token: 'ok' } }]);
    const api = new ApiClient({ baseUrl: 'http://x', getToken: () => null, fetch });
    const r = await pollDeviceFlow(api, code, { sleep: async () => undefined, now: () => 0 });
    expect(r).toMatchObject({ kind: 'token', token: { access_token: 'ok' } });
  });

  it('stops on errors that polling cannot fix, with the reason', async () => {
    const { fetch } = mockFetch([
      { status: 500, body: { error: 'auth0_not_configured', message: 'AUTH0_DOMAIN and AUTH0_CLIENTID must be set in the backend env' } },
      { status: 403, body: { error: 'invalid_grant', error_description: 'Invalid or expired device code.' } },
    ]);
    const api = new ApiClient({ baseUrl: 'http://x', getToken: () => null, fetch });
    expect(await api.pollDeviceToken('d')).toEqual({ kind: 'failed', code: 'auth0_not_configured', message: 'AUTH0_DOMAIN and AUTH0_CLIENTID must be set in the backend env' });
    expect(await api.pollDeviceToken('d')).toEqual({ kind: 'failed', code: 'invalid_grant', message: 'Invalid or expired device code.' });
  });

  it('fails on a 200 without a token', async () => {
    const { fetch } = mockFetch([{ status: 200, body: { nope: true } }]);
    const api = new ApiClient({ baseUrl: 'http://x', getToken: () => null, fetch });
    expect(await api.pollDeviceToken('d')).toMatchObject({ kind: 'failed', code: 'bad_response' });
  });
});

describe('trace runs', () => {
  const body: TurnBody = {
    owner: 'p_7f3a',
    turn: 2,
    screen: { url: 'figma-trace://Billing%20flow/2-20?node-id=2-20', title: 'Billing settings', frameId: '2:20', overlays: [], viewport: [390, 844], scroll: { x: 0, y: 0, maxX: 0, maxY: 0 } },
    screenshot_b64: '/9j/4AAQ',
    elements: [{ id: 'e1', label: 'Connect bank', role: 'button', box: [24, 220, 200, 44] }],
    visible_text_excerpt: 'Billing settings · Connect bank',
    last: { action: { type: 'click', element: 'e1' }, outcome: 'navigated', target: 'Billing (e1)' },
    flags: [],
    elapsed_s: 4.2,
    client_ts: '2026-11-10T10:00:02Z',
  };

  it('claims, posts and reads turns, aborts and asks for the next wave on the backend routes', async () => {
    const { fetch, calls } = mockFetch([
      { status: 200, body: { runId: 'r 1', sessionId: 'plugin-abc', claimedAt: 'now', brief: 'b', persona: { name: 'Tom' }, instructions: { targetUrl: 'figma-trace://x', goal: 'g' } } },
      { status: 202, body: { turn: 2, status: 'thinking' } },
      { status: 200, body: { turn: 2, status: 'thinking' } },
      { status: 200, body: { runId: 'r 1', status: 'aborted', abortReason: 'render_failed' } },
      { status: 201, body: { studyId: 's1', wave: 2, created: true, runs: [{ runId: 'r9', archetypeId: 'a1', archetypeName: 'Impatient', repeatIndex: 0 }] } },
    ]);
    const api = new ApiClient({ baseUrl: 'https://api.x.com', getToken: () => 't', fetch });
    const browser = { engine: 'figma-trace' as const, version: '0.7.0', viewport: [390, 844] as [number, number] };
    expect(await api.claimRun('r 1', { browser, owner: 'p_7f3a', flowMapVersion: 3 })).toMatchObject({ runId: 'r 1', sessionId: 'plugin-abc' });
    expect(await api.postTurn('r 1', body)).toEqual({ turn: 2, status: 'thinking' });
    expect(await api.getTurn('r 1', 2)).toEqual({ turn: 2, status: 'thinking' });
    expect(await api.abortRun('r 1', { owner: 'p_7f3a', code: 'render_failed', detail: 'The export was empty twice.' })).toEqual({ runId: 'r 1', status: 'aborted', abortReason: 'render_failed' });
    expect(await api.nextWave('s1')).toMatchObject({ wave: 2, runs: [{ runId: 'r9' }] });
    expect(calls.map((c) => `${c.init.method} ${c.url.replace('https://api.x.com', '')}`)).toEqual([
      'POST /api/plugin/runs/r%201/claim',
      'POST /api/plugin/runs/r%201/turn',
      'GET /api/plugin/runs/r%201/turn/2',
      'POST /api/plugin/runs/r%201/abort',
      'POST /api/studies/s1/runs/next',
    ]);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ browser: { engine: 'figma-trace', version: '0.7.0', viewport: [390, 844] }, owner: 'p_7f3a', flowMapVersion: 3 });
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual(body);
    expect(calls[2]!.init.body).toBeUndefined();
    expect(JSON.parse(calls[3]!.init.body as string)).toEqual({ owner: 'p_7f3a', code: 'render_failed', detail: 'The export was empty twice.' });
    expect(calls[4]!.init.body).toBe('{}');
    expect(calls.every((c) => (c.init.headers as Record<string, string>).Authorization === 'Bearer t')).toBe(true);
  });

  it('returns the stored record of a re-posted turn and every turn the poll can see', async () => {
    const ready = {
      turn: 2, status: 'ready', action: { type: 'click', element: 'e1' }, ended: null,
      state: { seq: 1, maxSteps: 22, unproductive: 0, maxUnproductiveSteps: 5, progress: 30, sentimentTrend: 'steady', reviewGiveUp: false, ended: false, endedReason: null },
    };
    const failed = { turn: 3, status: 'failed', error: { code: 'brain_invalid_action', message: 'action.element must be one of e1' }, ended: { status: 'aborted', reason: 'brain_invalid_action' } };
    const ending = { ...ready, turn: 4, action: null, ended: { status: 'finalizing', reason: 'patience_exhausted_twice' } };
    const { fetch } = mockFetch([{ status: 202, body: ready }, { status: 200, body: failed }, { status: 200, body: ending }]);
    const api = new ApiClient({ baseUrl: 'http://x', getToken: () => 't', fetch });
    expect(await api.postTurn('r1', body)).toEqual(ready);
    expect(await api.getTurn('r1', 3)).toEqual(failed);
    expect(await api.getTurn('r1', 4)).toEqual(ending);
  });

  it('tells the next wave from a finished study', async () => {
    const { fetch } = mockFetch([{ status: 200, body: { studyId: 's1', done: true, reason: 'every archetype agrees', wave: 2 } }]);
    const api = new ApiClient({ baseUrl: 'http://x', getToken: () => 't', fetch });
    expect(await api.nextWave('s1')).toEqual({ studyId: 's1', done: true, reason: 'every archetype agrees', wave: 2 });
  });

  it('surfaces each 409 with its code, and the turn to post for turn_out_of_order', async () => {
    const { fetch } = mockFetch([
      { status: 409, body: { error: 'turn_out_of_order', message: 'turn 3 is out of order: this run takes turn 2 next.', expected: 2 } },
      { status: 409, body: { error: 'not_owner', message: 'run r1 belongs to another panel; stop this session.' } },
      { status: 409, body: { error: 'run_ended', message: 'run r1 is aborted; stop this session.' } },
      { status: 409, body: { error: 'run_ended', message: 'run r1 is finalizing.' } },
      { status: 409, body: { error: 'wave_in_progress', message: 'Wave 1 is still running.' } },
      { status: 404, body: { error: 'turn_not_found', message: 'run r1 has no turn 9.' } },
    ]);
    const api = new ApiClient({ baseUrl: 'http://x', getToken: () => 't', fetch });
    const out = (await api.postTurn('r1', { ...body, turn: 3 }).catch((e) => e)) as ApiError;
    expect(out).toBeInstanceOf(ApiError);
    expect(out).toMatchObject({ status: 409, code: 'turn_out_of_order', expected: 2, message: 'turn 3 is out of order: this run takes turn 2 next.' });
    expect(await api.postTurn('r1', body).catch((e) => e)).toMatchObject({ status: 409, code: 'not_owner', expected: null });
    expect(await api.getTurn('r1', 2).catch((e) => e)).toMatchObject({ status: 409, code: 'run_ended' });
    expect(await api.abortRun('r1', { owner: 'p', code: 'turn_timeout', detail: 'No answer after 180 s.' }).catch((e) => e)).toMatchObject({ status: 409, code: 'run_ended' });
    expect(await api.nextWave('s1').catch((e) => e)).toMatchObject({ status: 409, code: 'wave_in_progress' });
    expect(await api.getTurn('r1', 9).catch((e) => e)).toMatchObject({ status: 404, code: 'turn_not_found' });
  });

  it('gives a turn post 60 s by default, because a backend may decide the turn inside the request', async () => {
    vi.useFakeTimers();
    try {
      const fetch: FetchLike = (_url, init) =>
        new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
      const api = new ApiClient({ baseUrl: 'http://x', getToken: () => 't', fetch });
      expect(TURN_TIMEOUT_MS).toBe(60_000);
      let settled = false;
      const post = api.postTurn('r1', body);
      post.catch(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(59_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(post).rejects.toMatchObject({ code: 'timeout' });

      let longSettled = false;
      const long = api.postTurn('r1', body, { timeoutMs: 180_000 });
      long.catch(() => {
        longSettled = true;
      });
      await vi.advanceTimersByTimeAsync(179_999);
      expect(longSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(long).rejects.toMatchObject({ code: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });
});
