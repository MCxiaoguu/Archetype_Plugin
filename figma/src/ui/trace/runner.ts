/**
 * A whole plugin-mode study in the panel (spec, Data flow 3, 9 and 10). The
 * runner claims every queued run of the wave under this panel's owner id,
 * runs their sessions side by side, and once all of them ended asks the
 * backend for the next wave, until it says the study is done. When the
 * panel reopens, it first resumes the runs it owns; when it closes (the
 * signal), every session stops where it is, to resume then.
 *
 * No DOM and no figma globals: the bridge, the API, the clock and the status
 * callbacks come in, so the live driver runs the same runner in Node.
 */

import { ApiError, type ApiClient, type ClaimBody, type NextWave, type StudyRuns } from '../../lib/api';
import type { SavedSession } from '../../lib/messages';
import { start } from '../../lib/proto/engine';
import type { ProtoDoc } from '../../lib/proto/model';
import type { RunnerStatus } from '../../lib/runs';
import type { Bridge } from './bridge';
import { pauseFor, RETRY_FIRST_MS, RETRY_MAX_MS, runSession, type SessionDeps, type SessionResult, type SessionRun, type SessionStatus } from './session';

/** Finalizing runs keep the wave open; the runner waits this long for the next one (spec, Error handling). */
export const WAVE_WAIT_MS = 5 * 60_000;
export const WAVE_RETRY_MS = 5_000;

export const STUCK_MESSAGE = 'Archetype is still storing the last round of tries, so the next round has not started. Try again in a minute.';

export interface StudyTrace {
  studyId: string;
  /** This panel's id for the study's runs: every claim, turn and abort carries it. */
  owner: string;
  /** The prototype, read at launch or again when the panel reopened. */
  doc: ProtoDoc;
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
  try {
    return await run(study, deps, results);
  } catch (err) {
    if (err instanceof Cancelled) return { stop: 'cancelled', sessions: results };
    throw err;
  }
}

async function run(study: StudyTrace, deps: RunnerDeps, results: SessionResult[]): Promise<RunnerResult> {
  const { api, bridge } = deps;
  const { studyId, owner } = study;
  const checkCancel = () => {
    if (deps.signal?.aborted) throw new Cancelled();
  };
  // A start frame the engine can't start fails here, before any run is claimed.
  const { width, height } = start(study.doc, study.startFrameId).viewport;
  const claim: ClaimBody = { owner, browser: { engine: 'figma-trace', version: deps.pluginVersion, viewport: [width, height] } };

  let phase: RunnerStatus['phase'] = 'running';
  const report = (next: RunnerStatus['phase'], notice: string | null = null) => {
    phase = next;
    deps.onRunner({ phase, notice });
  };

  /** Calls the API until it answers or fails for good, pausing through network loss and sign in trouble. */
  async function call<T>(work: () => Promise<T>): Promise<T> {
    let delay = RETRY_FIRST_MS;
    let paused: RunnerStatus['phase'] | null = null;
    for (;;) {
      checkCancel();
      try {
        const result = await work();
        if (paused) report(paused);
        return result;
      } catch (err) {
        checkCancel();
        const why = pauseFor(err);
        if (!why) throw err;
        paused ??= phase;
        report('paused', why);
        await deps.sleep(delay);
        delay = Math.min(delay * 2, RETRY_MAX_MS);
      }
    }
  }

  const session = (runId: string, resume: SavedSession | null): SessionRun => ({
    runId,
    studyId,
    owner,
    doc: study.doc,
    shareKey: study.shareKey,
    startFrameId: study.startFrameId,
    resume,
  });

  /** Claims the runs at once, leaving a run another actor got first to that actor. */
  async function claimAll(runIds: readonly string[]): Promise<SessionRun[]> {
    const claimed = await Promise.all(
      runIds.map(async (runId) => {
        try {
          await call(() => api.claimRun(runId, claim));
          return session(runId, null);
        } catch (err) {
          if (err instanceof ApiError && err.status === 409) return null;
          throw err;
        }
      }),
    );
    return claimed.filter((r): r is SessionRun => r !== null);
  }

  /** Runs every session to its end. One that broke fails the runner, once the others are done. */
  async function runAll(runs: readonly SessionRun[]): Promise<void> {
    if (!runs.length) return;
    report('running');
    const settled = await Promise.allSettled(
      runs.map((run) =>
        runSession(run, {
          bridge,
          api,
          now: deps.now,
          sleep: deps.sleep,
          onStatus: deps.onSession,
          watchFile: deps.watchFile,
          postTurnTimeoutMs: deps.postTurnTimeoutMs,
          signal: deps.signal,
        }),
      ),
    );
    for (const s of settled) if (s.status === 'fulfilled') results.push(s.value);
    // The main thread's close handler removes what the closing panel's renders left.
    checkCancel();
    // No session renders any more: whatever a render left on the page can go.
    await bridge.call('trace-cleanup', {});
    for (const s of settled) if (s.status === 'rejected') throw s.reason;
  }

  /** The next wave, waiting through wave_in_progress for up to WAVE_WAIT_MS; null when it lasts longer. */
  async function nextWave(): Promise<NextWave | null> {
    let since: number | null = null;
    for (;;) {
      try {
        return await call(() => api.nextWave(studyId));
      } catch (err) {
        if (!(err instanceof ApiError && err.code === 'wave_in_progress')) throw err;
        since ??= deps.now();
        if (deps.now() - since >= WAVE_WAIT_MS) return null;
        await deps.sleep(WAVE_RETRY_MS);
        checkCancel();
      }
    }
  }

  // Resume (spec, Data flow 10): only the runs this panel saved that the backend still runs.
  // A saved run of another owner, or a running run nothing was saved for, may be another panel's.
  const { sessions: saved } = await bridge.call('trace-load', { studyId });
  const { runs } = await call(() => api.getRuns(studyId));
  if (!Array.isArray(runs)) throw new Error('Archetype sent a runs list the panel cannot read.');
  const statusOf = new Map(runs.map((r) => [r.runId, r.status]));
  let pending: SessionRun[] = [];
  for (const s of saved) {
    if (s.owner !== owner) continue;
    if (statusOf.get(s.runId) === 'running') pending.push(session(s.runId, s));
    // It ended while the panel was closed: there is nothing left to resume.
    else await bridge.call('trace-save', { studyId, runId: s.runId, session: null });
  }
  let queued = runs.filter((r) => r.status === 'queued').map((r) => r.runId);

  for (;;) {
    await runAll([...pending, ...(await claimAll(queued))]);
    pending = [];
    report('next_wave');
    const next = await nextWave();
    if (!next) return { stop: 'stuck', message: STUCK_MESSAGE, sessions: results };
    if (next.done) {
      report('done');
      return { stop: 'done', reason: next.reason, sessions: results };
    }
    queued = next.runs.map((r) => r.runId);
  }
}
