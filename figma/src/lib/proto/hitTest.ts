/**
 * Finding what a point hits, as the prototype viewer does: the topmost
 * layer whose measured box holds the point. Boxes arrive already clipped by
 * `clipsContent` ancestors, so content scrolled out of a nested area can't
 * be hit. Invisible layers that carry reactions (transparent hotspots) are
 * measured like any other and can be hit; hidden layers can't. While an
 * overlay is open only its layers can be hit.
 */

import { EngineError } from './errors';
import type { Box, Point, RawLayer, TraceState } from './model';

/** The measured layers of one screen, indexed. */
export interface LayerIndex {
  /** In paint order: a later layer draws over an earlier one. */
  layers: RawLayer[];
  byKey: Map<string, RawLayer>;
  /** The top level frame (base or overlay) each layer is in: the key of its root layer. */
  rootOf: Map<string, string>;
  /** Keys of the layers that are visible along with all their ancestors. */
  visible: Set<string>;
}

export function indexLayers(layers: RawLayer[]): LayerIndex {
  const byKey = new Map<string, RawLayer>();
  for (const layer of layers) {
    if (byKey.has(layer.key)) throw new EngineError('invalid_layers', `Layer ${layer.key} was measured twice`);
    byKey.set(layer.key, layer);
  }

  const rootOf = new Map<string, string>();
  const visible = new Set<string>();
  for (const layer of layers) {
    let top = layer;
    let shown = layer.visible;
    const seen = new Set([layer.key]);
    while (top.parentKey !== null) {
      const parent = byKey.get(top.parentKey);
      if (!parent) throw new EngineError('invalid_layers', `Layer ${top.key} has parent ${top.parentKey}, which wasn't measured`);
      if (seen.has(parent.key)) throw new EngineError('invalid_layers', `Layer ${layer.key} is its own ancestor`);
      seen.add(parent.key);
      shown = shown && parent.visible;
      top = parent;
    }
    rootOf.set(layer.key, top.key);
    if (shown) visible.add(layer.key);
  }
  return { layers, byKey, rootOf, visible };
}

export function layerOf(index: LayerIndex, key: string): RawLayer {
  const layer = index.byKey.get(key);
  if (!layer) throw new EngineError('invalid_layers', `Layer ${key} wasn't measured on this screen`);
  return layer;
}

export function rootOf(index: LayerIndex, key: string): string {
  const root = index.rootOf.get(key);
  if (root === undefined) throw new EngineError('invalid_layers', `Layer ${key} wasn't measured on this screen`);
  return root;
}

export function contains(box: Box, p: Point): boolean {
  return p.x >= box.x && p.x < box.x + box.width && p.y >= box.y && p.y < box.y + box.height;
}

/** Whether a top level frame is showing, as the base frame or an open overlay. */
export function isShown(s: TraceState, frameId: string): boolean {
  return s.frameId === frameId || s.overlays.some((o) => o.frameId === frameId);
}

/** The base frame and its place in history: a change means a navigation, after which the old layers are gone. */
export const baseOf = (s: TraceState) => JSON.stringify([s.frameId, s.history]);

/** What "shows a different frame or overlay" is measured against. */
export const screenOf = (s: TraceState) => JSON.stringify([s.frameId, s.history, s.overlays.map((o) => o.frameId)]);

/** The frame whose layers can be hit: the top overlay while one is open, otherwise the base frame. */
export function hittableFrame(s: TraceState): string {
  const top = s.overlays[s.overlays.length - 1];
  return top ? top.frameId : s.frameId;
}

/** The topmost layer at `p` that can be hit, or null. */
export function hitAt(index: LayerIndex, s: TraceState, p: Point): RawLayer | null {
  const frameId = hittableFrame(s);
  for (let i = index.layers.length - 1; i >= 0; i--) {
    const layer = index.layers[i] as RawLayer;
    if (index.rootOf.get(layer.key) !== frameId || !index.visible.has(layer.key)) continue;
    if (contains(layer.box, p)) return layer;
  }
  return null;
}

/** `key` and its ancestors, innermost first. */
export function chainOf(index: LayerIndex, key: string): string[] {
  const chain: string[] = [];
  let layer: RawLayer | null = layerOf(index, key);
  while (layer) {
    chain.push(layer.key);
    layer = layer.parentKey === null ? null : layerOf(index, layer.parentKey);
  }
  return chain;
}

/** The first of `key` and its ancestors that `handles` the event, as an event bubbles; null when none does. */
export function bubble(index: LayerIndex, key: string, handles: (key: string) => boolean): string | null {
  return chainOf(index, key).find(handles) ?? null;
}
