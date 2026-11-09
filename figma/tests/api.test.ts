import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError, normaliseBase, pollDeviceFlow, type DeviceCode, type FetchLike } from '../src/lib/api';

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
    const { fetch, calls } = mockFetch(Array.from({ length: 8 }, () => ({ status: 200, body: {} })));
    const api = new ApiClient({ baseUrl: 'https://api.x.com', getToken: () => 't', fetch });
    await api.identifyFactors('s1');
    await api.buildArchetypes('s1');
    await api.startRuns('s1');
    await api.getStatus('s1');
    await api.getRuns('s1');
    await api.getReport('s1');
    await api.getStudy('s1');
    await api.getRunReport('r1');
    expect(calls.map((c) => `${c.init.method} ${c.url.replace('https://api.x.com', '')}`)).toEqual([
      'POST /api/studies/s1/factors',
      'POST /api/studies/s1/archetypes',
      'POST /api/studies/s1/runs',
      'GET /api/studies/s1/status',
      'GET /api/studies/s1/runs',
      'GET /api/studies/s1/report',
      'GET /api/studies/s1',
      'GET /api/plugin/runs/r1/report',
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
    const { fetch, calls } = mockFetch([
      { status: 403, body: { error: 'authorization_pending', error_description: 'waiting' } },
      { status: 403, body: { error: 'slow_down' } },
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

  it('keeps polling through network blips and 5xx', async () => {
    const { fetch } = mockFetch([new TypeError('offline'), { status: 502, body: { error: 'auth0_unreachable' } }, { status: 200, body: { access_token: 'ok' } }]);
    const api = new ApiClient({ baseUrl: 'http://x', getToken: () => null, fetch });
    const r = await pollDeviceFlow(api, code, { sleep: async () => undefined, now: () => 0 });
    expect(r).toMatchObject({ kind: 'token', token: { access_token: 'ok' } });
  });

  it('fails on a 200 without a token', async () => {
    const { fetch } = mockFetch([{ status: 200, body: { nope: true } }]);
    const api = new ApiClient({ baseUrl: 'http://x', getToken: () => null, fetch });
    expect(await api.pollDeviceToken('d')).toMatchObject({ kind: 'failed', code: 'bad_response' });
  });
});
