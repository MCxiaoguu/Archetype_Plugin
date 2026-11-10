import { DEFAULT_SETTINGS, SAVED_SESSION_VERSION, type Draft, type SavedSession, type Settings, type StudyRecord } from '../lib/messages';

export const KEYS = {
  settings: 'archetype.settings',
  token: 'archetype.token',
  studies: (fileId: string) => `archetype.file.${fileId}.studies`,
  last: (fileId: string) => `archetype.file.${fileId}.last`,
  draft: (fileId: string) => `archetype.file.${fileId}.draft`,
  /** The trace sessions this panel runs for a study, by run id. */
  trace: (fileId: string, studyId: string) => `archetype.file.${fileId}.trace.${studyId}`,
};

const FILE_ID_KEY = 'archetypeFileId';
export const MAX_STUDIES = 20;

/**
 * A stable id for the open file. Public plugins cannot read figma.fileKey, so
 * the plugin keeps its own id in the document's plugin data (only this plugin
 * can read it). It is written lazily, the first time there is something to save.
 */
export function fileId(api: PluginAPI, create: boolean): string | null {
  if (api.fileKey) return api.fileKey;
  const existing = api.root.getPluginData(FILE_ID_KEY);
  if (existing) return existing;
  if (!create) return null;
  const id = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  try {
    api.root.setPluginData(FILE_ID_KEY, id);
    return id;
  } catch {
    // View only files refuse writes; fall back to the file name so history
    // still works on this machine.
    return nameId(api);
  }
}

function nameId(api: PluginAPI): string {
  return `name:${api.root.name}`;
}

/** Where to read this file's history: its id, or, when it never got one (a view only file), its name. */
function readId(api: PluginAPI): string {
  return fileId(api, false) ?? nameId(api);
}

function cleanSettings(raw: unknown): Settings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<Settings>;
  return {
    apiBase: typeof s.apiBase === 'string' && s.apiBase.trim() ? s.apiBase.trim() : DEFAULT_SETTINGS.apiBase,
    webBase: typeof s.webBase === 'string' && s.webBase.trim() ? s.webBase.trim() : DEFAULT_SETTINGS.webBase,
  };
}

export async function loadSettings(api: PluginAPI): Promise<Settings> {
  return cleanSettings(await api.clientStorage.getAsync(KEYS.settings));
}

export async function saveSettings(api: PluginAPI, settings: Settings): Promise<void> {
  await api.clientStorage.setAsync(KEYS.settings, cleanSettings(settings));
}

export async function loadToken(api: PluginAPI): Promise<string | null> {
  const t = await api.clientStorage.getAsync(KEYS.token);
  return typeof t === 'string' && t ? t : null;
}

export async function saveToken(api: PluginAPI, token: string | null): Promise<void> {
  if (token) await api.clientStorage.setAsync(KEYS.token, token);
  else await api.clientStorage.deleteAsync(KEYS.token);
}

export async function loadStudies(api: PluginAPI): Promise<{ studies: StudyRecord[]; lastStudyId: string | null }> {
  const id = readId(api);
  const studies = await api.clientStorage.getAsync(KEYS.studies(id));
  const last = await api.clientStorage.getAsync(KEYS.last(id));
  return {
    studies: Array.isArray(studies) ? (studies as StudyRecord[]) : [],
    lastStudyId: typeof last === 'string' ? last : null,
  };
}

export async function saveStudy(api: PluginAPI, record: StudyRecord): Promise<{ studies: StudyRecord[]; lastStudyId: string }> {
  const id = fileId(api, true) as string;
  const { studies } = await loadStudies(api);
  const next = [record, ...studies.filter((s) => s.studyId !== record.studyId)]
    .sort((a, b) => b.launchedAt - a.launchedAt)
    .slice(0, MAX_STUDIES);
  await api.clientStorage.setAsync(KEYS.studies(id), next);
  await api.clientStorage.setAsync(KEYS.last(id), record.studyId);
  return { studies: next, lastStudyId: record.studyId };
}

export async function forgetLast(api: PluginAPI): Promise<void> {
  await api.clientStorage.deleteAsync(KEYS.last(readId(api)));
}

export async function loadDraft(api: PluginAPI): Promise<Partial<Draft> | null> {
  const d = await api.clientStorage.getAsync(KEYS.draft(readId(api)));
  return d && typeof d === 'object' ? (d as Partial<Draft>) : null;
}

