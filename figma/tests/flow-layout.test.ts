import { describe, expect, it } from 'vitest';
import { BEND, COLUMN_GAP, gapsHitIn, gapsShown, graphOf, layoutFlow, liveMarks, MAX_STUBS, NODE_HEIGHT, NODE_WIDTH, pastMarks, ROW_GAP, STUB, STUB_SPACING, type LayoutEdge, type LayoutGap, type LayoutNode, type Walker } from '../src/lib/flowLayout';
import type { FlowMap, FlowReading } from '../src/lib/proto/flow';

const n = (id: string, kind: LayoutNode['kind'] = 'frame'): LayoutNode => ({ id, name: `Frame ${id}`, kind });
const drawn = (from: string, to: string): LayoutEdge => ({ from, to, inferred: false });
const inferred = (from: string, to: string): LayoutEdge => ({ from, to, inferred: true });
const gap = (id: string, node: string): LayoutGap => ({ id, node, label: `Gap ${id}` });

describe('layoutFlow', () => {
  it('puts nodes left to right in breadth-first order from the start, one column per step', () => {
    const layout = layoutFlow([n('D'), n('A'), n('B'), n('C')], [drawn('A', 'B'), drawn('A', 'C'), inferred('C', 'D')], [], 'A');
    const where = Object.fromEntries(layout.nodes.map((p) => [p.id, [p.column, p.y]]));
    expect(where).toEqual({ A: [0, 0], B: [1, 0], C: [1, NODE_HEIGHT + ROW_GAP], D: [2, 0] });
    expect(layout.nodes.map((p) => p.id)).toEqual(['A', 'B', 'C', 'D']);
    expect(layout.nodes.every((p) => p.reached)).toBe(true);
  });

  it('follows inferred edges as well as drawn ones, and stands the unreached nodes in a last column', () => {
    const layout = layoutFlow([n('A'), n('B'), n('Old'), n('Err', 'overlay')], [inferred('A', 'B'), drawn('Old', 'A')], [], 'A');
    const old = layout.nodes.find((p) => p.id === 'Old');
    expect(old).toMatchObject({ column: 2, reached: false });
    expect(layout.nodes.find((p) => p.id === 'Err')).toMatchObject({ column: 2, reached: false, kind: 'overlay' });
    expect(layout.nodes.find((p) => p.id === 'B')).toMatchObject({ column: 1, reached: true });
  });

  it('draws forward edges from side to side and back edges round below, one per pair and kind, none to the node itself', () => {
    const layout = layoutFlow([n('A'), n('B')], [drawn('A', 'B'), drawn('A', 'B'), inferred('A', 'B'), drawn('B', 'A'), inferred('A', 'A')], [], 'A');
    expect(layout.edges.map((e) => `${e.from}${e.to}${e.inferred ? '~' : '-'}`)).toEqual(['AB-', 'AB~', 'BA-']);
    const forward = layout.edges[0]?.path as string;
    expect(forward.startsWith(`M ${NODE_WIDTH} ${NODE_HEIGHT / 2} C`)).toBe(true);
    const back = layout.edges[2]?.path as string;
    // From the bottom middle of B to the bottom middle of A, bending below both.
    const bx = NODE_WIDTH + COLUMN_GAP + NODE_WIDTH / 2;
    expect(back).toBe(`M ${bx} ${NODE_HEIGHT} C ${bx} ${NODE_HEIGHT + BEND}, ${NODE_WIDTH / 2} ${NODE_HEIGHT + BEND}, ${NODE_WIDTH / 2} ${NODE_HEIGHT}`);
  });

  it("gives each gap a stub down its node's right side, counting the ones it has no room for", () => {
    const many = Array.from({ length: 9 }, (_, i) => gap(`g${i}`, 'B'));
    const layout = layoutFlow([n('A'), n('B')], [drawn('A', 'B')], [gap('g', 'A'), ...many], 'A');
    const onA = layout.gaps.filter((g) => g.node === 'A');
    expect(onA).toEqual([{ id: 'g', node: 'A', label: 'Gap g', x1: NODE_WIDTH, y1: STUB_SPACING, x2: NODE_WIDTH + STUB, y2: STUB_SPACING }]);
    expect(layout.gaps.filter((g) => g.node === 'B')).toHaveLength(MAX_STUBS);
    expect(layout.nodes.find((p) => p.id === 'B')?.moreGaps).toBe(9 - MAX_STUBS);
  });

  it('is as wide and tall as what it holds', () => {
    const layout = layoutFlow([n('A'), n('B'), n('C')], [drawn('A', 'B'), drawn('A', 'C')], [], 'A');
    expect(layout.width).toBe(2 * NODE_WIDTH + COLUMN_GAP + STUB);
    expect(layout.height).toBe(2 * NODE_HEIGHT + ROW_GAP + BEND);
  });

  it('refuses a start, an edge or a gap that names a node the map lacks', () => {
    expect(() => layoutFlow([n('A')], [], [], 'Z')).toThrow('no start node Z');
    expect(() => layoutFlow([n('A')], [drawn('A', 'Z')], [], 'A')).toThrow("names a node it doesn't have");
    expect(() => layoutFlow([n('A')], [], [gap('g', 'Z')], 'A')).toThrow("a node it doesn't have");
  });
});

