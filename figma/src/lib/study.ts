import { buildProtoUrl, checkShareLink, LINK_PROBLEM_TEXT } from './links';
import { BLOCKER_TEXT, type Preflight } from './preflight';
import type { RunSize, StudyForm } from './form';
import type { DocSnapshot } from './types';

export type { RunSize, StudyForm } from './form';

export const EMPTY_FORM: StudyForm = {
  startId: null,
  goalId: null,
  goal: '',
  who: '',
  product: '',
  link: '',
  size: 'quick',
};

/** The study design: `single` is one baseline persona from the designer's description, one try, one wave. */
export type StudyDesign = { mode: 'single' | 'ofat_stress'; archetypeBudget: number; repeatPolicy: 'explore' | 'confirm' };

/** Each size's design, what the form says of it, and the action bar's estimate of how long it takes. */
export const RUN_SIZES: Record<RunSize, StudyDesign & { label: string; detail: string; estimate: string }> = {
  single: { mode: 'single', archetypeBudget: 1, repeatPolicy: 'explore', label: 'Single persona', detail: 'One synthetic user, one try, fastest', estimate: 'Takes about 1 to 3 minutes' },
  quick: { mode: 'ofat_stress', archetypeBudget: 5, repeatPolicy: 'explore', label: 'Quick', detail: '5 synthetic users, one try each', estimate: 'Takes about 5 to 10 minutes' },
  thorough: { mode: 'ofat_stress', archetypeBudget: 6, repeatPolicy: 'confirm', label: 'Thorough', detail: 'About 8 to 12 tries, repeats where results disagree', estimate: 'Takes about 15 to 30 minutes' },
};


export type FormField = 'start' | 'goal' | 'goalText' | 'who' | 'product' | 'link' | 'flow';
export type FormErrors = Partial<Record<FormField, string>>;

/** Cuts at a word boundary and never mid word, without an ellipsis. */
export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.5 ? cut.slice(0, space) : t.slice(0, max)).replace(/[\s,;:.-]+$/, '');
}

