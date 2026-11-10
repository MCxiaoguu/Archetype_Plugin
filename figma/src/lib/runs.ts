import type { RunRowApi } from './api';
import { frameForUrl, type FrameIndex } from './frames';
import { isTerminalRun } from './poll';

export type PersonaPhase = 'waiting' | 'running' | 'done';

/** What the panel's own session says about a run it is running (ui/trace/session.ts). */
export interface LiveRun {
  runId: string;
  phase: 'acting' | 'thinking' | 'paused' | 'ended';
  frameName: string;
  turn: number;
  notices: string[];
}

/** Where the panel's runner is with a study (ui/trace/runner.ts). */
export interface RunnerStatus {
  phase: 'running' | 'next_wave' | 'paused' | 'done';
  notice: string | null;
}

export interface PersonaRow {
  archetypeId: string;
  name: string;
  role: string;
  phase: PersonaPhase;
  runs: number;
  finished: number;
  completed: number;
  gaveUp: number;
  /** Plain words for the row, for example "On Checkout" or "Reached the goal". */
  statusText: string;
  screen: string | null;
  steps: number | null;
}

/**
 * The persona outcome of a finished run, as the backend's report scores it:
 * an aborted run, or one without a recorded outcome, is none.
 */
function personaOutcome(r: RunRowApi): boolean | null {
  if (!isTerminalRun(r.status) || r.status === 'aborted') return null;
  const completed = r.outcome?.completed;
  return typeof completed === 'boolean' ? completed : null;
}

/** The URL of a run's newest step, or null before its first step. */
export function rowUrl(row: RunRowApi): string | null {
  return row.lastStep?.url ?? null;
}

const ROLE_ORDER: Record<string, number> = { baseline: 0, variant: 1, stress: 2 };

/**
 * One row per persona (archetype), in the order the study runs them. A run
 * this panel's own session is on shows that session's screen and step: the
 * runs list lags behind it by a poll.
 */
export function personaRows(runs: RunRowApi[], frames: FrameIndex, live: Readonly<Record<string, LiveRun>> = {}): PersonaRow[] {
  const groups = new Map<string, RunRowApi[]>();
  for (const r of runs) {
    const list = groups.get(r.archetypeId) ?? [];
    list.push(r);
    groups.set(r.archetypeId, list);
  }
  const rows: PersonaRow[] = [];
  for (const [archetypeId, list] of groups) {
    const first = list[0] as RunRowApi;
    const finished = list.filter((r) => isTerminalRun(r.status)).length;
    const completed = list.filter((r) => personaOutcome(r) === true).length;
    const gaveUp = list.filter((r) => personaOutcome(r) === false).length;
    const session = list.map((r) => live[r.runId]).find((s) => s && s.phase !== 'ended');
    const running = list.find((r) => r.status === 'running');
    const phase: PersonaPhase = session || running ? 'running' : finished === list.length ? 'done' : 'waiting';
    const focus = running ?? [...list].reverse().find((r) => isTerminalRun(r.status)) ?? first;
    const frame = frameForUrl(rowUrl(focus), frames);
    const screen = session ? session.frameName : frame?.name ?? null;
    const steps = session ? session.turn : focus.metrics?.steps ?? focus.lastStep?.seq ?? null;
    let statusText: string;
    if (session) statusText = `${session.phase === 'paused' ? 'Paused on' : 'On'} ${session.frameName}`;
    else if (phase === 'running') statusText = frame ? `On ${frame.name}` : 'Clicking through';
    else if (phase === 'waiting') statusText = finished > 0 ? `${finished} of ${list.length} tries done` : 'Waiting to start';
    else if (list.length === 1) statusText = completed === 1 ? 'Reached the goal' : gaveUp === 1 ? 'Gave up' : 'Stopped before the end';
    else statusText = `Reached the goal ${completed} of ${list.length} times`;
    rows.push({
      archetypeId,
      name: first.archetypeName || 'Persona',
      role: first.role ?? 'variant',
      phase,
      runs: list.length,
      finished,
      completed,
      gaveUp,
      statusText,
      screen,
      steps: typeof steps === 'number' ? steps : null,
    });
  }
  return rows.sort((a, b) => (ROLE_ORDER[a.role] ?? 1) - (ROLE_ORDER[b.role] ?? 1));
}

/**
 * What the Running screen tells the designer about this panel's sessions and
 * runner, each once. A notice in `whilePaused` (lost touch, signed out) shows
 * only while its session or the runner is still paused.
 */
export function panelNotices(live: Readonly<Record<string, LiveRun>>, runner: RunnerStatus | null, whilePaused: readonly string[]): string[] {
  const shown = new Set<string>();
  for (const s of Object.values(live)) {
    for (const n of s.notices) if (s.phase === 'paused' || !whilePaused.includes(n)) shown.add(n);
  }
  if (runner?.phase === 'paused' && runner.notice) shown.add(runner.notice);
  return [...shown];
}
