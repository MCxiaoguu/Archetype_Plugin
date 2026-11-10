import type { DeviceCode, RunPath, RunRowApi, StudyStatusValue } from './api';
import type { FlowMap } from './proto/flow';
import { isRunSize } from './form';
import { DEFAULT_SETTINGS, type Draft, type InitPayload, type Settings, type StudyRecord } from './messages';
import { nextQueuedSince } from './poll';
import type { StudyReport } from './report';
import type { FailedImport } from './launch';
import type { LiveRun, RunnerStatus } from './runs';
import { EMPTY_FORM, type RunSize, type StudyForm } from './study';
import type { DocSnapshot, NodeRef } from './types';

export type Screen = 'loading' | 'signin' | 'new' | 'progress' | 'report' | 'history' | 'settings';

/** Where a launch is. The first four are the launch steps; then the panel watches. */
export type Stage = 'creating' | 'factors' | 'archetypes' | 'runs' | 'watching' | 'done';

export const LAUNCH_STAGES: Stage[] = ['creating', 'factors', 'archetypes', 'runs'];

export interface ActiveStudy {
  id: string | null;
  record: StudyRecord | null;
  stage: Stage;
  stageStartedAt: number;
  error: string | null;
  status: StudyStatusValue | null;
  runs: RunRowApi[];
  queuedSince: number | null;
  watchingSince: number | null;
  lastPolledAt: number | null;
  pollError: string | null;
  report: StudyReport | null;
  reportError: string | null;
  /** What the sessions this panel runs say, by run id (plugin mode). */
  live: Record<string, LiveRun>;
  runner: RunnerStatus | null;
  flow: FlowCard;
}

/** The Flow map card of a plugin-mode study (spec, The Flow map in the panel). */
export interface FlowCard {
  /** The study's current map version; null until it is known, and for a study that has none. */
  map: FlowMap | null;
  /** Each run's path from its steps, for a study that ran. */
  paths: RunPath[] | null;
  /** Why the map or the paths didn't load. */
  error: string | null;
  /** Clear paths: hidden until the panel opens the study again. */
  cleared: boolean;
  /** Follow persona: the run whose node the viewport moves to on each of its turns. */
  following: string | null;
  /** "On page <name>": the followed persona's frame is on another page, where the viewport doesn't go. */
  followNote: string | null;
  /** The screen each persona last saw on a node, by node: a visited node shows it. */
  shots: Record<string, Uint8Array>;
}

export const EMPTY_FLOW: FlowCard = { map: null, paths: null, error: null, cleared: false, following: null, followNote: null, shots: {} };

/** What stands between the form and a launch (spec, Data flow 1). */
export type LaunchGate =
  | { kind: 'checking' }
  /** The file can't be edited, so nothing can be rendered. `detail` is what Figma said. */
  | { kind: 'blocked'; reason: string; detail: string }
  /** Testing the flow would import these library components into the file: the designer confirms first. */
  | { kind: 'confirm-import'; components: string[] }
  /** The confirmed import couldn't add these: the designer launches anyway or cancels. */
  | { kind: 'import-failed'; failures: FailedImport[] };

export interface AuthState {
  phase: 'idle' | 'starting' | 'waiting' | 'error';
  code: DeviceCode | null;
  startedAt: number | null;
  error: string | null;
}

export interface Notice {
  kind: 'info' | 'success' | 'error';
  text: string;
}

export interface AppState {
  screen: Screen;
  /** The screen settings returns to. */
  back: Screen;
  settings: Settings;
  token: string | null;
  fileKey: string | null;
  pluginVersion: string;
  doc: DocSnapshot | null;
  selection: NodeRef | null;
  form: StudyForm;
  /** Show field errors after the first launch attempt. */
  touched: boolean;
  auth: AuthState;
  study: ActiveStudy | null;
  history: StudyRecord[];
  notice: Notice | null;
  gate: LaunchGate | null;
}

