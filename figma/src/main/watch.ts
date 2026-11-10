/**
 * What the page watchers make of `nodechange`: which changes are the
 * designer's, and which frames of the trace's ProtoDoc they touched. A
 * render creates and removes a scratch container full of copies, and none
 * of that may refresh the panel's flow or flag the file as changed.
 *
 * Changes arrive batched, after the fact: a removed node's parent can no
 * longer be read, so the renderer's layers are known three ways. The
 * container ids the renderer records (scratch.ts), the layers seen inside a
 * container while it was alive, and a node created and already removed by
 * the time its changes arrive, which changed nothing.
 */

import { topFrameOf } from './document';
import { isScratch, scratchContainerIds } from './scratch';

/** Layers this session saw inside a scratch container. */
const seenInScratch = new Set<string>();

const isRemoved = (node: BaseNode | RemovedNode): node is RemovedNode => node.removed === true;

function insideScratch(node: BaseNode): boolean {
  const containers = scratchContainerIds();
  for (let cur: BaseNode | null = node; cur; cur = cur.parent) {
    if (containers.has(cur.id) || isScratch(cur)) return true;
  }
  return false;
}

/** The changes of one `nodechange` event that are the designer's, not the trace renderer's. */
export function designerChanges(changes: readonly NodeChange[]): NodeChange[] {
  const containers = scratchContainerIds();
  const createdAndGone = new Set(changes.filter((c) => c.type === 'CREATE' && isRemoved(c.node)).map((c) => c.node.id));
  const kept: NodeChange[] = [];
  for (const change of changes) {
    const node = change.node;
    if (containers.has(node.id) || seenInScratch.has(node.id)) continue;
    if (isRemoved(node)) {
      if (!createdAndGone.has(node.id)) kept.push(change);
      continue;
    }
    if (insideScratch(node)) {
      seenInScratch.add(node.id);
      continue;
    }
    kept.push(change);
  }
  return kept;
}

/** The ProtoDoc frames (by id) that the designer's changes touched, in the order first touched. */
export function changedProtoFrames(changes: readonly NodeChange[], frames: ReadonlySet<string>): string[] {
  const touched: string[] = [];
  for (const change of designerChanges(changes)) {
    const node = change.node;
    // A removed layer can't be traced to its frame; a removed frame is known by its own id.
    const frameId = isRemoved(node) ? node.id : (topFrameOf(node)?.id ?? null);
    if (frameId && frames.has(frameId) && !touched.includes(frameId)) touched.push(frameId);
  }
  return touched;
}
