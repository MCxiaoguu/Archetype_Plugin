/**
 * A whole plugin-mode study in the panel (spec, Data flow 3, 9 and 10). The
 * runner claims every queued run of the wave under this panel's owner id,
 * runs their sessions side by side, and once all of them ended asks the
 * backend for the next wave, until it says the study is done. Each new wave
 * plays the prototype read again for it, so the file as it is then; a
 * session that starts on a read the file changed after is flagged. Before
 * every batch of claims, the flow of the read is committed as the study's
 * flow map (spec, At launch: the panel), and each claim names the version
 * it will play; the run plays that version for its whole life. When the
 * panel reopens, it first
 * resumes the runs it owns; when it closes (the signal), every session
 * stops where it is, to resume then.
 *
 * No DOM and no figma globals: the bridge, the API, the clock and the status
 * callbacks come in, so the live driver runs the same runner in Node.
 */

import { ApiError, type ApiClient, type ClaimBody, type FlowMapCommit, type NextWave, type RunBriefing, type RunRowApi, type StudyRuns } from '../../lib/api';
import { SAVED_SESSION_VERSION, type FlowRead, type SavedSession } from '../../lib/messages';
import { start } from '../../lib/proto/engine';
import type { FlowMap } from '../../lib/proto/flow';
import type { ProtoDoc, TraceState } from '../../lib/proto/model';
import { isTerminalRun } from '../../lib/poll';
import type { RunnerStatus } from '../../lib/runs';
import type { Bridge } from './bridge';
import { NOTICE, pauseFor, RETRY_FIRST_MS, RETRY_MAX_MS, runSession, type SessionDeps, type SessionResult, type SessionRun, type SessionStatus } from './session';

/** Finalizing runs keep the wave open; the runner waits this long for the next one (spec, Error handling). */
export const WAVE_WAIT_MS = 5 * 60_000;
export const WAVE_RETRY_MS = 5_000;

/** A read of the prototype, and whether the main thread reported the file changed since the read was sent. */
export interface DocRead {
  doc: ProtoDoc;
  changed: () => boolean;
}

export interface StudyTrace {
  studyId: string;
  /** This panel's id for the study's runs: every claim, turn and abort carries it. */
  owner: string;
  /** The prototype, read for this runner as it starts. */
  read: DocRead;
  /** The share link's file key; null without a link. */
  shareKey: string | null;
  startFrameId: string;
  /** The designer chose Launch with drawn connections only: the first commit asks no model, and every unread candidate is a gap. */
  drawnOnly: boolean;
}

export interface RunnerDeps {
  bridge: Pick<Bridge, 'call'>;
  api: Pick<ApiClient, 'claimRun' | 'nextWave' | 'postTurn' | 'getTurn' | 'abortRun' | 'commitFlowMap' | 'getFlowBuild' | 'getFlowMap'> & { getRuns(studyId: string): Promise<StudyRuns> };
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** The claim's browser version. */
  pluginVersion: string;
  onSession: (status: SessionStatus) => void;
  onRunner: (status: RunnerStatus) => void;
  watchFile: SessionDeps['watchFile'];
  /** Reads the prototype again, for a new wave. */
  readDoc: () => Promise<DocRead>;
  postTurnTimeoutMs?: number;
  /** Fires when the panel closes. */
  signal?: AbortSignal;
}

export type RunnerResult =
  | { stop: 'done'; reason: string; sessions: SessionResult[] }
  /** wave_in_progress outlasted WAVE_WAIT_MS: the panel offers Try again, which resumes. */
  | { stop: 'stuck'; message: string; sessions: SessionResult[] }
  /**
   * The flow map couldn't be completed (spec, When the map can't be
   * completed): the backend's "Couldn't read the flow of ..." message. The
   * panel offers Try again and Launch with drawn connections only.
   */
  | { stop: 'map_failed'; message: string; sessions: SessionResult[] }
  /** The panel closed: the runs resume when it reopens. */
  | { stop: 'cancelled'; sessions: SessionResult[] };

/** The panel is closing: the runner stops where it is. */
class Cancelled extends Error {
  constructor() {
    super('The panel closed.');
  }
}