describe('graphOf', () => {
  const reading = (id: string, kind: FlowReading['kind'], nodes: string[], to: string | null = null): FlowReading => ({
    id, shareKey: `L:${nodes[0]}:x`, nodes, layerKeys: nodes.map(() => 'x'), label: `Label ${id}`, role: 'link', kind, to, by: 'model', reason: 'r',
  });
  const map: FlowMap = {
    studyId: 's', version: 2, baseVersion: 1, inputHash: 'h', docHash: 'd', dropped: [], completedAt: 'c', model: null, buildId: null,
    nodes: [{ id: 'A', kind: 'frame', name: 'Home', pageId: 'p', heading: '' }, { id: 'B', kind: 'frame', name: 'Plans', pageId: 'p', heading: '' }, { id: 'O', kind: 'overlay', name: 'Error', pageId: 'p', heading: '' }],
    edges: [
      { id: 'd1', from: 'A', to: 'O', layerKey: '1', label: 'Go', trigger: 'ON_CLICK', action: 'OVERLAY', conditional: false },
      { id: 'd2', from: 'A', to: '9:9', layerKey: '2', label: 'Top', trigger: 'ON_CLICK', action: 'SCROLL_TO', conditional: false },
    ],
    readings: [reading('r1', 'edge', ['A', 'O', 'A'], 'B'), reading('r2', 'gap', ['A', 'B']), reading('r3', 'control', ['B'])],
  };

  it('draws the edges that change the screen, an inferred edge per node an edge reading is on, and a gap per node', () => {
    const g = graphOf(map);
    expect(g.nodes).toEqual([{ id: 'A', name: 'Home', kind: 'frame' }, { id: 'B', name: 'Plans', kind: 'frame' }, { id: 'O', name: 'Error', kind: 'overlay' }]);
    expect(g.edges).toEqual([{ from: 'A', to: 'O', inferred: false }, { from: 'A', to: 'B', inferred: true }, { from: 'O', to: 'B', inferred: true }]);
    expect(g.gaps).toEqual([{ id: 'r2@A', node: 'A', label: 'Label r2' }, { id: 'r2@B', node: 'B', label: 'Label r2' }]);
    expect(() => layoutFlow(g.nodes, g.edges, g.gaps, 'A')).not.toThrow();
  });
});

