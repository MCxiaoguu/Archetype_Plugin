/**
 * The pointer model. Every action aimed at an element first moves the
 * pointer to it. Moving leaves the layers the pointer was over and enters
 * the ones under it; a layer that holds both points (an ancestor of the old
 * and the new layer) is neither left nor entered, like the DOM's
 * mouseenter. It also undoes "while hovering" effects the pointer has
 * left. A click is a press and a release at one point.
 */

import { bubble, chainOf, contains, hitAt, isShown, type LayerIndex, rootOf } from './hitTest';
import type { HeldEffect, OpenOverlay, Point, ProtoTrigger, TraceState, TraceTimer } from './model';

export type TriggerType = ProtoTrigger['type'];

export interface PointerDeps {
  layers: LayerIndex;
  /** Whether the layer has a reaction for this trigger. */
  handles(s: TraceState, layerKey: string, trigger: TriggerType): boolean;
  /** Fires the layer's reactions for this trigger: now, or as a timer when the trigger has a delay. */
  fire(s: TraceState, layerKey: string, trigger: TriggerType): void;
}

const MOUSE_TIMERS: ReadonlySet<TriggerType> = new Set<TriggerType>(['MOUSE_ENTER', 'MOUSE_LEAVE', 'MOUSE_DOWN', 'MOUSE_UP']);

/** The base frame and its place in history: a change means a navigation, after which the old layers are gone. */
const baseOf = (s: TraceState) => JSON.stringify([s.frameId, s.history]);

/** What the click sequence watches: "shows a different frame or overlay" stops it. */
const screenOf = (s: TraceState) => JSON.stringify([s.frameId, s.history, s.overlays.map((o) => o.frameId)]);

/** Moves the pointer to `point`. Returns false when a leave or enter reaction navigated away, so the old layers are gone. */
export function movePointer(deps: PointerDeps, s: TraceState, point: Point): boolean {
  const { layers } = deps;
  s.pointer.point = point;
  for (const held of [...s.pointer.held]) {
    if (held.trigger === 'ON_HOVER' && !stillHovering(layers, s, held, point)) undo(s, held);
  }

  const base = baseOf(s);
  const before = s.pointer.over;
  const hit = hitAt(layers, s, point);
  const after = hit ? chainOf(layers, hit.key) : [];
  s.pointer.over = after;

  for (const key of before) {
    // A layer of a frame that has gone since can't be left.
    if (after.includes(key) || !layers.byKey.has(key) || !isShown(s, rootOf(layers, key))) continue;
    deps.fire(s, key, 'MOUSE_LEAVE');
    if (baseOf(s) !== base) return false;
  }
  for (const key of [...after].reverse()) {
    if (before.includes(key)) continue;
    deps.fire(s, key, 'MOUSE_ENTER');
    if (baseOf(s) !== base) return false;
    if (deps.handles(s, key, 'ON_HOVER')) hold(deps, s, key, 'ON_HOVER');
    if (baseOf(s) !== base) return false;
  }
  return true;
}

/**
 * MOUSE_DOWN, ON_PRESS, MOUSE_UP and ON_CLICK at one point, each on the
 * layer the hit bubbles to for that trigger. Once one of them shows a
 * different frame or overlay the rest don't fire, but the release still
 * undoes the press. A click outside an overlay reaches nothing below it;
 * it closes the overlay when that closes on an outside click.
 */
export function click(deps: PointerDeps, s: TraceState, point: Point): void {
  if (!movePointer(deps, s, point)) return;

  const { layers } = deps;
  const hit = hitAt(layers, s, point);
  if (!hit) {
    if (s.overlays[s.overlays.length - 1]?.closeOnOutsideClick) s.overlays.pop();
    return;
  }

  const shown = screenOf(s);
  let stopped = false;
  const press = (trigger: TriggerType, held: boolean) => {
    if (stopped) return;
    const key = bubble(layers, hit.key, (k) => deps.handles(s, k, trigger));
    if (key === null) return;
    if (held) hold(deps, s, key, 'ON_PRESS');
    else deps.fire(s, key, trigger);
    stopped = screenOf(s) !== shown;
  };

  s.pointer.pressing = hit.key;
  press('MOUSE_DOWN', false);
  press('ON_PRESS', true);
  s.pointer.pressing = null;
  for (const held of [...s.pointer.held]) {
    if (held.trigger === 'ON_PRESS') undo(s, held);
  }
  press('MOUSE_UP', false);
  press('ON_CLICK', false);
}

export function drag(deps: PointerDeps, s: TraceState, point: Point): void {
  if (!movePointer(deps, s, point)) return;
  const hit = hitAt(deps.layers, s, point);
  if (!hit) return;
  const key = bubble(deps.layers, hit.key, (k) => deps.handles(s, k, 'ON_DRAG'));
  if (key !== null) deps.fire(s, key, 'ON_DRAG');
}

export function isMouseTimer(timer: TraceTimer): boolean {
  return MOUSE_TIMERS.has(timer.triggerType);
}

/** Whether a delayed mouse reaction still applies at settle: its frame shows and the pointer is where its trigger needs it. */
export function stillWhereNeeded(s: TraceState, timer: TraceTimer): boolean {
  if (!isShown(s, timer.frameId)) return false;
  const over = s.pointer.over.includes(timer.layerKey);
  return timer.triggerType === 'MOUSE_LEAVE' ? !over : over;
}

/** Fires a "while hovering" or "while pressing" reaction and keeps what it opened, to undo later. */
function hold(deps: PointerDeps, s: TraceState, key: string, trigger: HeldEffect['trigger']): void {
  const base = baseOf(s);
  const before = s.overlays.map((o) => o.frameId);
  deps.fire(s, key, trigger);
  // An effect that navigated away has nothing left to undo.
  if (baseOf(s) !== base) return;
  const opened = pushedOn(before, s.overlays);
  if (opened.length) s.pointer.held.push({ layerKey: key, trigger, frameId: rootOf(deps.layers, key), overlays: opened });
}

/** The overlays pushed on top of an unchanged stack; none when the stack changed otherwise (a swap or a close). */
function pushedOn(before: string[], after: OpenOverlay[]): string[] {
  if (after.length <= before.length || before.some((id, i) => after[i]?.frameId !== id)) return [];
  return after.slice(before.length).map((o) => o.frameId);
}

/** A "while hovering" overlay stays open while the pointer is over its trigger or over the overlay. */
function stillHovering(layers: LayerIndex, s: TraceState, held: HeldEffect, p: Point): boolean {
  const trigger = layers.byKey.get(held.layerKey);
  if (trigger && isShown(s, held.frameId) && contains(trigger.box, p)) return true;
  return held.overlays.some(
    (id) => isShown(s, id) && layers.layers.some((l) => layers.rootOf.get(l.key) === id && layers.visible.has(l.key) && contains(l.box, p)),
  );
}

function undo(s: TraceState, held: HeldEffect): void {
  s.pointer.held = s.pointer.held.filter((h) => h !== held);
  for (const id of [...held.overlays].reverse()) {
    const i = s.overlays.map((o) => o.frameId).lastIndexOf(id);
    if (i >= 0) s.overlays.splice(i, 1);
  }
}