/** The backend couldn't complete the flow map: nothing is claimed on the read. */
class MapFailed extends Error {}

/** The map changed while this commit was built or claimed on: commit again on the new version. */
class MapMoved extends Error {}

/** A build is polled this often, and given up on after BUILD_WAIT_MS (the backend's deadline is 180 s). */
export const BUILD_POLL_MS = 2_000;
export const BUILD_WAIT_MS = 5 * 60_000;
/** Commits on top of a version that moved meanwhile, before the runner says the map keeps changing. */
const MAX_COMMITS = 3;

/** The longest node name a commit carries (the backend's); a longer one is cut, ending in an ellipsis. */
const MAX_NODE_NAME = 200;

/** What the panel commits of a read flow, on top of `baseVersion`. */
export function commitBody(flow: FlowRead, baseVersion: number | null, drawnOnly: boolean): FlowMapCommit {
  return {
    baseVersion,
    docHash: flow.docHash,
    nodes: flow.nodes.map((n) => ({ ...n, name: n.name.length > MAX_NODE_NAME ? `${n.name.slice(0, MAX_NODE_NAME - 1).trimEnd()}…` : n.name })),
    edges: flow.edges,
    candidates: flow.candidates,
    ...(drawnOnly ? { drawnOnly: true as const } : {}),
  };
}

