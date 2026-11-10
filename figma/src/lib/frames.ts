import { nodeIdFromUrl } from './ids';
import type { DocSnapshot, NodeRef } from './types';

export interface FrameIndex {
  byId: Map<string, NodeRef>;
}

export function indexFrames(doc: Pick<DocSnapshot, 'frames'> | null | undefined): FrameIndex {
  const byId = new Map<string, NodeRef>();
  for (const f of doc?.frames ?? []) byId.set(f.id, { id: f.id, name: f.name });
  return { byId };
}

/**
 * The frame a runner step was on, from the `node-id` of its URL. Null when
 * the URL has no node id or the frame is not on this page (renamed pages,
 * deleted frames, or a different file).
 */
export function frameForUrl(url: string | null | undefined, index: FrameIndex): NodeRef | null {
  const id = nodeIdFromUrl(url);
  if (!id) return null;
  return index.byId.get(id) ?? null;
}