/** A short label for the ICP from the designer's own description. */
export function icpLabel(who: string): string {
  const text = who.replace(/\s+/g, ' ').trim();
  const m = /^(.*?)(?:[.!?;](?:\s|$)|\s\(|,?\s(?:who|that|whose|with)\s|$)/i.exec(text);
  const firstClause = m && m[1] ? m[1] : text;
  return clip(firstClause.replace(/[.!?;,]+$/, ''), 60);
}

export function validateForm(form: StudyForm, preflight: Preflight | null, knownFileKey: string | null): FormErrors {
  const errors: FormErrors = {};
  if (!form.startId) errors.start = 'Pick the screen the test starts on.';
  if (!form.goalId) errors.goal = 'Pick the goal screen.';
  if (!form.goal.trim()) errors.goalText = 'Say what the person is trying to get done.';
  else if (form.goal.trim().length > 1000) errors.goalText = 'Keep the goal under 1000 characters.';
  if (!form.who.trim()) errors.who = 'Describe who your user is, in a sentence or two.';
  else if (form.who.trim().length > 2000) errors.who = 'Keep this under 2000 characters.';
  if (form.product.trim().length > 3000) errors.product = 'Keep this under 3000 characters.';
  // Optional: the panel runs the personas itself, and a link only gives step URLs the real prototype form.
  if (form.link.trim()) {
    const link = checkShareLink(form.link, knownFileKey);
    if (!link.ok) errors.link = LINK_PROBLEM_TEXT[link.reason];
  }
  if (preflight?.blocker === 'start_not_a_screen') errors.start = BLOCKER_TEXT.start_not_a_screen;
  else if (preflight?.blocker === 'goal_not_a_screen') errors.goal = BLOCKER_TEXT.goal_not_a_screen;
  else if (preflight && !preflight.ok && form.startId && form.goalId) {
    errors.flow = preflight.blocker === 'goal_is_overlay' ? 'The goal screen only opens as an overlay.' : 'The goal screen cannot be reached from the start.';
  }
  return errors;
}

export interface StudyContext {
  doc: DocSnapshot;
  preflight: Preflight;
  pluginVersion: string;
  knownFileKey: string | null;
}

export interface CreateStudyBody {
  title: string;
  icp: { label: string; description: string };
  /** `url` only with a share link. */
  task: { goal: string; url?: string; preconditions: string[] };
  success: {
    criterion: string;
    checks: { type: 'frame_reached'; value: string; required: true; rationale: string }[];
  };
  context: { productDescription: string; keyFeatures: string[] };
  design: StudyDesign;
  source: 'figma';
  /** The panel runs the personas itself (spec, Data flow 2). */
  execution: 'plugin';
  figma: {
    /** Only with a share link. */
    fileKey?: string;
    startNodeId: string;
    targetNodeId: string;
    flowName: string | null;
    pluginVersion: string;
    /** Name the prototype for the briefing and the figma-trace:// step URLs when there is no link. */
    fileName: string;
    pageName: string;
  };
}

/**
 * The designer's product line, their words only. No note about the prototype
 * medium: the backend and the actor already know a figma.com/proto target is a
 * prototype, and such a note made factor identification pick factors about
 * the prototype tool instead of people (live study, 2026-11-03).
 */
export function productDescription(productLine: string): string {
  const line = productLine.replace(/\s+/g, ' ').trim().replace(/[.!\s]+$/, '');
  return line ? `${clip(line, 3000)}.` : '';
}

/** The share link's file key, or null when the designer gave none. Throws on a link that isn't valid. */
export function shareKeyOf(form: StudyForm, knownFileKey: string | null): string | null {
  if (!form.link.trim()) return null;
  const link = checkShareLink(form.link, knownFileKey);
  if (!link.ok) throw new Error(LINK_PROBLEM_TEXT[link.reason]);
  return link.link.fileKey;
}

/** The POST /api/studies body for a Figma prototype study. Call validateForm first. */
export function buildStudyRequest(form: StudyForm, ctx: StudyContext): CreateStudyBody {
  const fileKey = shareKeyOf(form, ctx.knownFileKey);
  if (!form.startId || !form.goalId) throw new Error('Pick a start and a goal screen.');
  const frames = new Map(ctx.doc.frames.map((f) => [f.id, f.name]));
  const goalName = frames.get(form.goalId) ?? 'goal';
  const flow = ctx.doc.flowStarts.find((f) => f.nodeId === form.startId);
  const size = RUN_SIZES[form.size];
  const goal = form.goal.replace(/\s+/g, ' ').trim();
  const who = form.who.trim();
  return {
    title: clip(goal, 80),
    icp: { label: icpLabel(who) || clip(who, 60), description: clip(who, 2000) },
    task: {
      goal: clip(goal, 1000),
      ...(fileKey ? { url: buildProtoUrl(fileKey, form.startId, ctx.doc.fileName) } : {}),
      preconditions: [],
    },
    success: {
      criterion: clip(`Reaches the "${goalName}" screen`, 500),
      checks: [
        {
          // Met when a step URL's node-id names the goal frame exactly. A
          // url_matches glob cannot do this: the viewer's URL sometimes ends
          // right after node-id and sometimes carries more parameters.
          type: 'frame_reached',
          value: form.goalId,
          required: true,
          rationale: 'The prototype shows the goal frame',
        },
      ],
    },
    context: {
      productDescription: productDescription(form.product),
      keyFeatures: ctx.preflight.keyFeatures.slice(0, 20).map((n) => n.slice(0, 200)),
    },
    design: { mode: size.mode, archetypeBudget: size.archetypeBudget, repeatPolicy: size.repeatPolicy },
    source: 'figma',
    execution: 'plugin',
    figma: {
      ...(fileKey ? { fileKey } : {}),
      startNodeId: form.startId,
      targetNodeId: form.goalId,
      flowName: flow ? clip(flow.name, 120) : null,
      pluginVersion: ctx.pluginVersion.slice(0, 20),
      fileName: clip(ctx.doc.fileName, 120),
      pageName: clip(ctx.doc.pageName, 120),
    },
  };
}
