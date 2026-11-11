import { describe, expect, it } from 'vitest';
import { indexFrames } from '../src/lib/frames';
import { buildReportView, quitWords, triesReached, type ReportFlow } from '../src/lib/report';
import { fixtureDoc, fixtureReport, protoAt } from './helpers';

describe('report view', () => {
  const view = buildReportView(fixtureReport(), indexFrames(fixtureDoc()));

  it('uses the report headline and counts completion over scored tries', () => {
    expect(view.headline).toMatch(/^Trust and willingness to share is the factor most likely to lower completion/);
    expect(view.runsScored).toBe(15);
    expect(view.completionRate).toBeCloseTo(6 / 15);
    expect(view.partial).toBe(false);
  });

  it('shows each persona with the report confidence words', () => {
    expect(view.personas.map((p) => [p.name, `${p.k}/${p.n}`, p.confidenceWords])).toEqual([
      ['Baseline founder', '3/3', null],
      ['Low trust founder', '0/3', '99% likely lower completion'],
      ['Unprepared founder', '1/2', '86% likely lower completion'],
      ['Impatient founder', '1/3', '93% likely lower completion'],
      ['Novice founder', '1/1', expect.stringMatching(/likely/)],
      ['Stress: low trust, unprepared, impatient, novice', '0/3', null],
    ]);
    expect(view.personas[0]?.roleLabel).toBe('Typical user');
    expect(view.personas[1]).toMatchObject({ gaveUpBecause: 'would not share personal details', quote: 'They wanted my phone number before showing it works. No.' });
    expect(view.personas[5]?.roleLabel).toBe('Every risk at once');
  });

  it('maps finding evidence to frames on the canvas', () => {
    expect(view.findings.length).toBeGreaterThan(0);
    expect(view.findings.length).toBeLessThanOrEqual(5);
    const f1 = view.findings.find((f) => f.id === 'F1');
    expect(f1).toMatchObject({ title: 'Bank sign in fails with a temporarily unavailable error', severityLabel: 'major', hitCount: 4, runCount: 15 });
    expect(f1?.frames).toEqual([{ id: '2:20', name: 'Connect bank' }]);
    expect(view.findings.find((f) => f.id === 'F2')?.frames).toEqual([{ id: '2:30', name: 'Verify phone' }]);
    const sev = view.findings.map((f) => f.severity);
    expect([...sev].sort((a, b) => b - a)).toEqual(sev);
  });

  it('counts drop off by screen', () => {
    expect(view.dropOff.map((d) => [d.label, d.count])).toEqual([
      ['Connect bank', 5],
      ['Verify phone', 4],
    ]);
    expect(view.dropOff[0]?.personas).toEqual(['Unprepared founder', 'Impatient founder', 'Stress: low trust, unprepared, impatient, novice']);
  });

  it('builds one Archetype pin per affected frame', () => {
    expect(view.pins.map((p) => p.frameName).sort()).toEqual(['Connect bank', 'Help: What is ACH', 'Verify phone']);
    for (const p of view.pins) expect(p.label.startsWith('Archetype:')).toBe(true);
    const bank = view.pins.find((p) => p.frameId === '2:20');
    expect(bank?.label).toContain('F1 Bank sign in fails');
    expect(bank?.label).toContain('5 tries gave up here');
  });

  it('keeps unmapped screens visible without frames', () => {
    const r = fixtureReport();
    for (const a of r.archetypes) for (const ab of a.abandonment ?? []) ab.url = 'https://elsewhere.dev/x';
    const v = buildReportView(r, indexFrames(fixtureDoc()));
    expect(v.dropOff.every((d) => d.frame === null)).toBe(true);
    expect(v.dropOff[0]?.label).toMatch(/not on this page/);
  });

  it('reads naturally for one persona and one try', () => {
    const one = buildReportView({
      studyId: 's', title: 't', status: 'complete', partial: false, runsTotal: 1, runsScored: 1, runsPending: 0,
      archetypes: [{ archetypeId: 'a1', name: 'Baseline founder', role: 'baseline', completion: { k: 1, n: 1, rate: 1 } }],
      findings: { clusters: [{ clusterId: 'F1', title: 'The bank sign in fails', severity: 2, severityLabel: 'Major', hitBy: ['Baseline founder'], hitCount: 1, runCount: 1, evidence: [{ runId: 'r1', step: 4, url: protoAt('2-20'), quote: null }] }] },
    }, indexFrames(fixtureDoc()));
    expect(one.headline).toBe('1 of 1 try reached the goal.');
    expect(one.personas).toMatchObject([{ name: 'Baseline founder', roleLabel: 'Typical user', k: 1, n: 1, confidenceWords: null }]);
    expect(one.pins[0]?.label).toBe('Archetype: F1 The bank sign in fails (Major, 1 of 1 try)');
    expect(triesReached(1)).toBe('try reached the goal');
    expect(triesReached(6)).toBe('tries reached the goal');
  });

  it('copes with an empty report', () => {
    const v = buildReportView({ studyId: 's', title: 't', status: 'running', partial: true, runsTotal: 5, runsScored: 0, runsPending: 5, archetypes: [] }, indexFrames(null));
    expect(v).toMatchObject({ headline: 'No finished tries yet.', personas: [], findings: [], dropOff: [], pins: [], completionRate: null, partial: true });
  });

  it('puts quit reasons in plain words', () => {
    expect(quitWords('trustRefused')).toBe('would not share personal details');
    expect(quitWords('technical_error')).toBe('hit an error');
    expect(quitWords('someNewReason')).toBe('some new reason');
    expect(quitWords('missing_feature')).toBe("needed something the product doesn't have yet");
    expect(quitWords(null)).toBeNull();
  });
});

