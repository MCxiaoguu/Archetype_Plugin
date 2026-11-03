/**
 * A small client for the Archetype API. It runs in the panel iframe (the only
 * place with network access) and knows nothing about Figma.
 */

export interface ApiErrorBody {
  error?: string;
  message?: string;
  request_id?: string;
  fields?: Record<string, string>;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly fields: Record<string, string> | null;

  constructor(status: number, code: string, message: string, extra: { requestId?: string | null; fields?: Record<string, string> | null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = extra.requestId ?? null;
    this.fields = extra.fields ?? null;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  baseUrl: string;
  getToken: () => string | null;
  fetch?: FetchLike;
  /** Called once per 401, before the error is thrown. */
  onUnauthorized?: () => void;
  timeoutMs?: number;
}

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

export type DevicePoll =
  | { kind: 'pending' }
  | { kind: 'slow_down' }
  | { kind: 'token'; token: TokenSet }
  | { kind: 'failed'; code: string; message: string };

export const DEFAULT_TIMEOUT_MS = 30_000;
/** Building personas can take about 90 s on the backend. */
export const ARCHETYPE_TIMEOUT_MS = 180_000;

export function normaliseBase(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/api$/, '');
}

function friendlyMessage(status: number, body: ApiErrorBody | null, fallback: string): string {
  if (body?.message) return body.message;
  if (status >= 500) return 'Archetype had a problem on its side. Try again in a moment.';
  return fallback;
}

export class ApiClient {
  private readonly base: string;
  private readonly opts: ApiClientOptions;
  private readonly doFetch: FetchLike;

  constructor(opts: ApiClientOptions) {
    this.opts = opts;
    this.base = normaliseBase(opts.baseUrl);
    const f = opts.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
    this.doFetch = f;
  }

  get baseUrl(): string {
    return this.base;
  }

