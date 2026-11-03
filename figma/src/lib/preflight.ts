import { buildGraph, deadEnds, distancesFrom, framesOnPaths, shortestPath, type FlowGraph } from './graph';
import { genericNameReason, suggestName, type GenericReason } from './names';
import type { DocSnapshot, NodeRef } from './types';

export interface GenericNameIssue {
  id: string;
  name: string;
  frameId: string;
  frameName: string;
  kind: 'hotspot' | 'screen';
  reason: GenericReason;
  suggestion: string | null;
}

export interface BrokenIssue {
  hotspotId: string;
  hotspotName: string;
  frameId: string;
  frameName: string;
}

export type Blocker = 'no_start' | 'no_goal' | 'same_frame' | 'unreachable' | 'no_frames';

export interface Preflight {
  /** Launch is allowed. Only `blocker` stops it; everything else is advice. */
  ok: boolean;
  blocker: Blocker | null;
  startId: string | null;
  goalId: string | null;
  /** Frames on the shortest path, start and goal included. */
  path: NodeRef[];
  /** Clicks on the shortest path. */
  clicks: number | null;
  reachableCount: number;
  deadEnds: NodeRef[];
  broken: BrokenIssue[];
  genericNames: GenericNameIssue[];
  /** Up to 20 screen names on paths from start to goal, for the study context. */
  keyFeatures: string[];
}

export const BLOCKER_TEXT: Record<Blocker, string> = {
  no_frames: 'This page has no top level frames. Open the page with your prototype.',
  no_start: 'Pick the screen the test starts on.',
  no_goal: 'Pick the screen that means the goal is reached.',
  same_frame: 'The goal screen is the start screen. Pick a goal further into the flow.',
  unreachable: 'No chain of hotspots leads from the start to the goal screen, so no one can finish. Connect the screens in Prototype mode and check again.',
};

const MAX_KEY_FEATURES = 20;

function ref(graph: FlowGraph, id: string): NodeRef {
  return { id, name: graph.frames.get(id)?.name ?? id };
}

export function runPreflight(doc: DocSnapshot, startId: string | null, goalId: string | null): Preflight {
  const graph = buildGraph(doc);
  const empty: Preflight = {
    ok: false,
    blocker: null,
    startId,
    goalId,
    path: [],
    clicks: null,
    reachableCount: 0,
    deadEnds: [],
    broken: [],
    genericNames: [],
    keyFeatures: [],
  };
  if (graph.frames.size === 0) return { ...empty, blocker: 'no_frames' };
  if (!startId || !graph.frames.has(startId)) return { ...empty, blocker: 'no_start' };

  const reach = distancesFrom(graph, startId);
  const inReach = (frameId: string) => reach.has(frameId);
  const frameName = (id: string) => graph.frames.get(id)?.name ?? id;

  const broken: BrokenIssue[] = graph.broken
    .filter((b) => inReach(b.frameId))
    .map((b) => ({ hotspotId: b.hotspotId, hotspotName: b.hotspotName, frameId: b.frameId, frameName: frameName(b.frameId) }));

  const genericNames: GenericNameIssue[] = [];
  const seenHotspots = new Set<string>();
  for (const [frameId] of [...reach.entries()].sort((a, b) => a[1] - b[1])) {
    const frameReason = genericNameReason(frameName(frameId));
    if (frameReason) {
      genericNames.push({ id: frameId, name: frameName(frameId), frameId, frameName: frameName(frameId), kind: 'screen', reason: frameReason, suggestion: null });
    }
    for (const h of graph.hotspotsByFrame.get(frameId) ?? []) {
      if (h.id === frameId || seenHotspots.has(h.id)) continue;
      seenHotspots.add(h.id);
      const reason = genericNameReason(h.name);
      if (reason) {
        genericNames.push({ id: h.id, name: h.name, frameId, frameName: frameName(frameId), kind: 'hotspot', reason, suggestion: suggestName(h.textHint) });
      }
    }
  }

  const base = {
    ...empty,
    reachableCount: reach.size,
    broken,
    genericNames,
    deadEnds: deadEnds(graph, startId, goalId).map((id) => ref(graph, id)),
  };
  if (!goalId || !graph.frames.has(goalId)) return { ...base, blocker: 'no_goal' };
  if (goalId === startId) return { ...base, blocker: 'same_frame' };
  const path = shortestPath(graph, startId, goalId);
  if (!path) return { ...base, blocker: 'unreachable' };

  const names: string[] = [];
  for (const id of framesOnPaths(graph, startId, goalId)) {
    const n = frameName(id).trim().slice(0, 200);
    if (n && !names.includes(n)) names.push(n);
    if (names.length >= MAX_KEY_FEATURES) break;
  }
  return {
    ...base,
    ok: true,
    path: path.map((id) => ref(graph, id)),
    clicks: path.length - 1,
    keyFeatures: names,
  };
}