export async function runStudy(study: StudyTrace, deps: RunnerDeps): Promise<RunnerResult> {
  const results: SessionResult[] = [];
  const started = new Map<string, Promise<SessionResult>>();
  try {
    return await run(study, deps, results, started);
  } catch (err) {
    if (!(err instanceof Cancelled || err instanceof MapFailed)) throw err;
    // Closing: every session has the same signal and stops at its next step. A map that failed
    // mid-batch (committed again for a stale claim): the sessions already started play on.
    // Either way the runner stops once they have.
    const settled = await Promise.allSettled(started.values());
    for (const s of settled) if (s.status === 'fulfilled' && !results.includes(s.value)) results.push(s.value);
    // A session that broke (a cancel never rejects) stays loud, closing panel or not.
    const broke = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
    if (broke) throw broke.reason;
    if (err instanceof MapFailed) return { stop: 'map_failed', message: err.message, sessions: results };
    return { stop: 'cancelled', sessions: results };
  }
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The persona names of runs, for the designer: "Baseline founder and Low trust founder". */
function names(runs: readonly RunRowApi[]): string {
  const all = [...new Set(runs.map((r) => r.archetypeName || r.runId))];
  return all.length > 1 ? `${all.slice(0, -1).join(', ')} and ${all[all.length - 1]}` : (all[0] ?? '');
}

/** Why the next wave hasn't started after WAVE_WAIT_MS, from the runs as the backend lists them. */
function stuckMessage(runs: readonly RunRowApi[], ours: ReadonlySet<string>): string {
  const open = runs.filter((r) => !isTerminalRun(r.status));
  const elsewhere = open.filter((r) => !ours.has(r.runId));
  if (elsewhere.length) {
    const one = elsewhere.length === 1;
    return `The next round of tries can't start while ${names(elsewhere)} ${one ? 'is' : 'are'} still open, and this panel isn't running ${one ? 'it' : 'them'}. Try again once ${one ? 'it ends' : 'they end'}.`;
  }
  if (open.length) return `Archetype is still finishing ${names(open)}, so the next round of tries hasn't started. Try again in a minute.`;
  return "Archetype hasn't started the next round of tries yet. Try again in a minute.";
}

async function run(study: StudyTrace, deps: RunnerDeps, results: SessionResult[], started: Map<string, Promise<SessionResult>>): Promise<RunnerResult> {
  const { api, bridge } = deps;
  const { studyId, owner } = study;
  const checkCancel = () => {
    if (deps.signal?.aborted) throw new Cancelled();
  };
  /** The read the runs started from now play; each new wave reads the prototype again. */
  let current!: DocRead;
  let startState!: TraceState;
  let browser!: ClaimBody['browser'];
  /** The study's flow map versions this runner has, by version. */
  const maps = new Map<number, FlowMap>();
  /** The version committed for the read the runs now play: the one each claim names. */
  let playing: number | null = null;
  /** The study's current version as this runner last heard it; undefined until it asks. */
  let latest: number | null | undefined;
  /** A start frame the engine can't start fails here, before any run is claimed on the read. */
  function playOn(read: DocRead) {
    startState = start(read.doc, study.startFrameId);
    const { width, height } = startState.viewport;
    browser = { engine: 'figma-trace', version: deps.pluginVersion, viewport: [width, height] };
    current = read;
  }
  playOn(study.read);

  /** Where the runner is, apart from pauses (calls in parallel may pause at once); unset until a session starts. */
  let phase: RunnerStatus['phase'] | null = null;
  let pauses = 0;
  const report = (next: RunnerStatus['phase'], notice: string | null = null) => {
    phase = next;
    if (pauses === 0) deps.onRunner({ phase, notice });
  };

  /** Calls the API until it answers or fails for good, pausing through network loss and sign in trouble. */
  async function call<T>(work: () => Promise<T>): Promise<T> {
    let delay = RETRY_FIRST_MS;
    let paused = false;
    try {
      for (;;) {
        checkCancel();
        try {
          return await work();
        } catch (err) {
          checkCancel();
          const why = pauseFor(err);
          if (!why) throw err;
          if (!paused) {
            paused = true;
            pauses++;
          }
          deps.onRunner({ phase: 'paused', notice: why });
          await deps.sleep(delay);
          delay = Math.min(delay * 2, RETRY_MAX_MS);
        }
      }
    } finally {
      if (paused && --pauses === 0) deps.onRunner({ phase: phase ?? 'running', notice: null });
    }
  }

  const keep = (map: FlowMap) => {
    maps.set(map.version, map);
    return map;
  };

  /** The study's current version; null when it has none yet. */
  async function currentVersion(): Promise<number | null> {
    try {
      return keep((await call(() => api.getFlowMap(studyId))).map).version;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'flow_map_not_found') return null;
      throw err;
    }
  }

  /** Polls a build until it is ready; a failed one is the designer's to decide on, or a map that moved meanwhile. */
  async function built(buildId: string): Promise<FlowMap> {
    const since = deps.now();
    for (;;) {
      const build = await call(() => api.getFlowBuild(studyId, buildId));
      if (build.status === 'ready') return build.map;
      if (build.status === 'failed') {
        if (build.error === 'flow_map_changed') throw new MapMoved(build.message);
        throw new MapFailed(build.message);
      }
      if (deps.now() - since >= BUILD_WAIT_MS) {
        throw new MapFailed(`Archetype hasn't finished reading the flow after ${BUILD_WAIT_MS / 60_000} minutes (${build.nodesRead} of ${build.nodesToRead} screens read).`);
      }
      await deps.sleep(BUILD_POLL_MS);
      checkCancel();
    }
  }

  /**
   * Commits the flow of the read the runs now play, before any of them is
   * claimed: the backend answers the current version when the input is the
   * same, and builds the next one otherwise. A version that moved meanwhile
   * (another panel's commit, an edit) is the base of the next try.
   */
  async function commit(drawnOnly: boolean): Promise<void> {
    const flow = await bridge.call('trace-candidates', { docHash: current.doc.docHash });
    for (let attempt = 1; ; attempt++) {
      latest ??= await currentVersion();
      const body = commitBody(flow, latest, drawnOnly);
      try {
        const answer = await call(() => api.commitFlowMap(studyId, body));
        const map = keep(answer.status === 'ready' ? answer.map : await built(answer.buildId));
        latest = map.version;
        playing = map.version;
        return;
      } catch (err) {
        const moved = err instanceof MapMoved || (err instanceof ApiError && err.code === 'flow_map_changed');
        if (!moved) throw err;
        if (attempt >= MAX_COMMITS) throw new Error(`The flow map kept changing while this panel committed it (${messageOf(err)}).`);
        latest = undefined;
      }
    }
  }
  const readAgain = async () => {
    playOn(await deps.readDoc());
    await commit(false);
  };

  /** One commit at a time: claims that each find their version stale share the commit that makes it current again. */
  let recommitting: Promise<void> | null = null;
  function recommit(): Promise<void> {
    latest = undefined;
    recommitting ??= commit(false).finally(() => (recommitting = null));
    return recommitting;
  }

  /** The map a run plays: its claim's version, null for a run claimed with no map. */
  async function mapOf(version: number | null): Promise<FlowMap | null> {
    if (version === null) return null;
    const held = maps.get(version);
    if (held) return held;
    const { map } = await call(() => api.getFlowMap(studyId, version));
    if (map.version !== version) throw new Error(`Archetype sent flow map version ${map.version} for version ${version}.`);
    return keep(map);
  }

  const readRuns = async (): Promise<RunRowApi[]> => {
    const { runs } = await call(() => api.getRuns(studyId));
    if (!Array.isArray(runs)) throw new Error('Archetype sent a runs list the panel cannot read.');
    return runs;
  };

  /** Claims the backend refused for good; they fail the runner once the sessions that did start are done. */
  const refused: string[] = [];

  function begin(runId: string, resume: SavedSession | null, map: FlowMap | null) {
    if (phase !== 'running') report('running');
    const run: SessionRun = { runId, studyId, owner, doc: current.doc, shareKey: study.shareKey, startFrameId: study.startFrameId, resume, fileChanged: current.changed(), map };
    started.set(runId, runSession(run, { bridge, api, now: deps.now, sleep: deps.sleep, onStatus: deps.onSession, watchFile: deps.watchFile, postTurnTimeoutMs: deps.postTurnTimeoutMs, signal: deps.signal }));
  }

  /**
   * Claims a run and starts its session at once, without waiting for the
   * other claims. It saves the run at turn 0 first, so a panel that closes
   * now resumes it. A run another actor got first is theirs. A running run
   * is claimed again the same way: the backend answers its own owner with
   * the briefing again, and anyone else with already_claimed.
   */
  async function claimAndStart(runId: string): Promise<void> {
    let version: number | null;
    try {
      const briefing = await claimOn(runId);
      version = briefing.flowMapVersion;
      if (version !== null && !(Number.isInteger(version) && version >= 1)) throw new Error(`Archetype sent the claim of ${runId} with flow map version ${String(version)}.`);
    } catch (err) {
      if (err instanceof Cancelled || err instanceof MapFailed) throw err;
      if (err instanceof ApiError && err.code === 'already_claimed') return;
      refused.push(`${runId} (${messageOf(err)})`);
      return;
    }
    const map = await mapOf(version);
    await saveTurn0(runId, version);
    checkCancel();
    begin(runId, null, map);
  }

  /** Claims a run on the version committed for the read; a version gone stale meanwhile is committed again, then claimed on. */
  async function claimOn(runId: string): Promise<RunBriefing> {
    for (let attempt = 1; ; attempt++) {
      const claimed = playing;
      try {
        return await call(() => api.claimRun(runId, { owner, browser, flowMapVersion: claimed }));
      } catch (err) {
        if (!(err instanceof ApiError && err.code === 'flow_map_stale') || attempt >= MAX_COMMITS) throw err;
        // Another claim may have committed the current version already.
        if (playing === claimed) await recommit();
      }
    }
  }

  async function saveTurn0(runId: string, flowMapVersion: number | null): Promise<void> {
    const session: SavedSession = { owner, runId, turn: 0, state: startState, lastOutcome: null, timerEffects: [], loopFrames: [], flowMapVersion, mapMisses: [], version: SAVED_SESSION_VERSION };
    let failure: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await bridge.call('trace-save', { studyId, runId, session });
        return;
      } catch (err) {
        failure = err;
      }
    }
    // The run goes on; only a panel closed before its first turn is saved can't resume it.
    deps.onRunner({ phase: phase ?? 'running', notice: `${NOTICE.notSaved} ${messageOf(failure)}` });
  }

  /** Claims and starts runs, each on its own; when the panel closes, once every claim is through. */
  async function claimEach(runIds: readonly string[]): Promise<void> {
    const claims = await Promise.allSettled(runIds.filter((id) => !started.has(id)).map((id) => claimAndStart(id)));
    for (const c of claims) if (c.status === 'rejected') throw c.reason;
  }

  const claimQueued = (runs: readonly RunRowApi[]) => claimEach(runs.filter((r) => r.status === 'queued').map((r) => r.runId));

  /** Waits for every session started so far, then cleans up; a session that broke or a refused claim fails the runner. */
  async function settle(): Promise<void> {
    let seen = -1;
    const settled = new Map<string, PromiseSettledResult<SessionResult>>();
    while (seen !== started.size) {
      seen = started.size;
      for (const [runId, session] of started) if (!settled.has(runId)) settled.set(runId, (await Promise.allSettled([session]))[0] as PromiseSettledResult<SessionResult>);
    }
    for (const s of settled.values()) if (s.status === 'fulfilled' && !results.includes(s.value)) results.push(s.value);
    // The main thread's close handler removes what the closing panel's renders left.
    checkCancel();
    // No session renders any more: whatever a render left on the page can go.
    await bridge.call('trace-cleanup', {});
    for (const s of settled.values()) if (s.status === 'rejected') throw s.reason;
    if (refused.length) throw new Error(`Archetype refused to let this panel run ${refused.join('; ')}.`);
  }

  /**
   * The next wave, or 'started' when the wait found queued runs to claim:
   * a wave whose answer was lost, or runs queued meanwhile. Waits through
   * wave_in_progress for up to WAVE_WAIT_MS; then it is stuck.
   */
  async function nextWave(): Promise<NextWave | 'started' | { stuck: string }> {
    let since: number | null = null;
    for (;;) {
      try {
        const next = await call(() => api.nextWave(studyId));
        if (!next || (!next.done && !Array.isArray(next.runs))) throw new Error('Archetype sent a next wave the panel cannot read.');
        return next;
      } catch (err) {
        if (!(err instanceof ApiError && err.code === 'wave_in_progress')) throw err;
        const runs = await readRuns();
        const before = started.size;
        // Queued runs are a new wave (whose answer was lost, or queued meanwhile): they play the file as it is now.
        if (runs.some((r) => r.status === 'queued' && !started.has(r.runId))) await readAgain();
        await claimQueued(runs);
        if (started.size > before || refused.length) return 'started';
        since ??= deps.now();
        if (deps.now() - since >= WAVE_WAIT_MS) return { stuck: stuckMessage(runs, new Set(started.keys())) };
        await deps.sleep(WAVE_RETRY_MS);
        checkCancel();
      }
    }
  }

  // `started` holds every session this runner started, in the order it started them.
  // Resume (spec, Data flow 10): the runs this panel saved that the backend still runs.
  // A saved run of another owner is another panel's on this machine.
  await commit(study.drawnOnly);
  const { sessions: saved } = await bridge.call('trace-load', { studyId });
  const runs = await readRuns();
  const statusOf = new Map(runs.map((r) => [r.runId, r.status]));
  for (const s of saved) {
    if (s.owner !== owner) continue;
    if (statusOf.get(s.runId) === 'running') begin(s.runId, s, await mapOf(s.flowMapVersion));
    // It ended while the panel was closed: there is nothing left to resume.
    else await bridge.call('trace-save', { studyId, runId: s.runId, session: null });
  }
  // A running run nothing was saved for here: this panel's when it closed before the turn 0 save
  // landed, or another panel's. Claimed again, the backend says which. One of ours starts from
  // turn 1; if the backend already holds turns of it, nothing saved says the file is as it was
  // then, so the session aborts it with panel_state_lost rather than replay them.
  const savedHere = new Set(saved.map((s) => s.runId));
  const unsaved = runs.filter((r) => r.status === 'running' && !savedHere.has(r.runId)).map((r) => r.runId);
  await claimEach([...runs.filter((r) => r.status === 'queued').map((r) => r.runId), ...unsaved]);

  for (;;) {
    await settle();
    report('next_wave');
    const next = await nextWave();
    if (next === 'started') continue;
    if ('stuck' in next) return { stop: 'stuck', message: next.stuck, sessions: results };
    if (next.done) {
      report('done');
      return { stop: 'done', reason: next.reason, sessions: results };
    }
    await readAgain();
    await claimQueued(next.runs.map((r) => ({ runId: r.runId, archetypeId: r.archetypeId, archetypeName: r.archetypeName, status: 'queued' })));
  }
}
