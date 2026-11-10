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
import { isScratch, scratchNodeIds } from './scratch';

/** Layers this session saw inside a scratch container. */
const seenInScratch = new Set<string>();

const isRemoved = (node: BaseNode | RemovedNode): node is RemovedNode => node.removed === true;

function insideScratch(node: BaseNode): boolean {
  const containers = scratchNodeIds();
  for (let cur: BaseNode | null = node; cur; cur = cur.parent) {
    if (containers.has(cur.id) || isScratch(cur)) return true;
  }
  return false;
}

/** The changes of one `nodechange` event that are the designer's, not the trace renderer's. */
export function designerChanges(changes: readonly NodeChange[]): NodeChange[] {
  const containers = scratchNodeIds();
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

/**
 * Which frames of the ProtoDoc the designer's changes touched, in the order
 * first touched. A live node counts through its top level frame. A removed
 * one can't be traced to its frame any more, so it counts when the trace
 * knows its id (`known`: original id to the frame it belongs to, null when
 * unknown), naming that frame, or else the id itself.
 */
export function changedProtoFrames(
  changes: readonly NodeChange[],
  frames: ReadonlySet<string>,
  known: ReadonlyMap<string, string | null>,
): string[] {
  const touched: string[] = [];
  for (const change of designerChanges(changes)) {
    const node = change.node;
    let named: string | null;
    if (isRemoved(node)) named = known.has(node.id) ? (known.get(node.id) ?? node.id) : null;
    else {
      const frameId = topFrameOf(node)?.id ?? null;
      named = frameId && frames.has(frameId) ? frameId : null;
    }
    if (named && !touched.includes(named)) touched.push(named);
  }
  return touched;
}
