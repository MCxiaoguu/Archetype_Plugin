/**
 * The Flow map card's layout (spec, The Flow map in the panel): nodes left
 * to right in breadth-first order from the start node, one column per step
 * away from it; drawn edges solid, inferred edges dashed, and each gap a
 * short stub ending in a dot. Pure geometry: the card draws it as SVG.
 */

import type { FlowMap } from './proto/flow';

export interface LayoutNode {
  id: string;
  name: string;
  kind: 'frame' | 'overlay';
}

/** A drawn edge, or an inferred one: a reading of kind edge to another node. */
export interface LayoutEdge {
  from: string;
  to: string;
  inferred: boolean;
}

/** A reading of kind gap, on the node that shows it. */
export interface LayoutGap {
  id: string;
  node: string;
  label: string;
}

export interface PlacedNode extends LayoutNode {
  x: number;
  y: number;
  column: number;
  /** False for a node no edge leads to from the start; those stand in a last column. */
  reached: boolean;
  /** Gaps on the node beyond the stubs it has room for. */
  moreGaps: number;
}

export interface PlacedEdge extends LayoutEdge {
  /** An SVG path from the source to the target. */
  path: string;
}

/** A stub from (x1, y1) to the dot at (x2, y2). */
export interface PlacedGap extends LayoutGap {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface FlowLayout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  gaps: PlacedGap[];
  width: number;
  height: number;
}

export const NODE_WIDTH = 96;
export const NODE_HEIGHT = 64;
const COLUMN_GAP = 56;
const ROW_GAP = 28;
const STUB = 12;
const STUB_SPACING = 8;
/** Room for the stubs down a node's right side, and below a back edge's bend. */
const MAX_STUBS = Math.floor((NODE_HEIGHT - STUB_SPACING) / STUB_SPACING);
const BEND = 24;

