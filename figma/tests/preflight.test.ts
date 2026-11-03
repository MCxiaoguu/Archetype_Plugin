import { describe, expect, it } from 'vitest';
import { runPreflight } from '../src/lib/preflight';
import { fixtureDoc } from './helpers';

describe('preflight', () => {
  const doc = fixtureDoc();

  it('passes a reachable goal with the path, dead ends, broken links and names', () => {
    const pf = runPreflight(doc, '1:2', '2:50');
    expect(pf.ok).toBe(true);
    expect(pf.blocker).toBeNull();
    expect(pf.clicks).toBe(4);
    expect(pf.path.map((p) => p.name)).toEqual(['Dashboard', 'Billing settings', 'Connect bank', 'Verify phone', 'Bank connected']);
    expect(pf.deadEnds.map((d) => d.name)).toEqual(['Plans']);
    expect(pf.broken).toEqual([{ hotspotId: '2:23', hotspotName: 'Frame 48', frameId: '2:20', frameName: 'Connect bank' }]);
    expect(pf.genericNames.map((g) => [g.name, g.reason, g.suggestion])).toEqual([
      ['Rectangle 12', 'default', null],
      ['icons8-help-32 1', 'export', null],
      ['Frame 48', 'default', 'Use routing number instead'],
    ]);
    expect(pf.keyFeatures).toEqual(['Dashboard', 'Billing settings', 'Connect bank', 'Verify phone', 'Bank connected']);
    expect(pf.reachableCount).toBe(8);
  });

  it('blocks launch only when the goal is unreachable (or not chosen)', () => {
    expect(runPreflight(doc, '1:2', '4:1')).toMatchObject({ ok: false, blocker: 'unreachable' });
    expect(runPreflight(doc, '1:2', null)).toMatchObject({ ok: false, blocker: 'no_goal' });
    expect(runPreflight(doc, null, '2:50')).toMatchObject({ ok: false, blocker: 'no_start' });
    expect(runPreflight(doc, '1:2', '1:2')).toMatchObject({ ok: false, blocker: 'same_frame' });
    expect(runPreflight({ ...doc, frames: [] }, '1:2', '2:50')).toMatchObject({ ok: false, blocker: 'no_frames' });
  });

  it('still reports advice while the goal is missing', () => {
    const pf = runPreflight(doc, '1:2', null);
    expect(pf.deadEnds.length).toBe(1);
    expect(pf.broken.length).toBe(1);
  });

  it('only looks at what the start can reach', () => {
    // From the help screen the only way is back, so nothing else is in reach.
    const pf = runPreflight(doc, '2:40', '2:50');
    expect(pf.blocker).toBe('unreachable');
    expect(pf.reachableCount).toBe(1);
    expect(pf.broken).toEqual([]);
    expect(pf.genericNames).toEqual([]);
    expect(pf.deadEnds).toEqual([]);
    // From the goal screen, Done leads back into the whole flow.
    expect(runPreflight(doc, '2:50', '2:30').broken).toHaveLength(1);
  });

  it('flags generic screen names on the way', () => {
    const d = fixtureDoc();
    d.frames = d.frames.map((f) => (f.id === '2:30' ? { ...f, name: 'Frame 7' } : f));
    const pf = runPreflight(d, '1:2', '2:50');
    expect(pf.genericNames.find((g) => g.kind === 'screen')).toMatchObject({ id: '2:30', name: 'Frame 7' });
  });

  it('caps key features at 20 unique names', () => {
    const d = fixtureDoc();
    d.frames = Array.from({ length: 30 }, (_, i) => ({ id: `9:${i}`, name: i % 2 ? `Step ${i}` : `Step ${i - 1}` }));
    d.hotspots = d.frames.slice(0, -1).map((f, i) => ({
      id: `h${i}`,
      name: 'Next',
      type: 'INSTANCE',
      frameId: f.id,
      trigger: 'ON_CLICK',
      actions: [{ kind: 'node', navigation: 'NAVIGATE', destinationId: `9:${i + 1}` }],
    }));
    d.destinations = Object.fromEntries(d.frames.map((f) => [f.id, { exists: true, frameId: f.id }]));
    const pf = runPreflight(d, '9:0', '9:29');
    expect(pf.clicks).toBe(29);
    expect(pf.keyFeatures.length).toBeLessThanOrEqual(20);
    expect(new Set(pf.keyFeatures).size).toBe(pf.keyFeatures.length);
  });
});
