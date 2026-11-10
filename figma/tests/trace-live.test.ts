import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { liveConfig, openWireframer, readText, saveFile, type Wireframer } from '../harness/live.mjs';
import { ApiClient, ApiError, type ClaimBody, type NextWave, type RunBriefing, type StudyRuns, type TurnBody, type TurnView } from '../src/lib/api';
import type { ProtoDoc } from '../src/lib/proto/model';
import type { RunnerStatus } from '../src/lib/runs';
import { runStudy, type RunnerDeps, type RunnerResult } from '../src/ui/trace/runner';
import type { SessionResult, SessionStatus } from '../src/ui/trace/session';
import { hiddenFrameNames, namesIn, readsGreetingAsWrongName } from './live-checks';
import { expectUntouched, fakeFile, openPlugin, scratchOn, snapshot, tick, type Fake, type Plugin } from './trace-plugin';
import { sceneOf } from './wireframe';

// A live trace study: the plugin as in trace-e2e (the real reader,
// renderer, trace.ts, bridge, session and study runner on the fake Farside
// file), against
// the local live backend (backend scripts/trace_live_server.py: the real
// app and routes, eager Celery, real Gemini decisions). Each export is a
// real JPEG, a wireframe of what the scratch copies draw. The personas are
// not deterministic: the run is recorded, and only what must hold whatever
// they do is asserted. Never part of npm test: it runs only with
//
//   TRACE_LIVE_URL=http://127.0.0.1:5013 npx vitest run tests/trace-live.test.ts
//
// Each run writes its log, wireframes, report and the backend's state to
// TRACE_LIVE_OUT/run-<time>/ (default harness/live/, gitignored).

const LIVE = liveConfig();
const OWNER = `panel-live-${Date.now().toString(36)}`;
const START = '1:2';
const GOAL = '2:50';
const TERMINAL = new Set(['completed', 'abandoned', 'aborted']);
/** Aborts the panel or backend must never cause without a cause the run log explains. */
const UNEXPLAINED_ABORTS = new Set(['engine_error', 'panel_state_lost', 'brain_invalid_action', 'decider_error']);
/** Turn posts the backend refuses: a body it can't use (400), or one too large (413). */
const REFUSED = new Set([400, 413]);
/** A turn decided inside the request: about 4 s, 10 to 20 s with the debrief; a give-up review asks twice. */
const POST_TURN_TIMEOUT_MS = 180_000;
const MAX_SCREENSHOT_BYTES = 1.5 * 1024 * 1024;
/** The trace brain's model, as the report and each run name it. */
const ACTOR_MODEL = 'google:gemini-3-flash-preview';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const nodeId = (url: string) => new URL(url).searchParams.get('node-id');
const last = <T>(items: readonly T[]): T | undefined => items[items.length - 1];
const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** What a turn post and its polls did, as the run log keeps it. */
interface TurnRecord {
  turn: number;
  posts: Array<{ at: string; ms: number; status: number | null; code: string | null; message: string | null }>;
  screen: TurnBody['screen'];
  screenshot: { file: string; bytes: number };
  elements: Array<{ id: string; label: string; role: string }>;
  visibleText: string;
  last: TurnBody['last'];
  flags: TurnBody['flags'];
  polls: number;
  decided: TurnView | null;
  /** From the post's start to the decision the panel read. */
  decideMs: number | null;
}

interface RunLog {
  runId: string;
  wave: number | null;
  archetypeName: string;
  personaName: string | null;
  /** The claim's briefing, as the persona's brain gets it. */
  briefing: RunBriefing | null;
  claimedAt: string | null;
  /** From the claim to the last answer the run got. */
  wallMs: number | null;
  result: SessionResult | null;
  statuses: string[];
  turns: TurnRecord[];
  aborts: Array<{ code: string; detail: string }>;
}

interface Doc {
  [key: string]: unknown;
}

async function liveState(base: string): Promise<Record<string, Doc[]>> {
  const res = await fetch(`${base}/__live/state`);
  if (!res.ok) throw new Error(`GET /__live/state answered ${res.status}`);
  return (await res.json()) as Record<string, Doc[]>;
}

