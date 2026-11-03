import { describe, expect, it } from 'vitest';
import { buildGraph, deadEnds, distancesFrom, framesOnPaths, isReachable, shortestPath } from '../src/lib/graph';
import type { DocSnapshot, HotspotInfo } from '../src/lib/types';
import { fixtureDoc } from './helpers';

function tiny(hotspots: HotspotInfo[], frames = ['A', 'B', 'C', 'D']): DocSnapshot {
  const destinations: DocSnapshot['destinations'] = {};
  for (const f of frames) destinations[f] = { exists: true, frameId: f };
  return { fileName: 'x', pageId: 'p', pageName: 'P', frames: frames.map((id) => ({ id, name: `Frame ${id}` })), flowStarts: [], hotspots, destinations };
}
const go = (id: string, from: string, to: string, navigation: 'NAVIGATE' | 'OVERLAY' | 'SWAP' | 'SCROLL_TO' | 'CHANGE_TO' = 'NAVIGATE'): HotspotInfo => ({
  id,
  name: id,
  type: 'INSTANCE',
  frameId: from,
  trigger: 'ON_CLICK',
  actions: [{ kind: 'node', navigation, destinationId: to }],
});

describe('graph building', () => {
  it('maps hotspots to edges between top level frames', () => {
    const g = buildGraph(fixtureDoc());
    expect(g.out.get('1:2')?.map((e) => e.to).sort()).toEqual(['2:10', '3:5']);
    expect(g.out.get('2:20')?.map((e) => e.to).sort()).toEqual(['2:30', '3:1']);
    expect(g.overlays.has('3:1')).toBe(true);
  });

  it('dedupes parallel hotspots and ignores self links', () => {
    const g = buildGraph(tiny([go('h1', 'A', 'B'), go('h2', 'A', 'B'), go('h3', 'A', 'A')]));
    expect(g.out.get('A')).toHaveLength(1);
    expect(g.exits.has('A')).toBe(true);
  });

  it('treats scroll and variant changes as staying on the screen', () => {
    const g = buildGraph(tiny([go('h1', 'A', 'B', 'SCROLL_TO'), go('h2', 'A', 'C', 'CHANGE_TO')]));
    expect(g.out.get('A')).toBeUndefined();
    expect(g.exits.has('A')).toBe(false);
  });

  it('counts back, close and external links as ways out', () => {
    const doc = tiny([
      { id: 'b', name: 'Back', type: 'INSTANCE', frameId: 'A', trigger: 'ON_CLICK', actions: [{ kind: 'back' }] },
      { id: 'c', name: 'Close', type: 'INSTANCE', frameId: 'B', trigger: 'ON_CLICK', actions: [{ kind: 'close' }] },
      { id: 'u', name: 'Docs', type: 'TEXT', frameId: 'C', trigger: 'ON_CLICK', actions: [{ kind: 'url', url: 'https://x' }] },
    ]);
    const g = buildGraph(doc);
    expect([...g.exits].sort()).toEqual(['A', 'B', 'C']);
  });

  it('records hotspots whose destination is gone or null', () => {
    const doc = tiny([go('h1', 'A', 'ZZ'), { ...go('h2', 'A', 'B'), actions: [{ kind: 'node', navigation: 'NAVIGATE', destinationId: null }] }]);
    doc.destinations.ZZ = { exists: false, frameId: null };
    const g = buildGraph(doc);
    expect(g.broken.map((b) => b.hotspotId).sort()).toEqual(['h1', 'h2']);
  });

  it('ignores hotspots outside known frames and destinations off the page', () => {
    const doc = tiny([go('h1', 'Q', 'A'), go('h2', 'A', 'OFF')]);
    doc.destinations.OFF = { exists: true, frameId: null };
    const g = buildGraph(doc);
    expect(g.out.size).toBe(0);
    expect(g.broken).toHaveLength(0);
  });

  it('marks overlays that close on an outside click as having a way out', () => {
    const doc = tiny([go('h1', 'A', 'B', 'OVERLAY')]);
    doc.frames[1] = { id: 'B', name: 'Menu', closesOnOutsideClick: true };
    expect(buildGraph(doc).exits.has('B')).toBe(true);
  });
});

describe('reachability', () => {
  const g = buildGraph(fixtureDoc());

  it('finds distances with breadth first search', () => {
    const d = distancesFrom(g, '1:2');
    expect(d.get('1:2')).toBe(0);
    expect(d.get('2:10')).toBe(1);
    expect(d.get('2:50')).toBe(4);
    expect(d.has('4:1')).toBe(false);
    expect(distancesFrom(g, 'nope').size).toBe(0);
  });

  it('finds the shortest path', () => {
    expect(shortestPath(g, '1:2', '2:50')).toEqual(['1:2', '2:10', '2:20', '2:30', '2:50']);
    expect(shortestPath(g, '1:2', '1:2')).toEqual(['1:2']);
    expect(shortestPath(g, '1:2', '4:1')).toBeNull();
    expect(shortestPath(g, 'x', '1:2')).toBeNull();
    expect(isReachable(g, '1:2', '2:50')).toBe(true);
    expect(isReachable(g, '2:50', '4:1')).toBe(false);
  });

  it('prefers the shorter of two routes', () => {
    const doc = tiny([go('1', 'A', 'B'), go('2', 'B', 'C'), go('3', 'C', 'D'), go('4', 'A', 'D')]);
    expect(shortestPath(buildGraph(doc), 'A', 'D')).toEqual(['A', 'D']);
  });

  it('lists frames on any path from start to goal', () => {
    expect(framesOnPaths(g, '1:2', '2:50')).toEqual(['1:2', '2:10', '2:20', '2:30', '2:50']);
    expect(framesOnPaths(g, '1:2', '4:1')).toEqual([]);
  });

  it('finds reachable dead ends but not the goal', () => {
    expect(deadEnds(g, '1:2', '2:50')).toEqual(['3:5']);
    // Without a goal, the goal screen with a Done button still has a way out.
    expect(deadEnds(g, '1:2', null)).toEqual(['3:5']);
    const doc = tiny([go('1', 'A', 'B')]);
    expect(deadEnds(buildGraph(doc), 'A', 'B')).toEqual([]);
    expect(deadEnds(buildGraph(doc), 'A', null)).toEqual(['B']);
  });
});