export async function saveDraft(api: PluginAPI, draft: Partial<Draft>): Promise<void> {
  const id = fileId(api, true) as string;
  await api.clientStorage.setAsync(KEYS.draft(id), draft);
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string';

/**
 * What is wrong with a trace state, or null: the fields rendering and the
 * engine rely on, so a state a resume can't settle is refused when it is
 * loaded, not partway through a turn.
 */
export function traceStateProblem(state: unknown): string | null {
  if (!isObject(state)) return 'it is not an object';
  const bad: string[] = [];
  if (!isText(state.frameId)) bad.push('frameId');
  if (!Array.isArray(state.overlays) || !state.overlays.every(isObject)) bad.push('overlays');
  if (!Array.isArray(state.history) || !state.history.every(isText)) bad.push('history');
  for (const field of ['scroll', 'variants', 'variables', 'modes'] as const) if (!isObject(state[field])) bad.push(field);
  if (!Number.isFinite(state.clockMs)) bad.push('clockMs');
  if (!Array.isArray(state.timers) || !state.timers.every(isObject)) bad.push('timers');
  const pointer = state.pointer;
  const pointerOk =
    isObject(pointer) && (pointer.point === null || isObject(pointer.point)) && Array.isArray(pointer.over) &&
    (pointer.pressing === null || isText(pointer.pressing)) && Array.isArray(pointer.held);
  if (!pointerOk) bad.push('pointer');
  if (!isText(state.docHash)) bad.push('docHash');
  if (!isObject(state.viewport) || !Number.isFinite(state.viewport.width) || !Number.isFinite(state.viewport.height)) bad.push('viewport');
  if (state.focus !== null && !isObject(state.focus)) bad.push('focus');
  return bad.length ? `its ${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} missing or malformed` : null;
}

/** Saved progress made by a version of the plugin whose sessions this one doesn't read. */
export const OTHER_VERSION = "This test's saved progress was made by another version of the plugin.";

/** What is wrong with a saved session of `runId`, or null. */
export function savedSessionProblem(session: unknown, runId: string): string | null {
  if (!isObject(session)) return 'it is not an object';
  if (session.version !== SAVED_SESSION_VERSION) return `it was made by another version of the plugin (version ${String(session.version)}, not ${SAVED_SESSION_VERSION})`;
  if (!isText(session.owner) || !session.owner) return 'it has no owner';
  if (session.runId !== runId) return `its runId is not the run it is saved under (${runId})`;
  if (!Number.isInteger(session.turn) || (session.turn as number) < 0) return 'its turn is not a whole number from 0';
  const state = traceStateProblem(session.state);
  if (state) return `its state is not a trace state (${state})`;
  if (session.lastOutcome !== null && !isObject(session.lastOutcome)) return 'its lastOutcome is not an object or null';
  if (!Array.isArray(session.timerEffects) || !session.timerEffects.every((e) => isObject(e) && isText(e.type) && isText(e.detail))) {
    return 'its timerEffects are not a list of {type, detail}';
  }
  if (!Array.isArray(session.loopFrames) || !session.loopFrames.every(isText)) return 'its loopFrames are not a list of frame ids';
  const v = session.flowMapVersion;
  if (v !== null && !(Number.isInteger(v) && (v as number) >= 1)) return 'its flowMapVersion is not a version number or null';
  return null;
}

/** Saved progress of a study this plugin can't read. The panel offers to forget it (trace-forget). */
export class SavedProgressError extends Error {
  readonly code = 'saved_progress_unreadable' as const;

  constructor(message: string) {
    super(message);
    this.name = 'SavedProgressError';
  }
}

/** A study's stored sessions. Stored data the plugin can't read is refused, never written over. */
async function traceSessions(api: PluginAPI, key: string): Promise<Record<string, SavedSession>> {
  const stored: unknown = await api.clientStorage.getAsync(key);
  if (stored === undefined) return {};
  if (!isObject(stored)) throw new SavedProgressError(`The trace sessions stored under ${key} are not an object, so the plugin leaves them as they are.`);
  for (const [runId, session] of Object.entries(stored)) {
    if (isObject(session) && session.version !== SAVED_SESSION_VERSION) throw new SavedProgressError(OTHER_VERSION);
    const problem = savedSessionProblem(session, runId);
    if (problem) throw new SavedProgressError(`The trace session of run ${runId} stored under ${key} can't be read: ${problem}.`);
  }
  return stored as Record<string, SavedSession>;
}

/**
 * The saves of each study's sessions, newest last. The runs of a study save
 * into one key, and each save reads, changes and writes it: two saves at once
 * would each write what they read, and one run's session would be lost.
 */
const traceSaves = new Map<string, Promise<void>>();

function afterSaves(key: string): Promise<void> {
  return traceSaves.get(key) ?? Promise.resolve();
}

/** The sessions saved for a study, in the order they were first saved, once the saves sent before this load are done. */
export async function loadTraceSessions(api: PluginAPI, studyId: string): Promise<SavedSession[]> {
  const key = KEYS.trace(readId(api), studyId);
  await afterSaves(key);
  return Object.values(await traceSessions(api, key));
}

/** Runs `write` on a study's key after the writes sent before it. */
function queued(key: string, write: () => Promise<void>): Promise<void> {
  const save = afterSaves(key).then(write);
  // The queue only orders the writes; each one's own failure reaches its caller through `save`.
  const done = save.catch(() => undefined);
  traceSaves.set(key, done);
  void done.then(() => {
    if (traceSaves.get(key) === done) traceSaves.delete(key);
  });
  return save;
}

/** Saves a run's session, or forgets the run when `session` is null (it ended), after the saves of the study sent before it. */
export async function saveTraceSession(api: PluginAPI, studyId: string, runId: string, session: SavedSession | null): Promise<void> {
  const key = KEYS.trace(fileId(api, true) as string, studyId);
  return queued(key, async () => {
    const sessions = await traceSessions(api, key);
    if (session) sessions[runId] = session;
    else delete sessions[runId];
    if (Object.keys(sessions).length) await api.clientStorage.setAsync(key, sessions);
    else await api.clientStorage.deleteAsync(key);
  });
}

/** Forgets all of a study's saved sessions, readable or not, after the saves sent before. Its runs are left to the backend's watchdog. */
export async function forgetTraceSessions(api: PluginAPI, studyId: string): Promise<void> {
  const key = KEYS.trace(readId(api), studyId);
  return queued(key, () => api.clientStorage.deleteAsync(key));
}
