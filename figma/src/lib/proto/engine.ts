/**
 * The trace engine: a pure, deterministic interpreter of a Figma
 * prototype, one instance per persona in the panel. `start` opens the
 * start frame, `apply` plays one persona action on the screen it was taken
 * on, and `settle` fires what would happen before a person acted again.
 * This module dispatches: hit-testing, the pointer and scrolling live in
 * their own modules beside it.
 */

import { EngineError } from './errors';
import { indexLayers, isShown, type LayerIndex, layerOf, rootOf } from './hitTest';
import type {
  Box,
  ElementTarget,
  OpenOverlay,
  Point,
  ProtoAction,
  ProtoDoc,
  ProtoFrame,
  ProtoReaction,
  ProtoTrigger,
  RawLayer,
  Size,
  TraceAction,
  TraceOutcome,
  TraceState,
  TraceTimer,
} from './model';
import { type EngineEffect, outcomeOf } from './outcome';
import { click, drag, isMouseTimer, movePointer, type PointerDeps, stillWhereNeeded, type TriggerType } from './pointer';
import { scrollBy, scrollIntoView, scrollOnShow } from './scroll';

export type { EngineEffect } from './outcome';

export interface ApplyResult {
  state: TraceState;
  outcome: TraceOutcome;
  effects: EngineEffect[];
}

export interface SettleResult {
  state: TraceState;
  /** How many reactions fired. */
  fired: number;
  /** The frames involved when the loop guard stopped a loop of timers; null when it didn't. */
  looped: string[] | null;
  effects: EngineEffect[];
}

type NodeAction = Extract<ProtoAction, { type: 'NODE' }>;

/** The layer whose reaction runs, the frame it's in, and its unclipped box. */
interface Source {
  layerKey: string;
  frameId: string;
  box: Box;
}

interface Context {
  doc: ProtoDoc;
  frames: Map<string, ProtoFrame>;
  /** The measured screen; null in `settle`, which runs before the next render. */
  layers: LayerIndex | null;
  effects: EngineEffect[];
}

/** The viewport is the start frame's size, its height capped like a laptop's or a phone's screen. */
export function viewportFor(doc: ProtoDoc, startFrameId: string): Size {
  const frame = doc.frames.find((f) => f.id === startFrameId);
  if (!frame) throw new EngineError('invalid_doc', `The start frame ${startFrameId} isn't in the prototype`);
  return { width: frame.width, height: Math.min(frame.height, frame.width >= 768 ? 900 : 844) };
}

export function start(doc: ProtoDoc, startFrameId: string): TraceState {
  return {
    frameId: startFrameId,
    overlays: [],
    history: [],
    scroll: {},
    variants: {},
    variables: {},
    modes: {},
    clockMs: 0,
    timers: [],
    pointer: { point: null, over: [], pressing: null, held: [] },
    docHash: doc.docHash,
    viewport: viewportFor(doc, startFrameId),
  };
}

/**
 * Plays one persona action. `layers` are the measured layers of the screen
 * the action was taken on, and `targets` map that screen's element ids to
 * their layer and point. Never mutates `state`.
 */
export function apply(
  doc: ProtoDoc,
  state: TraceState,
  action: TraceAction,
  layers: RawLayer[],
  targets: Record<string, ElementTarget>,
): ApplyResult {
  if (action.type === 'give_up' || action.type === 'done') {
    throw new EngineError('run_ending_action', `${action.type} ends the run, which the backend handles`);
  }
  const s = structuredClone(state);
  const index = indexLayers(layers);
  const ctx: Context = { doc, frames: new Map(doc.frames.map((f) => [f.id, f])), layers: index, effects: [] };
  const pointer = pointerDeps(ctx, index);
  const at = (element: string) => targetOf(targets, element);

  let fallback: TraceOutcome = 'nothing_happened';
  switch (action.type) {
    case 'click':
      click(pointer, s, at(action.element).point);
      break;
    case 'hover':
      movePointer(pointer, s, at(action.element).point);
      break;
    case 'drag':
      drag(pointer, s, at(action.element).point);
      break;
    case 'scroll': {
      fallback = 'scroll_at_end';
      const target = action.element === undefined ? null : at(action.element);
      if (target && !movePointer(pointer, s, target.point)) break;
      scrollBy(index, s, baseFrame(ctx, s), action.direction, action.amount ?? 'page', target?.layerKey ?? null);
      break;
    }
    case 'back':
      fallback = 'back_empty';
      goBack(s);
      break;
    case 'press_key':
    case 'type':
    case 'wait':
      throw new EngineError('not_implemented', `The engine doesn't play ${action.type} yet`);
  }
  prune(s);
  return { state: s, outcome: outcomeOf(state, s, ctx.effects, fallback), effects: ctx.effects };
}

