/**
 * Showing frames: NAVIGATE, SWAP, BACK and overlays. A frame that shows
 * gets its scroll (reset or carried over), loses its variant overrides
 * when the action resets interactive components, and starts its
 * AFTER_TIMEOUT timers.
 */

import { EngineError } from './errors';
import { isShown } from './hitTest';
import type { Box, OpenOverlay, Point, ProtoAction, ProtoDoc, ProtoFrame, Size, TraceState } from './model';
import { pageOffset, scrollOnShow } from './scroll';
import { startFrameTimers } from './timers';

export type NodeAction = Extract<ProtoAction, { type: 'NODE' }>;

/** The layer whose reaction runs: its ancestors as measured (innermost first, itself included), its frame and its unclipped box. */
export interface Source {
  layerKey: string;
  chain: string[];
  frameId: string;
  /** Null when the trigger wasn't measured, as for an interactive component's timer. */
  box: Box | null;
}

export interface Proto {
  doc: ProtoDoc;
  frames: Map<string, ProtoFrame>;
}

export function frameOf(proto: Proto, frameId: string): ProtoFrame {
  const frame = proto.frames.get(frameId);
  if (!frame) throw new EngineError('invalid_doc', `The frame ${frameId} isn't in the prototype`);
  return frame;
}

/** Where the base frame sits in the viewport, moved up and left by its page offset. */
function pageBox(s: TraceState, frame: ProtoFrame): Box {
  const { x, y } = pageOffset(s, frame.id);
  return { x: -x, y: -y, width: frame.width, height: frame.height };
}

/** The scroll resets when `resetScrollPosition` is true, or when the deprecated `preserveScrollPosition` is false. */
const resetsScroll = (action: NodeAction) => action.resetScrollPosition || !action.preserveScrollPosition;

/** Shows `dest` as the base frame. Open overlays close, and the layers under the pointer go with the old frame. */
export function showBase(proto: Proto, s: TraceState, dest: ProtoFrame, action: NodeAction, pushHistory: boolean): void {
  scrollOnShow(s, dest, { reset: resetsScroll(action), asBase: true });
  if (action.resetInteractiveComponents) delete s.variants[dest.id];
  if (pushHistory) s.history.push(s.frameId);
  s.frameId = dest.id;
  s.overlays = [];
  s.pointer.over = [];
  startFrameTimers(proto.doc, s, dest.id, pageBox(s, dest));
}

/** Pops history. Returns false when there was none to pop. */
export function goBack(proto: Proto, s: TraceState): boolean {
  const previous = s.history.pop();
  if (previous === undefined) return false;
  s.frameId = previous;
  s.overlays = [];
  s.pointer.over = [];
  startFrameTimers(proto.doc, s, previous, pageBox(s, frameOf(proto, previous)));
  return true;
}

/**
 * Replaces the overlay the trigger is in, or the base frame (without
 * history) when it's in the base frame. Returns false when a MANUAL
 * overlay can't be placed because its trigger wasn't measured.
 */
export function swap(proto: Proto, s: TraceState, dest: ProtoFrame, action: NodeAction, source: Source): boolean {
  const i = s.overlays.findIndex((o) => o.frameId === source.frameId);
  if (i < 0) {
    showBase(proto, s, dest, action, false);
    return true;
  }
  if (dest.id !== source.frameId && isShown(s, dest.id)) return true;
  const entry = overlayEntry(s, dest, action, source);
  if (!entry) return false;
  scrollOnShow(s, dest, { reset: resetsScroll(action), asBase: false });
  if (action.resetInteractiveComponents) delete s.variants[dest.id];
  s.overlays[i] = entry;
  startFrameTimers(proto.doc, s, dest.id, overlayBox(entry, dest));
  return true;
}

/** Opens `dest` as an overlay on top; a frame already showing doesn't open twice. Returns false as `swap` does. */
export function openOverlay(proto: Proto, s: TraceState, dest: ProtoFrame, action: NodeAction, source: Source): boolean {
  if (isShown(s, dest.id)) return true;
  const entry = overlayEntry(s, dest, action, source);
  if (!entry) return false;
  scrollOnShow(s, dest, { reset: resetsScroll(action), asBase: false });
  if (action.resetInteractiveComponents) delete s.variants[dest.id];
  s.overlays.push(entry);
  startFrameTimers(proto.doc, s, dest.id, overlayBox(entry, dest));
  return true;
}

const overlayBox = (entry: OpenOverlay, frame: ProtoFrame): Box => ({ ...entry.origin, width: frame.width, height: frame.height });

function overlayEntry(s: TraceState, dest: ProtoFrame, action: NodeAction, source: Source): OpenOverlay | null {
  const origin = overlayOrigin(dest, s.viewport, action, source);
  if (!origin) return null;
  return { frameId: dest.id, position: dest.overlay.position, origin, closeOnOutsideClick: dest.overlay.closeOnOutsideClick };
}

/** One of eight places in the viewport, or (MANUAL) offset from the trigger's box; null when that box wasn't measured. */
function overlayOrigin(frame: ProtoFrame, viewport: Size, action: NodeAction, source: Source): Point | null {
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
      return source.box ? { x: source.box.x + offset.x, y: source.box.y + offset.y } : null;
    }
  }
}
