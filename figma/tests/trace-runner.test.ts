import { describe, expect, it, vi } from 'vitest';
import { ApiError, type AbortBody, type ClaimBody, type RunRowApi, type TurnBody, type TurnView } from '../src/lib/api';
import type { SavedSession } from '../src/lib/messages';
import { start } from '../src/lib/proto/engine';
import type { TraceState } from '../src/lib/proto/model';
import type { RunnerStatus } from '../src/lib/runs';
import { runStudy, WAVE_RETRY_MS, WAVE_WAIT_MS, type RunnerResult, type StudyTrace } from '../src/ui/trace/runner';
import type { SessionStatus } from '../src/ui/trace/session';
import { clock, click, DONE, lastOf, mainThread, type Decision, type MainThread } from './trace-fakes';

const OWNER = 'p_owner1';
const STATE = { seq: 1, maxSteps: 22, unproductive: 0, maxUnproductiveSteps: 5, progress: 30, sentimentTrend: 'steady' as const, reviewGiveUp: false, ended: false, endedReason: null };
const TERMINAL = new Set(['completed', 'failed', 'aborted', 'abandoned']);

/** Two steps: from the Dashboard to Billing settings, and done there. */
const shortWalk = (_runId: string, body: TurnBody): Decision => (body.screen.title === 'Dashboard' ? { action: click(body, 'Billing') } : DONE);

// --- The backend: a study's runs, claims, turns and waves ------------------------

interface BackendOptions {
  runs: Array<{ runId: string; status: string; owner?: string }>;
  /** The run ids of each wave `nextWave` creates, in order. */
  waves?: string[][];
  /** How many times `nextWave` answers wave_in_progress after every run ended (a debrief still running). */
  busy?: number;
  /** Claims the backend refuses with these errors, claiming nothing. */
  claimErrors?: Record<string, unknown[]>;
  /** Claims the backend makes, whose answer is then lost with these errors. */
  lostClaims?: Record<string, unknown[]>;
  /** Runs another actor claims just before this panel's claim reaches the backend. */
  takenBy?: Record<string, string>;
  /** The next wave is made, then its answer is lost with this error. */
  lostNextWave?: unknown;
  /** The next wave's answer, as the backend sends it, when it can't be read. */
  badNextWave?: unknown;
  postErrors?: Record<string, unknown[]>;
  onClaim?: (runId: string) => void;
  /** Claims that reach the backend only once these settle. */
  claimWaits?: Record<string, Promise<void>>;
  onPost?: (runId: string, turn: number) => void;
}