  async request<T>(method: string, path: string, body?: unknown, options: { timeoutMs?: number; auth?: boolean } = {}): Promise<T> {
    const auth = options.auth !== false;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth) {
      const token = this.opts.getToken();
      if (!token) {
        this.opts.onUnauthorized?.();
        throw new ApiError(401, 'signed_out', 'Sign in to Archetype first.');
      }
      headers.Authorization = `Bearer ${token}`;
    }
    const timeoutMs = options.timeoutMs ?? this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let res: Response;
    try {
      res = await this.doFetch(`${this.base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller?.signal,
      });
    } catch (err) {
      const aborted = controller?.signal.aborted;
      throw new ApiError(
        0,
        aborted ? 'timeout' : 'network',
        aborted
          ? 'Archetype took too long to answer. It may still be working; try again in a moment.'
          : `Could not reach Archetype at ${this.base}. Check your connection or the backend address in settings.`,
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (res.status === 401 && auth) {
      this.opts.onUnauthorized?.();
      throw new ApiError(401, 'unauthorized', 'Your Archetype session ended. Sign in again.');
    }
    if (!res.ok) {
      const errBody = (data && typeof data === 'object' ? data : null) as ApiErrorBody | null;
      throw new ApiError(res.status, errBody?.error ?? `http_${res.status}`, friendlyMessage(res.status, errBody, `Request failed (${res.status}).`), {
        requestId: errBody?.request_id ?? null,
        fields: errBody?.fields ?? null,
      });
    }
    return data as T;
  }

  // Studies

  createStudy<T = StudyLike>(body: unknown): Promise<T> {
    return this.request<T>('POST', '/api/studies', body);
  }

  getStudy<T = StudyLike>(id: string): Promise<T> {
    return this.request<T>('GET', `/api/studies/${encodeURIComponent(id)}`);
  }

  identifyFactors(id: string): Promise<unknown> {
    return this.request('POST', `/api/studies/${encodeURIComponent(id)}/factors`, {}, { timeoutMs: 90_000 });
  }

  buildArchetypes(id: string): Promise<unknown> {
    return this.request('POST', `/api/studies/${encodeURIComponent(id)}/archetypes`, {}, { timeoutMs: ARCHETYPE_TIMEOUT_MS });
  }

  startRuns(id: string): Promise<unknown> {
    return this.request('POST', `/api/studies/${encodeURIComponent(id)}/runs`, {}, { timeoutMs: 60_000 });
  }

  getStatus<T = StudyStatus>(id: string): Promise<T> {
    return this.request<T>('GET', `/api/studies/${encodeURIComponent(id)}/status`);
  }

  getRuns<T = StudyRuns>(id: string): Promise<T> {
    return this.request<T>('GET', `/api/studies/${encodeURIComponent(id)}/runs`);
  }

  getReport<T = unknown>(id: string): Promise<T> {
    return this.request<T>('GET', `/api/studies/${encodeURIComponent(id)}/report`, undefined, { timeoutMs: 90_000 });
  }

  /** One run's steps (for the screen a persona is on right now). */
  getRunReport<T = RunReport>(runId: string): Promise<T> {
    return this.request<T>('GET', `/api/plugin/runs/${encodeURIComponent(runId)}/report`);
  }

  // Device flow (no bearer token)

  startDeviceFlow(): Promise<DeviceCode> {
    return this.request<DeviceCode>('POST', '/api/oauth/device/code', {}, { auth: false });
  }

  async pollDeviceToken(deviceCode: string): Promise<DevicePoll> {
    try {
      const token = await this.request<TokenSet>('POST', '/api/oauth/device/token', { device_code: deviceCode }, { auth: false });
      if (!token || typeof token.access_token !== 'string' || !token.access_token) {
        return { kind: 'failed', code: 'bad_response', message: 'Archetype answered without a token. Try signing in again.' };
      }
      return { kind: 'token', token };
    } catch (err) {
      if (err instanceof ApiError && (err.status === 403 || err.status === 400 || err.status === 428)) {
        if (err.code === 'authorization_pending') return { kind: 'pending' };
        if (err.code === 'slow_down') return { kind: 'slow_down' };
        if (err.code === 'expired_token') return { kind: 'failed', code: err.code, message: 'The sign in code expired. Start again.' };
        if (err.code === 'access_denied') return { kind: 'failed', code: err.code, message: 'Sign in was cancelled in the browser.' };
        return { kind: 'failed', code: err.code, message: err.message };
      }
      if (err instanceof ApiError && (err.code === 'network' || err.code === 'timeout' || err.status >= 500)) {
        // Transient: keep polling, the code is still valid.
        return { kind: 'pending' };
      }
      throw err;
    }
  }
}

export interface DeviceFlowHooks {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Return true to stop polling (the person cancelled or closed the screen). */
  cancelled?: () => boolean;
}

export type DeviceFlowResult =
  | { kind: 'token'; token: TokenSet }
  | { kind: 'failed'; code: string; message: string }
  | { kind: 'cancelled' };

/**
 * Polls the token endpoint every `interval` seconds until the person approves,
 * the code expires, or the caller cancels. `slow_down` adds 5 s to the interval.
 */
export async function pollDeviceFlow(api: Pick<ApiClient, 'pollDeviceToken'>, code: DeviceCode, hooks: DeviceFlowHooks): Promise<DeviceFlowResult> {
  let interval = Math.max(1, code.interval || 5) * 1000;
  const deadline = hooks.now() + Math.max(30, code.expires_in || 900) * 1000;
  for (;;) {
    await hooks.sleep(interval);
    if (hooks.cancelled?.()) return { kind: 'cancelled' };
    if (hooks.now() > deadline) return { kind: 'failed', code: 'expired_token', message: 'The sign in code expired. Start again.' };
    const r = await api.pollDeviceToken(code.device_code);
    if (hooks.cancelled?.()) return { kind: 'cancelled' };
    if (r.kind === 'token') return r;
    if (r.kind === 'failed') return r;
    if (r.kind === 'slow_down') interval += 5000;
  }
}

// Response shapes the panel reads (only the fields it uses).

export interface StudyLike {
  studyId: string;
  title: string;
  status: StudyStatusValue;
  createdAt?: string;
  updatedAt?: string;
  archetypes?: { archetypeId: string; name: string; role: string }[];
}

export type StudyStatusValue = 'draft' | 'factors_ready' | 'archetypes_ready' | 'running' | 'complete' | 'failed';

export interface StudyStatus {
  studyId: string;
  status: StudyStatusValue;
  archetypeCount: number;
  factorSpecReady: boolean;
  runs: { allTerminal: boolean; byStatus: Record<string, number>; terminal: number; total: number };
  updatedAt: string;
}

export interface RunRowApi {
  runId: string;
  archetypeId: string;
  archetypeName: string;
  role?: string;
  status: string;
  wave?: number;
  repeatIndex?: number;
  metrics?: { steps?: number | null; frustrationScore?: number | null } | null;
  outcome?: { completed?: boolean | null; quitReason?: string | null; abandonedAtStep?: number | null } | null;
  /** Newer backends add the latest step's URL; older ones do not. */
  lastUrl?: string | null;
  lastStep?: { seq?: number; url?: string | null } | null;
  currentUrl?: string | null;
}

export interface StudyRuns {
  studyId: string;
  status: StudyStatusValue;
  currentWave?: number;
  runs: RunRowApi[];
}

export interface RunReport {
  status?: string;
  steps?: { seq?: number; url?: string | null }[];
}
