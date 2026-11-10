/**
 * A whole plugin-mode study in the panel (spec, Data flow 3, 9 and 10). The
 * runner claims every queued run of the wave under this panel's owner id,
 * runs their sessions side by side, and once all of them ended asks the
 * backend for the next wave, until it says the study is done. Each new wave
 * plays the prototype read again for it, so the file as it is then; a
 * session that starts on a read the file changed after is flagged. When the
 * panel reopens, it first resumes the runs it owns; when it closes (the
 * signal), every session stops where it is, to resume then.
 *
 * No DOM and no figma globals: the bridge, the API, the clock and the status
 * callbacks come in, so the live driver runs the same runner in Node.
 */

import { ApiError, type ApiClient, type ClaimBody, type NextWave, type RunRowApi, type StudyRuns } from '../../lib/api';
import { SAVED_SESSION_VERSION, type SavedSession } from '../../lib/messages';
import { start } from '../../lib/proto/engine';
import type { ProtoDoc, TraceState } from '../../lib/proto/model';
import { isTerminalRun } from '../../lib/poll';
import type { RunnerStatus } from '../../lib/runs';
import type { Bridge } from './bridge';
import { NOTICE, pauseFor, RETRY_FIRST_MS, RETRY_MAX_MS, runSession, type SessionDeps, type SessionResult, type SessionRun, type SessionStatus } from './session';

/** Finalizing runs keep the wave open; the runner waits this long for the next one (spec, Error handling). */
export const WAVE_WAIT_MS = 5 * 60_000;
export const WAVE_RETRY_MS = 5_000;

/** A read of the prototype, and whether the main thread reported the file changed since the read was sent. */
export interface DocRead {
  doc: ProtoDoc;
  changed: () => boolean;
}

export interface StudyTrace {
  studyId: string;
  /** This panel's id for the study's runs: every claim, turn and abort carries it. */
  owner: string;
  /** The prototype, read for this runner as it starts. */
  read: DocRead;
  /** The share link's file key; null without a link. */
  shareKey: string | null;
  startFrameId: string;
}

export interface RunnerDeps {
  bridge: Pick<Bridge, 'call'>;
  api: Pick<ApiClient, 'claimRun' | 'nextWave' | 'postTurn' | 'getTurn' | 'abortRun'> & { getRuns(studyId: string): Promise<StudyRuns> };
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** The claim's browser version. */
  pluginVersion: string;
  onSession: (status: SessionStatus) => void;
  onRunner: (status: RunnerStatus) => void;
  watchFile: SessionDeps['watchFile'];
  /** Reads the prototype again, for a new wave. */
  readDoc: () => Promise<DocRead>;
  postTurnTimeoutMs?: number;
  /** Fires when the panel closes. */
  signal?: AbortSignal;
}

export type RunnerResult =
  | { stop: 'done'; reason: string; sessions: SessionResult[] }
  /** wave_in_progress outlasted WAVE_WAIT_MS: the panel offers Try again, which resumes. */
  | { stop: 'stuck'; message: string; sessions: SessionResult[] }
  /** The panel closed: the runs resume when it reopens. */
  | { stop: 'cancelled'; sessions: SessionResult[] };

/** The panel is closing: the runner stops where it is. */
class Cancelled extends Error {
  constructor() {
    super('The panel closed.');
  }
}

