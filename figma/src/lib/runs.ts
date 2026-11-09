import type { RunRowApi } from './api';
import { frameForUrl, type FrameIndex } from './frames';
import { isTerminalRun } from './poll';

export type PersonaPhase = 'waiting' | 'running' | 'done';

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

/** The URL of a run's newest step, or null before its first step. */
export function rowUrl(row: RunRowApi): string | null {
  return row.lastStep?.url ?? null;
}

const ROLE_ORDER: Record<string, number> = { baseline: 0, variant: 1, stress: 2 };

/** One row per persona (archetype), in the order the study runs them. */
export function personaRows(runs: RunRowApi[], frames: FrameIndex): PersonaRow[] {
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
    const completed = list.filter((r) => isTerminalRun(r.status) && (r.outcome?.completed ?? r.status === 'completed')).length;
    const gaveUp = finished - completed;
    const live = list.find((r) => r.status === 'running');
    const phase: PersonaPhase = live ? 'running' : finished === list.length ? 'done' : 'waiting';
    const focus = live ?? [...list].reverse().find((r) => isTerminalRun(r.status)) ?? first;
    const frame = frameForUrl(rowUrl(focus), frames);
    const steps = focus.metrics?.steps ?? focus.lastStep?.seq ?? null;
    let statusText: string;
    if (phase === 'running') statusText = frame ? `On ${frame.name}` : 'Clicking through';
    else if (phase === 'waiting') statusText = finished > 0 ? `${finished} of ${list.length} tries done` : 'Waiting to start';
    else if (list.length === 1) statusText = completed === 1 ? 'Reached the goal' : 'Gave up';
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
      screen: frame?.name ?? null,
      steps: typeof steps === 'number' ? steps : null,
    });
  }
  return rows.sort((a, b) => (ROLE_ORDER[a.role] ?? 1) - (ROLE_ORDER[b.role] ?? 1));
}
