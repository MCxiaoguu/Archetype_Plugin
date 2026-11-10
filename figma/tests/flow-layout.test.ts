import { describe, expect, it } from 'vitest';
import { layoutFlow, NODE_HEIGHT, NODE_WIDTH, type LayoutEdge, type LayoutGap, type LayoutNode } from '../src/lib/flowLayout';

const n = (id: string, kind: LayoutNode['kind'] = 'frame'): LayoutNode => ({ id, name: `Frame ${id}`, kind });
const drawn = (from: string, to: string): LayoutEdge => ({ from, to, inferred: false });
const inferred = (from: string, to: string): LayoutEdge => ({ from, to, inferred: true });
const gap = (id: string, node: string): LayoutGap => ({ id, node, label: `Gap ${id}` });

describe('layoutFlow', () => {
  it('puts nodes left to right in breadth-first order from the start, one column per step', () => {
    const layout = layoutFlow([n('D'), n('A'), n('B'), n('C')], [drawn('A', 'B'), drawn('A', 'C'), inferred('C', 'D')], [], 'A');
    const where = Object.fromEntries(layout.nodes.map((p) => [p.id, [p.column, p.y]]));
    expect(where).toEqual({ A: [0, 0], B: [1, 0], C: [1, NODE_HEIGHT + 28], D: [2, 0] });
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
    expect(back).toBe(`M ${NODE_WIDTH + 56 + NODE_WIDTH / 2} ${NODE_HEIGHT} C ${NODE_WIDTH + 56 + NODE_WIDTH / 2} ${NODE_HEIGHT + 24}, ${NODE_WIDTH / 2} ${NODE_HEIGHT + 24}, ${NODE_WIDTH / 2} ${NODE_HEIGHT}`);
  });

  it("gives each gap a stub down its node's right side, counting the ones it has no room for", () => {
    const many = Array.from({ length: 9 }, (_, i) => gap(`g${i}`, 'B'));
    const layout = layoutFlow([n('A'), n('B')], [drawn('A', 'B')], [gap('g', 'A'), ...many], 'A');
    const onA = layout.gaps.filter((g) => g.node === 'A');
    expect(onA).toEqual([{ id: 'g', node: 'A', label: 'Gap g', x1: NODE_WIDTH, y1: 8, x2: NODE_WIDTH + 12, y2: 8 }]);
    expect(layout.gaps.filter((g) => g.node === 'B')).toHaveLength(7);
    expect(layout.nodes.find((p) => p.id === 'B')?.moreGaps).toBe(2);
  });

  it('is as wide and tall as what it holds', () => {
    const layout = layoutFlow([n('A'), n('B'), n('C')], [drawn('A', 'B'), drawn('A', 'C')], [], 'A');
    expect(layout.width).toBe(2 * NODE_WIDTH + 56 + 12);
    expect(layout.height).toBe(2 * NODE_HEIGHT + 28 + 24);
  });

  it('refuses a start, an edge or a gap that names a node the map lacks', () => {
    expect(() => layoutFlow([n('A')], [], [], 'Z')).toThrow('no start node Z');
    expect(() => layoutFlow([n('A')], [drawn('A', 'Z')], [], 'A')).toThrow("names a node it doesn't have");
    expect(() => layoutFlow([n('A')], [], [gap('g', 'Z')], 'A')).toThrow("a node it doesn't have");
  });
});
