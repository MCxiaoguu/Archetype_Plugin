import type { DocSnapshot, FrameInfo, HotspotInfo, NavigationKind } from './types';

export interface Edge {
  from: string;
  to: string;
  via: string;
  navigation: NavigationKind;
}

export interface BrokenLink {
  hotspotId: string;
  hotspotName: string;
  frameId: string;
  destinationId: string | null;
}

export interface FlowGraph {
  frames: Map<string, FrameInfo>;
  /** Outgoing screen changes per frame, deduplicated by destination. */
  out: Map<string, Edge[]>;
  /** Frames with at least one way out (a screen change, back, close or a link). */
  exits: Set<string>;
  /** Frames opened as an overlay somewhere. */
  overlays: Set<string>;
  /**
   * For each frame, the frames that "Navigate to" it. Only that changes the
   * prototype's address: an overlay (opened or swapped) keeps the address of
   * the screen under it.
   */
  navigatedFrom: Map<string, Set<string>>;
  broken: BrokenLink[];
  hotspotsByFrame: Map<string, HotspotInfo[]>;
}

/** Navigations that put a different screen (or overlay) in front of the person. */
const MOVES: ReadonlySet<NavigationKind> = new Set<NavigationKind>(['NAVIGATE', 'SWAP', 'OVERLAY']);

export function buildGraph(doc: Pick<DocSnapshot, 'frames' | 'hotspots' | 'destinations'>): FlowGraph {
  const frames = new Map<string, FrameInfo>();
  for (const f of doc.frames) frames.set(f.id, f);
  const out = new Map<string, Edge[]>();
  const exits = new Set<string>();
  const overlays = new Set<string>();
  const navigatedFrom = new Map<string, Set<string>>();
  const broken: BrokenLink[] = [];
  const hotspotsByFrame = new Map<string, HotspotInfo[]>();
  const seen = new Set<string>();

  for (const h of doc.hotspots) {
    if (!frames.has(h.frameId)) continue;
    const list = hotspotsByFrame.get(h.frameId) ?? [];
    list.push(h);
    hotspotsByFrame.set(h.frameId, list);

    for (const action of h.actions) {
      if (action.kind === 'back' || action.kind === 'close' || action.kind === 'url') {
        exits.add(h.frameId);
        continue;
      }
      if (action.kind !== 'node') continue;
      const dest = action.destinationId ? doc.destinations[action.destinationId] : undefined;
      if (!action.destinationId || !dest || !dest.exists) {
        broken.push({ hotspotId: h.id, hotspotName: h.name, frameId: h.frameId, destinationId: action.destinationId });
        continue;
      }
      if (!MOVES.has(action.navigation)) continue;
      const to = dest.frameId;
      if (!to || !frames.has(to)) continue;
      if (action.navigation === 'OVERLAY') overlays.add(to);
      if (to === h.frameId) continue;
      if (action.navigation === 'NAVIGATE') {
        const from = navigatedFrom.get(to) ?? new Set<string>();
        from.add(h.frameId);
        navigatedFrom.set(to, from);
      }
      exits.add(h.frameId);
      const key = `${h.frameId}>${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const edges = out.get(h.frameId) ?? [];
      edges.push({ from: h.frameId, to, via: h.id, navigation: action.navigation });
      out.set(h.frameId, edges);
    }
  }
  for (const id of overlays) {
    if (frames.get(id)?.closesOnOutsideClick) exits.add(id);
  }
  return { frames, out, exits, overlays, navigatedFrom, broken, hotspotsByFrame };
}

/** Breadth first distances (in clicks) from `start` to every reachable frame. */
export function distancesFrom(graph: FlowGraph, start: string): Map<string, number> {
  const dist = new Map<string, number>();
  if (!graph.frames.has(start)) return dist;
  dist.set(start, 0);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i] as string;
    const d = dist.get(id) as number;
    for (const e of graph.out.get(id) ?? []) {
      if (!dist.has(e.to)) {
        dist.set(e.to, d + 1);
        queue.push(e.to);
      }
    }
  }
  return dist;
}

export function isReachable(graph: FlowGraph, start: string, goal: string): boolean {
  return distancesFrom(graph, start).has(goal);
}

/** The shortest click path from start to goal (both included), or null. */
export function shortestPath(graph: FlowGraph, start: string, goal: string): string[] | null {
  if (!graph.frames.has(start) || !graph.frames.has(goal)) return null;
  if (start === goal) return [start];
  const parent = new Map<string, string>();
  const visited = new Set([start]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i] as string;
    for (const e of graph.out.get(id) ?? []) {
      if (visited.has(e.to)) continue;
      visited.add(e.to);
      parent.set(e.to, id);
      if (e.to === goal) {
        const path = [goal];
        let cur = goal;
        while (cur !== start) {
          cur = parent.get(cur) as string;
          path.unshift(cur);
        }
        return path;
      }
      queue.push(e.to);
    }
  }
  return null;
}

/**
 * Frames that sit on at least one path from start to goal: reachable from the
 * start and able to reach the goal. Ordered by distance from the start.
 */
export function framesOnPaths(graph: FlowGraph, start: string, goal: string): string[] {
  const fromStart = distancesFrom(graph, start);
  if (!fromStart.has(goal)) return [];
  const reverse = new Map<string, string[]>();
  for (const edges of graph.out.values()) {
    for (const e of edges) {
      const list = reverse.get(e.to) ?? [];
      list.push(e.from);
      reverse.set(e.to, list);
    }
  }
  const toGoal = new Set([goal]);
  const queue = [goal];
  for (let i = 0; i < queue.length; i++) {
    for (const prev of reverse.get(queue[i] as string) ?? []) {
      if (!toGoal.has(prev)) {
        toGoal.add(prev);
        queue.push(prev);
      }
    }
  }
  return [...fromStart.entries()]
    .filter(([id]) => toGoal.has(id))
    .sort((a, b) => a[1] - b[1])
    .map(([id]) => id);
}

/** Frames reachable from the start with no way out, other than the goal. */
export function deadEnds(graph: FlowGraph, start: string, goal: string | null): string[] {
  const reachable = distancesFrom(graph, start);
  return [...reachable.entries()]
    .filter(([id]) => id !== goal && !graph.exits.has(id))
    .sort((a, b) => a[1] - b[1])
    .map(([id]) => id);
}
