/**
 * The trace engine: a pure, deterministic interpreter of a Figma
 * prototype, one instance per persona in the panel. `start` opens the
 * start frame, `apply` plays one persona action on the screen it was taken
 * on, and `settle` fires what would happen before a person acted again.
 * This module dispatches: hit-testing, the pointer, scrolling, navigation,
 * variables, variants, keys and timers live in their own modules beside it.
 */

import { EngineError } from './errors';
import { ExprError, type ExprScope } from './expr';
import { chainOf, checkMeasured, indexLayers, isShown, type LayerIndex, layerOf, rootOf } from './hitTest';
import { keyCodes, type KeyDeps, matchesKeys, pressKey, typeText } from './keys';
import type {
  ElementReading,
  ElementTarget,
  ProtoAction,
  ProtoDoc,
  ProtoReaction,
  ProtoTrigger,
  RawLayer,
  ReadingLookup,
  Size,
  TraceAction,
  TraceOutcome,
  TraceState,
  TraceTimer,
} from './model';
import { frameOf, goBack, type NodeAction, openOverlay, type Proto, showBase, type Source, swap } from './navigation';
import { type EngineEffect, outcomeOf } from './outcome';
import { click, drag, movePointer, type PointerDeps, stillWhereNeeded, type TriggerType } from './pointer';
import { scrollBy, scrollIntoView } from './scroll';
import { addTimer, firesAtSettle, isMouseTimer, LOOP_GUARD, nextTimer, restartInstanceTimers, startFrameTimers } from './timers';
import { assignVariable, conditionalBlock, setVariableMode } from './variables';
import { instanceFor, reactionsFor, setOverride } from './variants';

export type { EngineEffect } from './outcome';

export interface ApplyResult {
  state: TraceState;
  outcome: TraceOutcome;
  effects: EngineEffect[];
  /** Set when a `wait` met the loop guard, as in `SettleResult`. */
  looped: string[] | null;
  /** The flow map's reading that decided the outcome; null when the prototype's own reactions did. */
  reading: ElementReading | null;
}

export interface SettleResult {
  state: TraceState;
  /** How many reactions fired. */
  fired: number;
  /** The frames whose timers fired when the loop guard stopped a loop of timers; null when it didn't. */
  looped: string[] | null;
  effects: EngineEffect[];
}

interface Context extends Proto {
  /** The measured screen; null in `settle`, which runs before the next render. */
  layers: LayerIndex | null;
  effects: EngineEffect[];
}

const context = (doc: ProtoDoc, layers: LayerIndex | null): Context => ({
  doc,
  frames: new Map(doc.frames.map((f) => [f.id, f])),
  layers,
  effects: [],
});

/**
 * The viewport is the start frame's size, its height capped like a laptop's
 * or a phone's screen, in whole pixels as a device's is (the backend's claim
 * takes only whole numbers). A frame a fraction taller keeps that fraction
 * as its page's scroll range.
 */
export function viewportFor(doc: ProtoDoc, startFrameId: string): Size {
  const frame = doc.frames.find((f) => f.id === startFrameId);
  if (!frame) throw new EngineError('invalid_doc', `The start frame ${startFrameId} isn't in the prototype`);
  const width = Math.round(frame.width);
  return { width, height: Math.round(Math.min(frame.height, width >= 768 ? 900 : 844)) };
}

export function start(doc: ProtoDoc, startFrameId: string): TraceState {
  const viewport = viewportFor(doc, startFrameId);
  const s: TraceState = {
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
    viewport,
    focus: null,
  };
  const frame = frameOf(context(doc, null), startFrameId);
  startFrameTimers(doc, s, startFrameId, { x: 0, y: 0, width: frame.width, height: frame.height });
  return s;
}

/** A state belongs to the document it was made from; the session aborts a run whose file changed. */
function checkDoc(doc: ProtoDoc, state: TraceState): void {
  if (state.docHash !== doc.docHash) {
    throw new EngineError('doc_changed', `The state was made from document ${state.docHash}, not ${doc.docHash}`);
  }
}

/** How an edge the flow map read plays: as a drawn NAVIGATE that resets the scroll and keeps the components' variants. */
const INFERRED_NAVIGATE: NodeAction = {
  type: 'NODE',
  navigation: 'NAVIGATE',
  destinationId: null,
  resetScrollPosition: true,
  preserveScrollPosition: false,
  resetInteractiveComponents: false,
  overlayRelativePosition: null,
};