export async function runStudy(study: StudyTrace, deps: RunnerDeps): Promise<RunnerResult> {
  const results: SessionResult[] = [];
  const started = new Map<string, Promise<SessionResult>>();
  try {
    return await run(study, deps, results, started);
  } catch (err) {
    if (!(err instanceof Cancelled)) throw err;
    // Every session has the same signal and stops at its next step: the runner stops once they have.
    const settled = await Promise.allSettled(started.values());
    for (const s of settled) if (s.status === 'fulfilled' && !results.includes(s.value)) results.push(s.value);
    // A session that broke (a cancel never rejects) stays loud, closing panel or not.
    const broke = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
    if (broke) throw broke.reason;
    return { stop: 'cancelled', sessions: results };
  }
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The persona names of runs, for the designer: "Baseline founder and Low trust founder". */
function names(runs: readonly RunRowApi[]): string {
  const all = [...new Set(runs.map((r) => r.archetypeName || r.runId))];
  return all.length > 1 ? `${all.slice(0, -1).join(', ')} and ${all[all.length - 1]}` : (all[0] ?? '');
}

/** Why the next wave hasn't started after WAVE_WAIT_MS, from the runs as the backend lists them. */
function stuckMessage(runs: readonly RunRowApi[], ours: ReadonlySet<string>): string {
  const open = runs.filter((r) => !isTerminalRun(r.status));
  const elsewhere = open.filter((r) => !ours.has(r.runId));
  if (elsewhere.length) {
    const one = elsewhere.length === 1;
    return `The next round of tries can't start while ${names(elsewhere)} ${one ? 'is' : 'are'} still open, and this panel isn't running ${one ? 'it' : 'them'}. Try again once ${one ? 'it ends' : 'they end'}.`;
  }
  if (open.length) return `Archetype is still finishing ${names(open)}, so the next round of tries hasn't started. Try again in a minute.`;
  return "Archetype hasn't started the next round of tries yet. Try again in a minute.";
}

async function run(study: StudyTrace, deps: RunnerDeps, results: SessionResult[], started: Map<string, Promise<SessionResult>>): Promise<RunnerResult> {
  const { api, bridge } = deps;
  const { studyId, owner } = study;
  const checkCancel = () => {
    if (deps.signal?.aborted) throw new Cancelled();
  };
  /** The read the runs started from now play; each new wave reads the prototype again. */
  let current!: DocRead;
  let startState!: TraceState;
  let claim!: ClaimBody;
  /** A start frame the engine can't start fails here, before any run is claimed on the read. */
  function playOn(read: DocRead) {
    startState = start(read.doc, study.startFrameId);
    const { width, height } = startState.viewport;
    claim = { owner, browser: { engine: 'figma-trace', version: deps.pluginVersion, viewport: [width, height] } };
    current = read;
  }
  playOn(study.read);
  const readAgain = async () => playOn(await deps.readDoc());

  /** Where the runner is, apart from pauses (calls in parallel may pause at once); unset until a session starts. */
  let phase: RunnerStatus['phase'] | null = null;
  let pauses = 0;
  const report = (next: RunnerStatus['phase'], notice: string | null = null) => {
    phase = next;
    if (pauses === 0) deps.onRunner({ phase, notice });
  };

  /** Calls the API until it answers or fails for good, pausing through network loss and sign in trouble. */
  async function call<T>(work: () => Promise<T>): Promise<T> {
    let delay = RETRY_FIRST_MS;
    let paused = false;
    try {
      for (;;) {
        checkCancel();
        try {
          return await work();
        } catch (err) {
          checkCancel();
          const why = pauseFor(err);
          if (!why) throw err;
          if (!paused) {
            paused = true;
            pauses++;
          }
          deps.onRunner({ phase: 'paused', notice: why });
          await deps.sleep(delay);
          delay = Math.min(delay * 2, RETRY_MAX_MS);
        }
      }
    } finally {
      if (paused && --pauses === 0) deps.onRunner({ phase: phase ?? 'running', notice: null });
    }
  }

  const readRuns = async (): Promise<RunRowApi[]> => {
    const { runs } = await call(() => api.getRuns(studyId));
    if (!Array.isArray(runs)) throw new Error('Archetype sent a runs list the panel cannot read.');
    return runs;
  };

  /** Claims the backend refused for good; they fail the runner once the sessions that did start are done. */
  const refused: string[] = [];

  function begin(runId: string, resume: SavedSession | null) {
    if (phase !== 'running') report('running');
    const run: SessionRun = { runId, studyId, owner, doc: current.doc, shareKey: study.shareKey, startFrameId: study.startFrameId, resume, fileChanged: current.changed() };
    started.set(runId, runSession(run, { bridge, api, now: deps.now, sleep: deps.sleep, onStatus: deps.onSession, watchFile: deps.watchFile, postTurnTimeoutMs: deps.postTurnTimeoutMs, signal: deps.signal }));
  }

  /**
   * Claims a run and starts its session at once, without waiting for the
   * other claims. It saves the run at turn 0 first, so a panel that closes
   * now resumes it. A run another actor got first is theirs. A running run
   * is claimed again the same way: the backend answers its own owner with
   * the briefing again, and anyone else with already_claimed.
   */
  async function claimAndStart(runId: string): Promise<void> {
    try {
      await call(() => api.claimRun(runId, claim));
    } catch (err) {
      if (err instanceof Cancelled) throw err;
      if (err instanceof ApiError && err.code === 'already_claimed') return;
      refused.push(`${runId} (${messageOf(err)})`);
      return;
    }
    await saveTurn0(runId);
    checkCancel();
    begin(runId, null);
  }

  async function saveTurn0(runId: string): Promise<void> {
    const session: SavedSession = { owner, runId, turn: 0, state: startState, lastOutcome: null, timerEffects: [], loopFrames: [], version: SAVED_SESSION_VERSION };
    let failure: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await bridge.call('trace-save', { studyId, runId, session });
        return;
      } catch (err) {
        failure = err;
      }
    }
    // The run goes on; only a panel closed before its first turn is saved can't resume it.
    deps.onRunner({ phase: phase ?? 'running', notice: `${NOTICE.notSaved} ${messageOf(failure)}` });
  }

  /** Claims and starts runs, each on its own; when the panel closes, once every claim is through. */
  async function claimEach(runIds: readonly string[]): Promise<void> {
    const claims = await Promise.allSettled(runIds.filter((id) => !started.has(id)).map((id) => claimAndStart(id)));
    for (const c of claims) if (c.status === 'rejected') throw c.reason;
  }

  const claimQueued = (runs: readonly RunRowApi[]) => claimEach(runs.filter((r) => r.status === 'queued').map((r) => r.runId));

  /** Waits for every session started so far, then cleans up; a session that broke or a refused claim fails the runner. */
  async function settle(): Promise<void> {
    let seen = -1;
    const settled = new Map<string, PromiseSettledResult<SessionResult>>();
    while (seen !== started.size) {
      seen = started.size;
      for (const [runId, session] of started) if (!settled.has(runId)) settled.set(runId, (await Promise.allSettled([session]))[0] as PromiseSettledResult<SessionResult>);
    }
    for (const s of settled.values()) if (s.status === 'fulfilled' && !results.includes(s.value)) results.push(s.value);
    // The main thread's close handler removes what the closing panel's renders left.
    checkCancel();
    // No session renders any more: whatever a render left on the page can go.
    await bridge.call('trace-cleanup', {});
    for (const s of settled.values()) if (s.status === 'rejected') throw s.reason;
    if (refused.length) throw new Error(`Archetype refused to let this panel run ${refused.join('; ')}.`);
  }

  /**
   * The next wave, or 'started' when the wait found queued runs to claim:
   * a wave whose answer was lost, or runs queued meanwhile. Waits through
   * wave_in_progress for up to WAVE_WAIT_MS; then it is stuck.
   */
  async function nextWave(): Promise<NextWave | 'started' | { stuck: string }> {
    let since: number | null = null;
    for (;;) {
      try {
        const next = await call(() => api.nextWave(studyId));
        if (!next || (!next.done && !Array.isArray(next.runs))) throw new Error('Archetype sent a next wave the panel cannot read.');
        return next;
      } catch (err) {
        if (!(err instanceof ApiError && err.code === 'wave_in_progress')) throw err;
        const runs = await readRuns();
        const before = started.size;
        // Queued runs are a new wave (whose answer was lost, or queued meanwhile): they play the file as it is now.
        if (runs.some((r) => r.status === 'queued' && !started.has(r.runId))) await readAgain();
        await claimQueued(runs);
        if (started.size > before || refused.length) return 'started';
        since ??= deps.now();
        if (deps.now() - since >= WAVE_WAIT_MS) return { stuck: stuckMessage(runs, new Set(started.keys())) };
        await deps.sleep(WAVE_RETRY_MS);
        checkCancel();
      }
    }
  }

  // `started` holds every session this runner started, in the order it started them.
  // Resume (spec, Data flow 10): the runs this panel saved that the backend still runs.
  // A saved run of another owner is another panel's on this machine.
  const { sessions: saved } = await bridge.call('trace-load', { studyId });
  const runs = await readRuns();
  const statusOf = new Map(runs.map((r) => [r.runId, r.status]));
  for (const s of saved) {
    if (s.owner !== owner) continue;
    if (statusOf.get(s.runId) === 'running') begin(s.runId, s);
    // It ended while the panel was closed: there is nothing left to resume.
    else await bridge.call('trace-save', { studyId, runId: s.runId, session: null });
  }
  // A running run nothing was saved for here: this panel's when it closed before the turn 0 save
  // landed, or another panel's. Claimed again, the backend says which. One of ours starts from
  // turn 1; if the backend already holds turns of it, nothing saved says the file is as it was
  // then, so the session aborts it with panel_state_lost rather than replay them.
  const savedHere = new Set(saved.map((s) => s.runId));
  const unsaved = runs.filter((r) => r.status === 'running' && !savedHere.has(r.runId)).map((r) => r.runId);
  await claimEach([...runs.filter((r) => r.status === 'queued').map((r) => r.runId), ...unsaved]);

  for (;;) {
    await settle();
    report('next_wave');
    const next = await nextWave();
    if (next === 'started') continue;
    if ('stuck' in next) return { stop: 'stuck', message: next.stuck, sessions: results };
    if (next.done) {
      report('done');
      return { stop: 'done', reason: next.reason, sessions: results };
    }
    await readAgain();
    await claimQueued(next.runs.map((r) => ({ runId: r.runId, archetypeId: r.archetypeId, archetypeName: r.archetypeName, status: 'queued' })));
  }
}
