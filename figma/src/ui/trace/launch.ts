/**
 * The panel's side of a plugin-mode study around the runner: the launch
 * gate (spec, Data flow 1), reading the prototype, and starting, resuming
 * and stopping the runner of the study on screen. Effects calls it; state
 * changes go through the store.
 */

import type { ApiClient } from '../../lib/api';
import { componentsToImport, failedImports } from '../../lib/launch';
import type { ProtoDoc } from '../../lib/proto/model';
import type { RunnerStatus } from '../../lib/runs';
import { toMain } from '../bridge';
import type { Store } from '../store';
import { BridgeError, createBridge, panelTransport, type Bridge } from './bridge';
import { runStudy, type DocRead } from './runner';
import type { SessionStatus } from './session';

/** A read that imports library components can take longer than the bridge's 30 s. */
export const READ_TIMEOUT_MS = 120_000;

export type TraceBridge = Pick<Bridge, 'call'> & Partial<Pick<Bridge, 'close'>>;

/** The prototype a launch goes on, and whether the designer let the read import library components. */
export interface GatedRead {
  doc: ProtoDoc;
  importLibraryVariants: boolean;
}

export interface TracePanelDeps {
  store: Store;
  api: () => ApiClient;
  /** The line to the main thread; postMessage by default. */
  bridge?: TraceBridge;
  sleep: (ms: number) => Promise<void>;
  message: (err: unknown) => string;
}

