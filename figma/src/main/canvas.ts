import { PIN_PREFIX, type TraceFollowReply } from '../lib/messages';
import type { Pin } from '../lib/types';
import { pageOf, topLevelFrames } from './document';

type Annotated = SceneNode & { annotations: ReadonlyArray<Annotation> };

function canAnnotate(node: BaseNode | null): node is Annotated {
  return !!node && 'annotations' in node;
}

function isOurs(a: Annotation): boolean {
  return typeof a.label === 'string' && a.label.startsWith(PIN_PREFIX);
}

export async function showNode(api: PluginAPI, nodeId: string): Promise<{ ok: boolean; message: string | null }> {
  const node = await api.getNodeByIdAsync(nodeId);
  if (!node || node.type === 'DOCUMENT' || node.type === 'PAGE') {
    return { ok: false, message: 'That frame is no longer in this file.' };
  }
  const page = pageOf(node);
  if (page && page.id !== api.currentPage.id) await api.setCurrentPageAsync(page);
  const scene = node as SceneNode;
  api.currentPage.selection = [scene];
  api.viewport.scrollAndZoomIntoView([scene]);
  return { ok: true, message: null };
}

/**
 * Follow persona (spec, The Flow map in the panel): brings the frame into
 * view and changes nothing else, neither the selection nor the current
 * page. A frame on another page leaves the viewport where it is, and the
 * answer names that page.
 */
export async function followFrame(api: PluginAPI, frameId: string): Promise<TraceFollowReply> {
  const node = await api.getNodeByIdAsync(frameId);
  if (!node || node.removed || node.type === 'DOCUMENT' || node.type === 'PAGE') throw new Error(`The frame ${frameId} isn't in the file any more`);
  const page = pageOf(node);
  if (!page) throw new Error(`The frame ${frameId} is on no page`);
  if (page.id !== api.currentPage.id) return { otherPage: page.name };
  api.viewport.scrollAndZoomIntoView([node as SceneNode]);
  return { otherPage: null };
}

/** Labels are plain text; keep them short enough to read on the canvas. */
const MAX_LABEL = 900;

export async function pinFindings(api: PluginAPI, pins: Pin[]): Promise<{ ok: boolean; count: number; message: string }> {
  let count = 0;
  let refused = 0;
  let missing = 0;
  for (const pin of pins) {
    let node: BaseNode | null = null;
    try {
      node = await api.getNodeByIdAsync(pin.frameId);
    } catch {
      node = null;
    }
    if (!canAnnotate(node)) {
      missing += 1;
      continue;
    }
    const label = pin.label.length > MAX_LABEL ? `${pin.label.slice(0, MAX_LABEL - 3)}...` : pin.label;
    try {
      const keep = node.annotations.filter((a) => !isOurs(a));
      node.annotations = [...keep, { label }];
      count += 1;
    } catch {
      refused += 1;
    }
  }
  if (count === 0 && pins.length > 0) {
    return {
      ok: false,
      count,
      message: refused
        ? 'Figma did not let the plugin add annotations here (view only access, or annotations are off for this file). The findings stay in the panel.'
        : 'None of the frames with findings are on this file any more.',
    };
  }
  const extra = refused ? ` ${refused} frame${refused === 1 ? '' : 's'} could not be annotated.` : missing ? ` ${missing} frame${missing === 1 ? ' is' : 's are'} gone.` : '';
  return { ok: true, count, message: `Pinned findings on ${count} frame${count === 1 ? '' : 's'}.${extra}` };
}

/** Removes only the annotations this plugin wrote, on every top level frame of the page. */
export function clearPins(api: PluginAPI): { ok: boolean; count: number; message: string } {
  let count = 0;
  let failed = 0;
  for (const frame of topLevelFrames(api.currentPage)) {
    if (!canAnnotate(frame)) continue;
    const ours = frame.annotations.filter(isOurs);
    if (ours.length === 0) continue;
    try {
      frame.annotations = frame.annotations.filter((a) => !isOurs(a));
      count += 1;
    } catch {
      failed += 1;
    }
  }
  if (failed && !count) return { ok: false, count, message: 'Figma did not let the plugin remove the pins.' };
  return { ok: true, count, message: count ? `Cleared pins from ${count} frame${count === 1 ? '' : 's'}.` : 'No Archetype pins on this page.' };
}
