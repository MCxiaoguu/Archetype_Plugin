/**
 * The pointer model. Every action aimed at an element first moves the
 * pointer to it. Moving leaves the layers the pointer was over and enters
 * the ones under it; a layer that holds both points (an ancestor of the old
 * and the new layer) is neither left nor entered, like the DOM's
 * mouseenter. It also undoes "while hovering" effects the pointer has
 * left. A click is a press and a release at one point.
 */

import { baseOf, bubble, chainOf, contains, hitAt, hittableFrame, isShown, type LayerIndex, rootOf, screenOf } from './hitTest';
import type { HeldEffect, OpenOverlay, Point, ProtoTrigger, TraceState, TraceTimer } from './model';
import { variantChanges } from './variants';

export type TriggerType = ProtoTrigger['type'];

export interface PointerDeps {
  layers: LayerIndex;
  /** Whether the layer has a reaction for this trigger. */
  handles(s: TraceState, layerKey: string, trigger: TriggerType): boolean;
  /** Fires the layer's reactions for this trigger: now, or as a timer when the trigger has a delay. */
  fire(s: TraceState, layerKey: string, trigger: TriggerType): void;
  /** Sets (or, with null, clears) an instance's variant override, as undoing a held effect does. */
  setVariant(s: TraceState, frameId: string, instanceKey: string, variantId: string | null): void;
}

/** Moves the pointer to `point`. Returns false when a leave or enter reaction navigated away, so the old layers are gone. */
export function movePointer(deps: PointerDeps, s: TraceState, point: Point): boolean {
  const { layers } = deps;
  s.pointer.point = point;
  for (const held of [...s.pointer.held]) {
    if (held.trigger === 'ON_HOVER' && !stillHovering(layers, s, held, point)) undo(deps, s, held);
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
 * different frame or overlay that lasts, the rest don't fire; a "while
 * pressing" effect undone at the release doesn't last, so it stops
 * nothing. A click outside the top overlay reaches nothing below it; it
 * closes the overlay when that closes on an outside click. The hit is
 * found among the layers the persona saw, so an overlay this click's own
 * pointer move opened can't take it.
 */
export function click(deps: PointerDeps, s: TraceState, point: Point): void {
  if (!movePointer(deps, s, point)) return;

  const { layers } = deps;
  const hit = hitAt(layers, s, point);
  // Typed keys go to the layer a click lands on.
  s.focus = hit ? { layerKey: hit.key, frameId: rootOf(layers, hit.key) } : null;
  if (!hit) {
    const top = hittableFrame(layers, s);
    const overlay = s.overlays.find((o) => o.frameId === top);
    if (overlay?.closeOnOutsideClick) s.overlays.splice(s.overlays.indexOf(overlay), 1);
    return;
  }

  const shown = screenOf(s);
  let stopped = false;
  const press = (trigger: TriggerType) => {
    if (stopped) return;
    const key = bubble(layers, hit.key, (k) => deps.handles(s, k, trigger));
    if (key === null) return;
    deps.fire(s, key, trigger);
    stopped = screenOf(s) !== shown;
  };

  s.pointer.pressing = hit.key;
  press('MOUSE_DOWN');
  const pressed = stopped ? null : bubble(layers, hit.key, (k) => deps.handles(s, k, 'ON_PRESS'));
  if (pressed !== null) hold(deps, s, pressed, 'ON_PRESS');
  s.pointer.pressing = null;
  for (const held of [...s.pointer.held]) {
    if (held.trigger === 'ON_PRESS') undo(deps, s, held);
  }
  // What the press changed and the release didn't undo lasts, and stops the rest.
  stopped = stopped || screenOf(s) !== shown;
  press('MOUSE_UP');
  press('ON_CLICK');
}

export function drag(deps: PointerDeps, s: TraceState, point: Point): void {
  if (!movePointer(deps, s, point)) return;
  const hit = hitAt(deps.layers, s, point);
  if (!hit) return;
  const key = bubble(deps.layers, hit.key, (k) => deps.handles(s, k, 'ON_DRAG'));
  if (key !== null) deps.fire(s, key, 'ON_DRAG');
}

/** Whether a delayed mouse reaction still applies at settle: its frame shows and the pointer is where its trigger needs it. */
export function stillWhereNeeded(s: TraceState, timer: TraceTimer): boolean {
  if (!isShown(s, timer.frameId)) return false;
  const over = s.pointer.over.includes(timer.layerKey);
  return timer.triggerType === 'MOUSE_LEAVE' ? !over : over;
}

/** Fires a "while hovering" or "while pressing" reaction and keeps what it opened and changed, to undo later. */
function hold(deps: PointerDeps, s: TraceState, key: string, trigger: HeldEffect['trigger']): void {
  const base = baseOf(s);
  const overlays = s.overlays.map((o) => o.frameId);
  const variants = structuredClone(s.variants);
  deps.fire(s, key, trigger);
  // An effect that navigated away has nothing left to undo.
  if (baseOf(s) !== base) return;
  const opened = pushedOn(overlays, s.overlays);
  const changed = variantChanges(variants, s.variants);
  if (opened.length || changed.length) {
    s.pointer.held.push({ layerKey: key, trigger, frameId: rootOf(deps.layers, key), overlays: opened, variants: changed });
  }
}

/** The overlays pushed on top of an unchanged stack; none when the stack changed otherwise (a swap or a close). */
function pushedOn(before: string[], after: OpenOverlay[]): string[] {
  if (after.length <= before.length || before.some((id, i) => after[i]?.frameId !== id)) return [];
  return after.slice(before.length).map((o) => o.frameId);
}

/**
 * A "while hovering" effect holds while the pointer is over its trigger,
 * over an instance it changed (whose layers have new keys once swapped),
 * or over an overlay it opened.
 */
function stillHovering(layers: LayerIndex, s: TraceState, held: HeldEffect, p: Point): boolean {
  if (!isShown(s, held.frameId)) return false;
  const over = (key: string) => {
    const layer = layers.byKey.get(key);
    return layer !== undefined && contains(layer.box, p);
  };
  if (over(held.layerKey) || held.variants.some((v) => over(v.instanceKey))) return true;
  return held.overlays.some(
    (id) => isShown(s, id) && layers.layers.some((l) => layers.rootOf.get(l.key) === id && layers.visible.has(l.key) && contains(l.box, p)),
  );
}

function undo(deps: PointerDeps, s: TraceState, held: HeldEffect): void {
  s.pointer.held = s.pointer.held.filter((h) => h !== held);
  for (const change of held.variants) deps.setVariant(s, change.frameId, change.instanceKey, change.previous);
  for (const id of [...held.overlays].reverse()) {
    const i = s.overlays.map((o) => o.frameId).lastIndexOf(id);
    if (i >= 0) s.overlays.splice(i, 1);
  }
}