export function layoutFlow(nodes: LayoutNode[], edges: LayoutEdge[], gaps: LayoutGap[], start: string): FlowLayout {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (!byId.has(start)) throw new Error(`The flow map has no start node ${start}`);
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) throw new Error(`The flow map's edge ${e.from} to ${e.to} names a node it doesn't have`);
  }
  for (const g of gaps) if (!byId.has(g.node)) throw new Error(`The flow map's gap ${g.id} is on ${g.node}, a node it doesn't have`);

  // One line per pair and kind; an edge to its own node is no move.
  const seen = new Set<string>();
  const lines = edges.filter((e) => {
    const key = `${e.from}>${e.to}>${e.inferred}`;
    if (e.from === e.to || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const column = new Map<string, number>([[start, 0]]);
  const order: string[] = [start];
  for (let i = 0; i < order.length; i++) {
    const from = order[i] as string;
    for (const e of lines) {
      if (e.from !== from || column.has(e.to)) continue;
      column.set(e.to, (column.get(from) as number) + 1);
      order.push(e.to);
    }
  }
  const reachedColumns = Math.max(...column.values()) + 1;
  for (const n of nodes) {
    if (column.has(n.id)) continue;
    column.set(n.id, reachedColumns);
    order.push(n.id);
  }

  const rows = new Map<number, number>();
  const gapsOf = (id: string) => gaps.filter((g) => g.node === id);
  const placed: PlacedNode[] = order.map((id) => {
    const n = byId.get(id) as LayoutNode;
    const col = column.get(id) as number;
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    return {
      ...n,
      x: col * (NODE_WIDTH + COLUMN_GAP),
      y: row * (NODE_HEIGHT + ROW_GAP),
      column: col,
      reached: col < reachedColumns,
      moreGaps: Math.max(0, gapsOf(id).length - MAX_STUBS),
    };
  });
  const at = new Map(placed.map((p) => [p.id, p]));

  const placedEdges: PlacedEdge[] = lines.map((e) => {
    const a = at.get(e.from) as PlacedNode;
    const b = at.get(e.to) as PlacedNode;
    if (b.column > a.column) {
      const x1 = a.x + NODE_WIDTH;
      const y1 = a.y + NODE_HEIGHT / 2;
      const x2 = b.x;
      const y2 = b.y + NODE_HEIGHT / 2;
      const dx = (x2 - x1) / 2;
      return { ...e, path: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}` };
    }
    // Back, or within a column: from below the source round to below the target.
    const x1 = a.x + NODE_WIDTH / 2;
    const y1 = a.y + NODE_HEIGHT;
    const x2 = b.x + NODE_WIDTH / 2;
    const y2 = b.y + NODE_HEIGHT;
    const low = Math.max(y1, y2) + BEND;
    return { ...e, path: `M ${x1} ${y1} C ${x1} ${low}, ${x2} ${low}, ${x2} ${y2}` };
  });

  const placedGaps: PlacedGap[] = [];
  for (const p of placed) {
    gapsOf(p.id)
      .slice(0, MAX_STUBS)
      .forEach((g, i) => {
        const y = p.y + STUB_SPACING * (i + 1);
        placedGaps.push({ ...g, x1: p.x + NODE_WIDTH, y1: y, x2: p.x + NODE_WIDTH + STUB, y2: y });
      });
  }

  const columns = Math.max(...placed.map((p) => p.column)) + 1;
  const tallest = Math.max(...[...rows.values()]);
  return {
    nodes: placed,
    edges: placedEdges,
    gaps: placedGaps,
    width: columns * NODE_WIDTH + (columns - 1) * COLUMN_GAP + STUB,
    height: tallest * NODE_HEIGHT + (tallest - 1) * ROW_GAP + BEND,
  };
}

/**
 * What a map version draws: its nodes; its drawn edges that change the
 * screen (a scroll stays on its node); an inferred edge from every node an
 * edge reading is on to its frame; and a gap on every node a gap is on.
 */
export function graphOf(map: FlowMap): { nodes: LayoutNode[]; edges: LayoutEdge[]; gaps: LayoutGap[] } {
  const edges: LayoutEdge[] = map.edges.filter((e) => e.action !== 'SCROLL_TO').map((e) => ({ from: e.from, to: e.to, inferred: false }));
  const gaps: LayoutGap[] = [];
  for (const r of map.readings) {
    const on = [...new Set(r.nodes)];
    if (r.kind === 'edge') for (const n of on) edges.push({ from: n, to: r.to as string, inferred: true });
    if (r.kind === 'gap') for (const n of on) gaps.push({ id: `${r.id}@${n}`, node: n, label: r.label });
  }
  return { nodes: map.nodes.map((n) => ({ id: n.id, name: n.name, kind: n.kind })), edges, gaps };
}


/** A persona on the map: where it is, where its last action took it, and how its run ended. */
export interface Walker {
  id: string;
  name: string;
  node: string;
  move: { from: string; to: string; outcome: string; label: string | null; turn: number } | null;
  /** Null while the run goes on. */
  ended: 'reached' | 'stopped' | null;
}

/** What the card lights on the map for the personas walking it, or for the paths past runs took. */
export interface Marks {
  /** One token per persona, on its node, in the order given (its colour). */
  tokens: Array<{ id: string; name: string; node: string; slot: number }>;
  /** The edges taken, as `from>to`: the last move of each live persona, or every step of a past path. */
  lit: Set<string>;
  /** The node left and the node reached on each persona's last move, to alternate briefly; `key` restarts it per turn. */
  moves: Array<{ from: string; to: string; key: string }>;
  /** A control accepted or a gap hit: the node pulses, with the gap's label. */
  pulses: Array<{ node: string; label: string | null; key: string }>;
  /** Where a run ended: reached the goal, or stopped (gave up, ran out of steps). */
  ends: Array<{ id: string; node: string; reached: boolean }>;
}

const edgeKey = (from: string, to: string) => `${from}>${to}`;

/** The marks of personas walking the map now (spec, Live). */
export function liveMarks(walkers: Walker[]): Marks {
  const marks: Marks = { tokens: [], lit: new Set(), moves: [], pulses: [], ends: [] };
  walkers.forEach((w, slot) => {
    marks.tokens.push({ id: w.id, name: w.name, node: w.node, slot });
    if (w.ended) marks.ends.push({ id: w.id, node: w.node, reached: w.ended === 'reached' });
    const m = w.move;
    if (!m) return;
    const key = `${w.id}:${m.turn}`;
    if (m.from !== m.to) {
      marks.lit.add(edgeKey(m.from, m.to));
      marks.moves.push({ from: m.from, to: m.to, key });
    }
    if (m.outcome === 'accepted' || m.outcome === 'missing') marks.pulses.push({ node: m.to, label: m.outcome === 'missing' ? m.label : null, key });
  });
  return marks;
}

/** The marks of the paths past runs took: every step's edge lit, and where each run ended (spec, Past studies). */
export function pastMarks(paths: Array<{ runId: string; archetypeName: string; endNode: string | null; reachedGoal?: boolean; steps: Array<{ node: string }> }>, goal: string | null): Marks {
  const marks: Marks = { tokens: [], lit: new Set(), moves: [], pulses: [], ends: [] };
  paths.forEach((p, slot) => {
    p.steps.forEach((st, i) => {
      const next = p.steps[i + 1];
      if (next && next.node !== st.node) marks.lit.add(edgeKey(st.node, next.node));
    });
    if (p.endNode === null) return;
    marks.tokens.push({ id: p.runId, name: p.archetypeName, node: p.endNode, slot });
    marks.ends.push({ id: p.runId, node: p.endNode, reached: p.reachedGoal ?? (goal !== null && p.steps.some((st) => st.node === goal)) });
  });
  return marks;
}

export { edgeKey };