export function createTracePanel(deps: TracePanelDeps) {
  const { store } = deps;
  let line: TraceBridge | null = deps.bridge ?? null;
  const bridge = () => (line ??= createBridge(panelTransport()));
  /** The read the gate passed, or holds while the designer reads what an import couldn't add. */
  let gated: GatedRead | null = null;
  /**
   * The file edits the main thread reported since the panel opened. A read
   * notes the count when it is sent: an edit after that (during the read
   * too) means the doc it gave may not be the file any more, and the
   * sessions started on it are flagged (spec, Error handling).
   */
  let edits = 0;
  /** Studies this panel just launched through the gate, whose edit access it checked moments ago. */
  const launching = new Set<string>();
  /** Studies whose runner is going: one runner per study, through retries and sign ins. */
  const runners = new Set<string>();
  const fileWatchers = new Set<(frameIds: string[]) => void>();
  /** Fires when the panel closes: every session stops where it is, to resume when it reopens. */
  const closing = new AbortController();

  /**
   * Reads the prototype on the current page, once more if the main thread
   * answered with an error (spec, Error handling). A read that timed out
   * may still be running there, and another would only queue behind it, so
   * it isn't tried again.
   */
  async function read(importLibraryVariants: boolean): Promise<ProtoDoc> {
    let first: unknown;
    try {
      return await bridge().call('trace-read', { importLibraryVariants }, { timeoutMs: READ_TIMEOUT_MS });
    } catch (err) {
      if (!(err instanceof BridgeError)) throw err;
      first = err;
    }
    try {
      return await bridge().call('trace-read', { importLibraryVariants }, { timeoutMs: READ_TIMEOUT_MS });
    } catch (second) {
      const [a, b] = [deps.message(first), deps.message(second)];
      throw new Error(a === b ? b : `${b} (the first try: ${a})`);
    }
  }

  /** A read for a runner: the doc, and whether the file changed since the read was sent. */
  async function readForRunner(importLibraryVariants: boolean): Promise<DocRead> {
    const at = edits;
    const doc = await read(importLibraryVariants);
    return { doc, changed: () => edits > at };
  }

  /**
   * The launch gate. Returns the read to launch on, or null while the gate
   * holds the launch: the file can't be edited, the designer confirms an
   * import first, or reads what the confirmed import couldn't add.
   */
  async function gate(importConfirmed: boolean): Promise<GatedRead | null> {
    store.dispatch({ type: 'gate', gate: { kind: 'checking' } });
    gated = null;
    let doc: ProtoDoc;
    try {
      const check = await bridge().call('trace-scratch-check', {});
      if (!check.ok) {
        store.dispatch({ type: 'gate', gate: { kind: 'blocked', reason: check.reason, detail: check.detail } });
        return null;
      }
      doc = await read(importConfirmed);
    } catch (err) {
      store.dispatch({ type: 'gate', gate: null });
      store.dispatch({ type: 'notice', notice: { kind: 'error', text: deps.message(err) } });
      return null;
    }
    const components = importConfirmed ? [] : componentsToImport(doc);
    if (components.length > 0) {
      store.dispatch({ type: 'gate', gate: { kind: 'confirm-import', components } });
      return null;
    }
    gated = { doc, importLibraryVariants: importConfirmed };
    const failures = importConfirmed ? failedImports(doc) : [];
    if (failures.length > 0) {
      store.dispatch({ type: 'gate', gate: { kind: 'import-failed', failures } });
      return null;
    }
    store.dispatch({ type: 'gate', gate: null });
    return gated;
  }

  /** The designer read what the import couldn't add and launches anyway. */
  function launchAnyway(): GatedRead | null {
    if (store.get().gate?.kind !== 'import-failed' || !gated) return null;
    store.dispatch({ type: 'gate', gate: null });
    return gated;
  }

  function cancel() {
    gated = null;
    store.dispatch({ type: 'gate', gate: null });
  }

  /** The read the last launch passed the gate with, for a Try again before its study exists. */
  function lastRead(): GatedRead | null {
    return gated;
  }

  /** The gate passed for this study's launch: its runner needn't check edit access again. */
  function launchedOn(studyId: string) {
    launching.add(studyId);
  }

  /**
   * Runs the plugin-mode study on screen in this panel, or resumes the runs
   * it owns. Call it only while the study is running. One runner per study:
   * a retry or a sign in while it goes on leaves it be. A test runs on the
   * page it was launched on; from another page, the designer goes there first.
   * The runner plays the prototype read here, as the file is now (the launch
   * gate's read can be minutes old by the time the study runs), and reads it
   * again for each new wave. `drawnOnly` is the designer's Launch with drawn
   * connections only, after the flow map couldn't be completed.
   */
  function start({ drawnOnly = false }: { drawnOnly?: boolean } = {}) {
    const st = store.get().study;
    const trace = st?.record?.trace;
    if (!st?.id || !trace || runners.has(st.id)) return;
    const studyId = st.id;
    const report = (status: RunnerStatus) => store.dispatch({ type: 'runner', studyId, status });
    const otherPage = () => report({ phase: 'other_page', notice: `This test runs on page ${trace.pageName}.` });
    if (store.get().doc?.pageId !== trace.pageId) {
      otherPage();
      return;
    }
    runners.add(studyId);
    /** Where the runner stopped short of done, for the study on screen, or as a Figma notice for one that isn't. */
    const stop = (phase: 'stuck' | 'failed', text: string) => {
      if (store.get().study?.id !== studyId) {
        toMain({ type: 'notify', text });
        return;
      }
      report({ phase, notice: text });
      store.dispatch({ type: 'launch-failed', message: text });
    };
    (async () => {
      // Edit access, checked by the launch gate, can be gone in a reopened panel: check before resuming anything.
      if (!launching.has(studyId)) {
        const check = await bridge().call('trace-scratch-check', {});
        if (!check.ok) {
          stop('failed', `${check.reason} (${check.detail})`);
          return null;
        }
      }
      launching.delete(studyId);
      const first = await readForRunner(trace.importLibraryVariants);
      // The designer changed page while the read ran.
      if (first.doc.pageId !== trace.pageId) {
        otherPage();
        return null;
      }
      return runStudy(
        { studyId, owner: trace.owner, read: first, shareKey: trace.shareKey, startFrameId: trace.startFrameId, drawnOnly },
        {
          bridge: bridge(),
          api: deps.api(),
          now: () => Date.now(),
          sleep: deps.sleep,
          pluginVersion: store.get().pluginVersion,
          onSession: (status) => {
            store.dispatch({ type: 'session', studyId, status });
            follow(studyId, status);
          },
          onRunner: report,
          onMap: (map) => store.dispatch({ type: 'flow-map', studyId, map }),
          onScreen: (_runId, node, image) => store.dispatch({ type: 'flow-shot', studyId, node, image }),
          onFrame: (frame) => store.dispatch({ type: 'live-frame', studyId, frame }),
          watchFile: (onChange) => {
            fileWatchers.add(onChange);
            return () => fileWatchers.delete(onChange);
          },
          readDoc: () => readForRunner(trace.importLibraryVariants),
          signal: closing.signal,
        },
      );
    })()
      .then((result) => {
        if (result?.stop === 'stuck') stop('stuck', result.message);
        // Its own banner offers the two ways on; the study on screen or not, nothing was claimed on the read.
        if (result?.stop === 'map_failed') {
          if (store.get().study?.id === studyId) report({ phase: 'map_failed', notice: result.message });
          else toMain({ type: 'notify', text: result.message });
        }
      })
      .catch((err: unknown) => {
        // Try again would fail the same way: the way out is to forget that progress.
        if (err instanceof BridgeError && err.code === 'saved_progress_unreadable' && store.get().study?.id === studyId) report({ phase: 'progress_unreadable', notice: err.message });
        else stop('failed', deps.message(err));
      })
      .finally(() => runners.delete(studyId));
  }

  /**
   * Forgets the saved progress of the study on screen, which this plugin
   * can't read, and runs it on without. Its running runs, saved here no
   * more, are claimed again: one with no turns yet starts from the first,
   * and one the backend already holds turns of is aborted with
   * panel_state_lost, since nothing saved says where it was.
   */
  async function forgetProgress() {
    const st = store.get().study;
    if (!st?.id || st.runner?.phase !== 'progress_unreadable') return;
    try {
      await bridge().call('trace-forget', { studyId: st.id });
    } catch (err) {
      store.dispatch({ type: 'runner', studyId: st.id, status: { phase: 'failed', notice: deps.message(err) } });
      store.dispatch({ type: 'launch-failed', message: deps.message(err) });
      return;
    }
    start();
  }

  /** The node the viewport last moved to for each followed run, so it moves once per turn there. */
  const followed = new Map<string, string>();

  /**
   * Follow persona: on each turn of the followed run that lands on another
   * node, the main thread brings that frame into view, moving nothing else.
   * A frame on another page leaves the viewport, and the card says which page.
   */
  function follow(studyId: string, status: Pick<SessionStatus, 'runId' | 'node'>) {
    const flow = store.get().study?.id === studyId ? store.get().study?.flow : null;
    if (!flow || flow.following !== status.runId || followed.get(status.runId) === status.node) return;
    followed.set(status.runId, status.node);
    bridge()
      .call('trace-follow', { frameId: status.node })
      .then(({ otherPage }) => store.dispatch({ type: 'flow-follow-note', studyId, note: otherPage ? `On page ${otherPage}` : null }))
      .catch((err: unknown) => store.dispatch({ type: 'flow-follow-note', studyId, note: `Can't follow: ${deps.message(err)}` }));
  }

  /** Starts or stops following a persona of the study on screen; following starts at the node it is on. */
  function followRun(runId: string | null) {
    const st = store.get().study;
    if (!st?.id) return;
    store.dispatch({ type: 'flow-follow', studyId: st.id, runId });
    followed.clear();
    const live = runId ? st.live[runId] : undefined;
    if (live) follow(st.id, live);
  }

  /** After the flow map couldn't be completed: Try again, or launch with the drawn connections only. */
  function afterMapFailed(drawnOnly: boolean) {
    if (store.get().study?.runner?.phase !== 'map_failed') return;
    start({ drawnOnly });
  }

  /** The page's doc changed: a test waiting for its page starts once the designer is there. */
  function pageChanged() {
    const st = store.get().study;
    if (st?.runner?.phase === 'other_page' && st.record?.trace?.pageId === store.get().doc?.pageId) start();
  }

  /** Opens the test's page, at its start frame; the doc that follows starts the test. */
  function goToPage() {
    const trace = store.get().study?.record?.trace;
    if (trace) toMain({ type: 'show-node', nodeId: trace.startFrameId });
  }

  function fileChanged(frameIds: string[]) {
    edits++;
    for (const onChange of fileWatchers) onChange(frameIds);
  }

  /**
   * The panel is closing. The sessions stop without aborting or forgetting
   * their runs, before the bridge goes: a call it rejects then is the close,
   * not a failed render.
   */
  function close() {
    closing.abort();
    line?.close?.();
  }

  return { gate, launchAnyway, cancel, lastRead, launchedOn, start, forgetProgress, afterMapFailed, followRun, pageChanged, goToPage, fileChanged, close };
}

export type TracePanel = ReturnType<typeof createTracePanel>;
