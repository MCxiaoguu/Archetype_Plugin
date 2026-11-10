import { ApiClient, ApiError, pollDeviceFlow, type StudyLike, type StudyRuns, type StudyStatus } from '../lib/api';
import { componentsToImport, continueLaunch } from '../lib/launch';
import { isSafeWebUrl, studyWebUrl, type MainToUi, type Settings, type StudyRecord } from '../lib/messages';
import { isStudyDone, pollDelay } from '../lib/poll';
import type { ProtoDoc } from '../lib/proto/model';
import { runPreflight } from '../lib/preflight';
import { buildReportView, type StudyReport } from '../lib/report';
import { indexFrames } from '../lib/frames';
import { buildStudyRequest, shareKeyOf, validateForm } from '../lib/study';
import { toMain } from './bridge';
import type { Store } from './store';
import { createBridge, panelTransport, type Bridge } from './trace/bridge';
import { runStudy } from './trace/runner';

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

/** A random id for the panel that runs a study's personas (spec, Data flow 3). */
function newOwner(): string {
  return `p_${Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export interface EffectsDeps {
  /** The trace runner's line to the main thread; postMessage by default. */
  bridge?: Pick<Bridge, 'call'>;
}

/**
 * Side effects of the panel: network calls, polling, messages to the main
 * thread, and the trace runner that runs a plugin-mode study's personas.
 * State changes only go through the store's reducer.
 */
export function createEffects(store: Store, deps: EffectsDeps = {}) {
  let watchGen = 0;
  let signinGen = 0;
  let traceBridge = deps.bridge ?? null;
  const bridge = () => (traceBridge ??= createBridge(panelTransport()));
  /** The ProtoDoc read at launch, for the runner of the study it created. */
  let launched: { studyId: string; doc: ProtoDoc } | null = null;
  /** Studies whose runner is going: one runner per study, through retries and sign ins. */
  const runners = new Set<string>();
  const fileWatchers = new Set<(frameIds: string[]) => void>();

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
      const page = code.verification_uri_complete || code.verification_uri;
      if (!isSafeWebUrl(page ?? '')) {
        throw new Error('Archetype sent a sign in page that is not https, so the panel will not open it. Check the backend address in settings.');
      }
      store.dispatch({ type: 'signin-code', code, now: Date.now() });
      toMain({ type: 'open-url', url: page });
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

  /**
   * The launch gate (spec, Data flow 1), then the study. A file the panel
   * can't render in blocks the launch; a flow that would import library
   * components waits for the designer to confirm, then reads again with the
   * import allowed.
   */
  async function launch(importConfirmed = false) {
    store.dispatch({ type: 'attempt-launch' });
    const s = store.get();
    if (!s.doc || s.gate?.kind === 'checking') return;
    const preflight = runPreflight(s.doc, s.form.startId, s.form.goalId);
    const errors = validateForm(s.form, preflight, s.fileKey);
    if (Object.keys(errors).length > 0) {
      store.dispatch({ type: 'notice', notice: { kind: 'error', text: 'A few things need a look before launch.' } });
      if (typeof document !== 'undefined') {
        setTimeout(() => (document.querySelector('[aria-invalid="true"]') as HTMLElement | null)?.focus(), 0);
      }
      return;
    }
    store.dispatch({ type: 'gate', gate: { kind: 'checking' } });
    let doc: ProtoDoc;
    try {
      const check = await bridge().call('trace-scratch-check', {});
      if (!check.ok) {
        store.dispatch({ type: 'gate', gate: { kind: 'blocked', reason: check.reason } });
        return;
      }
      doc = await bridge().call('trace-read', { importLibraryVariants: importConfirmed });
    } catch (err) {
      store.dispatch({ type: 'gate', gate: null });
      store.dispatch({ type: 'notice', notice: { kind: 'error', text: message(err) } });
      return;
    }
    const components = importConfirmed ? [] : componentsToImport(doc);
    if (components.length > 0) {
      store.dispatch({ type: 'gate', gate: { kind: 'confirm-import', components } });
      return;
    }
    await create(doc, importConfirmed);
  }

  /** The designer agreed that testing adds the library components to the file. */
  async function confirmImport() {
    if (store.get().gate?.kind !== 'confirm-import') return;
    store.dispatch({ type: 'gate', gate: null });
    await launch(true);
  }

  function cancelImport() {
    store.dispatch({ type: 'gate', gate: null });
  }

  async function create(doc: ProtoDoc, importLibraryVariants: boolean) {
    const s = store.get();
    if (!s.doc) return;
    const preflight = runPreflight(s.doc, s.form.startId, s.form.goalId);
    const body = buildStudyRequest(s.form, { doc: s.doc, preflight, pluginVersion: s.pluginVersion, knownFileKey: s.fileKey });
    const frames = new Map(s.doc.frames.map((f) => [f.id, f.name]));
    toMain({ type: 'save-draft', draft: { goal: s.form.goal, who: s.form.who, product: s.form.product, link: s.form.link, size: s.form.size } });
    store.dispatch({ type: 'launch-started', now: Date.now() });
    const gen = ++watchGen;
    try {
      const study = await api().createStudy<StudyLike>(body);
      if (gen !== watchGen) return;
      if (!study || typeof study.studyId !== 'string' || !study.studyId) {
        throw new Error('Archetype did not return the study id, so the panel cannot follow the test. Try again.');
      }
      const record: StudyRecord = {
        studyId: study.studyId,
        title: study.title || body.title,
        startName: frames.get(s.form.startId as string) ?? 'Start',
        goalName: frames.get(s.form.goalId as string) ?? 'Goal',
        size: s.form.size,
        launchedAt: Date.now(),
        status: study.status || 'draft',
        outcome: null,
        trace: {
          owner: newOwner(),
          docHash: doc.docHash,
          startFrameId: s.form.startId as string,
          shareKey: shareKeyOf(s.form, s.fileKey),
          importLibraryVariants,
        },
      };
      launched = { studyId: study.studyId, doc };
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
    if (result === 'watching' && gen === watchGen) {
      startRunner();
      void loop(gen);
    }
  }

  /**
   * Runs a plugin-mode study's personas in this panel, or resumes the ones it
   * owns when the panel reopened. One runner per study: a retry or a sign in
   * while it goes on leaves it be.
   */
  function startRunner() {
    const st = store.get().study;
    const trace = st?.record?.trace;
    if (!st?.id || !trace || runners.has(st.id)) return;
    const studyId = st.id;
    runners.add(studyId);
    const shown = () => store.get().study?.id === studyId;
    const fail = (text: string) => {
      if (shown()) store.dispatch({ type: 'launch-failed', message: text });
      else toMain({ type: 'notify', text });
    };
    (async () => {
      const doc = launched?.studyId === studyId ? launched.doc : await bridge().call('trace-read', { importLibraryVariants: trace.importLibraryVariants });
      if (launched?.studyId === studyId) launched = null;
      return runStudy(
        { studyId, owner: trace.owner, doc, shareKey: trace.shareKey, startFrameId: trace.startFrameId },
        {
          bridge: bridge(),
          api: api(),
          now: () => Date.now(),
          sleep,
          pluginVersion: store.get().pluginVersion,
          onSession: (status) => store.dispatch({ type: 'session', studyId, status }),
          onRunner: (status) => store.dispatch({ type: 'runner', studyId, status }),
          watchFile: (onChange) => {
            fileWatchers.add(onChange);
            return () => fileWatchers.delete(onChange);
          },
        },
      );
    })()
      .then((result) => {
        if (result.stop === 'stuck') fail(result.message);
      })
      .catch((err: unknown) => fail(message(err)))
      .finally(() => runners.delete(studyId));
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
        if (typeof status?.status !== 'string' || !Array.isArray(runs?.runs)) {
          throw new Error('Archetype sent a study status or runs list the panel cannot read.');
        }
        store.dispatch({ type: 'poll', status: status.status, runs: runs.runs, now: Date.now() });
        toMain({ type: 'save-study', record: store.get().study?.record as StudyRecord });
        if (isStudyDone(status.status)) {
          await loadReport(gen);
          return;
        }
      } catch (err) {
        if (gen !== watchGen) return;
        if (err instanceof ApiError && err.status === 401) return;
        if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) {
          // The study is gone or not this account's: polling cannot fix that.
          store.dispatch({ type: 'launch-failed', message: message(err) });
          return;
        }
        store.dispatch({ type: 'poll-failed', message: message(err) });
      }
      const since = store.get().study?.watchingSince ?? Date.now();
      await sleep(pollDelay(Date.now() - since));
    }
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
      case 'trace-file-changed':
        for (const onChange of fileWatchers) onChange(msg.frameIds);
        return;
      default:
        return;
    }
  }

  return {
    signIn,
    cancelSignIn,
    acceptToken,
    signOut,
    saveSettings,
    launch: () => launch(),
    confirmImport,
    cancelImport,
    retry,
    openStudy,
    newTest,
    openInArchetype,
    pin,
    handleMain,
    watch,
  };
}

export type Effects = ReturnType<typeof createEffects>;
