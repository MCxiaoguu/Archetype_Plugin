/**
 * What a persona action did, read off what is shown before and after it,
 * so that effects which cancel out within one action (a "while pressing"
 * overlay that opens at the press and closes at the release) count as
 * nothing.
 */

import type { TraceOutcome, TraceScroll, TraceState } from './model';

/** What the screen can't show: a link that opened outside the prototype, or an action the engine can't play. */
export type EngineEffect = { type: 'url'; url: string } | { type: 'unsupported'; action: string };

/** Plain data as JSON with sorted keys, so two values compare by content. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

const same = (a: unknown, b: unknown) => stable(a) === stable(b);

/** The offsets that move something: a frame with no entry and one at zero show the same. */
function movedScroll(scroll: TraceScroll): Record<string, unknown> {
  const moved: Record<string, unknown> = {};
  for (const [frameId, entry] of Object.entries(scroll)) {
    const areas = Object.fromEntries(Object.entries(entry.areas).filter(([, o]) => o.x || o.y));
    if (entry.x || entry.y || Object.keys(areas).length) moved[frameId] = { x: entry.x, y: entry.y, areas };
  }
  return moved;
}

/**
 * A change to the base frame wins over one to the overlays, then to state,
 * then to scroll; any visible change wins over a link that opened outside,
 * which wins over an unsupported action. `fallback` is what the action
 * gives when nothing changed: a misclick, the end of a scroll range, or
 * an empty history.
 */
export function outcomeOf(before: TraceState, after: TraceState, effects: EngineEffect[], fallback: TraceOutcome): TraceOutcome {
  if (!same(before.history, after.history)) return 'navigated';
  if (before.frameId !== after.frameId) return 'swapped';

  const was = before.overlays.map((o) => o.frameId);
  const is = after.overlays.map((o) => o.frameId);
  if (!same(was, is)) {
    if (is.length > was.length) return 'opened_overlay';
    if (is.length < was.length) return 'closed_overlay';
    return 'swapped';
  }

  if (!same(before.variants, after.variants) || !same(before.variables, after.variables) || !same(before.modes, after.modes)) {
    return 'changed_state';
  }
  if (!same(movedScroll(before.scroll), movedScroll(after.scroll))) return 'scrolled';
  if (effects.some((e) => e.type === 'url')) return 'left_prototype';
  if (effects.some((e) => e.type === 'unsupported')) return 'unsupported';
  return fallback;
}
