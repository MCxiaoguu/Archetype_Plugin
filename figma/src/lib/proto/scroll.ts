/**
 * Scroll positions. The base frame's page moves under the fixed viewport
 * when the frame is taller or wider than the viewport, whatever its
 * `overflowDirection`, as in the viewer; an open overlay bigger than the
 * viewport moves the same way. A nested frame whose `overflowDirection`
 * isn't NONE is a scroll area: its content moves on the axes that
 * direction allows, as far as the renderer measured it to reach. Fixed
 * children stay put while their frame scrolls. While an overlay is open,
 * only it scrolls: never the page under it.
 */

import { hittableFrame, type LayerIndex, layerOf, rootOf } from './hitTest';
import type { Box, ProtoFrame, RawLayer, ScrollArea, ScrollOffset, Size, TraceDirection, TraceScrollAmount, TraceState } from './model';

export interface ScrollRange {
  maxX: number;
  maxY: number;
}

/** A frame's page (the base frame's, or an open overlay's), or a nested area. */
interface Scroller {
  frameId: string;
  /** The area's layer key; null for a page. */
  areaKey: string | null;
  range: ScrollRange;
  /** What the scroller shows, in viewport coordinates: the viewport (from the overlay's origin) for a page, the area's own box otherwise. */
  view: Box;
}

/** A scroller around a layer, with the layer on the way to it that is its direct child (null for the scroller itself). */
interface Around {
  scroller: Scroller;
  via: RawLayer | null;
}

/** How far one scroll moves, as a share of the scroller's view. */
const STEP: Record<TraceScrollAmount, number> = { page: 0.9, half: 0.5 };

const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);

/**
 * How far content that overflows by `overflow` scrolls: in whole pixels,
 * never below zero. Under half a pixel (a frame 818.4 tall in an 818
 * viewport) doesn't scroll, since nothing would visibly move. The renderer
 * measures scroll areas with it too, so its ranges are the engine's.
 */
export function scrollRange(overflow: number): number {
  return Math.max(0, Math.round(overflow));
}

/**
 * How far a page scrolls: by the frame's size as rendered now, the root
 * layer's unclipped box, which a variant swap in a hug-height frame can have
 * grown since the read. Only a frame about to show, not rendered yet, is
 * measured by the size the read gave it (scrollOnShow).
 */
export function pageRange(size: { width: number; height: number }, viewport: Size): ScrollRange {
  return { maxX: scrollRange(size.width - viewport.width), maxY: scrollRange(size.height - viewport.height) };
}

/** The page range of a measured root layer. */
export function measuredPageRange(root: RawLayer, viewport: Size): ScrollRange {
  return pageRange(root.unclippedBox, viewport);
}

function areaRange(area: ScrollArea): ScrollRange {
  return {
    maxX: area.direction === 'VERTICAL' ? 0 : scrollRange(area.maxX),
    maxY: area.direction === 'HORIZONTAL' ? 0 : scrollRange(area.maxY),
  };
}

export function pageOffset(s: TraceState, frameId: string): ScrollOffset {
  const entry = s.scroll[frameId];
  return entry ? { x: entry.x, y: entry.y } : { x: 0, y: 0 };
}

function offsetOf(s: TraceState, scroller: Scroller): ScrollOffset {
  if (scroller.areaKey === null) return pageOffset(s, scroller.frameId);
  const area = s.scroll[scroller.frameId]?.areas[scroller.areaKey];
  return area ? { ...area } : { x: 0, y: 0 };
}

function setOffset(s: TraceState, scroller: Scroller, offset: ScrollOffset): void {
  const entry = s.scroll[scroller.frameId] ?? { x: 0, y: 0, areas: {} };
  s.scroll[scroller.frameId] = entry;
  if (scroller.areaKey === null) {
    entry.x = offset.x;
    entry.y = offset.y;
  } else {
    entry.areas[scroller.areaKey] = { ...offset };
  }
}

function pageOf(s: TraceState, frames: Map<string, ProtoFrame>, root: RawLayer): Scroller | null {
  const rootKey = root.key;
  if (!frames.has(rootKey)) return null;
  const { width, height } = s.viewport;
  const range = measuredPageRange(root, s.viewport);
  if (rootKey === s.frameId) return { frameId: rootKey, areaKey: null, range, view: { x: 0, y: 0, width, height } };
  const overlay = s.overlays.find((o) => o.frameId === rootKey);
  if (overlay) return { frameId: rootKey, areaKey: null, range, view: { ...overlay.origin, width, height } };
  return null;
}