describe('the report of a plugin-mode Figma study', () => {
  const flow: ReportFlow = {
    versionsPlayed: [1],
    currentVersion: 2,
    startNode: '1:2',
    goalNode: '2:50',
    nodes: [
      { id: '1:2', name: 'Dashboard' },
      { id: '2:20', name: 'Connect bank' },
      { id: '2:50', name: 'Bank connected' },
    ],
    paths: [
      {
        runId: 'run-a', archetypeId: 'a', archetypeName: 'Mara', status: 'completed', flowMapVersion: 1, endNode: '2:50', reachedGoal: true,
        steps: [
          { seq: 1, node: '1:2', target: 'Billing', actionText: 'Click Billing', outcome: 'navigated', reading: null },
          { seq: 2, node: '2:20', target: 'Use routing number instead', actionText: 'Try the routing number', outcome: 'missing', reading: 'r4' },
          { seq: 3, node: '2:50', target: null, actionText: 'Done', outcome: null, reading: null },
        ],
      },
      {
        runId: 'run-b', archetypeId: 'b', archetypeName: 'Dev', status: 'abandoned', flowMapVersion: 1, endNode: '2:20', reachedGoal: false,
        steps: [{ seq: 1, node: '2:20', target: null, actionText: 'Give up', outcome: null, reading: null }],
      },
    ],
    completion: { runs: 2, reachedGoal: 1 },
    dropOffs: [{ node: '2:20', nodeName: 'Connect bank', count: 1, runIds: ['run-b'], reasons: [{ reason: 'give_up', count: 1 }] }],
    featureNeeds: [{
      id: 'N1', reading: 'r4', label: 'Use routing number instead', nodes: ['2:20'], nodeNames: ['Connect bank'], personas: 2, tries: 3, runIds: ['run-a', 'run-b'],
      quotes: [{ runId: 'run-a', seq: 2, text: 'I would rather type my routing number.' }],
      needs: [{ runId: 'run-a', seq: 2, text: 'A way to enter my routing number by hand.' }],
    }],
    otherNeeds: [{ node: '1:2', nodeName: 'Dashboard', needs: [{ runId: 'run-b', seq: 1, text: 'A help link.' }] }],
    inferredTransitions: [{ id: 'T1', reading: 'r7', label: 'Connect your bank', from: ['2:20'], to: '1:2', toName: 'Dashboard', uses: 2, personas: 1, runIds: ['run-a'] }],
    mapMisses: { count: 1, runIds: ['run-b'], labels: ['Manifest'] },
  };
  const report = (change: Partial<ReportFlow> = {}) => ({ ...fixtureReport(), findings: null, flow: { ...flow, ...change } });
  const view = buildReportView(report(), indexFrames(fixtureDoc()));

  it('has no findings, and shows what the personas looked for in their own words', () => {
    expect(view.findings).toEqual([]);
    expect(view.flow?.needs).toEqual([
      { id: 'N1', label: 'Use routing number instead', frames: [{ id: '2:20', name: 'Connect bank' }], personas: 2, tries: 3, quote: 'A way to enter my routing number by hand.' },
    ]);
    expect(view.flow?.otherNeeds).toEqual([{ frame: { id: '1:2', name: 'Dashboard' }, texts: ['A help link.'] }]);
    expect(view.flow?.mapMisses).toEqual({ count: 1, labels: ['Manifest'] });
  });

  it('lists the links the personas took that the prototype does not draw, to wire', () => {
    expect(view.flow?.transitions).toEqual([
      { id: 'T1', label: 'Connect your bank', from: [{ id: '2:20', name: 'Connect bank' }], to: { id: '1:2', name: 'Dashboard' }, uses: 2, personas: 1 },
    ]);
  });

  it("shows each persona's path, its gaps marked, and its end", () => {
    expect(view.flow?.paths).toEqual([
      {
        runId: 'run-a', persona: 'Mara', reachedGoal: true,
        steps: [
          { frame: { id: '1:2', name: 'Dashboard' }, action: 'Click Billing', gap: false },
          { frame: { id: '2:20', name: 'Connect bank' }, action: 'Try the routing number', gap: true },
          { frame: { id: '2:50', name: 'Bank connected' }, action: null, gap: false },
        ],
      },
      { runId: 'run-b', persona: 'Dev', reachedGoal: false, steps: [{ frame: { id: '2:20', name: 'Connect bank' }, action: null, gap: false }] },
    ]);
  });

  it('places drop offs on their nodes, and pins needs, links to wire and drop offs to frames', () => {
    expect(view.dropOff).toEqual([{ frame: { id: '2:20', name: 'Connect bank' }, label: 'Connect bank', count: 1, personas: ['Dev'] }]);
    expect(view.pins).toEqual([{
      frameId: '2:20',
      frameName: 'Connect bank',
      label: 'Archetype: No page behind "Use routing number instead" yet: 2 personas looked for it\n"Connect your bank" works as a link to Dashboard: wire it (2 uses)\n1 try gave up here: Dev',
    }]);
  });

  it("refuses a flow that names a node it doesn't list, or a drop off of a run it has no path of", () => {
    expect(() => buildReportView(report({ nodes: flow.nodes.slice(1) }), indexFrames(null))).toThrow("names node 1:2, which its nodes don't list");
    expect(() => buildReportView(report({ paths: flow.paths.slice(0, 1) }), indexFrames(null))).toThrow("drop off of run run-b, which its paths don't list");
  });
});
