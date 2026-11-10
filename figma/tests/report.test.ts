import { describe, expect, it } from 'vitest';
import { indexFrames } from '../src/lib/frames';
import { buildReportView, quitWords, triesReached } from '../src/lib/report';
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
    expect(quitWords(null)).toBeNull();
  });
});