function studyBackend(brain: (runId: string, body: TurnBody) => Decision, opts: BackendOptions, log: string[]) {
  const rows: Array<RunRowApi & { owner?: string }> = opts.runs.map((r) => ({ archetypeId: `a-${r.runId}`, archetypeName: `Persona ${r.runId}`, ...r }));
  const waves = [...(opts.waves ?? [])];
  let busy = opts.busy ?? 0;
  let wave = 1;
  const claims: Array<{ runId: string; body: ClaimBody }> = [];
  const posted: Array<{ runId: string; body: TurnBody }> = [];
  const aborted: Array<{ runId: string } & AbortBody> = [];
  const decisions = new Map<string, Decision>();
  const row = (runId: string) => {
    const found = rows.find((r) => r.runId === runId);
    if (!found) throw new ApiError(404, 'run_not_found', `No run ${runId}.`);
    return found;
  };
  const api = {
    getRuns: vi.fn(async (studyId: string) => ({ studyId, status: 'running' as const, runs: rows.map((r) => ({ ...r })) })),
    claimRun: vi.fn(async (runId: string, body: ClaimBody) => {
      await opts.claimWaits?.[runId];
      const refused = opts.claimErrors?.[runId]?.shift();
      if (refused) throw refused;
      const r = row(runId);
      const other = opts.takenBy?.[runId];
      if (other && r.status === 'queued') Object.assign(r, { status: 'running', owner: other });
      const briefing = { runId, sessionId: `sess-${runId}`, claimedAt: '2026-11-10T10:00:00Z', brief: '', persona: { name: r.archetypeName }, instructions: { targetUrl: '', goal: '' } };
      // As the backend does since 2f16ec9: the run's own owner, claiming again after a lost answer, gets the briefing again.
      if (r.status === 'running' && r.owner === body.owner) return briefing;
      if (r.status !== 'queued') throw new ApiError(409, 'already_claimed', `run ${runId} is ${r.status}, not queued, so it cannot be claimed again.`);
      Object.assign(r, { status: 'running', owner: body.owner });
      claims.push({ runId, body: structuredClone(body) });
      log.push(`claim ${runId}`);
      opts.onClaim?.(runId);
      const lost = opts.lostClaims?.[runId]?.shift();
      if (lost) throw lost;
      return briefing;
    }),
    postTurn: vi.fn(async (runId: string, body: TurnBody): Promise<TurnView> => {
      const error = opts.postErrors?.[runId]?.shift();
      if (error) throw error;
      posted.push({ runId, body: structuredClone(body) });
      log.push(`post ${runId} ${body.turn}`);
      opts.onPost?.(runId, body.turn);
      const key = `${runId}/${body.turn}`;
      if (!decisions.has(key)) decisions.set(key, brain(runId, body));
      return { turn: body.turn, status: 'thinking' };
    }),
    getTurn: vi.fn(async (runId: string, n: number): Promise<TurnView> => {
      const d = decisions.get(`${runId}/${n}`);
      if (!d) return { turn: n, status: 'thinking' };
      if (d.ended) row(runId).status = 'failed' in d ? 'aborted' : 'completed';
      if ('failed' in d) return { turn: n, status: 'failed', error: d.failed, ended: d.ended };
      return { turn: n, status: 'ready', action: d.action, state: STATE, ended: d.ended ?? null };
    }),
    abortRun: vi.fn(async (runId: string, body: AbortBody) => {
      aborted.push({ runId, ...body });
      row(runId).status = 'aborted';
      log.push(`abort ${runId}`);
      return { runId, status: 'aborted' as const, abortReason: body.code };
    }),
    nextWave: vi.fn(async (studyId: string) => {
      log.push('next');
      if (rows.some((r) => !TERMINAL.has(r.status)) || busy-- > 0) {
        throw new ApiError(409, 'wave_in_progress', 'Runs are still open; wait until every run is completed, failed, aborted or abandoned.');
      }
      const ids = waves.shift();
      if (!ids) return { studyId, done: true as const, reason: 'every wave ran', wave };
      wave++;
      for (const runId of ids) rows.push({ runId, archetypeId: `a-${runId}`, archetypeName: `Persona ${runId}`, status: 'queued', wave });
      if (opts.lostNextWave) {
        const lost = opts.lostNextWave;
        delete opts.lostNextWave;
        throw lost;
      }
      if (opts.badNextWave) return opts.badNextWave as never;
      return { studyId, wave, created: true, runs: ids.map((runId, i) => ({ runId, archetypeId: `a-${runId}`, archetypeName: `Persona ${runId}`, repeatIndex: i })) };
    }),
  };
  return { api, rows, claims, posted, aborted };
}

async function runner(
  brain: (runId: string, body: TurnBody) => Decision,
  opts: BackendOptions & {
    main?: MainThread;
    /** The backend of an earlier runner on the same study, as the panel finds it on reopening. */
    server?: ReturnType<typeof studyBackend>;
    study?: (main: MainThread) => Partial<StudyTrace>;
    fails?: boolean;
    signal?: AbortSignal;
  },
) {
  const main = opts.main ?? (await mainThread());
  // One log for the main thread and the backend, in the order things happened.
  const log = main.log;
  const server = opts.server ?? studyBackend(brain, opts, log);
  const time = clock();
  const sessions: SessionStatus[] = [];
  const statuses: RunnerStatus[] = [];
  const study: StudyTrace = { studyId: 's1', owner: OWNER, doc: main.doc, shareKey: null, startFrameId: '1:2', ...opts.study?.(main) };
  let result: RunnerResult | null = null;
  let error: unknown = null;
  try {
    result = await runStudy(study, {
      bridge: main.bridge,
      api: server.api,
      now: time.now,
      sleep: time.sleep,
      pluginVersion: '0.4.0',
      onSession: (s) => sessions.push(s),
      onRunner: (s) => statuses.push(s),
      watchFile: () => () => {},
      signal: opts.signal,
    });
  } catch (err) {
    if (!opts.fails) throw err;
    error = err;
  }
  if (opts.fails && !error) throw new Error('The runner was meant to fail');
  return { ...server, backend: server, result: result as RunnerResult, error, log, sessions, statuses, time, main };
}

