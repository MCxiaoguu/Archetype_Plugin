import { isSafeWebUrl, isTraceRequest, PIN_PREFIX, type MainToUi, type Settings, type StudyRecord, type UiToMain } from '../lib/messages';
import { clearPins, pinFindings, showNode } from './canvas';
import { readDocument, selectedFrame } from './document';
import * as store from './storage';
import { createTraceMain } from './trace';

export const MIN_SIZE = { width: 320, height: 420 };
export const MAX_SIZE = { width: 900, height: 1200 };

/**
 * The panel is this plugin's own code, but it renders backend data and holds
 * the network; the main thread checks what it is asked to store, open or
 * write into the file, and refuses anything else loudly.
 */
function invalid(what: string): never {
  throw new Error(`The panel sent ${what}.`);
}

const isText = (v: unknown): v is string => typeof v === 'string';
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function checkUrl(url: unknown): string {
  if (!isText(url) || !isSafeWebUrl(url)) invalid('a link that is not https (or http on this machine)');
  return url;
}

function checkSettings(s: unknown): Settings {
  if (!isObject(s) || !isText(s.apiBase) || !isText(s.webBase) || !isSafeWebUrl(s.apiBase.trim()) || !isSafeWebUrl(s.webBase.trim())) {
    invalid('settings with an address that is not https (or http on this machine)');
  }
  return { apiBase: s.apiBase, webBase: s.webBase };
}

function checkRecord(r: unknown): StudyRecord {
  const ok =
    isObject(r) &&
    isText(r.studyId) && r.studyId.length > 0 &&
    isText(r.title) && isText(r.startName) && isText(r.goalName) && isText(r.status) &&
    (r.size === 'quick' || r.size === 'thorough') &&
    typeof r.launchedAt === 'number' && Number.isFinite(r.launchedAt);
  if (!ok) invalid('an incomplete test record (it needs a study id, names, size, status and launch time)');
  return r as unknown as StudyRecord;
}

export interface MainController {
  start(): Promise<void>;
  handle(msg: UiToMain): Promise<void>;
  /** Re-read the page and push it to the panel. */
  refreshDoc(): Promise<void>;
  pushSelection(): void;
  /** Removes scratch containers a crash left behind (at launch and when the plugin closes). */
  removeLeftovers(): number;
}

export function createController(api: PluginAPI, pluginVersion: string): MainController {
  const post = (msg: MainToUi) => api.ui.postMessage(msg);
  const trace = createTraceMain(api, post);

  async function refreshDoc() {
    post({ type: 'doc', doc: await readDocument(api) });
  }

  function pushSelection() {
    post({ type: 'selection', selection: selectedFrame(api) });
  }

  async function start() {
    trace.removeLeftovers();
    const [settings, token, doc, history, draft] = await Promise.all([
      store.loadSettings(api),
      store.loadToken(api),
      readDocument(api),
      store.loadStudies(api),
      store.loadDraft(api),
    ]);
    post({
      type: 'init',
      settings,
      token,
      fileKey: api.fileKey ?? null,
      doc,
      selection: selectedFrame(api),
      studies: history.studies,
      lastStudyId: history.lastStudyId,
      draft,
      pluginVersion,
    });
  }

  async function handle(msg: UiToMain) {
    if (!isObject(msg)) invalid('a message that is not an object');
    // Answered with trace-result or trace-error, never thrown (bar a missing request id).
    if (isTraceRequest(msg)) {
      await trace.handle(msg);
      return;
    }
    switch (msg.type) {
      case 'ready':
        await start();
        return;
      case 'resize': {
        if (!Number.isFinite(msg.width) || !Number.isFinite(msg.height)) invalid('a panel size that is not a number');
        const w = Math.round(Math.min(MAX_SIZE.width, Math.max(MIN_SIZE.width, msg.width)));
        const h = Math.round(Math.min(MAX_SIZE.height, Math.max(MIN_SIZE.height, msg.height)));
        api.ui.resize(w, h);
        return;
      }
      case 'refresh':
        await refreshDoc();
        pushSelection();
        return;
      case 'save-settings':
        await store.saveSettings(api, checkSettings(msg.settings));
        return;
      case 'save-token':
        if (msg.token !== null && !isText(msg.token)) invalid('a token that is not text');
        await store.saveToken(api, msg.token);
        return;
      case 'save-study': {
        const r = await store.saveStudy(api, checkRecord(msg.record));
        post({ type: 'studies', studies: r.studies, lastStudyId: r.lastStudyId });
        return;
      }
      case 'forget-last':
        await store.forgetLast(api);
        return;
      case 'save-draft':
        if (!isObject(msg.draft)) invalid('a draft that is not an object');
        await store.saveDraft(api, msg.draft);
        return;
      case 'open-url':
        api.openExternal(checkUrl(msg.url));
        return;
      case 'show-node': {
        if (!isText(msg.nodeId)) invalid('a node id that is not text');
        const r = await showNode(api, msg.nodeId).catch(() => ({ ok: false, message: 'Could not show that frame.' }));
        post({ type: 'show-result', ok: r.ok, message: r.message });
        return;
      }
      case 'pin': {
        // Clear pins removes only labels with the prefix: anything else could never be cleared.
        const pins: unknown = msg.pins;
        if (!Array.isArray(pins) || !pins.every((p) => isObject(p) && isText(p.frameId) && isText(p.frameName) && isText(p.label) && p.label.startsWith(PIN_PREFIX))) {
          invalid(`pins that are not "${PIN_PREFIX}" annotations on a frame`);
        }
        const r = await pinFindings(api, msg.pins);
        post({ type: 'pin-result', ...r });
        if (r.ok) api.notify(r.message);
        return;
      }
      case 'clear-pins': {
        const r = clearPins(api);
        post({ type: 'pin-result', ...r });
        return;
      }
      case 'notify':
        if (!isText(msg.text)) invalid('a notice that is not text');
        api.notify(msg.text);
        return;
      default:
        invalid(`a message the plugin does not know (${String((msg as { type?: unknown }).type)})`);
    }
  }

  return { start, handle, refreshDoc, pushSelection, removeLeftovers: trace.removeLeftovers };
}
