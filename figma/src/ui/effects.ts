import { ApiClient, ApiError, pollDeviceFlow, type StudyLike, type StudyRuns, type StudyStatus } from '../lib/api';
import { continueLaunch } from '../lib/launch';
import { studyWebUrl, type MainToUi, type Settings, type StudyRecord } from '../lib/messages';
import { isStudyDone, pollDelay } from '../lib/poll';
import { runPreflight } from '../lib/preflight';
import { buildReportView, type StudyReport } from '../lib/report';
import { latestStepOf, runsToPeek } from '../lib/runs';
import { indexFrames } from '../lib/frames';
import { buildStudyRequest, validateForm } from '../lib/study';
import { toMain } from './bridge';
import type { Store } from './store';

const PEEK_EVERY_MS = 15_000;

function message(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.fields) {
      const first = Object.entries(err.fields)[0];
      if (first) return `${err.message}`;
    }
    return err.requestId ? `${err.message} (reference ${err.requestId})` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Side effects of the panel: network calls, polling and messages to the main
 * thread. State changes only go through the store's reducer.
 */
export function createEffects(store: Store) {
  let watchGen = 0;
  let signinGen = 0;
  const lastPeek = new Map<string, number>();

  const api = () => {
    const s = store.get();
    return new ApiClient({
      baseUrl: s.settings.apiBase,
      getToken: () => store.get().token,
      onUnauthorized: () => {
        if (!store.get().token) return;
        toMain({ type: 'save-token', token: null });
        watchGen++;
        store.dispatch({ type: 'signed-out', expired: true });
      },
    });
  };

  async function signIn() {
    const gen = ++signinGen;
    store.dispatch({ type: 'signin-start', now: Date.now() });
    try {
      const client = api();
      const code = await client.startDeviceFlow();
      if (gen !== signinGen) return;
      store.dispatch({ type: 'signin-code', code, now: Date.now() });
      toMain({ type: 'open-url', url: code.verification_uri_complete || code.verification_uri });
      const result = await pollDeviceFlow(client, code, { sleep, now: Date.now, cancelled: () => gen !== signinGen });
      if (gen !== signinGen || result.kind === 'cancelled') return;
      if (result.kind === 'failed') {
        store.dispatch({ type: 'signin-failed', message: result.message });
        return;
      }
      acceptToken(result.token.access_token);
    } catch (err) {
      if (gen === signinGen) store.dispatch({ type: 'signin-failed', message: message(err) });
    }
  }

  function cancelSignIn() {
    signinGen++;
    store.dispatch({ type: 'signin-cancel' });
  }

  function acceptToken(token: string) {
    toMain({ type: 'save-token', token });
    store.dispatch({ type: 'signed-in', token });
    const s = store.get();
    if (s.study) watch();
  }

  function signOut() {
    watchGen++;
    toMain({ type: 'save-token', token: null });
    store.dispatch({ type: 'signed-out', expired: false });
  }

  function saveSettings(settings: Settings) {
    toMain({ type: 'save-settings', settings });
    store.dispatch({ type: 'settings', settings });
    store.dispatch({ type: 'notice', notice: { kind: 'success', text: 'Settings saved.' } });
  }

  async function launch() {
    store.dispatch({ type: 'attempt-launch' });
    const s = store.get();
    if (!s.doc) return;
    const preflight = runPreflight(s.doc, s.form.startId, s.form.goalId);
    const errors = validateForm(s.form, preflight, s.fileKey);
    if (Object.keys(errors).length > 0) {
      store.dispatch({ type: 'notice', notice: { kind: 'error', text: 'A few things need a look before launch.' } });
      return;
    }
    const body = buildStudyRequest(s.form, { doc: s.doc, preflight, pluginVersion: s.pluginVersion, knownFileKey: s.fileKey });
    const frames = new Map(s.doc.frames.map((f) => [f.id, f.name]));
    toMain({ type: 'save-draft', draft: { goal: s.form.goal, who: s.form.who, product: s.form.product, link: s.form.link, size: s.form.size } });
    store.dispatch({ type: 'launch-started', now: Date.now() });
    const gen = ++watchGen;
    try {
      const study = await api().createStudy<StudyLike>(body);
      if (gen !== watchGen) return;
      const record: StudyRecord = {
        studyId: study.studyId,
        title: study.title || body.title,
        startName: frames.get(s.form.startId as string) ?? 'Start',
        goalName: frames.get(s.form.goalId as string) ?? 'Goal',
        size: s.form.size,
        launchedAt: Date.now(),
        status: study.status || 'draft',
        outcome: null,
      };
      toMain({ type: 'save-study', record });
      store.dispatch({ type: 'study-created', record });
      await proceed(gen);
    } catch (err) {
      if (gen === watchGen) store.dispatch({ type: 'launch-failed', message: message(err) });
    }
  }

  async function proceed(gen: number) {
    const id = store.get().study?.id;
    if (!id) return;
    const result = await continueLaunch(api(), id, {
      sleep,
      cancelled: () => gen !== watchGen,
      onStage: (stage) => {
        if (gen === watchGen) store.dispatch({ type: 'stage', stage, now: Date.now() });
      },
    });
    if (result === 'watching' && gen === watchGen) void loop(gen);
  }

  /** Resume a study: finish any missing launch step, then poll. */
  function watch() {
    const gen = ++watchGen;
    const st = store.get().study;
    if (!st?.id) return;
    store.dispatch({ type: 'retry', now: Date.now() });
    proceed(gen).catch((err) => {
      if (gen === watchGen) store.dispatch({ type: 'launch-failed', message: message(err) });
    });
  }

  async function retry() {
    const st = store.get().study;
    if (!st) return;
    if (!st.id) {
      await launch();
      return;
    }
    if (st.stage === 'done' || st.reportError) {
      await loadReport(watchGen);
      return;
    }
    watch();
  }

  async function loop(gen: number) {
    while (gen === watchGen) {
      const st = store.get().study;
      if (!st?.id) return;
      try {
        const client = api();
        const [status, runs] = await Promise.all([client.getStatus<StudyStatus>(st.id), client.getRuns<StudyRuns>(st.id)]);
        if (gen !== watchGen) return;
        store.dispatch({ type: 'poll', status: status.status, runs: runs.runs ?? [], now: Date.now() });
        toMain({ type: 'save-study', record: store.get().study?.record as StudyRecord });
        await peek(gen, runs);
        if (isStudyDone(status.status)) {
          await loadReport(gen);
          return;
        }
      } catch (err) {
        if (gen !== watchGen) return;
        if (err instanceof ApiError && err.status === 401) return;
        store.dispatch({ type: 'poll-failed', message: message(err) });
      }
      const since = store.get().study?.watchingSince ?? Date.now();
      await sleep(pollDelay(Date.now() - since));
    }
  }

  async function peek(gen: number, runs: StudyRuns) {
    const now = Date.now();
    const ids = runsToPeek(runs.runs ?? []).filter((id) => now - (lastPeek.get(id) ?? 0) >= PEEK_EVERY_MS);
    const client = api();
    await Promise.all(
      ids.map(async (id) => {
        lastPeek.set(id, now);
        try {
          const r = await client.getRunReport(id);
          const step = latestStepOf(r.steps);
          if (step && gen === watchGen) store.dispatch({ type: 'peek', runId: id, step });
        } catch {
          // The screen name is a nicety; the status rows still update.
        }
      }),
    );
  }

  async function loadReport(gen: number) {
    const st = store.get().study;
    if (!st?.id) return;
    try {
      const report = await api().getReport<StudyReport>(st.id);
      if (gen !== watchGen) return;
      store.dispatch({ type: 'report', report, now: Date.now() });
      const rec = store.get().study?.record;
      if (rec) toMain({ type: 'save-study', record: rec });
    } catch (err) {
      if (gen === watchGen) store.dispatch({ type: 'report-failed', message: message(err) });
    }
  }

  function openStudy(record: StudyRecord) {
    store.dispatch({ type: 'open-study', record, now: Date.now() });
    toMain({ type: 'save-study', record });
    watch();
  }

  function newTest() {
    watchGen++;
    toMain({ type: 'forget-last' });
    store.dispatch({ type: 'new-test' });
  }

  function openInArchetype() {
    const s = store.get();
    if (s.study?.id) toMain({ type: 'open-url', url: studyWebUrl(s.settings.webBase, s.study.id) });
  }

  function pin() {
    const s = store.get();
    if (!s.study?.report) return;
    const view = buildReportView(s.study.report, indexFrames(s.doc));
    if (view.pins.length === 0) {
      store.dispatch({ type: 'notice', notice: { kind: 'info', text: 'No findings point at frames on this page, so there is nothing to pin.' } });
      return;
    }
    toMain({ type: 'pin', pins: view.pins });
  }

  function handleMain(msg: MainToUi) {
    switch (msg.type) {
      case 'init': {
        const { type: _t, ...payload } = msg;
        store.dispatch({ type: 'init', payload, now: Date.now() });
        if (store.get().study && store.get().token) watch();
        return;
      }
      case 'doc':
        store.dispatch({ type: 'doc', doc: msg.doc });
        return;
      case 'selection':
        store.dispatch({ type: 'selection', selection: msg.selection });
        return;
      case 'studies':
        store.dispatch({ type: 'studies', studies: msg.studies });
        return;
      case 'pin-result':
        store.dispatch({ type: 'notice', notice: { kind: msg.ok ? 'success' : 'error', text: msg.message } });
        return;
      case 'show-result':
        if (!msg.ok && msg.message) store.dispatch({ type: 'notice', notice: { kind: 'error', text: msg.message } });
        return;
      default:
        return;
    }
  }

  return { signIn, cancelSignIn, acceptToken, signOut, saveSettings, launch, retry, openStudy, newTest, openInArchetype, pin, handleMain, watch };
}

export type Effects = ReturnType<typeof createEffects>;
