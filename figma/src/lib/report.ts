import { frameForUrl, type FrameIndex } from './frames';
import type { NodeRef } from './types';

// The parts of GET /api/studies/<id>/report the panel reads.

export interface ReportArchetype {
  archetypeId: string;
  name: string;
  role: 'baseline' | 'variant' | 'stress' | string;
  variedFactors?: string[];
  completion?: { k: number; n: number; rate: number | null } | null;
  abandonment?: { runId: string; step: number | null; pageType: string | null; url: string | null; quitReason: string | null; inTheirWords: string | null }[];
  quitReasons?: Record<string, number>;
}

export interface ReportFactorImpact {
  factor: string;
  label: string;
  archetypeId: string | null;
  confidence: string;
  confidenceWords: string | null;
  direction?: string;
}

export interface ReportCluster {
  clusterId: string;
  title: string;
  severity: number;
  severityLabel: string;
  hitBy: string[];
  hitCount: number;
  runCount: number;
  location?: { path: string | null } | null;
  evidence?: { runId: string; step: number | null; url: string | null; quote: string | null }[];
}

export interface StudyReport {
  studyId: string;
  title: string;
  status: string;
  partial: boolean;
  runsTotal: number;
  runsScored: number;
  runsPending: number;
  icp?: { label: string | null } | null;
  factors?: { key: string; label: string }[];
  archetypes: ReportArchetype[];
  factorImpact?: ReportFactorImpact[];
  headline?: { sentence: string } | null;
  robustness?: { score: number | null; sentence: string | null } | null;
  findings?: { clusters?: ReportCluster[] } | null;
  recommendations?: { title: string; whatToChange: string; affectedArchetypes?: string[] }[];
  icpRead?: string | null;
  honesty?: { caveats?: string[] } | null;
}

export interface PersonaResult {
  archetypeId: string;
  name: string;
  roleLabel: string;
  k: number;
  n: number;
  /** The report's own words, like "99% likely lower completion". */
  confidenceWords: string | null;
  confidence: string | null;
  gaveUpBecause: string | null;
  quote: string | null;
}

export interface FindingView {
  id: string;
  title: string;
  severity: number;
  severityLabel: string;
  hitBy: string[];
  hitCount: number;
  runCount: number;
  frames: NodeRef[];
  quote: string | null;
}

export interface DropOffRow {
  frame: NodeRef | null;
  label: string;
  count: number;
  personas: string[];
}

export interface Pin {
  frameId: string;
  frameName: string;
  label: string;
}

export interface ReportView {
  partial: boolean;
  runsScored: number;
  runsTotal: number;
  headline: string;
  summary: string | null;
  personas: PersonaResult[];
  findings: FindingView[];
  dropOff: DropOffRow[];
  changes: { title: string; whatToChange: string }[];
  caveat: string | null;
  pins: Pin[];
  completionRate: number | null;
}

const QUIT_WORDS: Record<string, string> = {
  trust_refused: 'would not share personal details',
  technical_error: 'hit an error',
  frustration: 'got frustrated',
  feature_not_found: 'could not find the way forward',
  price_barrier: 'objected to the price',
  patience_exhausted: 'ran out of patience',
  patience_exhausted_twice: 'ran out of patience',
  confusion: 'got lost',
  confused: 'got lost',
  lost: 'got lost',
  time_limit: 'ran out of steps',
  max_steps: 'ran out of steps',
  other: 'stopped for another reason',
};

