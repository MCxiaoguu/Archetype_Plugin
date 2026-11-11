import type { RunPath } from './api';
import { frameForUrl, type FrameIndex } from './frames';
import type { NodeRef, Pin } from './types';

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

/** A persona's words at a step: the monologue there, or the debrief's need citing it. */
export interface StepText {
  runId: string;
  seq: number;
  text: string;
}

/** A plugin-mode Figma study's flow results (spec, What the report shows for Figma plugin studies). */
export interface ReportFlow {
  versionsPlayed: number[];
  currentVersion: number | null;
  startNode: string;
  goalNode: string | null;
  /** Every node of the versions played, for names. */
  nodes: { id: string; name: string }[];
  paths: Array<RunPath & { reachedGoal: boolean }>;
  completion: { runs: number; reachedGoal: number };
  dropOffs: { node: string; nodeName: string; count: number; runIds: string[]; reasons: { reason: string; count: number }[] }[];
  /** Gap clicks, by reading: what the personas looked for and found no page behind. */
  featureNeeds: {
    id: string;
    reading: string;
    label: string;
    nodes: string[];
    nodeNames: string[];
    personas: number;
    tries: number;
    runIds: string[];
    quotes: StepText[];
    needs: StepText[];
  }[];
  /** The debrief's needs citing a step that was no gap click, by the node it was on. */
  otherNeeds: { node: string; nodeName: string; needs: StepText[] }[];
  /** The readings of kind edge the personas took, so the designer can wire them. */
  inferredTransitions: { id: string; reading: string; label: string; from: string[]; to: string; toName: string; uses: number; personas: number; runIds: string[] }[];
  /** Clicks on elements the map should have read and had no reading for. */
  mapMisses: { count: number; runIds: string[]; labels: string[] };
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
  /** Null for a plugin-mode Figma study, which reports `flow` instead. */
  findings?: { clusters?: ReportCluster[] } | null;
  flow?: ReportFlow | null;
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

export interface FlowStepView {
  frame: NodeRef;
  /** What the persona did there, as it put it; null on the screen the run ended on. */
  action: string | null;
  /** A gap: the persona looked for what has no page yet. */
  gap: boolean;
}

export interface FlowPathView {
  runId: string;
  persona: string;
  reachedGoal: boolean;
  steps: FlowStepView[];
}

export interface FeatureNeedView {
  id: string;
  label: string;
  frames: NodeRef[];
  personas: number;
  tries: number;
  /** The persona's own words: the debrief's need, else its monologue at the step. */
  quote: string | null;
}

export interface TransitionView {
  id: string;
  label: string;
  from: NodeRef[];
  to: NodeRef;
  uses: number;
  personas: number;
}

/** The flow sections that take the findings' place in a plugin-mode Figma study's report. */
export interface FlowView {
  needs: FeatureNeedView[];
  otherNeeds: { frame: NodeRef; texts: string[] }[];
  transitions: TransitionView[];
  paths: FlowPathView[];
  mapMisses: { count: number; labels: string[] } | null;
}

export interface ReportView {
  partial: boolean;
  runsScored: number;
  runsTotal: number;
  headline: string;
  summary: string | null;
  personas: PersonaResult[];
  /** Empty for a flow report, which has none. */
  findings: FindingView[];
  /** Set for a plugin-mode Figma study. */
  flow: FlowView | null;
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
  missing_feature: "needed something the product doesn't have yet",
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

const tries = (n: number) => (n === 1 ? 'try' : 'tries');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The score's label: "try reached the goal" for a test of one try. */
export function triesReached(n: number): string {
  return `${tries(n)} reached the goal`;
}

/** The flow sections of the report: needs, other needs, transitions to wire, and each persona's path. */
function buildFlowView(flow: ReportFlow): FlowView {
  const nameOf = new Map(flow.nodes.map((n) => [n.id, n.name]));
  const node = (id: string): NodeRef => {
    const name = nameOf.get(id);
    if (name === undefined) throw new Error(`The report's flow names node ${id}, which its nodes don't list.`);
    return { id, name };
  };
  return {
    needs: flow.featureNeeds.map((f) => ({
      id: f.id,
      label: f.label,
      frames: f.nodes.map(node),
      personas: f.personas,
      tries: f.tries,
      quote: f.needs[0]?.text ?? f.quotes[0]?.text ?? null,
    })),
    otherNeeds: flow.otherNeeds.map((o) => ({ frame: node(o.node), texts: o.needs.map((n) => n.text) })),
    transitions: flow.inferredTransitions.map((t) => ({ id: t.id, label: t.label, from: t.from.map(node), to: node(t.to), uses: t.uses, personas: t.personas })),
    paths: flow.paths.map((p) => ({
      runId: p.runId,
      persona: p.archetypeName,
      reachedGoal: p.reachedGoal,
      steps: p.steps.map((st) => ({ frame: node(st.node), action: st.outcome === null ? null : st.actionText, gap: st.outcome === 'missing' })),
    })),
    mapMisses: flow.mapMisses.count > 0 ? { count: flow.mapMisses.count, labels: flow.mapMisses.labels } : null,
  };
}

/**
 * The report as the panel shows it. Throws for a report whose parts don't
 * fit together (a flow naming a node it doesn't list), which loading the
 * report reports as it would a failed request.
 */
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

  const flow = report.flow ? buildFlowView(report.flow) : null;

  const drop = new Map<string, DropOffRow>();
  // A flow report places each drop off on its node; the persona names come from the paths.
  const personaOf = new Map((report.flow?.paths ?? []).map((p) => [p.runId, p.archetypeName]));
  const personaOfRun = (runId: string) => {
    const name = personaOf.get(runId);
    if (name === undefined) throw new Error(`The report's flow has a drop off of run ${runId}, which its paths don't list.`);
    return name;
  };
  for (const d of report.flow?.dropOffs ?? []) {
    drop.set(`f:${d.node}`, { frame: { id: d.node, name: d.nodeName }, label: d.nodeName, count: d.count, personas: [...new Set(d.runIds.map(personaOfRun))] });
  }
  for (const a of report.flow ? [] : report.archetypes) {
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
    for (const f of fv.frames) addPin(f, `${fv.id} ${fv.title} (${fv.severityLabel}, ${fv.hitCount} of ${fv.runCount} ${tries(fv.runCount)})`);
  }
  for (const need of flow?.needs ?? []) {
    for (const f of need.frames) addPin(f, `No page behind "${need.label}" yet: ${plural(need.personas, 'persona')} looked for it`);
  }
  for (const t of flow?.transitions ?? []) {
    for (const f of t.from) addPin(f, `"${t.label}" works as a link to ${t.to.name}: wire it (${t.uses} ${t.uses === 1 ? 'use' : 'uses'})`);
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
    (n > 0 ? `${k} of ${n} ${triesReached(n)}.` : 'No finished tries yet.');

  return {
    partial: report.partial,
    runsScored: report.runsScored,
    runsTotal: report.runsTotal,
    headline,
    summary: report.icpRead ?? null,
    personas,
    findings,
    flow,
    dropOff,
    changes: (report.recommendations ?? []).slice(0, 3).map((r) => ({ title: r.title, whatToChange: r.whatToChange })),
    caveat: report.honesty?.caveats?.[0] ?? null,
    pins,
    completionRate: n > 0 ? k / n : null,
  };
}