export const INITIAL_STATE: AppState = {
  screen: 'loading',
  back: 'new',
  settings: DEFAULT_SETTINGS,
  token: null,
  fileKey: null,
  pluginVersion: '0.0.0',
  doc: null,
  selection: null,
  form: EMPTY_FORM,
  touched: false,
  auth: { phase: 'idle', code: null, startedAt: null, error: null },
  study: null,
  history: [],
  notice: null,
  gate: null,
};

export type Action =
  | { type: 'init'; payload: InitPayload; now: number }
  | { type: 'doc'; doc: DocSnapshot }
  | { type: 'selection'; selection: NodeRef | null }
  | { type: 'field'; field: 'goal' | 'who' | 'product' | 'link'; value: string }
  | { type: 'size'; size: RunSize }
  | { type: 'pick'; role: 'start' | 'goal'; nodeId: string | null }
  | { type: 'use-selection'; role: 'start' | 'goal' }
  | { type: 'attempt-launch' }
  | { type: 'launch-started'; now: number }
  | { type: 'study-created'; record: StudyRecord }
  | { type: 'stage'; stage: Stage; now: number }
  | { type: 'launch-failed'; message: string }
  | { type: 'retry'; now: number }
  | { type: 'poll'; status: StudyStatusValue; runs: RunRowApi[]; now: number }
  | { type: 'poll-failed'; message: string }
  | { type: 'report'; report: StudyReport; now: number }
  | { type: 'report-failed'; message: string }
  | { type: 'open-study'; record: StudyRecord; now: number }
  | { type: 'new-test' }
  | { type: 'navigate'; screen: Screen }
  | { type: 'signin-start'; now: number }
  | { type: 'signin-code'; code: DeviceCode; now: number }
  | { type: 'signin-failed'; message: string }
  | { type: 'signin-cancel' }
  | { type: 'signed-in'; token: string }
  | { type: 'signed-out'; expired: boolean }
  | { type: 'settings'; settings: Settings }
  | { type: 'studies'; studies: StudyRecord[] }
  | { type: 'notice'; notice: Notice | null }
  | { type: 'gate'; gate: LaunchGate | null }
  | { type: 'session'; studyId: string; status: LiveRun }
  | { type: 'runner'; studyId: string; status: RunnerStatus }
  | { type: 'flow-map'; studyId: string; map: FlowMap | null }
  | { type: 'flow-paths'; studyId: string; paths: RunPath[] }
  | { type: 'flow-error'; studyId: string; message: string }
  | { type: 'flow-shot'; studyId: string; node: string; image: Uint8Array }
  | { type: 'flow-clear'; studyId: string }
  | { type: 'flow-follow'; studyId: string; runId: string | null }
  | { type: 'flow-follow-note'; studyId: string; note: string | null };

function emptyStudy(now: number, record: StudyRecord | null, stage: Stage): ActiveStudy {
  return {
    id: record?.studyId ?? null,
    record,
    stage,
    stageStartedAt: now,
    error: null,
    status: null,
    runs: [],
    queuedSince: null,
    watchingSince: stage === 'watching' ? now : null,
    lastPolledAt: null,
    pollError: null,
    report: null,
    reportError: null,
    live: {},
    runner: null,
    flow: EMPTY_FLOW,
  };
}

/** The Flow map card after one of its actions. */
function flowCard(flow: FlowCard, action: Extract<Action, { type: `flow-${string}` }>): FlowCard {
  switch (action.type) {
    case 'flow-map':
      return { ...flow, map: action.map, error: null };
    case 'flow-paths':
      return { ...flow, paths: action.paths, error: null };
    case 'flow-error':
      return { ...flow, error: action.message };
    case 'flow-shot':
      return { ...flow, shots: { ...flow.shots, [action.node]: action.image } };
    case 'flow-clear':
      return { ...flow, cleared: true, following: null, followNote: null };
    case 'flow-follow':
      return { ...flow, following: action.runId, followNote: null };
    case 'flow-follow-note':
      return { ...flow, followNote: action.note };
  }
}

/** A top level frame on the page that the prototype can open as a screen. */
function isScreen(doc: DocSnapshot | null, id: string | null): boolean {
  return !!id && !!doc?.frames.some((f) => f.id === id && !f.notAScreen);
}

