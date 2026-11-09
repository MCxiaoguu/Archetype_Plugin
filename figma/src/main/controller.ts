import type { MainToUi, UiToMain } from '../lib/messages';
import { clearPins, pinFindings, showNode } from './canvas';
import { readDocument, selectedFrame } from './document';
import * as store from './storage';

export const MIN_SIZE = { width: 320, height: 420 };
export const MAX_SIZE = { width: 900, height: 1200 };

export interface MainController {
  start(): Promise<void>;
  handle(msg: UiToMain): Promise<void>;
  /** Re-read the page and push it to the panel. */
  refreshDoc(): Promise<void>;
  pushSelection(): void;
}

export function createController(api: PluginAPI, pluginVersion: string): MainController {
  const post = (msg: MainToUi) => api.ui.postMessage(msg);

  async function refreshDoc() {
    post({ type: 'doc', doc: await readDocument(api) });
  }

  function pushSelection() {
    post({ type: 'selection', selection: selectedFrame(api) });
  }

  async function start() {
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
    switch (msg.type) {
      case 'ready':
        await start();
        return;
      case 'resize': {
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
        await store.saveSettings(api, msg.settings);
        return;
      case 'save-token':
        await store.saveToken(api, msg.token);
        return;
      case 'save-study': {
        const r = await store.saveStudy(api, msg.record);
        post({ type: 'studies', studies: r.studies, lastStudyId: r.lastStudyId });
        return;
      }
      case 'forget-last':
        await store.forgetLast(api);
        return;
      case 'save-draft':
        await store.saveDraft(api, msg.draft);
        return;
      case 'open-url':
        if (/^https?:\/\//i.test(msg.url)) api.openExternal(msg.url);
        return;
      case 'show-node': {
        const r = await showNode(api, msg.nodeId).catch(() => ({ ok: false, message: 'Could not show that frame.' }));
        post({ type: 'show-result', ok: r.ok, message: r.message });
        return;
      }
      case 'pin': {
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
        api.notify(msg.text);
        return;
      default:
        return;
    }
  }

  return { start, handle, refreshDoc, pushSelection };
}
