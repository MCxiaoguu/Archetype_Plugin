import type { RunRowApi } from './api';
import { frameForUrl, type FrameIndex } from './frames';
import type { RunSize } from './form';
import { isTerminalRun, type RunnerState } from './poll';

export type PersonaPhase = 'waiting' | 'running' | 'done';

/** What the panel's own session says about a run it is running (ui/trace/session.ts). */
export interface LiveRun {
  runId: string;
  phase: 'acting' | 'thinking' | 'paused' | 'ended';
  frameName: string;
  /** The node the persona is on: the topmost overlay, else the frame. */
  node: string;
  turn: number;
  notices: string[];
  /** How the run ended, once it has. */
  ended: { status: string; reason: string | null } | null;
  /** Where the last action took the persona, from node to node, and what it did. */
  move: { from: string; to: string; outcome: string; label: string | null; turn: number } | null;
}

/**
 * Where the panel's runner is with a study (ui/trace/runner.ts). The last
 * five are where it stopped: the next wave didn't come (stuck), it failed,
 * it waits for the designer to open the test's page, the study's saved
 * progress can't be read and the designer can forget it, or the flow map
 * couldn't be completed and the designer tries again or launches with the
 * drawn connections only.
 */
export interface RunnerStatus {
  phase: 'running' | 'next_wave' | 'paused' | 'done' | 'stuck' | 'failed' | 'other_page' | 'progress_unreadable' | 'map_failed';
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
  /** A session in this panel runs it now. */
  here: boolean;
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
 * runs list lags behind it by a poll. In plugin mode (`inPanel`), a run
 * the backend shows running that no session here runs is not clicking
 * through: another panel has it, or this panel's runner stopped.
 */
export function personaRows(
  runs: RunRowApi[],
  frames: FrameIndex,
  { live = {}, inPanel = false }: { live?: Readonly<Record<string, LiveRun>>; inPanel?: boolean } = {},
): PersonaRow[] {
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
    const elsewhere = inPanel && !session && !!running;
    const phase: PersonaPhase = session || (running && !elsewhere) ? 'running' : finished === list.length ? 'done' : 'waiting';
    const focus = running ?? [...list].reverse().find((r) => isTerminalRun(r.status)) ?? first;
    const frame = frameForUrl(rowUrl(focus), frames);
    const screen = session ? session.frameName : frame?.name ?? null;
    const steps = session ? session.turn : focus.metrics?.steps ?? focus.lastStep?.seq ?? null;
    let statusText: string;
    if (session) statusText = `${session.phase === 'paused' ? 'Paused on' : 'On'} ${session.frameName}`;
    else if (elsewhere) statusText = 'Not running in this panel';
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
      here: !!session,
    });
  }
  return rows.sort((a, b) => (ROLE_ORDER[a.role] ?? 1) - (ROLE_ORDER[b.role] ?? 1));
}

/**
 * What the Running screen tells the designer about this panel's sessions and
 * runner, each once. A session drops a notice once it no longer holds (it
 * reached Archetype again); the runner's shows while it is paused.
 */
export function panelNotices(live: Readonly<Record<string, LiveRun>>, runner: RunnerStatus | null): string[] {
  const shown = new Set(Object.values(live).flatMap((s) => s.notices));
  // Where it stopped has its own banner, with what to do.
  if (runner?.notice && (runner.phase === 'paused' || runner.phase === 'running')) shown.add(runner.notice);
  return [...shown];
}

/**
 * The line under the persona list in plugin mode: what this panel's runner
 * and sessions are doing. One row is a one-persona study, which has one try:
 * the runner's ask for a next round finds every try in.
 */
export function panelRunText(rows: readonly PersonaRow[], runner: RunnerStatus | null, state: RunnerState): string {
  const one = rows.length === 1;
  if (runner && (runner.phase === 'stuck' || runner.phase === 'failed' || runner.phase === 'other_page' || runner.phase === 'progress_unreadable' || runner.phase === 'map_failed')) return '';
  if (rows.some((r) => r.here)) return one ? 'The persona is clicking through your prototype here in the panel.' : 'Personas are clicking through your prototype here in the panel.';
  if (runner?.phase === 'next_wave' && !one) return 'Starting the next round of tries.';
  if (runner?.phase === 'next_wave' || runner?.phase === 'done' || state === 'finishing') return 'All tries are in. Putting the results together.';
  if (state === 'queued' || state === 'waiting_for_runner') return one ? 'Starting the persona.' : 'Starting the personas.';
  return '';
}

export interface RunningStep {
  key: 'understand' | 'personas' | 'run';
  title: string;
  hint: string;
}

/** The Running screen's stages and labels for a test of this size: a Single persona test has one persona, not variants. */
export function runningTexts(size: RunSize): { steps: RunningStep[]; section: string; keepOpen: string } {
  if (size === 'single') {
    return {
      steps: [
        { key: 'understand', title: 'Understanding your user', hint: 'Reading who you said your user is. Usually under 30 s.' },
        { key: 'personas', title: 'Building the persona', hint: 'One typical user, from who you said your user is.' },
        { key: 'run', title: 'Running', hint: 'The persona opens your prototype and clicks through it.' },
      ],
      section: 'Persona',
      keepOpen: 'Keep this panel open while the persona runs',
    };
  }
  return {
    steps: [
      { key: 'understand', title: 'Understanding your users', hint: 'Finding the traits most likely to change whether someone finishes. Usually under 30 s.' },
      { key: 'personas', title: 'Building personas', hint: 'One typical user, then variants that each differ in one trait. Usually about a minute.' },
      { key: 'run', title: 'Running', hint: 'Personas open your prototype and click through it.' },
    ],
    section: 'Personas',
    keepOpen: 'Keep this panel open while the personas run',
  };
}