const postsOf = (posted: Array<{ runId: string; body: TurnBody }>, runId: string) => posted.filter((p) => p.runId === runId).map((p) => p.body);

/** A run this panel saved after turn `turn`, on the Dashboard. */
function savedSession(main: MainThread, runId: string, change: { owner?: string; turn?: number; state?: Partial<TraceState> } = {}): SavedSession {
  return {
    owner: change.owner ?? OWNER,
    runId,
    turn: change.turn ?? 2,
    state: { ...start(main.doc, '1:2'), ...change.state },
    lastOutcome: { action: { type: 'click', element: 'e1' }, outcome: 'nothing_happened', target: 'Welcome back, Mara (e1)' },
    timerEffects: [],
    loopFrames: [],
  };
}

function store(main: MainThread, ...sessions: SavedSession[]) {
  main.stored.set('s1', new Map(sessions.map((s) => [s.runId, s])));
}

// --- Waves ------------------------------------------------------------------------

describe('running a study in the panel', () => {
  it('claims every queued run of the wave with one owner and runs their sessions side by side', async () => {
    const { result, claims, posted, log, sessions, statuses } = await runner(shortWalk, {
      runs: [{ runId: 'r1', status: 'queued' }, { runId: 'r2', status: 'queued' }, { runId: 'r0', status: 'completed' }],
    });
    expect(claims).toEqual([
      { runId: 'r1', body: { owner: OWNER, browser: { engine: 'figma-trace', version: '0.4.0', viewport: [1280, 800] } } },
      { runId: 'r2', body: { owner: OWNER, browser: { engine: 'figma-trace', version: '0.4.0', viewport: [1280, 800] } } },
    ]);
    expect(posted.map((p) => [p.runId, p.body.turn, p.body.owner])).toEqual(expect.arrayContaining([['r1', 1, OWNER], ['r1', 2, OWNER], ['r2', 1, OWNER], ['r2', 2, OWNER]]));
    expect(posted).toHaveLength(4);
    // Side by side: the second persona's first turn goes out before the first persona's second.
    expect(log.indexOf('post r2 1')).toBeLessThan(log.indexOf('post r1 2'));
    expect(result).toEqual({ stop: 'done', reason: 'every wave ran', sessions: [expect.objectContaining({ runId: 'r1', stop: 'ended' }), expect.objectContaining({ runId: 'r2', stop: 'ended' })] });

    // Each persona's view for the Running screen comes from its own session.
    expect(lastOf(sessions.filter((s) => s.runId === 'r1'))).toMatchObject({ phase: 'ended', frameName: 'Billing settings', turn: 2 });
    expect(lastOf(sessions.filter((s) => s.runId === 'r2'))).toMatchObject({ phase: 'ended', frameName: 'Billing settings', turn: 2 });
    expect(lastOf(statuses)).toEqual({ phase: 'done', notice: null });

    // Scratch leftovers go once the last session ended, before the next wave is asked for.
    const cleanup = log.indexOf('cleanup');
    expect(cleanup).toBeGreaterThan(log.indexOf('save r1 null'));
    expect(cleanup).toBeGreaterThan(log.indexOf('save r2 null'));
    expect(cleanup).toBeLessThan(log.indexOf('next'));
  });

  it('asks for the next wave once every session ended, waits through wave_in_progress, and stops at done', async () => {
    const { result, log, time, statuses, claims } = await runner(shortWalk, { runs: [{ runId: 'r1', status: 'queued' }], waves: [['r2', 'r3']], busy: 3 });
    const steps = log.filter((l) => !l.startsWith('save') && !l.startsWith('post'));
    expect(steps).toEqual(['claim r1', 'cleanup', 'next', 'next', 'next', 'next', 'claim r2', 'claim r3', 'cleanup', 'next']);
    expect(time.waits.filter((w) => w === WAVE_RETRY_MS)).toHaveLength(3);
    expect(statuses.map((s) => s.phase)).toEqual(expect.arrayContaining(['running', 'next_wave', 'done']));
    expect(claims.map((c) => c.body.owner)).toEqual([OWNER, OWNER, OWNER]);
    expect(result).toMatchObject({ stop: 'done', reason: 'every wave ran' });
    expect(result.sessions.map((s) => s.runId)).toEqual(['r1', 'r2', 'r3']);
  });

  it('stops waiting for the next wave after 5 minutes, naming the open runs this panel is not running', async () => {
    const { result, log, time } = await runner(shortWalk, { runs: [{ runId: 'r1', status: 'queued' }, { runId: 'rX', status: 'running', owner: 'p_other' }] });
    expect(result).toMatchObject({ stop: 'stuck', message: expect.stringMatching(/Persona rX.*this panel isn't running.*Try again/) });
    const waited = time.waits.filter((w) => w === WAVE_RETRY_MS).length * WAVE_RETRY_MS;
    expect(waited).toBeGreaterThanOrEqual(WAVE_WAIT_MS);
    expect(waited).toBeLessThan(WAVE_WAIT_MS + 2 * WAVE_RETRY_MS);
    expect(lastOf(log)).toBe('next');
  });

  it('says the next round has not started when no run is open and the backend still waits', async () => {
    const { result } = await runner(shortWalk, { runs: [{ runId: 'r1', status: 'queued' }], busy: Infinity });
    expect(result).toMatchObject({ stop: 'stuck', message: expect.stringMatching(/hasn't started the next round.*Try again/) });
    expect((result as { message: string }).message).not.toMatch(/storing/);
  });

  it('leaves a run another actor claimed first to that actor', async () => {
    const { claims, posted, result } = await runner(shortWalk, { runs: [{ runId: 'r1', status: 'queued' }, { runId: 'r2', status: 'queued' }], takenBy: { r2: 'p_other' } });
    expect(claims.map((c) => c.runId)).toEqual(['r1']);
    expect(postsOf(posted, 'r2')).toEqual([]);
    expect(result.sessions.map((s) => s.runId)).toEqual(['r1']);
  });

  it('pauses claims through network loss, and keeps a claim whose answer was lost as its own', async () => {
    const offline = () => new ApiError(0, 'network', 'Could not reach Archetype.');
    const { claims, statuses, time, result, api } = await runner(shortWalk, { runs: [{ runId: 'r1', status: 'queued' }], claimErrors: { r1: [offline()] }, lostClaims: { r1: [offline()] } });
    // Not made, made with its answer lost, then the same briefing again.
    expect(api.claimRun).toHaveBeenCalledTimes(3);
    expect(claims.map((c) => c.runId)).toEqual(['r1']);
    expect(statuses).toContainEqual({ phase: 'paused', notice: 'Lost touch with Archetype. Retrying.' });
    expect(time.waits.slice(0, 2)).toEqual([2_000, 4_000]);
    expect(result).toMatchObject({ stop: 'done', sessions: [{ runId: 'r1', stop: 'ended' }] });
  });

  it('comes back from a pause once every paused claim is through, whatever order they recover in', async () => {
    const offline = () => new ApiError(0, 'network', 'Could not reach Archetype.');
    const { statuses } = await runner(shortWalk, {
      runs: [{ runId: 'r1', status: 'queued' }, { runId: 'r2', status: 'queued' }],
      claimErrors: { r1: [offline()], r2: [offline(), offline()] },
    });
    const lastPause = statuses.map((s) => s.phase).lastIndexOf('paused');
    expect(statuses[lastPause + 1]).toEqual({ phase: 'running', notice: null });
    expect(statuses.slice(lastPause + 1).some((s) => s.phase === 'paused')).toBe(false);
  });

  it('stops when the panel closes, leaving every run where it was to resume', async () => {
    const closing = new AbortController();
    const brain = (runId: string, body: TurnBody): Decision => {
      if (runId === 'r1' && body.turn === 2) closing.abort();
      return shortWalk(runId, body);
    };
    const { result, log, aborted, main } = await runner(brain, { runs: [{ runId: 'r1', status: 'queued' }, { runId: 'r2', status: 'queued' }], signal: closing.signal });
    expect(result).toMatchObject({ stop: 'cancelled', sessions: [{ runId: 'r1', stop: 'cancelled' }, { runId: 'r2', stop: 'cancelled' }] });
    expect(aborted).toEqual([]);
    expect(log).not.toContain('cleanup');
    expect(log).not.toContain('next');
    expect([...(main.stored.get('s1')?.keys() ?? [])].sort()).toEqual(['r1', 'r2']);
  });

  it("takes only already_claimed for another actor's run; another refusal fails the runner once the rest ran", async () => {
    const odd = new ApiError(409, 'not_editable', 'This study is archived.');
    const gone = new ApiError(404, 'run_not_found', 'No run r3 for this user.');
    const { error, posted, log } = await runner(shortWalk, {
      runs: [{ runId: 'r1', status: 'queued' }, { runId: 'r2', status: 'queued' }, { runId: 'r3', status: 'queued' }],
      claimErrors: { r1: [odd], r3: [gone] },
      fails: true,
    });
    // r2's claim and session did not wait for the others, and ran to the end.
    expect(postsOf(posted, 'r2').map((b) => b.turn)).toEqual([1, 2]);
    expect(log).toContain('save r2 null');
    expect((error as Error).message).toMatch(/r1.*This study is archived\./);
    expect((error as Error).message).toMatch(/r3.*No run r3 for this user\./);
    expect(log).not.toContain('next');
  });

  it('starts each run as soon as its own claim is through, without waiting for the others', async () => {
    let r1Posted = () => {};
    const posted1 = new Promise<void>((resolve) => (r1Posted = resolve));
    const { log, result } = await runner(shortWalk, {
      runs: [{ runId: 'r1', status: 'queued' }, { runId: 'r2', status: 'queued' }],
      // r2's claim is slow: it gets through only after r1 took its first turn.
      claimWaits: { r2: posted1 },
      onPost: (runId, turn) => runId === 'r1' && turn === 1 && r1Posted(),
    });
    expect(log.indexOf('post r1 1')).toBeLessThan(log.indexOf('claim r2'));
    expect(result).toMatchObject({ stop: 'done', sessions: [{ runId: 'r1', stop: 'ended' }, { runId: 'r2', stop: 'ended' }] });
  });

  it('saves each run at turn 0 as soon as it is claimed, so a panel closed right after the claims resumes them all', async () => {
    const closing = new AbortController();
    const main = await mainThread();
    const runs = [{ runId: 'r1', status: 'queued' }, { runId: 'r2', status: 'queued' }];
    let claimed = 0;
    const first = await runner(shortWalk, { main, runs, signal: closing.signal, onClaim: () => ++claimed === 2 && closing.abort() });
    // Closed before either session started: no session runs on, and both runs are saved.
    expect(first.result).toEqual({ stop: 'cancelled', sessions: [] });
    const turn0 = (runId: string) => ({ owner: OWNER, runId, turn: 0, state: start(main.doc, '1:2'), lastOutcome: null, timerEffects: [], loopFrames: [] });
    expect([...(main.stored.get('s1')?.values() ?? [])]).toEqual([turn0('r1'), turn0('r2')]);
    expect(first.claims.map((c) => c.runId)).toEqual(['r1', 'r2']);

    // Reopened: both runs go on under this owner, neither claimed again.
    const again = await runner(shortWalk, { main, runs, server: first.backend });
    expect(again.result).toMatchObject({ stop: 'done', sessions: [{ runId: 'r1', stop: 'ended' }, { runId: 'r2', stop: 'ended' }] });
    expect(first.claims.map((c) => c.runId)).toEqual(['r1', 'r2']);
    expect(postsOf(first.posted, 'r1').map((b) => b.turn)).toEqual([1, 2]);
    expect(postsOf(first.posted, 'r2').map((b) => b.turn)).toEqual([1, 2]);
    expect(main.stored.get('s1')?.size ?? 0).toBe(0);
  });

  it('claims and runs a wave whose answer was lost, when the backend says one is in progress', async () => {
    const lost = new ApiError(0, 'network', 'Could not reach Archetype.');
    const { claims, result, log } = await runner(shortWalk, { runs: [{ runId: 'r1', status: 'queued' }], waves: [['r2']], lostNextWave: lost });
    expect(claims.map((c) => c.runId)).toEqual(['r1', 'r2']);
    expect(log.filter((l) => l === 'next')).toHaveLength(3);
    expect(result).toMatchObject({ stop: 'done', sessions: [{ runId: 'r1' }, { runId: 'r2' }] });
  });

  it('fails loudly on a next wave it cannot read', async () => {
    const { error } = await runner(shortWalk, { runs: [{ runId: 'r1', status: 'queued' }], waves: [['r2']], badNextWave: { studyId: 's1', wave: 2, created: true }, fails: true });
    expect((error as Error).message).toMatch(/next wave/);
  });

  it('lets the other sessions finish, then fails loudly, when one session breaks', async () => {
    const broken = new TypeError('Cannot read properties of undefined');
    const { error, posted, log } = await runner(shortWalk, { runs: [{ runId: 'r1', status: 'queued' }, { runId: 'r2', status: 'queued' }], postErrors: { r1: [broken] }, fails: true });
    expect(error).toBe(broken);
    expect(postsOf(posted, 'r2').map((b) => b.turn)).toEqual([1, 2]);
    expect(log).toContain('save r2 null');
    // Nothing more happens for the study until the designer tries again.
    expect(log).not.toContain('next');
  });
});

// --- Resume -----------------------------------------------------------------------

describe('resuming when the panel reopens', () => {
  it('continues only runs this panel saved and the backend still runs, and leaves the rest alone', async () => {
    const main = await mainThread();
    const theirs = savedSession(main, 'r2', { owner: 'p_other_panel' });
    store(main, savedSession(main, 'r1'), theirs, savedSession(main, 'r4'), savedSession(main, 'r6'));
    const { claims, posted, result, main: m } = await runner(shortWalk, {
      main,
      runs: [
        { runId: 'r1', status: 'running' },
        { runId: 'r2', status: 'running' },
        { runId: 'r3', status: 'running' },
        { runId: 'r4', status: 'completed' },
        { runId: 'r5', status: 'queued' },
        { runId: 'r6', status: 'aborted' },
      ],
    });
    // r1 goes on from its saved turn, under the same owner, without a claim.
    expect(postsOf(posted, 'r1').map((b) => [b.turn, b.owner])).toEqual([[3, OWNER], [4, OWNER]]);
    expect(postsOf(posted, 'r1')[0]?.last).toEqual(savedSession(main, 'r1').lastOutcome);
    // r2 is another panel's, r3 has no saved state: both are left alone.
    expect(postsOf(posted, 'r2')).toEqual([]);
    expect(postsOf(posted, 'r3')).toEqual([]);
    expect(m.stored.get('s1')?.get('r2')).toEqual(theirs);
    // r4 ended and the watchdog aborted r6 while the panel was closed: their saved state goes.
    for (const runId of ['r4', 'r6']) {
      expect(postsOf(posted, runId)).toEqual([]);
      expect(m.stored.get('s1')?.has(runId)).toBe(false);
    }
    // The queued run is claimed as usual.
    expect(claims.map((c) => c.runId)).toEqual(['r5']);
    expect(postsOf(posted, 'r5').map((b) => b.turn)).toEqual([1, 2]);
    // The runs left alone keep the wave open.
    expect(result).toMatchObject({ stop: 'stuck' });
  });

  it('flags every resumed run with file_changed when the file changed since they were saved', async () => {
    const main = await mainThread();
    store(main, savedSession(main, 'r1', { state: { docHash: 'before-the-edit' } }), savedSession(main, 'r2', { state: { docHash: 'before-the-edit' } }));
    const { posted, sessions } = await runner(shortWalk, { main, runs: [{ runId: 'r1', status: 'running' }, { runId: 'r2', status: 'running' }] });
    for (const runId of ['r1', 'r2']) {
      expect(postsOf(posted, runId).every((b) => b.flags.includes('file_changed'))).toBe(true);
      expect(lastOf(sessions.filter((s) => s.runId === runId)).notices.some((n) => /file changed/.test(n))).toBe(true);
    }
  });

  it('aborts a resumed run with file_changed when the frame it was on is gone', async () => {
    const main = await mainThread();
    store(main, savedSession(main, 'r1', { state: { frameId: '9:99' } }));
    const { aborted, posted, main: m, result } = await runner(shortWalk, { main, runs: [{ runId: 'r1', status: 'running' }] });
    expect(aborted).toEqual([{ runId: 'r1', owner: OWNER, code: 'file_changed', detail: expect.stringContaining('9:99') }]);
    expect(postsOf(posted, 'r1')).toEqual([]);
    expect(m.stored.get('s1')?.has('r1')).toBe(false);
    expect(result).toMatchObject({ stop: 'done', sessions: [{ runId: 'r1', stop: 'aborted' }] });
  });
});
