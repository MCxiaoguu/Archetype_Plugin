/**
 * Builders for the trace engine tests: small hand-built ProtoDocs and
 * measured layer lists.
 */

import { apply } from '../src/lib/proto/engine';
import type {
  Box,
  ElementTarget,
  OverlaySettings,
  ProtoAction,
  ProtoDoc,
  ProtoFrame,
  ProtoNavigation,
  ProtoReaction,
  RawLayer,
  TraceAction,
  TraceDirection,
  TraceScrollAmount,
  TraceState,
} from '../src/lib/proto/model';

export type Rect = [x: number, y: number, width: number, height: number];
export type NodeAction = Extract<ProtoAction, { type: 'NODE' }>;

export const box = ([x, y, width, height]: Rect): Box => ({ x, y, width, height });

export function frame(id: string, width: number, height: number, extra: Partial<ProtoFrame> = {}): ProtoFrame {
  return {
    id,
    name: `Frame ${id}`,
    pageId: 'p',
    width,
    height,
    overflowDirection: 'NONE',
    numberOfFixedChildren: 0,
    overlay: { position: 'CENTER', background: { type: 'NONE' }, closeOnOutsideClick: false },
    explicitVariableModes: {},
    ...extra,
  };
}

export function overlayFrame(id: string, width: number, height: number, settings: Partial<OverlaySettings> = {}): ProtoFrame {
  return frame(id, width, height, {
    overlay: { position: 'CENTER', background: { type: 'NONE' }, closeOnOutsideClick: false, ...settings },
  });
}

export function protoDoc(frames: ProtoFrame[], reactions: Record<string, ProtoReaction[]> = {}, extra: Partial<ProtoDoc> = {}): ProtoDoc {
  return {
    docHash: 'hash-1',
    pageId: 'p',
    pageName: 'Prototype',
    explicitVariableModes: {},
    frames,
    reactions,
    variantSets: {},
    variableCollections: {},
    libraryVariants: [],
    ...extra,
  };
}

export function node(navigation: ProtoNavigation, destinationId: string | null, options: Partial<NodeAction> = {}): ProtoAction {
  return {
    type: 'NODE',
    navigation,
    destinationId,
    resetScrollPosition: false,
    preserveScrollPosition: true,
    resetInteractiveComponents: false,
    overlayRelativePosition: null,
    ...options,
  };
}
export const navigate = (to: string, options: Partial<NodeAction> = {}) => node('NAVIGATE', to, options);
export const openOverlay = (to: string, options: Partial<NodeAction> = {}) => node('OVERLAY', to, options);
/** A link leaves the screen as it is, so tests use one to see which reactions fired, and in what order. */
export const link = (url: string): ProtoAction => ({ type: 'URL', url });
export const urls = (effects: Array<{ type: string; url?: string }>) => effects.map((e) => e.url);

export const on = (type: 'ON_CLICK' | 'ON_HOVER' | 'ON_PRESS' | 'ON_DRAG', ...actions: ProtoAction[]): ProtoReaction => ({
  trigger: { type },
  actions,
});
export const mouse = (
  type: 'MOUSE_DOWN' | 'MOUSE_UP' | 'MOUSE_ENTER' | 'MOUSE_LEAVE',
  delayMs: number,
  ...actions: ProtoAction[]
): ProtoReaction => ({ trigger: { type, delayMs }, actions });

export function layer(key: string, parentKey: string | null, rect: Rect, extra: Partial<RawLayer> = {}): RawLayer {
  return {
    key,
    type: 'FRAME',
    name: key,
    text: null,
    box: box(rect),
    unclippedBox: box(rect),
    visible: true,
    paints: true,
    hasReactions: false,
    roleHint: null,
    parentKey,
    scroll: null,
    fixed: false,
    ...extra,
  };
}

/** Element targets for every layer, at its box's centre. The tests use layer keys as element ids. */
export function centres(layers: RawLayer[]): Record<string, ElementTarget> {
  const targets: Record<string, ElementTarget> = {};
  for (const l of layers) {
    targets[l.key] = { layerKey: l.key, point: { x: l.box.x + l.box.width / 2, y: l.box.y + l.box.height / 2 } };
  }
  return targets;
}

export const click = (element: string): TraceAction => ({ type: 'click', element });
export const hover = (element: string): TraceAction => ({ type: 'hover', element });
export const scroll = (direction: TraceDirection, element?: string, amount?: TraceScrollAmount): TraceAction => ({
  type: 'scroll',
  direction,
  ...(element ? { element } : {}),
  ...(amount ? { amount } : {}),
});

export function act(doc: ProtoDoc, state: TraceState, action: TraceAction, layers: RawLayer[], targets = centres(layers)) {
  return apply(doc, state, action, layers, targets);
}

/** A 400x800 screen A with one button; the viewport is A's size. */
export const A = frame('A', 400, 800);
export const B = frame('B', 400, 800);
export const C = frame('C', 400, 800);
export const screenA = [layer('A', null, [0, 0, 400, 800]), layer('btn', 'A', [20, 20, 100, 40])];

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