/**
 * Plays one persona action. `layers` are the measured layers of the screen
 * the action was taken on, and `targets` map that screen's element ids to
 * their layer and point. `readingOf` looks up the run's flow map: a click
 * that lands where no reaction handles it, or a `type` into a control no
 * key reaction takes, plays the reading of the element's own layer (spec,
 * Traversal). Never mutates `state`, `doc` or `layers`.
 */
export function apply(
  doc: ProtoDoc,
  state: TraceState,
  action: TraceAction,
  layers: RawLayer[],
  targets: Record<string, ElementTarget>,
  readingOf: ReadingLookup | null = null,
): ApplyResult {
  if (action.type === 'give_up' || action.type === 'done') {
    throw new EngineError('run_ending_action', `${action.type} ends the run, which the backend handles`);
  }
  checkDoc(doc, state);
  const s = structuredClone(state);
  const index = indexLayers(layers);
  checkMeasured(index, s);
  const ctx = context(doc, index);
  const pointer = pointerDeps(ctx, index);
  const at = (element: string) => targetOf(targets, element);
  /** The reading of the element's own layer, with the node the element is on. */
  const readingAt = (target: ElementTarget) => {
    const node = rootOf(index, target.layerKey);
    const reading = readingOf ? readingOf(node, target.layerKey) : null;
    return reading ? { reading, node } : null;
  };

  let fallback: TraceOutcome = 'nothing_happened';
  let looped: string[] | null = null;
  let read: { reading: ElementReading; node: string } | null = null;
  switch (action.type) {
    case 'click': {
      const target = at(action.element);
      const clicked = click(pointer, s, target.point);
      if (clicked.landed && !clicked.handled) read = readingAt(target);
      break;
    }
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
      scrollBy(index, s, ctx.frames, action.direction, action.amount ?? 'page', target?.layerKey ?? null);
      break;
    }
    case 'back':
      fallback = 'back_empty';
      goBack(ctx, s);
      break;
    case 'press_key': {
      const codes = keyCodes(action.key);
      if (codes) pressKey(keyDeps(ctx, index), s, codes);
      else ctx.effects.push({ type: 'unsupported', action: `press_key ${action.key}` });
      break;
    }
    case 'type': {
      fallback = 'typed_nothing';
      const target = at(action.element);
      if (!movePointer(pointer, s, target.point)) break;
      // Typing into an element focuses it first.
      s.focus = { layerKey: target.layerKey, frameId: rootOf(index, target.layerKey) };
      if (typeText(keyDeps(ctx, index), s, action.text)) break;
      const typedInto = readingAt(target);
      if (typedInto?.reading.kind === 'control') read = typedInto;
      break;
    }
    case 'wait': {
      if (!(Number.isFinite(action.seconds) && action.seconds > 0)) {
        throw new EngineError('invalid_action', `wait needs a positive number of seconds, not ${action.seconds}`);
      }
      const end = s.clockMs + action.seconds * 1000;
      const result = fireTimers(ctx, s, (t) => t.triggerType === 'AFTER_TIMEOUT' && t.dueAtMs <= end);
      // A wait the loop guard stopped keeps the state the loop reached, clock included.
      if (!result.looped) s.clockMs = Math.max(s.clockMs, end);
      prune(s);
      return { state: s, outcome: result.fired ? 'timers_fired' : 'waited', effects: ctx.effects, looped: result.looped, reading: null };
    }
  }
  if (read) {
    // The reading's outcome stands for the action, whatever the pointer's move changed on the way.
    const outcome = playReading(ctx, s, read.reading, read.node);
    prune(s);
    return { state: s, outcome, effects: ctx.effects, looped, reading: read.reading };
  }
  prune(s);
  return { state: s, outcome: outcomeOf(state, s, ctx.effects, fallback), effects: ctx.effects, looped, reading: null };
}

/** Plays the flow map's reading of an element on the node `node`: an edge navigates, unless it goes where the persona is. */
function playReading(ctx: Context, s: TraceState, reading: ElementReading, node: string): TraceOutcome {
  if (reading.kind === 'control') return 'accepted';
  if (reading.kind === 'gap') return 'missing';
  if (reading.to === null) throw new EngineError('invalid_doc', `The flow map's edge ${reading.id} goes nowhere`);
  if (reading.to === node) return 'already_here';
  showBase(ctx, s, frameOf(ctx, reading.to), { ...INFERRED_NAVIGATE, destinationId: reading.to }, true);
  return 'navigated';
}