/**
 * Fires what would happen before a person acted again: pending delayed
 * mouse reactions, each only if the pointer is still where its trigger
 * needs it. Never mutates `state`.
 */
export function settle(doc: ProtoDoc, state: TraceState): SettleResult {
  const s = structuredClone(state);
  const ctx: Context = { doc, frames: new Map(doc.frames.map((f) => [f.id, f])), layers: null, effects: [] };
  let fired = 0;
  for (let i = nextMouseTimer(s.timers); i >= 0; i = nextMouseTimer(s.timers)) {
    const timer = s.timers.splice(i, 1)[0] as TraceTimer;
    if (!stillWhereNeeded(s, timer)) continue;
    s.clockMs = Math.max(s.clockMs, timer.dueAtMs);
    run(ctx, s, timer.actions, { layerKey: timer.layerKey, frameId: timer.frameId, box: timer.triggerBox });
    fired++;
  }
  prune(s);
  return { state: s, fired, looped: null, effects: ctx.effects };
}

// --- Firing reactions -----------------------------------------------------------

function targetOf(targets: Record<string, ElementTarget>, element: string): ElementTarget {
  if (!Object.prototype.hasOwnProperty.call(targets, element)) {
    throw new EngineError('unknown_element', `Element ${element} isn't on this screen`);
  }
  return targets[element] as ElementTarget;
}

function reactionsFor(doc: ProtoDoc, layerKey: string): ProtoReaction[] {
  return doc.reactions[layerKey] ?? [];
}

function pointerDeps(ctx: Context, layers: LayerIndex): PointerDeps {
  return {
    layers,
    handles: (_s, key, trigger) => reactionsFor(ctx.doc, key).some((r) => r.trigger.type === trigger),
    fire: (s, key, trigger) => fire(ctx, layers, s, key, trigger),
  };
}

function delayOf(trigger: ProtoTrigger): number {
  switch (trigger.type) {
    case 'MOUSE_DOWN':
    case 'MOUSE_UP':
    case 'MOUSE_ENTER':
    case 'MOUSE_LEAVE':
      return trigger.delayMs;
    default:
      return 0;
  }
}

/** Runs the layer's reactions for one trigger, or sets a timer for one whose trigger has a delay. */
function fire(ctx: Context, layers: LayerIndex, s: TraceState, layerKey: string, trigger: TriggerType): void {
  const source: Source = { layerKey, frameId: rootOf(layers, layerKey), box: layerOf(layers, layerKey).unclippedBox };
  for (const reaction of reactionsFor(ctx.doc, layerKey)) {
    if (reaction.trigger.type !== trigger) continue;
    const delayMs = delayOf(reaction.trigger);
    if (delayMs > 0) {
      s.timers.push({
        layerKey,
        frameId: source.frameId,
        triggerType: trigger,
        dueAtMs: s.clockMs + delayMs,
        actions: structuredClone(reaction.actions),
        triggerBox: { ...source.box },
      });
    } else {
      run(ctx, s, reaction.actions, source);
    }
  }
}

function nextMouseTimer(timers: TraceTimer[]): number {
  let next = -1;
  timers.forEach((timer, i) => {
    if (isMouseTimer(timer) && (next < 0 || timer.dueAtMs < (timers[next] as TraceTimer).dueAtMs)) next = i;
  });
  return next;
}

/** Drops held effects and timers of frames that no longer show: leaving a frame cancels them. */
function prune(s: TraceState): void {
  s.pointer.held = s.pointer.held.filter((h) => isShown(s, h.frameId));
  s.timers = s.timers.filter((t) => isShown(s, t.frameId));
}

// --- Prototype actions ----------------------------------------------------------

function run(ctx: Context, s: TraceState, actions: ProtoAction[], source: Source): void {
  for (const action of actions) runAction(ctx, s, action, source);
}

function runAction(ctx: Context, s: TraceState, action: ProtoAction, source: Source): void {
  switch (action.type) {
    case 'NODE':
      runNode(ctx, s, action, source);
      return;
    case 'BACK':
      goBack(s);
      return;
    case 'CLOSE':
      s.overlays.pop();
      return;
    case 'URL':
      ctx.effects.push({ type: 'url', url: action.url });
      return;
    case 'UPDATE_MEDIA_RUNTIME':
      ctx.effects.push({ type: 'unsupported', action: action.type });
      return;
    case 'UNKNOWN':
      ctx.effects.push({ type: 'unsupported', action: action.rawType });
      return;
    case 'SET_VARIABLE':
    case 'SET_VARIABLE_MODE':
    case 'CONDITIONAL':
      throw new EngineError('not_implemented', `The engine doesn't play ${action.type} yet`);
  }
}

