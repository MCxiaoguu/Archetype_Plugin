/**
 * Scroll positions. The base frame's page moves under the fixed viewport
 * when the frame is taller or wider than the viewport, whatever its
 * `overflowDirection`, as in the viewer. A frame whose `overflowDirection`
 * isn't NONE is a scroll area: its content moves on the axes that
 * direction allows, as far as the renderer measured it to reach. Fixed
 * children stay put while their frame scrolls.
 */

import { type LayerIndex, layerOf, rootOf } from './hitTest';
import type { Box, ProtoFrame, RawLayer, ScrollArea, ScrollOffset, Size, TraceDirection, TraceScrollAmount, TraceState } from './model';

export interface ScrollRange {
  maxX: number;
  maxY: number;
}

/** The base frame's page, or a nested area. */
interface Scroller {
  frameId: string;
  /** The area's layer key; null for the page. */
  areaKey: string | null;
  range: ScrollRange;
  /** What the scroller shows, in viewport coordinates: the viewport for the page, the area's own box otherwise. */
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

export function pageRange(frame: ProtoFrame, viewport: Size): ScrollRange {
  return { maxX: Math.max(0, frame.width - viewport.width), maxY: Math.max(0, frame.height - viewport.height) };
}

function areaRange(area: ScrollArea): ScrollRange {
  return {
    maxX: area.direction === 'VERTICAL' ? 0 : area.maxX,
    maxY: area.direction === 'HORIZONTAL' ? 0 : area.maxY,
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

/** The scrollers that move `key`, innermost first: the areas around it, then the page when it's in the base frame. */
function scrollersAround(index: LayerIndex, s: TraceState, base: ProtoFrame, key: string, withSelf: boolean): Around[] {
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
    if (layer.parentKey === null && layer.key === s.frameId) {
      const view = { x: 0, y: 0, width: s.viewport.width, height: s.viewport.height };
      around.push({ scroller: { frameId, areaKey: null, range: pageRange(base, s.viewport), view }, via });
    }
    via = layer;
    layer = layer.parentKey === null ? null : layerOf(index, layer.parentKey);
  }
  return around;
}

/**
 * The persona's scroll. With `fromKey` (the layer of the element it
 * scrolled over), the innermost scroller around it that can move on that
 * axis moves, as a scroll wheel would; a horizontal carousel passes a
 * vertical scroll on to the page. Without, the page moves. Returns whether
 * anything moved: false at the end of the range.
 */
export function scrollBy(
  index: LayerIndex,
  s: TraceState,
  base: ProtoFrame,
  direction: TraceDirection,
  amount: TraceScrollAmount,
  fromKey: string | null,
): boolean {
  const vertical = direction === 'up' || direction === 'down';
  const sign = direction === 'up' || direction === 'left' ? -1 : 1;
  const found = scrollersAround(index, s, base, fromKey ?? s.frameId, true).find(({ scroller }) =>
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
 * scroller does, so that scroller stays. Returns whether anything moved;
 * a node that isn't on this screen moves nothing, as in the viewer.
 */
export function scrollIntoView(index: LayerIndex, s: TraceState, base: ProtoFrame, key: string): boolean {
  const node = index.byKey.get(key);
  if (!node) return false;
  let { x, y } = node.unclippedBox;
  let moved = false;
  for (const { scroller, via } of scrollersAround(index, s, base, key, false)) {
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