function snake(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

export function quitWords(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const k = snake(reason);
  return QUIT_WORDS[k] ?? k.replace(/_/g, ' ');
}

function roleLabel(role: string): string {
  if (role === 'baseline') return 'Typical user';
  if (role === 'stress') return 'Every risk at once';
  return 'One trait changed';
}

const MAX_FINDINGS = 5;

export function buildReportView(report: StudyReport, frames: FrameIndex): ReportView {
  const impactByArchetype = new Map<string, ReportFactorImpact>();
  for (const fi of report.factorImpact ?? []) {
    if (fi.archetypeId && !impactByArchetype.has(fi.archetypeId)) impactByArchetype.set(fi.archetypeId, fi);
  }

  let k = 0;
  let n = 0;
  const personas: PersonaResult[] = report.archetypes.map((a) => {
    const c = a.completion ?? { k: 0, n: 0, rate: null };
    k += c.k;
    n += c.n;
    const impact = impactByArchetype.get(a.archetypeId);
    const top = Object.entries(a.quitReasons ?? {}).sort((x, y) => y[1] - x[1])[0];
    const quote = (a.abandonment ?? []).find((ab) => ab.inTheirWords)?.inTheirWords ?? null;
    return {
      archetypeId: a.archetypeId,
      name: a.name,
      roleLabel: roleLabel(a.role),
      k: c.k,
      n: c.n,
      confidenceWords: a.role === 'baseline' ? null : impact?.confidenceWords ?? null,
      confidence: a.role === 'baseline' ? null : impact?.confidence ?? null,
      gaveUpBecause: top ? quitWords(top[0]) : null,
      quote,
    };
  });

  const clusters = [...(report.findings?.clusters ?? [])].sort((a, b) => b.severity - a.severity || b.hitCount - a.hitCount);
  const findings: FindingView[] = clusters.slice(0, MAX_FINDINGS).map((c) => {
    const seen = new Map<string, NodeRef>();
    for (const ev of c.evidence ?? []) {
      const f = frameForUrl(ev.url, frames);
      if (f && !seen.has(f.id)) seen.set(f.id, f);
    }
    return {
      id: c.clusterId,
      title: c.title,
      severity: c.severity,
      severityLabel: c.severityLabel,
      hitBy: c.hitBy,
      hitCount: c.hitCount,
      runCount: c.runCount,
      frames: [...seen.values()],
      quote: (c.evidence ?? []).find((e) => e.quote)?.quote ?? null,
    };
  });

  const drop = new Map<string, DropOffRow>();
  for (const a of report.archetypes) {
    for (const ab of a.abandonment ?? []) {
      const frame = frameForUrl(ab.url, frames);
      const key = frame ? `f:${frame.id}` : `p:${ab.pageType ?? 'unknown'}`;
      const label = frame ? frame.name : ab.pageType ? `A ${ab.pageType} screen (not on this page)` : 'A screen not on this page';
      const row = drop.get(key) ?? { frame, label, count: 0, personas: [] };
      row.count += 1;
      if (!row.personas.includes(a.name)) row.personas.push(a.name);
      drop.set(key, row);
    }
  }
  const dropOff = [...drop.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  const pinLines = new Map<string, { name: string; lines: string[] }>();
  const addPin = (f: NodeRef, line: string) => {
    const p = pinLines.get(f.id) ?? { name: f.name, lines: [] };
    if (!p.lines.includes(line)) p.lines.push(line);
    pinLines.set(f.id, p);
  };
  for (const fv of findings) {
    for (const f of fv.frames) addPin(f, `${fv.id} ${fv.title} (${fv.severityLabel}, ${fv.hitCount} of ${fv.runCount} tries)`);
  }
  for (const d of dropOff) {
    if (d.frame) addPin(d.frame, `${d.count} ${d.count === 1 ? 'try' : 'tries'} gave up here: ${d.personas.join(', ')}`);
  }
  const pins: Pin[] = [...pinLines.entries()].map(([frameId, p]) => ({
    frameId,
    frameName: p.name,
    label: `Archetype: ${p.lines.join('\n')}`,
  }));

  const headline =
    report.headline?.sentence ??
    report.robustness?.sentence ??
    (n > 0 ? `${k} of ${n} tries reached the goal.` : 'No finished tries yet.');

  return {
    partial: report.partial,
    runsScored: report.runsScored,
    runsTotal: report.runsTotal,
    headline,
    summary: report.icpRead ?? null,
    personas,
    findings,
    dropOff,
    changes: (report.recommendations ?? []).slice(0, 3).map((r) => ({ title: r.title, whatToChange: r.whatToChange })),
    caveat: report.honesty?.caveats?.[0] ?? null,
    pins,
    completionRate: n > 0 ? k / n : null,
  };
}