/**
 * Fires what would happen before a person acted again: pending delayed
 * mouse reactions (each only if the pointer is still where its trigger
 * needs it) and AFTER_TIMEOUT timers due within 2 s, in the order they
 * come due. Never mutates `state` or `doc`.
 */
export function settle(doc: ProtoDoc, state: TraceState): SettleResult {
  checkDoc(doc, state);
  const s = structuredClone(state);
  const ctx = context(doc, null);
  const { fired, looped } = fireTimers(ctx, s, (t) => firesAtSettle(t, s.clockMs));
  prune(s);
  return { state: s, fired, looped, effects: ctx.effects };
}

// --- Firing reactions -----------------------------------------------------------

function targetOf(targets: Record<string, ElementTarget>, element: string): ElementTarget {
  if (!Object.prototype.hasOwnProperty.call(targets, element)) {
    throw new EngineError('unknown_element', `Element ${element} isn't on this screen`);
  }
  return targets[element] as ElementTarget;
}

function pointerDeps(ctx: Context, layers: LayerIndex): PointerDeps {
  return {
    layers,
    handles: (s, key, trigger) => reactionsFor(ctx.doc, s, key).some((r) => r.trigger.type === trigger),
    fire: (s, key, trigger) => fire(ctx, layers, s, key, trigger),
    setVariant: (s, frameId, instanceKey, variantId) => setVariant(ctx, s, frameId, instanceKey, variantId),
  };
}