function runNode(ctx: Context, s: TraceState, action: NodeAction, source: Source): void {
  if (action.navigation === 'SCROLL_TO') {
    // `settle` runs before the render, so there is no measured screen to scroll in.
    if (!ctx.layers) ctx.effects.push({ type: 'unsupported', action: 'SCROLL_TO' });
    else if (action.destinationId !== null) scrollIntoView(ctx.layers, s, baseFrame(ctx, s), action.destinationId);
    return;
  }
  if (action.navigation === 'CHANGE_TO') {
    throw new EngineError('not_implemented', "The engine doesn't play CHANGE_TO yet");
  }

  const dest = action.destinationId === null ? undefined : ctx.frames.get(action.destinationId);
  // A link to a frame that isn't there does nothing, as in the viewer.
  if (!dest) return;
  if (action.navigation === 'NAVIGATE') showBase(s, dest, action, true);
  else if (action.navigation === 'SWAP') swap(s, dest, action, source);
  else openOverlay(s, dest, action, source);
}

function baseFrame(ctx: Context, s: TraceState): ProtoFrame {
  const frame = ctx.frames.get(s.frameId);
  if (!frame) throw new EngineError('invalid_doc', `The frame on screen, ${s.frameId}, isn't in the prototype`);
  return frame;
}

/** The scroll resets when `resetScrollPosition` is true, or when the deprecated `preserveScrollPosition` is false. */
const resetsScroll = (action: NodeAction) => action.resetScrollPosition || !action.preserveScrollPosition;

/** Shows `dest` as the base frame. Open overlays close, and the layers under the pointer go with the old frame. */
function showBase(s: TraceState, dest: ProtoFrame, action: NodeAction, pushHistory: boolean): void {
  scrollOnShow(s, dest, { reset: resetsScroll(action), asBase: true });
  if (action.resetInteractiveComponents) delete s.variants[dest.id];
  if (pushHistory) s.history.push(s.frameId);
  s.frameId = dest.id;
  s.overlays = [];
  s.pointer.over = [];
}

function goBack(s: TraceState): void {
  const previous = s.history.pop();
  if (previous === undefined) return;
  s.frameId = previous;
  s.overlays = [];
  s.pointer.over = [];
}

/** Replaces the overlay the trigger is in, or the base frame (without history) when it's in the base frame. */
function swap(s: TraceState, dest: ProtoFrame, action: NodeAction, source: Source): void {
  const i = s.overlays.findIndex((o) => o.frameId === source.frameId);
  if (i < 0) {
    showBase(s, dest, action, false);
    return;
  }
  if (dest.id !== source.frameId && isShown(s, dest.id)) return;
  scrollOnShow(s, dest, { reset: resetsScroll(action), asBase: false });
  if (action.resetInteractiveComponents) delete s.variants[dest.id];
  s.overlays[i] = overlayEntry(s, dest, action, source);
}

/** Opens `dest` as an overlay on top. A frame that is already showing doesn't open twice. */
function openOverlay(s: TraceState, dest: ProtoFrame, action: NodeAction, source: Source): void {
  if (isShown(s, dest.id)) return;
  scrollOnShow(s, dest, { reset: resetsScroll(action), asBase: false });
  if (action.resetInteractiveComponents) delete s.variants[dest.id];
  s.overlays.push(overlayEntry(s, dest, action, source));
}

function overlayEntry(s: TraceState, dest: ProtoFrame, action: NodeAction, source: Source): OpenOverlay {
  return {
    frameId: dest.id,
    position: dest.overlay.position,
    origin: overlayOrigin(dest, s.viewport, action, source),
    closeOnOutsideClick: dest.overlay.closeOnOutsideClick,
  };
}

/** One of eight places in the viewport, or (MANUAL) offset from the trigger's box. */
function overlayOrigin(frame: ProtoFrame, viewport: Size, action: NodeAction, source: Source): Point {
  const right = viewport.width - frame.width;
  const bottom = viewport.height - frame.height;
  switch (frame.overlay.position) {
    case 'CENTER':
      return { x: right / 2, y: bottom / 2 };
    case 'TOP_LEFT':
      return { x: 0, y: 0 };
    case 'TOP_CENTER':
      return { x: right / 2, y: 0 };
    case 'TOP_RIGHT':
      return { x: right, y: 0 };
    case 'BOTTOM_LEFT':
      return { x: 0, y: bottom };
    case 'BOTTOM_CENTER':
      return { x: right / 2, y: bottom };
    case 'BOTTOM_RIGHT':
      return { x: right, y: bottom };
    case 'MANUAL': {
      const offset = action.overlayRelativePosition;
      if (!offset) {
        throw new EngineError('invalid_doc', `The MANUAL overlay ${frame.id} opened from ${source.layerKey} has no offset`);
      }
      return { x: source.box.x + offset.x, y: source.box.y + offset.y };
    }
  }
}
