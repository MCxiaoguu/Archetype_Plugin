/**
 * A small client for the Archetype API. It runs in the panel iframe (the only
 * place with network access) and knows nothing about Figma.
 */

import type { Element, TraceAction, TraceOutcome } from './proto/model';

/**
 * The error bodies the panel meets: the studies and plugin routes answer
 * `{error, message}` (error is a slug); framework errors are RFC 9457
 * problem documents (`detail` is the sentence; the slug is in `error`, or in
 * `code` on backends where `error` repeats `detail`); the device flow passes
 * Auth0's `{error, error_description}` through.
 */
export interface ApiErrorBody {
  error?: string;
  message?: string;
  code?: string;
  detail?: string;
  error_description?: string;
  request_id?: string;
  fields?: Record<string, string>;
  /** On 409 turn_out_of_order: the turn the run takes next. */
  expected?: number;
}

function errorCode(body: ApiErrorBody | null): string | null {
  if (typeof body?.code === 'string' && body.code) return body.code;
  return typeof body?.error === 'string' && body.error ? body.error : null;
}

function errorText(body: ApiErrorBody | null): string | null {
  for (const text of [body?.message, body?.detail, body?.error_description]) {
    if (typeof text === 'string' && text.trim()) return text;
  }
  return null;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly fields: Record<string, string> | null;
  /** Set on 409 turn_out_of_order: the turn the run takes next. */
  readonly expected: number | null;

  constructor(
    status: number,
    code: string,
    message: string,
    extra: { requestId?: string | null; fields?: Record<string, string> | null; expected?: number | null } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = extra.requestId ?? null;
    this.fields = extra.fields ?? null;
    this.expected = extra.expected ?? null;
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

/** Gateway answers while the device flow polls: the backend could not reach Auth0 this time. */
const TRANSIENT_STATUS = new Set([502, 503, 504]);

export const DEFAULT_TIMEOUT_MS = 30_000;
/** Building personas can take about 90 s on the backend. */
export const ARCHETYPE_TIMEOUT_MS = 180_000;
/**
 * A turn post answers at once behind a Celery worker, but a backend that
 * decides the turn inside the request (the local live server) takes the
 * model call: about 4 s, 10 to 20 s on a final turn with its debrief.
 */
export const TURN_TIMEOUT_MS = 60_000;

export function normaliseBase(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/api$/, '');
}

function friendlyMessage(status: number, body: ApiErrorBody | null, fallback: string): string {
  const text = errorText(body);
  if (text) return text;
  // 503 auth_unavailable: the backend could not reach its sign in service.
  // The token may be fine, so it is kept (only a 401 signs out).
  if (errorCode(body) === 'auth_unavailable') return 'Archetype cannot check sign ins right now. You are still signed in; try again in a minute.';
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
    let text: string;
    try {
      res = await this.doFetch(`${this.base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller?.signal,
      });
      // The timeout covers the body too: headers can arrive and the body stall.
      text = await res.text();
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
    let data: unknown = null;
    let readable = false;
    if (text) {
      try {
        data = JSON.parse(text);
        readable = true;
      } catch {
        data = null;
      }
    }
    if (res.ok && !readable) {
      // Every route the panel calls answers JSON; anything else (a proxy's
      // login page, an empty body) is not a result to act on.
      throw new ApiError(res.status, 'bad_response', `Archetype at ${this.base} sent an answer the panel could not read (HTTP ${res.status}).`);
    }
    if (res.status === 401 && auth) {
      this.opts.onUnauthorized?.();
      throw new ApiError(401, 'unauthorized', 'Your Archetype session ended. Sign in again.');
    }
    if (!res.ok) {
      const errBody = (data && typeof data === 'object' ? data : null) as ApiErrorBody | null;
      throw new ApiError(res.status, errorCode(errBody) ?? `http_${res.status}`, friendlyMessage(res.status, errBody, `Request failed (${res.status}).`), {
        requestId: errBody?.request_id ?? null,
        fields: errBody?.fields ?? null,
        expected: typeof errBody?.expected === 'number' ? errBody.expected : null,
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

  /** The next wave of runs, or done. 409 wave_in_progress while runs are still open or finalizing. */
  nextWave(id: string): Promise<NextWave> {
    return this.request<NextWave>('POST', `/api/studies/${encodeURIComponent(id)}/runs/next`, {}, { timeoutMs: 60_000 });
  }

  // Trace runs: the panel runs a plugin-mode study's personas itself

  /** 409 already_claimed when another actor has the run. */
  claimRun(runId: string, body: ClaimBody): Promise<RunBriefing> {
    return this.request<RunBriefing>('POST', `/api/plugin/runs/${encodeURIComponent(runId)}/claim`, body);
  }

  /**
   * Always 202: `{turn, status: "thinking"}` for a new turn, or the stored
   * record of a re-posted one. 409 turn_out_of_order (with `expected`),
   * not_owner or run_ended.
   */
  postTurn(runId: string, body: TurnBody, options: { timeoutMs?: number } = {}): Promise<TurnView> {
    return this.request<TurnView>('POST', `/api/plugin/runs/${encodeURIComponent(runId)}/turn`, body, {
      timeoutMs: options.timeoutMs ?? TURN_TIMEOUT_MS,
    });
  }

  getTurn(runId: string, turn: number): Promise<TurnView> {
    return this.request<TurnView>('GET', `/api/plugin/runs/${encodeURIComponent(runId)}/turn/${turn}`);
  }

  /** A failure the panel detected. 409 run_ended when the run is over or finalizing. */
  abortRun(runId: string, body: AbortBody): Promise<AbortResult> {
    return this.request<AbortResult>('POST', `/api/plugin/runs/${encodeURIComponent(runId)}/abort`, body);
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
      if (!(err instanceof ApiError)) throw err;
      // Auth0 answers 403 while pending and 429 for slow_down, other servers
      // 400: the OAuth error code decides, not the status.
      if (err.code === 'authorization_pending') return { kind: 'pending' };
      if (err.code === 'slow_down' || err.status === 429) return { kind: 'slow_down' };
      if (err.code === 'expired_token') return { kind: 'failed', code: err.code, message: 'The sign in code expired. Start again.' };
      if (err.code === 'access_denied') return { kind: 'failed', code: err.code, message: 'Sign in was cancelled in the browser.' };
      if (err.code === 'network' || err.code === 'timeout' || TRANSIENT_STATUS.has(err.status)) {
        // Transient: keep polling, the code is still valid.
        return { kind: 'pending' };
      }
      // Anything else (invalid_grant, a 500 from a backend without Auth0
      // settings) does not get better by polling until the code expires.
      return { kind: 'failed', code: err.code, message: err.message };
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
  /** The newest step the runner posted (null until the first one), for the screen a persona is on. */
  lastStep?: { seq?: number | null; url?: string | null } | null;
}

export interface StudyRuns {
  studyId: string;
  status: StudyStatusValue;
  currentWave?: number;
  runs: RunRowApi[];
}

export interface WaveRun {
  runId: string;
  archetypeId: string;
  archetypeName: string;
  repeatIndex: number;
}

/** 200 with `done` when the study needs no more runs, 201 with the new wave's runs. */
export type NextWave =
  | { studyId: string; done: true; reason: string; wave: number }
  | { studyId: string; done?: undefined; wave: number; created: boolean; runs: WaveRun[] };

// Trace runs (the backend's services/trace_turn_service.py)

export interface TraceBrowser {
  engine: 'figma-trace';
  version: string;
  viewport: [width: number, height: number];
}

export interface ClaimBody {
  browser: TraceBrowser;
  /** This panel's id; every turn and abort of the run must carry it. */
  owner: string;
}

/** The claim's briefing (only the fields the panel uses). */
export interface RunBriefing {
  runId: string;
  sessionId: string;
  claimedAt: string;
  brief: string;
  persona: { name: string };
  instructions: { targetUrl: string; goal: string };
}

export type TurnFlag = 'file_changed' | 'timer_loop' | 'missing_font';

/** What a timer fired during settle or wait that the outcome does not say. */
export interface TimerEffect {
  type: 'left_prototype' | 'unsupported';
  detail: string;
}

/** What the action turn n-1 answered did, as the engine saw it. */
export interface TurnLast {
  action: TraceAction;
  outcome: TraceOutcome;
  /** The element's label and id, such as "Continue (e4)"; null when the action had no element. */
  target: string | null;
  /** Required with the unsupported outcome, and only then: what did nothing, at most 200 characters. */
  unsupported?: string;
  /** At most 10. */
  timer_effects?: TimerEffect[];
}

export interface TurnScreen {
  url: string;
  title: string;
  frameId: string;
  overlays: string[];
  viewport: [width: number, height: number];
  scroll: { x: number; y: number; maxX: number; maxY: number };
}

export interface TurnBody {
  owner: string;
  turn: number;
  screen: TurnScreen;
  /** The viewport as a base64 JPEG, at most 1.5 MiB decoded. */
  screenshot_b64: string;
  /** At most 80, ids unique in the turn. */
  elements: Element[];
  visible_text_excerpt: string;
  /** Null on turn 1, required after it. */
  last: TurnLast | null;
  /** Required, [] when nothing applies. */
  flags: TurnFlag[];
  /** Each detail only with its flag in `flags`. */
  flag_details?: { timer_loop?: { frames: string[] }; missing_font?: { fonts: string[] } };
  elapsed_s: number;
  client_ts: string;
}

export interface TurnState {
  seq: number;
  maxSteps: number;
  unproductive: number;
  maxUnproductiveSteps: number;
  progress: number;
  sentimentTrend: 'falling' | 'steady' | 'rising';
  reviewGiveUp: boolean;
  ended: boolean;
  endedReason: string | null;
}

/** How the run ends: finalizing while the debrief is made, then its final status. */
export interface TurnEnded {
  status: 'finalizing' | 'completed' | 'abandoned' | 'aborted';
  reason: string | null;
}

/** A turn as the poll sees it. Once `ended` is set the session stops and never aborts. */
export type TurnView =
  | { turn: number; status: 'thinking' }
  /** `action` is null when patience ended the run on the step before. */
  | { turn: number; status: 'ready'; action: TraceAction | null; state: TurnState; ended: TurnEnded | null }
  | { turn: number; status: 'failed'; error: { code: string; message: string }; ended: TurnEnded };

/** The abort codes the panel may send (the backend's own finalize_failed is not one). */
export type AbortCode =
  | 'render_failed'
  | 'turn_timeout'
  | 'panel_state_lost'
  | 'file_changed'
  | 'brain_invalid_action'
  | 'model_unavailable'
  | 'debrief_invalid'
  | 'engine_error';

export interface AbortBody {
  owner: string;
  code: AbortCode;
  /** What went wrong, in a sentence; required. */
  detail: string;
}

export interface AbortResult {
  runId: string;
  status: 'aborted';
  abortReason: AbortCode;
}