/** The scrollers that move `key`, innermost first: the areas around it, then the page of its frame. */
function scrollersAround(index: LayerIndex, s: TraceState, frames: Map<string, ProtoFrame>, key: string, withSelf: boolean): Around[] {
  const around: Around[] = [];
  let via: RawLayer | null = null;
  let layer: RawLayer | null = layerOf(index, key);
  if (!withSelf) {
    via = layer;
    layer = layer.parentKey === null ? null : layerOf(index, layer.parentKey);
  }
  while (layer) {
    const frameId = rootOf(index, layer.key);
    if (layer.scroll) {
      around.push({ scroller: { frameId, areaKey: layer.key, range: areaRange(layer.scroll), view: layer.unclippedBox }, via });
    }
    if (layer.parentKey === null) {
      const page = pageOf(s, frames, layer);
      if (page) around.push({ scroller: page, via });
    }
    via = layer;
    layer = layer.parentKey === null ? null : layerOf(index, layer.parentKey);
  }
  return around;
}

/**
 * The persona's scroll, in the frame that can be hit: the top overlay
 * while one is open, otherwise the base frame. With `fromKey` (the layer
 * of the element it scrolled over), the innermost scroller around it that
 * can move on that axis moves, as a scroll wheel would; a horizontal
 * carousel passes a vertical scroll on to the page. Without, that frame's
 * page moves, as if scrolling over its root. Over an element of a frame
 * under an open overlay nothing moves. Returns whether anything moved:
 * false at the end of the range.
 */
export function scrollBy(
  index: LayerIndex,
  s: TraceState,
  frames: Map<string, ProtoFrame>,
  direction: TraceDirection,
  amount: TraceScrollAmount,
  fromKey: string | null,
): boolean {
  const top = hittableFrame(index, s);
  if (fromKey !== null && rootOf(index, fromKey) !== top) return false;
  const vertical = direction === 'up' || direction === 'down';
  const sign = direction === 'up' || direction === 'left' ? -1 : 1;
  const found = scrollersAround(index, s, frames, fromKey ?? top, true).find(({ scroller }) =>
    vertical ? scroller.range.maxY > 0 : scroller.range.maxX > 0,
  );
  if (!found) return false;

  const { scroller } = found;
  const offset = offsetOf(s, scroller);
  const step = Math.round(STEP[amount] * (vertical ? scroller.view.height : scroller.view.width));
  const next = vertical
    ? { x: offset.x, y: clamp(offset.y + sign * step, scroller.range.maxY) }
    : { x: clamp(offset.x + sign * step, scroller.range.maxX), y: offset.y };
  if (next.x === offset.x && next.y === offset.y) return false;
  setOffset(s, scroller, next);
  return true;
}

/**
 * SCROLL_TO: moves each scroller around the node, innermost first, so the
 * node's top left comes to its view's top left, within range. A node that
 * is (or sits in) a fixed child of a scroller doesn't move when that
 * scroller does, so that scroller stays. Returns whether anything moved.
 * The node must be on this screen; the engine checks.
 */
export function scrollIntoView(index: LayerIndex, s: TraceState, frames: Map<string, ProtoFrame>, key: string): boolean {
  let { x, y } = layerOf(index, key).unclippedBox;
  let moved = false;
  for (const { scroller, via } of scrollersAround(index, s, frames, key, false)) {
    if (via?.fixed) continue;
    const offset = offsetOf(s, scroller);
    const next = {
      x: clamp(x - scroller.view.x + offset.x, scroller.range.maxX),
      y: clamp(y - scroller.view.y + offset.y, scroller.range.maxY),
    };
    if (next.x !== offset.x || next.y !== offset.y) {
      setOffset(s, scroller, next);
      moved = true;
    }
    x -= next.x - offset.x;
    y -= next.y - offset.y;
  }
  return moved;
}

/**
 * The scroll of a frame about to show, called before it shows. A reset
 * starts its page and areas at zero. Otherwise its areas keep their
 * offsets and, shown as the base frame, it takes the page offset of the
 * base frame it replaces, within its own range.
 */
export function scrollOnShow(s: TraceState, dest: ProtoFrame, options: { reset: boolean; asBase: boolean }): void {
  if (options.reset) {
    delete s.scroll[dest.id];
    return;
  }
  if (!options.asBase) return;
  const from = pageOffset(s, s.frameId);
  const range = pageRange(dest, s.viewport);
  const x = clamp(from.x, range.maxX);
  const y = clamp(from.y, range.maxY);
  const entry = s.scroll[dest.id];
  if (entry) s.scroll[dest.id] = { ...entry, x, y };
  else if (x || y) s.scroll[dest.id] = { x, y, areas: {} };
}
