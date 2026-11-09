import type { RunRowApi, StudyStatusValue } from './api';

export const FAST_POLL_MS = 5_000;
export const SLOW_POLL_MS = 15_000;
export const SLOW_AFTER_MS = 2 * 60_000;
export const RUNNER_WAIT_MS = 3 * 60_000;

/** Every 5 s while the panel is open, 15 s after the first two minutes. */
export function pollDelay(watchingForMs: number): number {
  return watchingForMs >= SLOW_AFTER_MS ? SLOW_POLL_MS : FAST_POLL_MS;
}

export const TERMINAL_RUN = new Set(['completed', 'failed', 'aborted', 'abandoned']);

export function isTerminalRun(status: string): boolean {
  return TERMINAL_RUN.has(status);
}

export function isStudyDone(status: StudyStatusValue | string | null | undefined): boolean {
  return status === 'complete' || status === 'failed';
}

export type RunnerState = 'none' | 'queued' | 'waiting_for_runner' | 'running' | 'finishing';

/**
 * What the runs say about the runner. "Waiting for a runner" means some runs
 * have stayed queued for over three minutes and none is running: nobody has
 * picked the study up. It is a plain state, not an error.
 */
export function runnerState(runs: Pick<RunRowApi, 'status'>[], queuedSince: number | null, now: number): RunnerState {
  if (runs.length === 0) return 'none';
  const running = runs.some((r) => r.status === 'running');
  const queued = runs.some((r) => r.status === 'queued');
  if (running) return 'running';
  if (!queued) return 'finishing';
  if (queuedSince !== null && now - queuedSince > RUNNER_WAIT_MS) return 'waiting_for_runner';
  return 'queued';
}

/**
 * The moment the current queue started waiting: the earlier of the stored
 * value and now when something is queued and nothing runs; null otherwise.
 */
export function nextQueuedSince(runs: Pick<RunRowApi, 'status'>[], previous: number | null, now: number): number | null {
  const waiting = runs.some((r) => r.status === 'queued') && !runs.some((r) => r.status === 'running');
  if (!waiting) return null;
  return previous ?? now;
}