describe('the marks on the map', () => {
  const walker = (id: string, node: string, move: Walker['move'], ended: Walker['ended'] = null): Walker => ({ id, name: `Persona ${id}`, node, move, ended });

  it("puts each persona's token on its node, lights the edge it took and alternates the two nodes, once per turn", () => {
    const marks = liveMarks([
      walker('r1', 'B', { from: 'A', to: 'B', outcome: 'navigated', label: 'Billing', reading: null, turn: 3 }),
      walker('r2', 'A', null),
    ]);
    expect(marks.tokens).toEqual([{ id: 'r1', name: 'Persona r1', node: 'B', slot: 0 }, { id: 'r2', name: 'Persona r2', node: 'A', slot: 1 }]);
    expect([...marks.lit]).toEqual(['A>B']);
    expect(marks.moves).toEqual([{ from: 'A', to: 'B', key: 'r1:3' }]);
    expect(marks.pulses).toEqual([]);
  });

  it('pulses the node on an accepted control, and on a gap with its label', () => {
    const marks = liveMarks([
      walker('r1', 'B', { from: 'B', to: 'B', outcome: 'missing', label: 'Holidays', reading: null, turn: 4 }),
      walker('r2', 'B', { from: 'B', to: 'B', outcome: 'accepted', label: 'Annual', reading: null, turn: 2 }),
      walker('r3', 'B', { from: 'B', to: 'B', outcome: 'nothing_happened', label: 'Logo', reading: null, turn: 2 }),
    ]);
    expect(marks.pulses).toEqual([{ node: 'B', label: 'Holidays', key: 'r1:4' }, { node: 'B', label: null, key: 'r2:2' }]);
    expect(marks.lit.size).toBe(0);
    expect(marks.moves).toEqual([]);
  });

  it("marks a persona's last node once its run ended", () => {
    expect(liveMarks([walker('r1', 'C', null, 'reached'), walker('r2', 'B', null, 'stopped')]).ends).toEqual([
      { id: 'r1', node: 'C', reached: true },
      { id: 'r2', node: 'B', reached: false },
    ]);
  });

  it("lights every edge of a past run's path and marks where it ended", () => {
    const marks = pastMarks([
      { runId: 'a', archetypeName: 'Mara', endNode: 'C', reachedGoal: true, steps: [{ node: 'A' }, { node: 'B' }, { node: 'B' }, { node: 'C' }] },
      { runId: 'b', archetypeName: 'Dev', endNode: 'B', steps: [{ node: 'A' }, { node: 'B' }] },
    ], 'C');
    expect([...marks.lit].sort()).toEqual(['A>B', 'B>C']);
    expect(marks.ends).toEqual([{ id: 'a', node: 'C', reached: true }, { id: 'b', node: 'B', reached: false }]);
    expect(marks.tokens.map((t) => [t.id, t.node, t.slot])).toEqual([['a', 'C', 0], ['b', 'B', 1]]);
  });
});

describe('the gaps the card draws', () => {
  const gaps = [
    { id: 'r2@A', node: 'A', label: 'Holidays' },
    { id: 'r3@A', node: 'A', label: 'Manifest' },
    { id: 'r3@B', node: 'B', label: 'Manifest' },
    { id: 'r4@B', node: 'B', label: 'Logo' },
  ];

  it('are only those clicked in the paths shown; the rest count per node', () => {
    const { shown, hidden } = gapsShown(gaps, new Set(['r3@B']));
    expect(shown).toEqual([{ id: 'r3@B', node: 'B', label: 'Manifest' }]);
    expect(Object.fromEntries(hidden)).toEqual({ A: 2, B: 1 });
  });

  it('are none before any path, only the counts', () => {
    const { shown, hidden } = gapsShown(gaps, new Set());
    expect(shown).toEqual([]);
    expect(Object.fromEntries(hidden)).toEqual({ A: 2, B: 2 });
  });

  it("are the stored paths' steps that hit a gap, on the node each was on", () => {
    const hit = gapsHitIn([
      { steps: [{ node: 'A', outcome: 'navigated', reading: null }, { node: 'B', outcome: 'missing', reading: 'r3' }, { node: 'B', outcome: null, reading: null }] },
      { steps: [{ node: 'A', outcome: 'missing', reading: 'r2' }, { node: 'A', outcome: 'accepted', reading: 'r9' }] },
    ]);
    expect([...hit].sort()).toEqual(['r2@A', 'r3@B']);
  });
});

