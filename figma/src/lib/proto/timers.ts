/**
 * Timers: delayed mouse reactions, and AFTER_TIMEOUT reactions, which
 * start when their frame or overlay shows, or when an interactive
 * component comes to show their variant. Leaving a frame cancels its
 * timers (the engine drops those of frames no longer showing).
 */

import type { Box, ProtoDoc, TraceState, TraceTimer } from './model';
import { instancesIn, reactionsFor } from './variants';

/** `settle` fires AFTER_TIMEOUT timers this short or shorter: a person wouldn't act sooner. Longer ones wait for `wait`. */
export const SETTLE_LIMIT_MS = 2000;

/** How many timers one `settle` or `wait` fires before it stops a loop. */
export const LOOP_GUARD = 20;

const MOUSE: ReadonlySet<TraceTimer['triggerType']> = new Set<TraceTimer['triggerType']>(['MOUSE_ENTER', 'MOUSE_LEAVE', 'MOUSE_DOWN', 'MOUSE_UP']);

export function isMouseTimer(timer: TraceTimer): boolean {
  return MOUSE.has(timer.triggerType);
}

/** What `settle` fires: delayed mouse reactions, whatever their delay, and short AFTER_TIMEOUT timers. */
export function firesAtSettle(timer: TraceTimer): boolean {
  return isMouseTimer(timer) || (timer.triggerType === 'AFTER_TIMEOUT' && timer.delayMs <= SETTLE_LIMIT_MS);
}

export function addTimer(s: TraceState, timer: Omit<TraceTimer, 'dueAtMs'>): void {
  s.timers.push({ ...timer, chain: [...timer.chain], actions: structuredClone(timer.actions), dueAtMs: s.clockMs + timer.delayMs });
}

function schedule(doc: ProtoDoc, s: TraceState, frameId: string, layerKey: string, triggerBox: Box | null): void {
  for (const reaction of reactionsFor(doc, s, layerKey)) {
    if (reaction.trigger.type !== 'AFTER_TIMEOUT') continue;
    const { delayMs } = reaction.trigger;
    addTimer(s, { layerKey, chain: [layerKey], frameId, triggerType: 'AFTER_TIMEOUT', delayMs, actions: reaction.actions, triggerBox });
  }
}

/**
 * Starts the AFTER_TIMEOUT timers of a frame that has just shown: its own,
 * and those of the variants its interactive components show. Timers it
 * already had start again.
 */
export function startFrameTimers(doc: ProtoDoc, s: TraceState, frameId: string, frameBox: Box): void {
  s.timers = s.timers.filter((t) => t.triggerType !== 'AFTER_TIMEOUT' || t.frameId !== frameId);
  schedule(doc, s, frameId, frameId, frameBox);
  for (const instanceKey of instancesIn(doc, frameId)) schedule(doc, s, frameId, instanceKey, null);
}

/** Starts an interactive component's AFTER_TIMEOUT timers again, for the variant it shows now. */
export function restartInstanceTimers(doc: ProtoDoc, s: TraceState, frameId: string, instanceKey: string): void {
  s.timers = s.timers.filter((t) => t.triggerType !== 'AFTER_TIMEOUT' || t.layerKey !== instanceKey);
  schedule(doc, s, frameId, instanceKey, null);
}

/** The index of the earliest timer `eligible` picks (the first of equals), or -1. */
export function nextTimer(timers: TraceTimer[], eligible: (timer: TraceTimer) => boolean): number {
  let next = -1;
  timers.forEach((timer, i) => {
    if (eligible(timer) && (next < 0 || timer.dueAtMs < (timers[next] as TraceTimer).dueAtMs)) next = i;
  });
  return next;
}