describe.skipIf(!LIVE.url)('a live trace study against the local backend', () => {
  const base = LIVE.url ?? '';
  const folder = `${LIVE.out}/run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const runs = new Map<string, RunLog>();
  const refusals: Array<{ runId: string; turn: number; status: number; code: string; message: string }> = [];
  const screenshots: Array<{ bytes: number; jpeg: boolean }> = [];
  const log: Record<string, unknown> = { owner: OWNER, user: LIVE.user, backend: base, folder };
  let fake: Fake;
  let plugin: Plugin;
  let doc: ProtoDoc;
  let before: Map<string, unknown>;
  let wireframer: Wireframer;
  let client: ApiClient;
  let studyId: string;
  let report: Record<string, unknown>;
  let state: Record<string, Doc[]>;
  let runnerResult: RunnerResult;
  const startedAt = Date.now();

  const names = new Map<string, string>();
  const claims: Array<{ runId: string; body: ClaimBody }> = [];
  const waves: Array<{ at: string; answer: NextWave | null; error: string | null }> = [];
  const runner: RunnerStatus[] = [];

  /** A run's log, made the first time the runner touches the run. */
  function logOf(runId: string): RunLog {
    let run = runs.get(runId);
    if (!run) {
      run = { runId, wave: null, archetypeName: names.get(runId) ?? runId, personaName: null, briefing: null, claimedAt: null, wallMs: null, result: null, statuses: [], turns: [], aborts: [] };
      runs.set(runId, run);
    }
    return run;
  }

  /** The run's time so far: from its claim to the last answer it got. */
  function touched(run: RunLog) {
    if (run.claimedAt) run.wallMs = Date.now() - Date.parse(run.claimedAt);
  }

  /** The runner's API: the real client, recording every claim, turn post, poll, abort and wave, and saving each screenshot. */
  const recordingApi: RunnerDeps['api'] = {
    async getRuns(id: string) {
      const listed = await client.getRuns<StudyRuns>(id);
      for (const row of listed.runs) names.set(row.runId, row.archetypeName);
      return listed;
    },
    async claimRun(runId: string, body: ClaimBody) {
      claims.push({ runId, body });
      const run = logOf(runId);
      run.claimedAt = new Date().toISOString();
      const briefing = await client.claimRun(runId, body);
      run.personaName = briefing.persona?.name ?? null;
      run.briefing = briefing;
      return briefing;
    },
    commitFlowMap: (id, body) => client.commitFlowMap(id, body),
    getFlowBuild: (id, buildId) => client.getFlowBuild(id, buildId),
    getFlowMap: (id, version) => client.getFlowMap(id, version),
    async nextWave(id: string) {
      const at = new Date().toISOString();
      try {
        const answer = await client.nextWave(id);
        waves.push({ at, answer, error: null });
        if (!answer.done) for (const row of answer.runs) names.set(row.runId, row.archetypeName);
        return answer;
      } catch (err) {
        waves.push({ at, answer: null, error: err instanceof ApiError ? err.code : String(err) });
        throw err;
      }
    },
    async postTurn(runId: string, body: TurnBody, options?: { timeoutMs?: number }) {
      const run = logOf(runId);
      let record = run.turns.find((t) => t.turn === body.turn);
      const bytes = fromBase64(body.screenshot_b64);
      screenshots.push({ bytes: bytes.length, jpeg: bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff });
      if (!record) {
        const file = `${slug(run.archetypeName) || run.runId}/turn-${String(body.turn).padStart(2, '0')}.jpg`;
        saveFile(folder, file, bytes);
        record = {
          turn: body.turn,
          posts: [],
          screen: body.screen,
          screenshot: { file, bytes: bytes.length },
          elements: body.elements.map((e) => ({ id: e.id, label: e.label, role: e.role })),
          visibleText: body.visible_text_excerpt,
          last: body.last,
          flags: body.flags,
          polls: 0,
          decided: null,
          decideMs: null,
        };
        run.turns.push(record);
      }
      const at = Date.now();
      const post = { at: new Date(at).toISOString(), ms: 0, status: null as number | null, code: null as string | null, message: null as string | null };
      record.posts.push(post);
      try {
        const view = await client.postTurn(runId, body, options);
        post.ms = Date.now() - at;
        post.status = 202;
        if (view.status !== 'thinking') {
          record.decided = view;
          record.decideMs = Date.now() - at;
        }
        return view;
      } catch (err) {
        post.ms = Date.now() - at;
        if (err instanceof ApiError) {
          Object.assign(post, { status: err.status, code: err.code, message: err.message });
          if (REFUSED.has(err.status)) refusals.push({ runId, turn: body.turn, status: err.status, code: err.code, message: err.message });
        }
        throw err;
      } finally {
        touched(run);
      }
    },
    async getTurn(runId: string, turn: number) {
      const run = logOf(runId);
      const view = await client.getTurn(runId, turn);
      const record = run.turns.find((t) => t.turn === turn);
      if (record) {
        record.polls += 1;
        if (view.status !== 'thinking' && !record.decided) {
          record.decided = view;
          record.decideMs = Date.now() - Date.parse(record.posts[0]?.at as string);
        }
      }
      touched(run);
      return view;
    },
    async abortRun(runId: string, body: Parameters<ApiClient['abortRun']>[1]) {
      const run = logOf(runId);
      run.aborts.push({ code: body.code, detail: body.detail });
      const result = await client.abortRun(runId, body);
      touched(run);
      return result;
    },
  };

  function save() {
    const all = [...runs.values()];
    const decided = all.flatMap((r) => r.turns).filter((t) => t.decideMs !== null).map((t) => t.decideMs as number).sort((a, b) => a - b);
    const pct = (p: number) => (decided.length ? decided[Math.min(decided.length - 1, Math.floor(p * decided.length))] : null);
    log.totals = {
      runs: all.length,
      turns: all.reduce((n, r) => n + r.turns.length, 0),
      decideMs: { median: pct(0.5), p90: pct(0.9), max: last(decided) ?? null, mean: decided.length ? Math.round(decided.reduce((a, b) => a + b, 0) / decided.length) : null },
      screenshotBytes: { max: Math.max(0, ...screenshots.map((s) => s.bytes)), count: screenshots.length },
      wallMs: Date.now() - startedAt,
    };
    log.refusals = refusals;
    log.claims = claims;
    log.waves = waves;
    log.runs = all;
    saveFile(folder, 'log.json', JSON.stringify(log, null, 2));
    if (report) saveFile(folder, 'report.json', JSON.stringify(report, null, 2));
    if (state) saveFile(folder, 'state.json', JSON.stringify(state, null, 2));
  }

  /** The live server's log from where this run began, line by line: what it refused, and the model calls it retried. */
  let logFrom = 0;
  const serverLines = (): string[] => {
    if (!LIVE.serverLog) throw new Error('Set TRACE_LIVE_SERVER_LOG to the live server\'s log: the run reads its refusals and model retries there.');
    return readText(LIVE.serverLog).slice(logFrom).split('\n');
  };

  beforeAll(async () => {
    if (LIVE.serverLog) logFrom = readText(LIVE.serverLog).length;
    wireframer = openWireframer();
    fake = fakeFile();
    // Every export is a real JPEG of what the copies draw, read at export time.
    fake.world.exportImage = (node) => wireframer.draw(sceneOf(node));
    plugin = openPlugin(fake);
    client = new ApiClient({
      baseUrl: base,
      // The live server has no Auth0: its dev auth reads X-User-Id, before any token.
      getToken: () => 'live-dev-token',
      fetch: (input, init) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), 'X-User-Id': LIVE.user } }),
    });
    try {
      doc = await plugin.bridge.call('trace-read', { importLibraryVariants: true });
      before = snapshot(fake);

      // The study, as the panel creates a plugin-mode one: no share link.
      const created = await client.createStudy<{ studyId: string; execution: string; task: { url: string | null } }>({
        title: 'Farside billing: connect a bank account',
        icp: {
          label: 'Small business owners who do their own billing',
          description: 'Owners of small service businesses (one to ten people) who send invoices and pay bills themselves, between client work, without an accountant.',
        },
        task: { goal: 'Connect your business bank account to Farside, so invoices can be paid from it', url: null, preconditions: [] },
        success: {
          criterion: 'Reaches the "Bank connected" screen',
          checks: [{ type: 'frame_reached', value: GOAL, required: true, rationale: 'The prototype shows the goal frame' }],
        },
        context: {
          productDescription: 'Farside is invoicing and billing software for small businesses.',
          keyFeatures: ['Billing settings', 'Connect a bank account', 'Phone verification'],
        },
        // explore: one run per archetype in a single wave; 4 is the smallest budget.
        design: { mode: 'ofat_stress', archetypeBudget: 4, repeatPolicy: 'explore' },
        source: 'figma',
        execution: 'plugin',
        figma: { fileKey: null, startNodeId: START, targetNodeId: GOAL, flowName: null, pluginVersion: '0.1.0', fileName: fake.api.root.name, pageName: doc.pageName },
      });
      studyId = created.studyId;
      log.study = { studyId, execution: created.execution, taskUrl: created.task.url };
      let t = Date.now();
      log.factors = await client.identifyFactors(studyId);
      log.factorsMs = Date.now() - t;
      t = Date.now();
      log.archetypes = await client.buildArchetypes(studyId);
      log.archetypesMs = Date.now() - t;
      await client.startRuns(studyId);

      // The study runner, as the panel runs it: claim every queued run, play them side by side, next waves until done.
      const sessionsAt = Date.now();
      const result = await runStudy(
        // The doc was read just above, and nothing edits the fake file during the run.
        { studyId, owner: OWNER, read: { doc, changed: () => false }, shareKey: null, startFrameId: START, drawnOnly: false },
        {
          bridge: plugin.bridge,
          api: recordingApi,
          now: () => Date.now(),
          sleep,
          pluginVersion: '0.1.0',
          onSession: (status: SessionStatus) => {
            const run = logOf(status.runId);
            const line = `${status.phase} turn ${status.turn} on ${status.frameName}${status.notices.length ? ` (${status.notices.join(' | ')})` : ''}`;
            if (last(run.statuses) !== line) run.statuses.push(line);
          },
          onRunner: (status) => runner.push(status),
          watchFile: plugin.watchFile,
          readDoc: plugin.readDoc,
          postTurnTimeoutMs: POST_TURN_TIMEOUT_MS,
          signal: plugin.signal,
        },
      );
      log.sessionsMs = Date.now() - sessionsAt;
      log.runner = { stop: result.stop, reason: result.stop === 'done' ? result.reason : null, message: result.stop === 'stuck' ? result.message : null, statuses: runner };
      runnerResult = result;
      for (const session of result.sessions) logOf(session.runId).result = session;
      for (const row of (await client.getRuns<StudyRuns>(studyId)).runs) {
        const run = logOf(row.runId);
        run.wave = row.wave ?? null;
        run.archetypeName = row.archetypeName;
      }
      report = await client.getReport(studyId);
      state = await liveState(base);
      log.outcomes = testDocs().map((d) => {
        const results = (d.results ?? {}) as Doc;
        const feedback = (results.plugin_feedback ?? {}) as Doc;
        return {
          runId: d.test_id,
          archetypeName: runs.get(d.test_id as string)?.archetypeName,
          status: d.status,
          abortReason: results.abort_reason ?? null,
          path: runs.get(d.test_id as string)?.turns.map((t) => t.screen.title + (t.screen.overlays.length ? ` +${t.screen.overlays.join(',')}` : '')),
          outcome: results.outcome ?? null,
          verdict: feedback.verdict ?? null,
          summary: feedback.summary ?? null,
          personaReaction: feedback.personaReaction ?? null,
          findings: feedback.findings ?? [],
        };
      });
    } finally {
      save();
    }
  }, 40 * 60_000);

  afterAll(async () => {
    await wireframer?.close();
  });

  const testDocs = () => (state['Archetype_Test.test'] ?? []).filter((d) => runs.has(d.test_id as string));
  const stepsOf = (runId: string): Doc[] => {
    const test = testDocs().find((d) => d.test_id === runId);
    const session = (test?.test_meta as Doc | undefined)?.plugin_session_id;
    const logDoc = (state['Archetype_Test.session_log'] ?? []).find((d) => d.session_id === session);
    return [...((logDoc?.steps as Doc[] | undefined) ?? [])].sort((a, b) => (a.seq as number) - (b.seq as number));
  };

  it('runs the study to done through the runner, claiming every run once, in whole pixels', () => {
    expect(runnerResult).toMatchObject({ stop: 'done' });
    expect(runnerResult.sessions.map((s) => s.runId).sort()).toEqual([...runs.keys()].sort());
    expect(claims.map((c) => c.runId).sort()).toEqual([...runs.keys()].sort());
    for (const { body } of claims) {
      expect(body).toEqual({ owner: OWNER, browser: { engine: 'figma-trace', version: '0.1.0', viewport: [1280, 800] } });
    }
  });

  it('ends every run: completed, abandoned or aborted', () => {
    expect(runs.size).toBeGreaterThanOrEqual(3);
    for (const run of runs.values()) expect(run.result?.stop, run.runId).toMatch(/^(ended|aborted)$/);
    const statuses = testDocs().map((d) => [d.test_id, d.status]);
    expect(statuses).toHaveLength(runs.size);
    for (const [, status] of statuses) expect(TERMINAL.has(status as string)).toBe(true);
  });

  it('posts only turns the backend accepts, and no run aborts for a cause nobody explained', () => {
    expect(refusals).toEqual([]);
    for (const doc of testDocs()) {
      const reason = (doc.results as Doc | undefined)?.abort_reason as string | undefined;
      expect(UNEXPLAINED_ABORTS.has(reason ?? ''), `${doc.test_id as string} aborted: ${reason}`).toBe(false);
    }
    expect(plugin.failures).toEqual([]);
  });

  it('has the server refuse no turn post, and record why the model was asked again, never for a missing action_text', () => {
    const lines = serverLines();
    const ids = [...runs.keys()];
    const refused = lines.filter((l) => ids.some((id) => l.includes(`/api/plugin/runs/${id}/turn`)) && / HTTP\/1\.1"? (400|413) /.test(l.replace(/\x1b\[[0-9;]*m/g, '')));
    // Every model call after a turn's first is recorded with its reason
    // (an unusable answer's message, give_up_review or model_error), and so
    // is every debrief call after the first, on the turn that ended the run.
    const turns = (state['Archetype_Test.trace_turns'] ?? []).filter((t) => runs.has(t.run_id as string));
    const reasks: Array<{ runId: string; turn: number; attempt: number; call: string; reason: string }> = [];
    const unrecorded: Array<{ runId: string; turn: number; attempts: number; turnReasks: number }> = [];
    for (const t of turns) {
      const entries = ((t.reasks as Doc[] | undefined) ?? []).map((r) => ({
        runId: t.run_id as string, turn: t.turn as number, attempt: r.attempt as number, call: r.call as string, reason: r.reason as string,
      }));
      reasks.push(...entries);
      const turnReasks = entries.filter((r) => r.call === 'turn').length;
      if ((t.attempts as number) - 1 !== turnReasks) unrecorded.push({ runId: t.run_id as string, turn: t.turn as number, attempts: t.attempts as number, turnReasks });
    }
    const missingActionText = reasks.filter((r) => r.reason.startsWith('decide.action_text is required'));
    const logged = lines.filter((l) => / is asked again: /.test(l) && ids.some((id) => l.includes(`trace run ${id} `)));
    log.reasks = { turns: turns.length, reasks, missingActionText: missingActionText.length, loggedLines: logged.length };
    saveFile(folder, 'log.json', JSON.stringify(log, null, 2));
    expect(refused).toEqual([]);
    expect(turns.length).toBe([...runs.values()].reduce((n, r) => n + r.turns.length, 0));
    expect(unrecorded).toEqual([]);
    expect(logged).toHaveLength(reasks.length);
    expect(missingActionText).toEqual([]);
  });

  it('finalizes each run inside its last turn, as the eager server does', () => {
    for (const run of runs.values()) {
      const final = last(run.turns);
      // The first view the panel had of the run's last turn already holds how the run ended, not finalizing.
      expect((final?.decided as { ended?: { status: string } | null } | null)?.ended?.status, run.runId).toMatch(/^(completed|abandoned|aborted)$/);
    }
    expect(waves.filter((w) => w.error === 'wave_in_progress')).toEqual([]);
  });

  it('sends real JPEG screenshots within a turn\'s 1.5 MiB', () => {
    expect(screenshots.length).toBeGreaterThan(0);
    for (const shot of screenshots) expect(shot).toEqual({ bytes: expect.any(Number), jpeg: true });
    expect(Math.max(...screenshots.map((s) => s.bytes))).toBeLessThan(MAX_SCREENSHOT_BYTES);
  });

  it('records every step at a figma-trace:// URL, and shows the goal frame in every run scored completed', () => {
    for (const run of runs.values()) {
      for (const turn of run.turns) expect(turn.screen.url).toMatch(/^figma-trace:\/\//);
      const steps = stepsOf(run.runId);
      for (const step of steps) expect(step.url as string).toMatch(/^figma-trace:\/\//);
      const outcome = (testDocs().find((d) => d.test_id === run.runId)?.results as Doc | undefined)?.outcome as Doc | undefined;
      if (outcome?.completed !== true) continue;
      // A persona may go on past the goal before it says done (Bank
      // connected's Done leads back to the Dashboard): the check names the
      // step that showed it.
      const reached = (outcome.satisfied as Doc[]).find((c) => c.type === 'frame_reached');
      const step = steps.find((s) => s.seq === reached?.step);
      expect(nodeId(step?.url as string), run.runId).toBe(GOAL.replace(':', '-'));
      expect(run.turns.find((t) => t.turn === reached?.step)?.screen.frameId).toBe(GOAL);
    }
  });

  it('says in the report how the runs ran: inside the Figma panel, played by the trace brain', () => {
    const honesty = report.honesty as Doc;
    const browser = honesty.browser as Doc;
    expect(browser.sentence).toBe('Scored runs ran inside the Figma panel (figma-trace 0.1.0), 1280x800.');
    expect(browser.config).toEqual({ engine: 'figma-trace', version: '0.1.0', viewport: { width: 1280, height: 800 } });
    expect(browser.profile).toBeNull();
    expect((honesty.models as Doc).actor).toBe(ACTOR_MODEL);
    for (const test of testDocs()) expect((test.test_meta as Doc).actor_model, test.test_id as string).toBe(ACTOR_MODEL);
  });

  it('builds the report without falling back on its cluster review', () => {
    // A model that answered 504 is recorded in the log, not held against the run.
    const fallbacks = ((report.honesty as Doc).models as Doc).reportFallbacks as string[];
    log.reportFallbacks = fallbacks;
    expect(fallbacks.filter((f) => f.startsWith('cluster review'))).toEqual([]);
  });

  it('builds the report, counting every run that is not aborted', () => {
    const rows = report.runs as Array<{ runId: string; included: boolean; status: string }>;
    const scored = testDocs().filter((d) => d.status !== 'aborted').map((d) => d.test_id as string);
    expect(rows.filter((r) => r.included).map((r) => r.runId).sort()).toEqual([...scored].sort());
    expect(report.runsScored).toBe(scored.length);
    expect(report.runsPending).toBe(0);
  });

  /**
   * What the briefing tells the persona's brain: all of it but the success
   * criterion, which only scores the run, and the actor brief, which
   * restates the criterion and which the trace brain doesn't send.
   */
  function briefingTold(briefing: RunBriefing | null): string {
    if (!briefing) return '';
    const told = structuredClone(briefing) as unknown as Record<string, unknown> & { instructions: Record<string, unknown> };
    delete told.brief;
    delete told.instructions.success;
    return JSON.stringify(told);
  }

  /** What a persona said in its own words: each step's monologue, and its debrief. */
  function personaWords(runId: string): Array<{ where: string; text: string }> {
    const words = stepsOf(runId).map((step) => ({
      where: `step ${step.seq as number} monologue`,
      text: String((((step.protocol_v2 as Doc | undefined)?.decide as Doc | undefined)?.monologue as string | undefined) ?? ''),
    }));
    const results = (testDocs().find((d) => d.test_id === runId)?.results ?? {}) as Doc;
    const feedback = (results.plugin_feedback ?? {}) as Doc;
    words.push({ where: 'personaReaction', text: String(feedback.personaReaction ?? '') });
    words.push({ where: 'in_their_words', text: String(((results.outcome ?? {}) as Doc).in_their_words ?? '') });
    for (const [i, finding] of ((feedback.findings as Doc[] | undefined) ?? []).entries()) {
      words.push({ where: `finding ${i} description`, text: String(finding.description ?? '') });
      words.push({ where: `finding ${i} quote`, text: String(((finding.evidence ?? {}) as Doc).quote ?? '') });
    }
    return words.filter((w) => w.text);
  }

  it('gives each persona scenarios that name no frame', () => {
    const named: Array<{ runId: string; scenario: unknown; names: string[] }> = [];
    for (const run of runs.values()) {
      const screens = run.turns.flatMap((t) => [t.visibleText, ...t.elements.map((e) => e.label)]).join('\n');
      const { hidden } = hiddenFrameNames(fake, doc, screens);
      const scenarios = ((run.briefing as unknown as { instructions: { scenarios?: unknown[] } } | null)?.instructions.scenarios ?? []);
      expect(scenarios.length, run.runId).toBeGreaterThan(0);
      for (const scenario of scenarios) {
        const names = namesIn(JSON.stringify(scenario), hidden);
        if (names.length) named.push({ runId: run.runId, scenario, names });
      }
    }
    expect(named).toEqual([]);
  });

  it('never has a persona name a frame its screens did not show it', () => {
    const mentions: Array<{ runId: string; where: string; names: string[]; text: string }> = [];
    const checked: Record<string, { hidden: string[]; told: string[] }> = {};
    for (const run of runs.values()) {
      // Everything the run gave this persona: its briefing, and what its screens said and listed.
      const told = [briefingTold(run.briefing), ...run.turns.flatMap((t) => [t.visibleText, ...t.elements.map((e) => e.label)])].join('\n');
      const names = hiddenFrameNames(fake, doc, told);
      checked[run.runId] = names;
      for (const { where, text } of personaWords(run.runId)) {
        const found = namesIn(text, names.hidden);
        if (found.length) mentions.push({ runId: run.runId, where, names: found, text });
      }
    }
    log.frameNames = { checked, mentions };
    saveFile(folder, 'log.json', JSON.stringify(log, null, 2));
    expect(Object.keys(checked)).toHaveLength(runs.size);
    expect(mentions).toEqual([]);
  });

  it('never files the prototype\'s sample greeting as a wrong user name', () => {
    const wrong = testDocs().flatMap((test) => {
      const feedback = ((test.results as Doc | undefined)?.plugin_feedback ?? {}) as Doc;
      return ((feedback.findings as Doc[] | undefined) ?? []).filter((f) => readsGreetingAsWrongName(f)).map((f) => ({ runId: test.test_id, description: f.description }));
    });
    expect(wrong).toEqual([]);
  });

  it('cites, in each debrief finding, a step URL of that run', () => {
    for (const test of testDocs()) {
      const urls = new Set(stepsOf(test.test_id as string).map((s) => s.url as string));
      const feedback = (test.results as Doc | undefined)?.plugin_feedback as Doc | undefined;
      for (const finding of (feedback?.findings as Doc[] | undefined) ?? []) {
        expect(urls.has((finding.evidence as Doc).url as string), `${test.test_id as string}: ${JSON.stringify(finding)}`).toBe(true);
      }
    }
  });

  it('leaves the file as it was: no scratch container, every original node untouched', async () => {
    await plugin.settled();
    expect(scratchOn(fake)).toEqual([]);
    expect(plugin.main.removeLeftovers()).toBe(0);
    await tick();
    expectUntouched(fake, before);
    expect(plugin.posted.filter((m) => m.type === 'trace-file-changed')).toEqual([]);
  });
});