function keyDeps(ctx: Context, layers: LayerIndex): KeyDeps {
  return {
    layers,
    handles: (s, key, codes) => reactionsFor(ctx.doc, s, key).some((r) => matchesKeys(r.trigger, codes)),
    fire: (s, key, codes) => fire(ctx, layers, s, key, 'ON_KEY_DOWN', (r) => matchesKeys(r.trigger, codes)),
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

/**
 * Runs the layer's reactions for one trigger (those `only` keeps), or sets
 * a timer for one whose trigger has a delay. Triggers are matched by type
 * here; nothing ever fires ON_MEDIA_HIT, ON_MEDIA_END or UNKNOWN: the
 * engine plays no video, and an unknown trigger has no meaning to play.
 */
function fire(
  ctx: Context,
  layers: LayerIndex,
  s: TraceState,
  layerKey: string,
  trigger: TriggerType,
  only: (reaction: ProtoReaction) => boolean = () => true,
): void {
  const box = layerOf(layers, layerKey).unclippedBox;
  const source: Source = { layerKey, chain: chainOf(layers, layerKey), frameId: rootOf(layers, layerKey), box };
  for (const reaction of reactionsFor(ctx.doc, s, layerKey)) {
    if (reaction.trigger.type !== trigger || !only(reaction)) continue;
    const delayMs = delayOf(reaction.trigger);
    if (delayMs > 0) {
      const { chain, frameId } = source;
      addTimer(s, { layerKey, chain, frameId, triggerType: trigger, delayMs, actions: reaction.actions, triggerBox: { ...box } });
    } else {
      run(ctx, s, reaction.actions, source);
    }
  }
}

/** Fires the timers `eligible` picks, earliest first, until none is left or the loop guard stops them. */
function fireTimers(ctx: Context, s: TraceState, eligible: (timer: TraceTimer) => boolean) {
  let fired = 0;
  const frames: string[] = [];
  for (let i = nextTimer(s.timers, eligible); i >= 0; i = nextTimer(s.timers, eligible)) {
    if (fired === LOOP_GUARD) return { fired, looped: frames };
    const timer = s.timers.splice(i, 1)[0] as TraceTimer;
    if (isMouseTimer(timer) && !stillWhereNeeded(s, timer)) continue;
    s.clockMs = Math.max(s.clockMs, timer.dueAtMs);
    run(ctx, s, timer.actions, { layerKey: timer.layerKey, chain: timer.chain, frameId: timer.frameId, box: timer.triggerBox });
    fired++;
    if (!frames.includes(timer.frameId)) frames.push(timer.frameId);
    prune(s);
  }
  return { fired, looped: null };
}

/** Drops what belongs to frames that no longer show: held effects, timers (leaving a frame cancels them) and focus. */
function prune(s: TraceState): void {
  s.pointer.held = s.pointer.held.filter((h) => isShown(s, h.frameId));
  s.timers = s.timers.filter((t) => isShown(s, t.frameId));
  if (s.focus && !isShown(s, s.focus.frameId)) s.focus = null;
}

function setVariant(ctx: Context, s: TraceState, frameId: string, instanceKey: string, variantId: string | null): void {
  if (setOverride(s, frameId, instanceKey, variantId)) restartInstanceTimers(ctx.doc, s, frameId, instanceKey);
}

// --- Prototype actions ----------------------------------------------------------

function run(ctx: Context, s: TraceState, actions: ProtoAction[], source: Source): void {
  for (const action of actions) runAction(ctx, s, action, source);
}

/** Runs a variable action, reporting an ExprError as an effect: the document's variables, not the engine, failed. */
function tryExpr<T>(ctx: Context, action: string, evaluate: () => T): T | null {
  try {
    return evaluate();
  } catch (error) {
    if (!(error instanceof ExprError)) throw error;
    ctx.effects.push({ type: 'expr_error', action, message: error.message });
    return null;
  }
}

function runAction(ctx: Context, s: TraceState, action: ProtoAction, source: Source): void {
  const scope: ExprScope = { doc: ctx.doc, state: s, frameId: source.frameId };
  switch (action.type) {
    case 'NODE':
      runNode(ctx, s, action, source);
      return;
    case 'BACK':
      goBack(ctx, s);
      return;
    case 'CLOSE':
      s.overlays.pop();
      return;
    case 'URL':
      // An Open link with no URL filled in has nowhere to go: it does nothing, as an unfinished action does.
      if (action.url.trim()) ctx.effects.push({ type: 'url', url: action.url });
      return;
    case 'UPDATE_MEDIA_RUNTIME':
      ctx.effects.push({ type: 'unsupported', action: action.type });
      return;
    case 'UNKNOWN':
      ctx.effects.push({ type: 'unsupported', action: action.rawType });
      return;
    case 'SET_VARIABLE': {
      // An unfinished action (no variable or no value) does nothing, as in the viewer.
      const { variableId, value } = action;
      if (variableId !== null && value !== null) tryExpr(ctx, action.type, () => assignVariable(scope, variableId, value));
      return;
    }
    case 'SET_VARIABLE_MODE': {
      const { collectionId, modeId } = action;
      if (collectionId !== null && modeId !== null) tryExpr(ctx, action.type, () => setVariableMode(scope, collectionId, modeId));
      return;
    }
    case 'CONDITIONAL': {
      const block = tryExpr(ctx, action.type, () => conditionalBlock(scope, action.blocks));
      if (block) run(ctx, s, block.actions, source);
      return;
    }
  }
}

function runNode(ctx: Context, s: TraceState, action: NodeAction, source: Source): void {
  // A link without a destination does nothing, as in the viewer. A
  // destination the document doesn't have is no misclick: the reader didn't
  // deliver it, so the persona is told the prototype couldn't play it.
  const destinationId = action.destinationId;
  if (destinationId === null) return;
  const missing = (what: string) => ctx.effects.push({ type: 'unsupported', action: `${what}:${destinationId}` });

  if (action.navigation === 'SCROLL_TO') {
    // `settle` runs before the render, so there is no measured screen to scroll in.
    if (!ctx.layers) ctx.effects.push({ type: 'unsupported', action: 'SCROLL_TO' });
    else if (!ctx.layers.byKey.has(destinationId)) missing('missing_destination');
    else scrollIntoView(ctx.layers, s, ctx.frames, destinationId);
    return;
  }
  if (action.navigation === 'CHANGE_TO') {
    const found = instanceFor(ctx.doc, source.chain, destinationId);
    if (!found) missing('missing_variant_set');
    else if (found.variant.unavailable) ctx.effects.push({ type: 'unsupported', action: 'CHANGE_TO' });
    else setVariant(ctx, s, found.frameId, found.instanceKey, found.variant.id);
    return;
  }

  const dest = ctx.frames.get(destinationId);
  if (!dest) {
    missing('missing_destination');
    return;
  }
  if (action.navigation === 'NAVIGATE') {
    showBase(ctx, s, dest, action, true);
    return;
  }
  const placed = action.navigation === 'SWAP' ? swap(ctx, s, dest, action, source) : openOverlay(ctx, s, dest, action, source);
  // A MANUAL overlay from a trigger that wasn't measured can't be placed.
  if (!placed) ctx.effects.push({ type: 'unsupported', action: action.navigation });
}