function defaultStart(doc: DocSnapshot | null): string | null {
  const first = doc?.flowStarts.find((f) => isScreen(doc, f.nodeId));
  return first ? first.nodeId : null;
}

function landing(state: AppState): Screen {
  if (!state.token) return 'signin';
  if (state.study) return state.study.stage === 'done' && state.study.report ? 'report' : 'progress';
  return 'new';
}

function mergeDraft(form: StudyForm, draft: Partial<Draft> | null): StudyForm {
  if (!draft) return form;
  return {
    ...form,
    goal: draft.goal ?? form.goal,
    who: draft.who ?? form.who,
    product: draft.product ?? form.product,
    link: draft.link ?? form.link,
    // A draft from a plugin with sizes this one doesn't have starts from the form's default.
    size: isRunSize(draft.size) ? draft.size : form.size,
  };
}

function patchStudy(state: AppState, patch: Partial<ActiveStudy>): AppState {
  if (!state.study) return state;
  return { ...state, study: { ...state.study, ...patch } };
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'init': {
      const p = action.payload;
      const form = mergeDraft({ ...EMPTY_FORM, startId: defaultStart(p.doc) }, p.draft);
      const last = p.lastStudyId ? p.studies.find((s) => s.studyId === p.lastStudyId) ?? null : null;
      const next: AppState = {
        ...state,
        settings: p.settings,
        token: p.token,
        fileKey: p.fileKey,
        pluginVersion: p.pluginVersion,
        doc: p.doc,
        selection: p.selection,
        form,
        history: p.studies,
        study: last ? emptyStudy(action.now, last, 'watching') : null,
      };
      return { ...next, screen: landing(next) };
    }
    case 'doc': {
      const form = { ...state.form };
      if (!isScreen(action.doc, form.startId)) form.startId = defaultStart(action.doc);
      if (!isScreen(action.doc, form.goalId)) form.goalId = null;
      return { ...state, doc: action.doc, form };
    }
    case 'selection':
      return { ...state, selection: action.selection };
    case 'field':
      return { ...state, form: { ...state.form, [action.field]: action.value } };
    case 'size':
      return { ...state, form: { ...state.form, size: action.size } };
    case 'pick': {
      const id = isScreen(state.doc, action.nodeId) ? action.nodeId : null;
      return { ...state, form: { ...state.form, [action.role === 'start' ? 'startId' : 'goalId']: id } };
    }
    case 'use-selection': {
      const sel = state.selection;
      const frame = sel ? state.doc?.frames.find((f) => f.id === sel.id) : undefined;
      if (!sel || !frame) {
        return { ...state, notice: { kind: 'info', text: 'Select one top level frame on the canvas first.' } };
      }
      if (frame.notAScreen) {
        return { ...state, notice: { kind: 'info', text: 'A component set cannot be a test screen. Select a frame instead.' } };
      }
      return reducer({ ...state, notice: null }, { type: 'pick', role: action.role, nodeId: sel.id });
    }
    case 'attempt-launch':
      return { ...state, touched: true };
    case 'launch-started':
      return { ...state, screen: 'progress', study: emptyStudy(action.now, null, 'creating'), notice: null, gate: null };
    case 'study-created':
      return patchStudy(
        { ...state, history: [action.record, ...state.history.filter((h) => h.studyId !== action.record.studyId)] },
        { id: action.record.studyId, record: action.record },
      );
    case 'stage': {
      if (!state.study) return state;
      const patch: Partial<ActiveStudy> = { stage: action.stage, stageStartedAt: action.now, error: null };
      if (action.stage === 'watching' && state.study.watchingSince === null) patch.watchingSince = action.now;
      return patchStudy(state, patch);
    }
    case 'launch-failed':
      return patchStudy(state, { error: action.message });
    case 'retry':
      return patchStudy(state, { error: null, stageStartedAt: action.now, pollError: null, reportError: null });
    case 'poll': {
      if (!state.study) return state;
      const queuedSince = nextQueuedSince(action.runs, state.study.queuedSince ?? (state.study.record?.launchedAt ?? null), action.now);
      const record = state.study.record ? { ...state.study.record, status: action.status } : null;
      return {
        ...state,
        history: record ? state.history.map((h) => (h.studyId === record.studyId ? record : h)) : state.history,
        study: {
          ...state.study,
          record,
          status: action.status,
          runs: action.runs,
          queuedSince,
          lastPolledAt: action.now,
          pollError: null,
        },
      };
    }
    case 'poll-failed':
      return patchStudy(state, { pollError: action.message });
    case 'report': {
      if (!state.study) return state;
      const done = !action.report.partial && (action.report.status === 'complete' || action.report.status === 'failed');
      const k = action.report.archetypes.reduce((s, a) => s + (a.completion?.k ?? 0), 0);
      const n = action.report.archetypes.reduce((s, a) => s + (a.completion?.n ?? 0), 0);
      const record = state.study.record
        ? { ...state.study.record, status: action.report.status, outcome: n > 0 ? `${k} of ${n} reached the goal` : state.study.record.outcome ?? null }
        : null;
      const study: ActiveStudy = {
        ...state.study,
        record,
        report: action.report,
        reportError: null,
        stage: done ? 'done' : state.study.stage,
        status: (action.report.status as StudyStatusValue) ?? state.study.status,
      };
      const screen = done && state.screen === 'progress' ? 'report' : state.screen;
      return {
        ...state,
        screen,
        study,
        history: record ? state.history.map((h) => (h.studyId === record.studyId ? record : h)) : state.history,
      };
    }
    case 'report-failed':
      return patchStudy(state, { reportError: action.message });
    case 'open-study':
      return { ...state, study: emptyStudy(action.now, action.record, 'watching'), screen: 'progress', notice: null };
    case 'new-test':
      return { ...state, study: null, screen: 'new', touched: false, notice: null, gate: null };
    case 'navigate': {
      if (action.screen === 'settings') return { ...state, back: state.screen === 'settings' ? state.back : state.screen, screen: 'settings' };
      return { ...state, screen: action.screen };
    }
    case 'signin-start':
      return { ...state, auth: { phase: 'starting', code: null, startedAt: action.now, error: null } };
    case 'signin-code':
      return { ...state, auth: { phase: 'waiting', code: action.code, startedAt: action.now, error: null } };
    case 'signin-failed':
      return { ...state, auth: { phase: 'error', code: null, startedAt: null, error: action.message } };
    case 'signin-cancel':
      return { ...state, auth: INITIAL_STATE.auth };
    case 'signed-in': {
      const next = { ...state, token: action.token, auth: INITIAL_STATE.auth, notice: null };
      return { ...next, screen: state.screen === 'settings' ? 'settings' : landing(next) };
    }
    case 'signed-out':
      return {
        ...state,
        // A launch the sign out cut off before the study existed has nothing
        // to resume; the form still holds what was typed.
        study: state.study?.id ? state.study : null,
        token: null,
        screen: 'signin',
        auth: INITIAL_STATE.auth,
        notice: action.expired ? { kind: 'info', text: 'Your Archetype session ended. Sign in again to continue.' } : null,
      };
    case 'settings':
      return { ...state, settings: action.settings };
    case 'studies':
      return { ...state, history: action.studies };
    case 'notice':
      return { ...state, notice: action.notice };
    case 'gate':
      return { ...state, gate: action.gate };
    case 'session':
      if (state.study?.id !== action.studyId) return state;
      return patchStudy(state, { live: { ...state.study.live, [action.status.runId]: action.status } });
    case 'runner':
      if (state.study?.id !== action.studyId) return state;
      return patchStudy(state, { runner: action.status });
    case 'flow-map':
    case 'flow-paths':
    case 'flow-error':
    case 'flow-shot':
    case 'flow-clear':
    case 'flow-follow':
    case 'flow-follow-note': {
      if (state.study?.id !== action.studyId) return state;
      return patchStudy(state, { flow: flowCard(state.study.flow, action) });
    }
    default:
      return state;
  }
}
