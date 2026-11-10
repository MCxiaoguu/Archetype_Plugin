import { DEFAULT_SETTINGS, type Draft, type SavedSession, type Settings, type StudyRecord } from '../lib/messages';

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

async function traceSessions(api: PluginAPI, key: string): Promise<Record<string, SavedSession>> {
  const stored = await api.clientStorage.getAsync(key);
  return stored && typeof stored === 'object' ? (stored as Record<string, SavedSession>) : {};
}

/** The sessions saved for a study, in the order they were first saved. */
export async function loadTraceSessions(api: PluginAPI, studyId: string): Promise<SavedSession[]> {
  return Object.values(await traceSessions(api, KEYS.trace(readId(api), studyId)));
}

/** Saves a run's session, or forgets the run when `session` is null (it ended). */
export async function saveTraceSession(api: PluginAPI, studyId: string, runId: string, session: SavedSession | null): Promise<void> {
  const key = KEYS.trace(fileId(api, true) as string, studyId);
  const sessions = await traceSessions(api, key);
  if (session) sessions[runId] = session;
  else delete sessions[runId];
  if (Object.keys(sessions).length) await api.clientStorage.setAsync(key, sessions);
  else await api.clientStorage.deleteAsync(key);
}
