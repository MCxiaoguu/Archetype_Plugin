import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanTurn, createMockBackend, serveMock, type MockBackend, type ScriptStep } from '../harness/mock-backend.mjs';
import { ApiClient, ApiError, type TurnBody } from '../src/lib/api';
import { indexFrames } from '../src/lib/frames';
import { runPreflight } from '../src/lib/preflight';
import { buildReportView, type StudyReport } from '../src/lib/report';
import { EMPTY_FORM, buildStudyRequest } from '../src/lib/study';
import { readDocument } from '../src/main/document';
import type { MainToUi, SavedSession } from '../src/lib/messages';
import { start } from '../src/lib/proto/engine';
import type { ProtoDoc } from '../src/lib/proto/model';
import type { RunnerStatus } from '../src/lib/runs';
import { heldContainers, SCRATCH_KEY, SCRATCH_VALUE } from '../src/main/scratch';
import { runStudy, WAVE_RETRY_MS, type DocRead, type RunnerResult } from '../src/ui/trace/runner';
import { NOTICE, runSession, type SessionResult, type SessionStatus } from '../src/ui/trace/session';
import type { FakeNode } from './fake-figma';
import { frame, protoDoc } from './trace-fixtures';
import { expectUntouched, fakeFile, openPlugin, scratchOn, snapshot, tick, type Fake, type Plugin } from './trace-plugin';

// A whole trace study in the plugin, in process: the real reader, renderer,
// engine, elements, bridge, main thread (trace.ts) and session, on the fake
// Farside page, against the mock backend's trace routes over HTTP. The mock
// follows the backend as built (services/trace_turn_service.py); its brain
// is a script per run that names what to do by label, as a persona reads it.

const OWNER = 'panel-e2e';
const STUDY = 'study-trace';

/** What the fake's export drew (its JPEG stand in), without the ids of the scratch copies, which each render makes anew. */
function picture(b64: string | undefined): unknown {
  if (b64 === undefined) throw new Error('No screenshot');
  const drawn = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))) as unknown;
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (!node || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) if (key !== 'id') out[key] = strip(value);
    return out;
  };
  return strip(drawn);
}

let mock: MockBackend;
let server: { url: string; close(): Promise<void> };
let client: ApiClient;

beforeAll(async () => {
  mock = createMockBackend({ thinkingPolls: 1 });
  server = await serveMock(mock);
  client = new ApiClient({ baseUrl: server.url, getToken: () => 'mock-token' });
});

afterAll(async () => {
  await server.close();
});

function claim(runId: string) {
  return client.claimRun(runId, { browser: { engine: 'figma-trace', version: '0.1.0', viewport: [1280, 800] }, owner: OWNER, flowMapVersion: null });
}

function persona(
  plugin: Plugin,
  doc: ProtoDoc,
  runId: string,
  opts: { startFrameId?: string; resume?: SavedSession | null; sleep?: (ms: number) => Promise<void>; statuses?: SessionStatus[] } = {},
): Promise<SessionResult> {
  return runSession(
    { runId, studyId: STUDY, owner: OWNER, doc, shareKey: null, startFrameId: opts.startFrameId ?? '1:2', resume: opts.resume ?? null, fileChanged: false, map: null },
    {
      bridge: plugin.bridge,
      api: client,
      now: () => Date.now(),
      sleep: opts.sleep ?? tick,
      onStatus: (status) => opts.statuses?.push(status),
      watchFile: plugin.watchFile,
      postTurnTimeoutMs: 10_000,
      signal: plugin.signal,
    },
  );
}

const postsOf = (runId: string) => mock.trace.posts.filter((p) => p.runId === runId);
const refusalsOf = (...runIds: string[]) => mock.trace.refusals.filter((r) => runIds.some((id) => r.path.includes(`/runs/${id}/`)));
const bodiesOf = (runId: string) => postsOf(runId).map((p) => p.body as unknown as TurnBody);

/** The connect-a-bank flow, with a misclick, the bank's sign in error and a scroll to Continue. */
const GOLDEN: ScriptStep[] = [
  { expect: 'Dashboard', click: 'Billing' },
  { expect: 'Billing settings', click: 'Connect a bank' },
  { expect: 'Connect bank', click: 'Use routing number instead' },
  { expect: 'Connect bank', click: 'Sign in with your bank' },
  { expect: 'Connect bank', click: 'Try again' },
  { expect: 'Connect bank', scroll: 'down' },
  { expect: 'Connect bank', click: 'Continue' },
  { expect: 'Verify phone', click: 'Send code' },
  { expect: 'Bank connected', done: 'The bank account is connected.' },
];

/** The unlabeled hotspot on the dashboard leads to Plans, which has nothing about banks. */
const PLANS: ScriptStep[] = [
  { expect: 'Dashboard', click: 'unlabeled area' },
  { expect: 'Plans', give_up: 'Plans only sells subscriptions; there is no way back to billing here.' },
];

describe('a trace study in the plugin', () => {
  let fake: Fake;
  let plugin: Plugin;
  let doc: ProtoDoc;
  let before: Map<string, unknown>;
  let results: { golden: SessionResult; plans: SessionResult; broken: SessionResult };
  const renders = { made: 0, overlapping: 0 };

  beforeAll(async () => {
    mock.trace.addStudy({
      studyId: STUDY,
      waves: [[
        { runId: 'run-golden', archetypeName: 'Mara', script: GOLDEN },
        { runId: 'run-plans', archetypeName: 'Dev', script: PLANS },
        { runId: 'run-broken', archetypeName: 'Ana', script: [{ click: 'Start' }] },
      ]],
    });
    fake = fakeFile();
    plugin = openPlugin(fake);
    doc = await plugin.bridge.call('trace-read', { importLibraryVariants: true });
    before = snapshot(fake);
    // The Old onboarding screen is too big to send: every render of it fails.
    fake.world.exportFails = (node) => (node.children.some((c) => c.name === 'Old onboarding') ? 'huge' : null);
    // Each render makes one scratch container; one already there means two renders overlap.
    const createFrame = fake.api.createFrame.getMockImplementation();
    if (!createFrame) throw new Error('The fake has no createFrame');
    fake.api.createFrame.mockImplementation(() => {
      renders.made += 1;
      renders.overlapping = Math.max(renders.overlapping, scratchOn(fake).length);
      return createFrame();
    });
    for (const runId of ['run-golden', 'run-plans', 'run-broken']) await claim(runId);
    // One panel, one bridge, three personas at once.
    const [golden, plans, broken] = await Promise.all([
      persona(plugin, doc, 'run-golden'),
      persona(plugin, doc, 'run-plans'),
      persona(plugin, doc, 'run-broken', { startFrameId: '4:1' }),
    ]);
    results = { golden, plans, broken };
  }, 30_000);

  it('reaches Bank connected on the golden path, with the step URL naming it', async () => {
    expect(results.golden).toEqual({ runId: 'run-golden', ended: { status: 'finalizing', reason: 'done' }, stop: 'ended', message: null });
    const bodies = bodiesOf('run-golden');
    expect(bodies.map((b) => b.turn)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(bodies.map((b) => b.screen.title)).toEqual([
      'Dashboard', 'Billing settings', 'Connect bank', 'Connect bank', 'Connect bank', 'Connect bank', 'Connect bank', 'Verify phone', 'Bank connected',
    ]);
    const final = bodies[8] as TurnBody;
    expect(final.screen).toMatchObject({ url: 'figma-trace://Prototype/2-50?node-id=2-50', frameId: '2:50', overlays: [] });
    expect(final.last).toMatchObject({ action: { type: 'click' }, outcome: 'navigated', target: expect.stringMatching(/^Send code \(e\d+\)$/) });
    // The debrief ends the run once the panel has stopped.
    expect(await client.getTurn('run-golden', 9)).toMatchObject({ status: 'ready', action: { type: 'done' }, ended: { status: 'completed', reason: 'done' } });
    expect(mock.trace.runs.get('run-golden')?.status).toBe('completed');
  });

  it('logs the misclick on Use routing number instead as nothing happening', () => {
    const [, , misclick, after] = bodiesOf('run-golden');
    expect(misclick?.elements.find((e) => e.label === 'Use routing number instead')).toBeDefined();
    expect(after?.last).toMatchObject({ outcome: 'nothing_happened', target: expect.stringMatching(/^Use routing number instead \(e\d+\)$/) });
    expect(after?.screen.frameId).toBe('2:20');
  });

  it('opens the bank sign in error over Connect bank, and Try again closes it', () => {
    const bodies = bodiesOf('run-golden');
    const opened = bodies[4] as TurnBody;
    expect(opened.last).toMatchObject({ outcome: 'opened_overlay', target: expect.stringMatching(/^Sign in with your bank/) });
    expect(opened.screen).toMatchObject({ frameId: '2:20', overlays: ['3:1'], url: 'figma-trace://Prototype/2-20?node-id=2-20&overlay=3-1' });
    expect(opened.elements.map((e) => e.label)).toContain('Try again');
    const closed = bodies[5] as TurnBody;
    expect(closed.last).toMatchObject({ outcome: 'closed_overlay', target: expect.stringMatching(/^Try again/) });
    expect(closed.screen.overlays).toEqual([]);
    // Continue sits below the fold until the scroll.
    expect(closed.elements.map((e) => e.label)).not.toContain('Continue');
    const scrolled = bodies[6] as TurnBody;
    expect(scrolled.last).toMatchObject({ action: { type: 'scroll', direction: 'down' }, outcome: 'scrolled' });
    expect(scrolled.screen.scroll.y).toBeGreaterThan(0);
    expect(scrolled.elements.map((e) => e.label)).toContain('Continue');
  });

  it('gives up on Plans, a dead end', async () => {
    expect(results.plans).toEqual({ runId: 'run-plans', ended: { status: 'finalizing', reason: 'give_up' }, stop: 'ended', message: null });
    expect(bodiesOf('run-plans').map((b) => [b.screen.title, b.last?.outcome ?? null])).toEqual([['Dashboard', null], ['Plans', 'navigated']]);
    expect(await client.getTurn('run-plans', 2)).toMatchObject({ action: { type: 'give_up' }, ended: { status: 'abandoned', reason: 'give_up' } });
  });

  it('aborts only the run whose screen fails to render', () => {
    expect(results.broken).toMatchObject({ runId: 'run-broken', ended: { status: 'aborted', reason: 'render_failed' }, stop: 'aborted' });
    expect(results.broken.message).toMatch(/over the 1\.5 MiB a turn can carry/);
    expect(postsOf('run-broken')).toEqual([]);
    expect(mock.trace.runs.get('run-broken')).toMatchObject({ status: 'aborted', abortReason: 'render_failed' });
    expect(mock.trace.runs.get('run-golden')?.abortReason).toBeNull();
    expect(mock.trace.runs.get('run-plans')?.abortReason).toBeNull();
  });

  it('keeps each persona on its own screens: no reply crossed to another session', () => {
    // The script checks every screen's title before it acts, so a render
    // meant for another persona would have failed the turn.
    for (const runId of ['run-golden', 'run-plans']) {
      for (const record of mock.trace.runs.get(runId)?.turnList() ?? []) expect(record.status).toBe('ready');
    }
    expect(new Set(mock.trace.posts.map((p) => (p.body as { owner: string }).owner))).toEqual(new Set([OWNER]));
    expect(plugin.failures).toEqual([]);
  });

  it('renders the three personas\' screens one at a time, through the main thread\'s one queue', () => {
    // Golden 9 renders, Plans 2, and the failing screen twice (one retry).
    expect(renders).toEqual({ made: 13, overlapping: 0 });
    expect(fake.api.skipInvisibleInstanceChildren).toBe(true);
  });

  it('sends only turn bodies the backend accepts', () => {
    expect(refusalsOf('run-golden', 'run-plans', 'run-broken')).toEqual([]);
    for (const post of mock.trace.posts) {
      expect(post.status).toBe(202);
      expect(() => cleanTurn(post.body)).not.toThrow();
    }
  });

  it('leaves the file as it was: no scratch container, every original node untouched, no change reported', async () => {
    expect(scratchOn(fake)).toEqual([]);
    expect(plugin.main.removeLeftovers()).toBe(0);
    // The fake's nodechange arrives in a later task.
    await tick();
    expectUntouched(fake, before);
    expect(plugin.posted.filter((m) => m.type === 'trace-file-changed')).toEqual([]);
    for (const body of mock.trace.posts.map((p) => p.body as unknown as TurnBody)) expect(body.flags).toEqual([]);
  });

});

describe('closing the plugin mid-run', () => {
  const RESUME = 'study-resume';

  it('resumes the owned run from the turn it saved', async () => {
    mock.trace.addStudy({
      studyId: RESUME,
      waves: [[{
        runId: 'run-resume',
        script: [
          { expect: 'Dashboard', click: 'Billing' },
          { expect: 'Billing settings', click: 'Connect a bank' },
          { expect: 'Connect bank', click: 'Sign in with your bank', hold: 'reopened' },
          { expect: 'Connect bank', click: 'Try again' },
          { expect: 'Connect bank', done: 'I would sign in with my bank once it works.' },
        ],
      }]],
    });
    const fake = fakeFile();
    const first = openPlugin(fake);
    const doc = await first.bridge.call('trace-read', { importLibraryVariants: true });
    const before = snapshot(fake);
    await claim('run-resume');
    // The designer closes the plugin while turn 3 is thinking.
    await expect(
      runSession(
        { runId: 'run-resume', studyId: RESUME, owner: OWNER, doc, shareKey: null, startFrameId: '1:2', resume: null, fileChanged: false, map: null },
        {
          bridge: first.bridge, api: client, now: () => Date.now(), onStatus: () => {}, watchFile: first.watchFile, signal: first.signal,
          sleep: closeWhen(first, () => !!mock.trace.runs.get('run-resume')?.turns.has(3)),
        },
      ),
    ).resolves.toMatchObject({ stop: 'cancelled', ended: null });
    expect(mock.trace.runs.get('run-resume')?.status).toBe('running');

    // Reopened: a new main thread and panel on the same file.
    const second = openPlugin(fake);
    expect(second.main.removeLeftovers()).toBe(0);
    const reread = await second.bridge.call('trace-read', { importLibraryVariants: true });
    expect(reread.docHash).toBe(doc.docHash);
    const { sessions } = await second.bridge.call('trace-load', { studyId: RESUME });
    expect(sessions).toHaveLength(1);
    const saved = sessions[0] as SavedSession;
    expect(saved).toMatchObject({ owner: OWNER, runId: 'run-resume', turn: 2, state: { frameId: '2:20' }, lastOutcome: { outcome: 'navigated' } });

    mock.trace.release('run-resume', 'reopened');
    const result = await runSession(
      { runId: 'run-resume', studyId: RESUME, owner: OWNER, doc: reread, shareKey: null, startFrameId: '1:2', resume: saved, fileChanged: false, map: null },
      { bridge: second.bridge, api: client, now: () => Date.now(), sleep: tick, onStatus: () => {}, watchFile: second.watchFile },
    );
    expect(result).toEqual({ runId: 'run-resume', ended: { status: 'finalizing', reason: 'done' }, stop: 'ended', message: null });

    // Turn 3 was posted again, as it was, and the backend kept the one it had.
    const posts = postsOf('run-resume');
    expect(posts.map((p) => p.turn)).toEqual([1, 2, 3, 3, 4, 5]);
    const [again, repost] = posts.filter((p) => p.turn === 3).map((p) => p.body as unknown as TurnBody);
    expect(repost?.screen).toEqual(again?.screen);
    expect(repost?.elements).toEqual(again?.elements);
    expect(repost?.last).toEqual(again?.last);
    expect(picture(repost?.screenshot_b64)).toEqual(picture(again?.screenshot_b64));
    expect(mock.trace.runs.get('run-resume')?.turnList().map((t) => [t.turn, t.status])).toEqual([[1, 'ready'], [2, 'ready'], [3, 'ready'], [4, 'ready'], [5, 'ready']]);
    // The resumed run went on from the sign in error the held turn opened.
    expect(bodiesOf('run-resume').slice(4).map((b) => [b.turn, b.screen.overlays, b.last?.outcome])).toEqual([[4, ['3:1'], 'opened_overlay'], [5, [], 'closed_overlay']]);
    expect(refusalsOf('run-resume')).toEqual([]);

    expect(await second.bridge.call('trace-load', { studyId: RESUME })).toEqual({ sessions: [] });
    await tick();
    expect(scratchOn(fake)).toEqual([]);
    expectUntouched(fake, before);
    expect([...first.failures, ...second.failures]).toEqual([]);
  }, 30_000);
});

/** A sleep that closes the plugin once `when` holds: the sessions stop mid-turn, as a closing panel's do. */
const closeWhen = (plugin: Plugin, when: () => boolean) => async () => {
  if (when()) plugin.close();
  await tick();
};

describe('closing the plugin mid-render', () => {
  it('stops the session without a retry or an abort, and the close handler removes the container the render held', async () => {
    mock.trace.addStudy({ studyId: 'study-close-render', waves: [[{ runId: 'run-close-render', script: GOLDEN }]] });
    const fake = fakeFile();
    const plugin = openPlugin(fake);
    const doc = await plugin.bridge.call('trace-read', { importLibraryVariants: true });
    const before = snapshot(fake);
    await claim('run-close-render');
    // The designer closes the plugin while turn 1's screen is being exported.
    let held: FrameNode[] = [];
    let goneAtClose = false;
    fake.world.exportFails = () => {
      held = [...heldContainers()];
      plugin.close();
      goneAtClose = held.every((n) => n.removed);
      return null;
    };
    const result = await persona(plugin, doc, 'run-close-render');

    expect(result).toEqual({ runId: 'run-close-render', ended: null, stop: 'cancelled', message: null });
    // The close handler removed the container the render was drawing in, there and then.
    expect(held).toHaveLength(1);
    expect(goneAtClose).toBe(true);
    expect(plugin.sent.filter((type) => type === 'trace-render')).toHaveLength(1);
    expect(postsOf('run-close-render')).toEqual([]);
    expect(refusalsOf('run-close-render')).toEqual([]);
    expect(mock.trace.runs.get('run-close-render')).toMatchObject({ status: 'running', abortReason: null });
    // The render the close interrupted ends on the fake (Figma's would stop): nothing it held or made stays.
    await plugin.settled();
    await tick();
    expect(heldContainers().size).toBe(0);
    expect(fake.world.log?.filter((line) => line === `remove ${held[0]?.id}`)).toHaveLength(1);
    expect(scratchOn(fake)).toEqual([]);
    expect(snapshot(fake)).toEqual(before);
    expect(plugin.failures).toEqual([]);
  }, 30_000);
});

describe('a wave whose sessions save at once', () => {
  // Review C1: trace-save reads, changes and writes one key per study, so two
  // saves reaching the main thread together must not keep only one session.
  it('keeps every session, so each run resumes after the plugin closes', async () => {
    const script: ScriptStep[] = [
      { expect: 'Dashboard', click: 'Billing' },
      { expect: 'Billing settings', click: 'Connect a bank', hold: 'reopened' },
      { expect: 'Connect bank', done: 'The bank page is where I connect it.' },
    ];
    mock.trace.addStudy({ studyId: 'study-together', waves: [[{ runId: 'run-a', script }, { runId: 'run-b', script }]] });
    const fake = fakeFile();
    const first = openPlugin(fake);
    const doc = await first.bridge.call('trace-read', { importLibraryVariants: true });
    for (const runId of ['run-a', 'run-b']) await claim(runId);
    // Both personas' turn 1 saves reach the main thread in one task.
    first.holdSaves(2);
    // The plugin closes once both are thinking about turn 2, so no render is under way.
    const closing = (runId: string) => closeWhen(first, () => ['run-a', 'run-b'].every((id) => mock.trace.runs.get(id)?.turns.has(2)));
    const started = ['run-a', 'run-b'].map((runId) =>
      runSession(
        { runId, studyId: 'study-together', owner: OWNER, doc, shareKey: null, startFrameId: '1:2', resume: null, fileChanged: false, map: null },
        { bridge: first.bridge, api: client, now: () => Date.now(), sleep: closing(runId), onStatus: () => {}, watchFile: first.watchFile, signal: first.signal },
      ),
    );
    for (const session of started) await expect(session).resolves.toMatchObject({ stop: 'cancelled' });

    const second = openPlugin(fake);
    const reread = await second.bridge.call('trace-read', { importLibraryVariants: true });
    const { sessions } = await second.bridge.call('trace-load', { studyId: 'study-together' });
    expect(sessions.map((s) => [s.runId, s.turn]).sort()).toEqual([['run-a', 1], ['run-b', 1]]);
    for (const runId of ['run-a', 'run-b']) mock.trace.release(runId, 'reopened');
    const results = await Promise.all(sessions.map((saved) =>
      runSession(
        { runId: saved.runId, studyId: 'study-together', owner: OWNER, doc: reread, shareKey: null, startFrameId: '1:2', resume: saved, fileChanged: false, map: null },
        { bridge: second.bridge, api: client, now: () => Date.now(), sleep: tick, onStatus: () => {}, watchFile: second.watchFile },
      )));
    expect(results.map((r) => r.ended)).toEqual([{ status: 'finalizing', reason: 'done' }, { status: 'finalizing', reason: 'done' }]);
    expect(await second.bridge.call('trace-load', { studyId: 'study-together' })).toEqual({ sessions: [] });
    expect([...first.failures, ...second.failures]).toEqual([]);
  }, 30_000);
});

describe('a backend ahead of the saved session', () => {
  it('catches up through the turns the backend holds, posting none of them twice out of order', async () => {
    mock.trace.addStudy({
      studyId: 'study-ahead',
      waves: [[{
        runId: 'run-ahead',
        script: [
          { expect: 'Dashboard', click: 'Billing' },
          { expect: 'Billing settings', click: 'Connect a bank' },
          { expect: 'Connect bank', click: 'Use routing number instead' },
          { expect: 'Connect bank', click: 'Sign in with your bank', hold: 'reopened' },
          { expect: 'Connect bank', click: 'Try again' },
          { expect: 'Connect bank', done: 'I would sign in with my bank once it works.' },
        ],
      }]],
    });
    const fake = fakeFile();
    // The save after turn 3 fails, both tries: this machine only knows turn 2.
    const setAsync = fake.api.clientStorage.setAsync;
    const store = setAsync.getMockImplementation();
    if (!store) throw new Error('The fake clientStorage has no setAsync');
    let writes = 0;
    setAsync.mockImplementation(async (key: string, value: unknown) => {
      writes += 1;
      if (writes === 3 || writes === 4) throw new Error('The storage quota is full');
      return store(key, value);
    });
    const first = openPlugin(fake);
    const doc = await first.bridge.call('trace-read', { importLibraryVariants: true });
    await claim('run-ahead');
    const statuses: SessionStatus[] = [];
    await expect(
      runSession(
        { runId: 'run-ahead', studyId: 'study-ahead', owner: OWNER, doc, shareKey: null, startFrameId: '1:2', resume: null, fileChanged: false, map: null },
        {
          bridge: first.bridge, api: client, now: () => Date.now(), onStatus: (st) => statuses.push(st), watchFile: first.watchFile, signal: first.signal,
          sleep: closeWhen(first, () => !!mock.trace.runs.get('run-ahead')?.turns.has(4)),
        },
      ),
    ).resolves.toMatchObject({ stop: 'cancelled' });
    expect(statuses[statuses.length - 1]?.notices).toContain(`${NOTICE.notSaved} The storage quota is full`);

    const second = openPlugin(fake);
    const reread = await second.bridge.call('trace-read', { importLibraryVariants: true });
    const { sessions } = await second.bridge.call('trace-load', { studyId: 'study-ahead' });
    expect(sessions.map((s) => s.turn)).toEqual([2]);
    mock.trace.release('run-ahead', 'reopened');
    const result = await runSession(
      { runId: 'run-ahead', studyId: 'study-ahead', owner: OWNER, doc: reread, shareKey: null, startFrameId: '1:2', resume: sessions[0] as SavedSession, fileChanged: false, map: null },
      { bridge: second.bridge, api: client, now: () => Date.now(), sleep: tick, onStatus: () => {}, watchFile: second.watchFile },
    );
    expect(result).toEqual({ runId: 'run-ahead', ended: { status: 'finalizing', reason: 'done' }, stop: 'ended', message: null });

    // Turn 3 was the backend's already: it said so with expected 4, and the panel read it instead.
    expect(refusalsOf('run-ahead').map((r) => [r.status, r.error, (r.body as { turn: number }).turn])).toEqual([[409, 'turn_out_of_order', 3]]);
    expect(refusalsOf('run-ahead')[0]?.message).toMatch(/this run takes turn 4 next/);
    // Turn 4 was posted again, unchanged, and the backend kept the one it had.
    const posts = postsOf('run-ahead');
    expect(posts.map((p) => p.turn)).toEqual([1, 2, 3, 4, 4, 5, 6]);
    const [again, repost] = posts.filter((p) => p.turn === 4).map((p) => p.body as unknown as TurnBody);
    expect(repost?.last).toEqual(again?.last);
    expect(repost?.elements).toEqual(again?.elements);
    expect(repost?.screen).toEqual(again?.screen);
    expect(mock.trace.runs.get('run-ahead')?.turnList().map((t) => t.status)).toEqual(['ready', 'ready', 'ready', 'ready', 'ready', 'ready']);
    expect([...first.failures, ...second.failures]).toEqual([]);
  }, 30_000);
});

describe('the finalizing window', () => {
  it('stops the session at finalizing, refuses aborts, turns and the next wave until the debrief ends the run', async () => {
    mock.trace.addStudy({
      studyId: 'study-final',
      waves: [[{ runId: 'run-final', script: [{ expect: 'Dashboard', click: 'Billing' }, { expect: 'Billing settings', done: 'Billing is where banks go.', debrief: 'debrief' }] }]],
    });
    const fake = fakeFile();
    const plugin = openPlugin(fake);
    const doc = await plugin.bridge.call('trace-read', { importLibraryVariants: true });
    await claim('run-final');
    const result = await persona(plugin, doc, 'run-final');
    expect(result).toEqual({ runId: 'run-final', ended: { status: 'finalizing', reason: 'done' }, stop: 'ended', message: null });
    // The session ended on the backend's word: it saved nothing more and aborted nothing.
    expect(await plugin.bridge.call('trace-load', { studyId: 'study-final' })).toEqual({ sessions: [] });
    expect(mock.trace.runs.get('run-final')).toMatchObject({ status: 'running', abortReason: null });

    // The decider has marked the run finalizing; the debrief is still running.
    const last = bodiesOf('run-final')[1] as TurnBody;
    expect(await client.postTurn('run-final', last)).toMatchObject({ turn: 2, status: 'ready', ended: { status: 'finalizing', reason: 'done' } });
    const ended = await client.postTurn('run-final', { ...last, turn: 3 }).then(() => null, (err: unknown) => err);
    expect(ended).toMatchObject({ status: 409, code: 'run_ended', message: expect.stringMatching(/is finalizing/) });
    const abort = await client.abortRun('run-final', { owner: OWNER, code: 'render_failed', detail: 'late' }).then(() => null, (err: unknown) => err);
    expect(abort).toMatchObject({ status: 409, code: 'run_ended' });
    const wave = await client.nextWave('study-final').then(() => null, (err: unknown) => err);
    expect(wave).toMatchObject({ status: 409, code: 'wave_in_progress' });

    mock.trace.release('run-final', 'debrief');
    expect(await client.getTurn('run-final', 2)).toMatchObject({ status: 'ready', action: { type: 'done' }, ended: { status: 'completed', reason: 'done' } });
    expect(await client.nextWave('study-final')).toMatchObject({ studyId: 'study-final', done: true });
    expect(refusalsOf('run-final').map((r) => r.error)).toEqual(['run_ended', 'run_ended']);
  }, 30_000);
});

describe("the backend's bounds on a turn", () => {
  it('takes every turn of a frame whose name is longer than a turn carries, its title cut', async () => {
    mock.trace.addStudy({ studyId: 'study-long-name', waves: [[{ runId: 'run-long-name', script: [{ give_up: 'Too long to read.' }] }]] });
    const fake = fakeFile();
    const long = `Dashboard ${'for the whole finance team '.repeat(15)}`;
    (fake.nodes.get('1:2') as FakeNode).name = long;
    const plugin = openPlugin(fake);
    const doc = await plugin.bridge.call('trace-read', { importLibraryVariants: true });
    await claim('run-long-name');
    expect(await persona(plugin, doc, 'run-long-name')).toMatchObject({ stop: 'ended', ended: { status: 'finalizing', reason: 'give_up' } });
    expect(refusalsOf('run-long-name')).toEqual([]);
    const title = bodiesOf('run-long-name')[0]?.screen.title ?? '';
    expect([...title].length).toBeLessThanOrEqual(300);
    expect(title.endsWith('…')).toBe(true);
  }, 30_000);

  it('stops, aborting nothing itself, when the decider crashed on a turn', async () => {
    mock.trace.addStudy({ studyId: 'study-crash', waves: [[{ runId: 'run-crash', script: [{ expect: 'Dashboard', fail: 'decider_error' }] }]] });
    const fake = fakeFile();
    const plugin = openPlugin(fake);
    const doc = await plugin.bridge.call('trace-read', { importLibraryVariants: true });
    await claim('run-crash');
    const result = await persona(plugin, doc, 'run-crash');
    expect(result).toMatchObject({ stop: 'ended', ended: { status: 'aborted', reason: 'decider_error' }, message: expect.stringMatching(/decider_error/) });
    expect(mock.trace.runs.get('run-crash')).toMatchObject({ status: 'aborted', abortReason: 'decider_error' });
    // The panel sent no abort of its own: the backend had ended the run.
    expect(refusalsOf('run-crash')).toEqual([]);
    expect(await plugin.bridge.call('trace-load', { studyId: 'study-crash' })).toEqual({ sessions: [] });
  }, 30_000);
});

describe('a timer that opens a link', () => {
  /** The golden path, with Bank connected opening `url` a second after it shows. Returns the last turn's body. */
  async function linkOnBankConnected(runId: string, url: string): Promise<TurnBody> {
    mock.trace.addStudy({ studyId: `study-${runId}`, waves: [[{ runId, script: GOLDEN }]] });
    const fake = fakeFile();
    (fake.nodes.get('2:50') as FakeNode).reactions = [{ trigger: { type: 'AFTER_TIMEOUT', timeout: 1000 }, actions: [{ type: 'URL', url }] }];
    const plugin = openPlugin(fake);
    const doc = await plugin.bridge.call('trace-read', { importLibraryVariants: true });
    await claim(runId);
    const result = await persona(plugin, doc, runId);
    expect(refusalsOf(runId)).toEqual([]);
    expect(result).toEqual({ runId, ended: { status: 'finalizing', reason: 'done' }, stop: 'ended', message: null });
    const final = bodiesOf(runId)[8] as TurnBody;
    expect(final.screen.title).toBe('Bank connected');
    return final;
  }

  it('with no URL does nothing, and the turn after it is taken', async () => {
    // The link was never filled in. The backend refused the turn when this
    // became a timer effect with an empty detail (it needs 1 to 200 characters).
    const final = await linkOnBankConnected('run-no-url', '');
    expect(final.last).not.toHaveProperty('timer_effects');
  }, 30_000);

  it('with a 300 character URL reports it within the 200 characters a detail may have', async () => {
    const url = `https://status.example.com/${'a'.repeat(300 - 27)}`;
    expect(url).toHaveLength(300);
    const final = await linkOnBankConnected('run-long-url', url);
    const [effect, ...more] = final.last?.timer_effects ?? [];
    expect(more).toEqual([]);
    expect(effect?.type).toBe('left_prototype');
    expect(effect?.detail.length).toBeLessThanOrEqual(200);
    // However the session marks the cut, the detail starts as the URL does.
    expect(url.startsWith((effect?.detail ?? '').slice(0, 150))).toBe(true);
  }, 30_000);
});

// --- Whole studies through the runner ----------------------------------------

/** The panel's clock for the runner: it moves only when the panel waits, so polls and wave retries take no real time. */
function panelClock() {
  let at = Date.now();
  const waits: number[] = [];
  return {
    waits,
    now: () => at,
    sleep: async (ms: number) => {
      waits.push(ms);
      at += ms;
      await tick();
    },
  };
}

function study(
  plugin: Plugin,
  doc: ProtoDoc,
  studyId: string,
  opts: { sleep?: (ms: number) => Promise<void>; runner?: RunnerStatus[]; read?: DocRead; drawnOnly?: boolean } = {},
): Promise<RunnerResult> {
  const clock = panelClock();
  return runStudy(
    { studyId, owner: OWNER, read: opts.read ?? { doc, changed: () => false }, shareKey: null, startFrameId: '1:2', drawnOnly: opts.drawnOnly ?? false },
    {
      bridge: plugin.bridge,
      api: client,
      now: clock.now,
      sleep: opts.sleep ?? clock.sleep,
      pluginVersion: '0.1.0',
      onSession: () => {},
      onRunner: (status) => opts.runner?.push(status),
      watchFile: plugin.watchFile,
      readDoc: plugin.readDoc,
      postTurnTimeoutMs: 10_000,
      signal: plugin.signal,
    },
  );
}

/**
 * The designer renames the Dashboard and adds a layer to it: the rename is
 * what a read of the prototype now says, the new layer what the main
 * thread's watcher reports. Resolves once the panel has heard of it.
 */
async function editDashboard(fake: Fake, plugin: Plugin) {
  const dashboard = fake.nodes.get('1:2') as FakeNode;
  dashboard.name = 'Home';
  dashboard.appendChild(fake.api.createRectangle() as unknown as FakeNode);
  const heard = plugin.posted.filter((m) => m.type === 'trace-file-changed').length;
  for (let i = 0; i < 50 && plugin.posted.filter((m) => m.type === 'trace-file-changed').length === heard; i++) await tick();
  if (plugin.posted.filter((m) => m.type === 'trace-file-changed').length === heard) throw new Error('The main thread never reported the edit');
  await tick();
}

/** A scratch container a crashed render left on the page, as the renderer marks it. */
function leftover(fake: Fake): FakeNode {
  const node = fake.api.createFrame() as unknown as FakeNode;
  node.setPluginData(SCRATCH_KEY, SCRATCH_VALUE);
  node.locked = true;
  return node;
}

const cleanups = (plugin: Plugin) =>
  plugin.posted.filter((m): m is Extract<MainToUi, { type: 'trace-result' }> => m.type === 'trace-result' && !!m.result && typeof m.result === 'object' && 'removed' in m.result).map((m) => m.result);

describe('a whole study through the runner', () => {
  it('claims a wave of three personas under this panel, runs them side by side to done, and cleans up', async () => {
    const SIGN_IN: ScriptStep[] = [
      { expect: 'Dashboard', click: 'Billing' },
      { expect: 'Billing settings', click: 'Connect a bank' },
      { expect: 'Connect bank', click: 'Sign in with your bank' },
      { expect: 'Connect bank', give_up: 'Signing in with my bank fails every time.' },
    ];
    mock.trace.addStudy({
      studyId: 'study-runner',
      waves: [[
        { runId: 'run-r-golden', archetypeName: 'Mara', script: GOLDEN },
        { runId: 'run-r-plans', archetypeName: 'Dev', script: PLANS },
        { runId: 'run-r-signin', archetypeName: 'Ana', script: SIGN_IN },
      ]],
    });
    const fake = fakeFile();
    const plugin = openPlugin(fake);
    const doc = await plugin.bridge.call('trace-read', { importLibraryVariants: true });
    const before = snapshot(fake);
    leftover(fake);
    const runner: RunnerStatus[] = [];
    const result = await study(plugin, doc, 'study-runner', { runner });

    expect(result).toMatchObject({ stop: 'done', reason: expect.any(String) });
    expect(result.sessions.map((r) => [r.runId, r.ended]).sort()).toEqual([
      ['run-r-golden', { status: 'finalizing', reason: 'done' }],
      ['run-r-plans', { status: 'finalizing', reason: 'give_up' }],
      ['run-r-signin', { status: 'finalizing', reason: 'give_up' }],
    ]);
    for (const runId of ['run-r-golden', 'run-r-plans', 'run-r-signin']) {
      expect(mock.trace.runs.get(runId)).toMatchObject({ owner: OWNER, browser: { engine: 'figma-trace', version: '0.1.0', viewport: [1280, 800] } });
    }
    expect(['run-r-golden', 'run-r-plans', 'run-r-signin'].map((id) => mock.trace.runs.get(id)?.status)).toEqual(['completed', 'abandoned', 'abandoned']);
    expect(bodiesOf('run-r-golden').map((b) => b.screen.title).pop()).toBe('Bank connected');
    expect(refusalsOf('run-r-golden', 'run-r-plans', 'run-r-signin')).toEqual([]);
    expect(runner.map((r) => r.phase)).toEqual(['running', 'next_wave', 'done']);

    // The cleanup after the wave took what a crash had left, and the renders left nothing.
    expect(cleanups(plugin)).toEqual([{ removed: 1 }]);
    await tick();
    expect(scratchOn(fake)).toEqual([]);
    expectUntouched(fake, before);
    expect(plugin.failures).toEqual([]);
  }, 30_000);

  // Review C1: two runs that end together each forget themselves from the
  // study's sessions; the save written last must not bring the other back.
  it('forgets every run on this machine once the study is done, also runs that end at once', async () => {
    const quick = (reason: string): ScriptStep[] => [{ expect: 'Dashboard', click: 'Billing' }, { expect: 'Billing settings', give_up: reason }];
    mock.trace.addStudy({ studyId: 'study-runner-forget', waves: [[{ runId: 'run-f-one', script: quick('Nothing about banks.') }, { runId: 'run-f-two', script: quick('No bank here.') }]] });
    const fake = fakeFile();
    const plugin = openPlugin(fake);
    const doc = await plugin.bridge.call('trace-read', { importLibraryVariants: true });
    // Their saves of where they stand arrive one by one; the two last ones, which forget them, together.
    plugin.serialSaves();
    plugin.holdSaves(2, (msg) => msg.type === 'trace-save' && msg.session === null);
    const result = await study(plugin, doc, 'study-runner-forget');
    expect(result.sessions.map((r) => r.ended?.reason)).toEqual(['give_up', 'give_up']);
    expect(await plugin.bridge.call('trace-load', { studyId: 'study-runner-forget' })).toEqual({ sessions: [] });
  }, 30_000);

  it('waits out a wave that is still finalizing, runs the next wave, then stops at done', async () => {
    mock.trace.addStudy({
      studyId: 'study-runner-waves',
      waves: [
        [{ runId: 'run-w-first', script: [{ expect: 'Dashboard', click: 'Billing' }, { expect: 'Billing settings', done: 'Billing it is.', debrief: 'debrief' }] }],
        [{ runId: 'run-w-second', repeatIndex: 1, script: PLANS }],
      ],
    });
    const fake = fakeFile();
    const plugin = openPlugin(fake);
    const doc = await plugin.bridge.call('trace-read', { importLibraryVariants: true });
    const clock = panelClock();
    // The debrief of wave 1 ends after the runner's second wait for it.
    const sleep = async (ms: number) => {
      if (ms === WAVE_RETRY_MS && clock.waits.filter((w) => w === WAVE_RETRY_MS).length === 1) mock.trace.release('run-w-first', 'debrief');
      await clock.sleep(ms);
    };
    const runner: RunnerStatus[] = [];
    const result = await study(plugin, doc, 'study-runner-waves', { sleep, runner });

    expect(result).toEqual({
      stop: 'done',
      reason: 'at most 2 waves run per study',
      sessions: [
        { runId: 'run-w-first', ended: { status: 'finalizing', reason: 'done' }, stop: 'ended', message: null },
        { runId: 'run-w-second', ended: { status: 'finalizing', reason: 'give_up' }, stop: 'ended', message: null },
      ],
    });
    expect(clock.waits.filter((w) => w === WAVE_RETRY_MS)).toHaveLength(2);
    const nexts = mock.trace.refusals.filter((r) => r.path === '/api/studies/study-runner-waves/runs/next');
    expect(nexts.map((r) => [r.status, r.error])).toEqual([[409, 'wave_in_progress'], [409, 'wave_in_progress']]);
    expect(mock.trace.runs.get('run-w-first')?.status).toBe('completed');
    expect(mock.trace.runs.get('run-w-second')).toMatchObject({ wave: 2, owner: OWNER, status: 'abandoned' });
    expect(runner.map((r) => r.phase)).toEqual(['running', 'next_wave', 'running', 'next_wave', 'done']);
    expect(cleanups(plugin)).toEqual([{ removed: 0 }, { removed: 0 }]);
  }, 30_000);

  it('leaves a run another panel claimed to that panel, and its saved session too', async () => {
    mock.trace.addStudy({
      studyId: 'study-shared',
      waves: [[
        { runId: 'run-mine', script: PLANS },
        { runId: 'run-theirs', script: GOLDEN },
      ]],
    });
    await client.claimRun('run-theirs', { browser: { engine: 'figma-trace', version: '0.1.0', viewport: [1280, 800] }, owner: 'panel-other', flowMapVersion: null });
    const fake = fakeFile();
    const plugin = openPlugin(fake);
    const doc = await plugin.bridge.call('trace-read', { importLibraryVariants: true });
    // An earlier panel on this machine, with another owner id, saved where its run stood.
    const theirs: SavedSession = {
      owner: 'panel-other',
      runId: 'run-theirs',
      turn: 1,
      state: start(doc, '1:2'),
      lastOutcome: null,
      timerEffects: [],
      loopFrames: [],
      flowMapVersion: null,
      version: 2,
    };
    await plugin.bridge.call('trace-save', { studyId: 'study-shared', runId: 'run-theirs', session: theirs });
    const clock = panelClock();
    // The wave waits for the other panel's run, which that panel then aborts.
    const sleep = async (ms: number) => {
      if (ms === WAVE_RETRY_MS && mock.trace.runs.get('run-theirs')?.status === 'running') {
        await client.abortRun('run-theirs', { owner: 'panel-other', code: 'panel_state_lost', detail: 'The other panel closed for good.' });
      }
      await clock.sleep(ms);
    };
    const result = await study(plugin, doc, 'study-shared', { sleep });

    expect(result).toMatchObject({ stop: 'done', sessions: [{ runId: 'run-mine', ended: { status: 'finalizing', reason: 'give_up' } }] });
    expect(postsOf('run-theirs')).toEqual([]);
    expect(refusalsOf('run-theirs')).toEqual([]);
    expect(mock.trace.runs.get('run-theirs')).toMatchObject({ owner: 'panel-other', status: 'aborted', abortReason: 'panel_state_lost' });
    expect(await plugin.bridge.call('trace-load', { studyId: 'study-shared' })).toEqual({ sessions: [theirs] });
  }, 30_000);

  it('resumes the run it owns when the plugin reopens, with a new main thread and bridge on the same file', async () => {
    mock.trace.addStudy({
      studyId: 'study-runner-resume',
      waves: [[{
        runId: 'run-rr',
        script: [
          { expect: 'Dashboard', click: 'Billing' },
          { expect: 'Billing settings', click: 'Connect a bank' },
          { expect: 'Connect bank', click: 'Sign in with your bank', hold: 'reopened' },
          { expect: 'Connect bank', click: 'Try again' },
          { expect: 'Connect bank', done: 'I would sign in with my bank once it works.' },
        ],
      }]],
    });
    const fake = fakeFile();
    const first = openPlugin(fake);
    const doc = await first.bridge.call('trace-read', { importLibraryVariants: true });
    const before = snapshot(fake);
    const clock = panelClock();
    const closing = async (ms: number) => {
      if (mock.trace.runs.get('run-rr')?.turns.has(3)) first.close();
      await clock.sleep(ms);
    };
    await expect(study(first, doc, 'study-runner-resume', { sleep: closing })).resolves.toMatchObject({ stop: 'cancelled', sessions: [{ runId: 'run-rr', stop: 'cancelled' }] });
    expect(mock.trace.runs.get('run-rr')).toMatchObject({ status: 'running', owner: OWNER });

    const second = openPlugin(fake);
    const reread = await second.bridge.call('trace-read', { importLibraryVariants: true });
    mock.trace.release('run-rr', 'reopened');
    const result = await study(second, reread, 'study-runner-resume');

    expect(result).toEqual({ stop: 'done', reason: expect.any(String), sessions: [{ runId: 'run-rr', ended: { status: 'finalizing', reason: 'done' }, stop: 'ended', message: null }] });
    // Resumed from its saved turn 2, not claimed again: turn 3 went out twice, unchanged.
    expect(refusalsOf('run-rr')).toEqual([]);
    expect(postsOf('run-rr').map((p) => p.turn)).toEqual([1, 2, 3, 3, 4, 5]);
    const [once, again] = postsOf('run-rr').filter((p) => p.turn === 3).map((p) => p.body as unknown as TurnBody);
    expect(again?.last).toEqual(once?.last);
    expect(again?.screen).toEqual(once?.screen);
    expect(mock.trace.runs.get('run-rr')?.status).toBe('completed');
    expect(await second.bridge.call('trace-load', { studyId: 'study-runner-resume' })).toEqual({ sessions: [] });
    await tick();
    expect(scratchOn(fake)).toEqual([]);
    expectUntouched(fake, before);
    expect([...first.failures, ...second.failures]).toEqual([]);
  }, 30_000);

  it('claims again and finishes a run whose turn 0 save the plugin closed before storing', async () => {
    mock.trace.addStudy({
      studyId: 'study-reclaim',
      waves: [[{ runId: 'run-rc', script: [{ expect: 'Dashboard', click: 'Billing' }, { expect: 'Billing settings', give_up: 'Billing has no bank here.' }] }]],
    });
    const fake = fakeFile();
    const first = openPlugin(fake);
    const doc = await first.bridge.call('trace-read', { importLibraryVariants: true });
    // The run's turn 0 save is held back, and the plugin closes before it reaches the main thread.
    first.holdSaves(2);
    const running = study(first, doc, 'study-reclaim');
    for (let i = 0; i < 500 && !first.sent.includes('trace-save'); i++) await tick();
    first.close();
    expect(await running).toMatchObject({ stop: 'cancelled' });
    expect(mock.trace.runs.get('run-rc')).toMatchObject({ status: 'running', owner: OWNER });
    expect(postsOf('run-rc')).toEqual([]);

    // Reopened: nothing is saved for the run, but the backend answers this panel's claim of it again.
    const second = openPlugin(fake);
    const reread = await second.bridge.call('trace-read', { importLibraryVariants: true });
    expect(await second.bridge.call('trace-load', { studyId: 'study-reclaim' })).toEqual({ sessions: [] });
    const result = await study(second, reread, 'study-reclaim');
    expect(result).toMatchObject({ stop: 'done', sessions: [{ runId: 'run-rc', ended: { status: 'finalizing', reason: 'give_up' }, stop: 'ended' }] });
    expect(refusalsOf('run-rc')).toEqual([]);
    expect(postsOf('run-rc').map((p) => p.turn)).toEqual([1, 2]);
    expect(await second.bridge.call('trace-load', { studyId: 'study-reclaim' })).toEqual({ sessions: [] });
    await second.settled();
    expect([...first.failures, ...second.failures]).toEqual([]);
  }, 30_000);

  it('reads the prototype again before a new wave, so an edit between waves is what wave 2 plays', async () => {
    mock.trace.addStudy({
      studyId: 'study-edit-waves',
      waves: [
        [{ runId: 'run-e1', script: [{ expect: 'Dashboard', give_up: 'Not what I need.', debrief: 'debrief' }] }],
        [{ runId: 'run-e2', repeatIndex: 1, script: [{ expect: 'Home', give_up: 'Not here either.' }] }],
      ],
    });
    const fake = fakeFile();
    const plugin = openPlugin(fake);
    const doc = await plugin.bridge.call('trace-read', { importLibraryVariants: true });
    const clock = panelClock();
    // While wave 1's debrief runs, the designer edits the start screen.
    let edited = false;
    const sleep = async (ms: number) => {
      if (ms === WAVE_RETRY_MS && !edited) {
        edited = true;
        await editDashboard(fake, plugin);
        mock.trace.release('run-e1', 'debrief');
      }
      await clock.sleep(ms);
    };
    const result = await study(plugin, doc, 'study-edit-waves', { sleep });
    expect(result).toMatchObject({ stop: 'done', sessions: [{ runId: 'run-e1', stop: 'ended' }, { runId: 'run-e2', stop: 'ended' }] });
    expect(bodiesOf('run-e1')[0]?.screen.title).toBe('Dashboard');
    // Wave 2 plays the file as it is now, read after the edit: nothing changed since that read.
    expect(bodiesOf('run-e2')[0]).toMatchObject({ screen: { title: 'Home' }, flags: [] });
    expect(refusalsOf('run-e1', 'run-e2')).toEqual([]);
  }, 30_000);

  it('flags a session that starts on a read the file changed after', async () => {
    mock.trace.addStudy({ studyId: 'study-edit-early', waves: [[{ runId: 'run-e3', script: [{ expect: 'Dashboard', give_up: 'Gone.' }] }]] });
    const fake = fakeFile();
    const plugin = openPlugin(fake);
    const read = await plugin.readDoc();
    // Edited after the read, before the runner claims and starts the run.
    await editDashboard(fake, plugin);
    expect(read.changed()).toBe(true);
    const result = await study(plugin, read.doc, 'study-edit-early', { read });
    expect(result).toMatchObject({ stop: 'done', sessions: [{ runId: 'run-e3', stop: 'ended' }] });
    expect(bodiesOf('run-e3')[0]?.flags).toEqual(['file_changed']);
  }, 30_000);

  it('resumes every run from its turn 0 save when the plugin closes before any turn was played', async () => {
    const script: ScriptStep[] = [
      { expect: 'Dashboard', click: 'Billing', hold: 'reopened' },
      { expect: 'Billing settings', give_up: 'Billing has no bank here.' },
    ];
    mock.trace.addStudy({ studyId: 'study-turn0', waves: [[{ runId: 'run-z-one', script }, { runId: 'run-z-two', script }]] });
    const fake = fakeFile();
    const first = openPlugin(fake);
    const doc = await first.bridge.call('trace-read', { importLibraryVariants: true });
    const clock = panelClock();
    // Both runs have posted turn 1 and wait for it: the plugin closes before either played a turn.
    const closing = async (ms: number) => {
      if (['run-z-one', 'run-z-two'].every((id) => mock.trace.runs.get(id)?.turns.has(1))) first.close();
      await clock.sleep(ms);
    };
    expect(await study(first, doc, 'study-turn0', { sleep: closing })).toMatchObject({ stop: 'cancelled' });

    // What each saved is the state a fresh start gives, through the real storage.
    const second = openPlugin(fake);
    const reread = await second.bridge.call('trace-read', { importLibraryVariants: true });
    const { sessions } = await second.bridge.call('trace-load', { studyId: 'study-turn0' });
    // Saved on the flow map version the panel committed before claiming them.
    const turn0 = (runId: string): SavedSession => ({ owner: OWNER, runId, turn: 0, state: start(doc, '1:2'), lastOutcome: null, timerEffects: [], loopFrames: [], flowMapVersion: 1, version: 2 });
    expect([...sessions].sort((a, b) => a.runId.localeCompare(b.runId))).toEqual([turn0('run-z-one'), turn0('run-z-two')]);

    for (const runId of ['run-z-one', 'run-z-two']) mock.trace.release(runId, 'reopened');
    const result = await study(second, reread, 'study-turn0');
    expect(result).toMatchObject({ stop: 'done' });
    expect(result.sessions.map((r) => [r.runId, r.ended]).sort()).toEqual([
      ['run-z-one', { status: 'finalizing', reason: 'give_up' }],
      ['run-z-two', { status: 'finalizing', reason: 'give_up' }],
    ]);
    for (const runId of ['run-z-one', 'run-z-two']) {
      // Not claimed again; turn 1 went out again from the saved start, as the fresh start had sent it, with no last.
      expect(refusalsOf(runId)).toEqual([]);
      expect(postsOf(runId).map((p) => p.turn)).toEqual([1, 1, 2]);
      const [fresh, resumed] = postsOf(runId).filter((p) => p.turn === 1).map((p) => p.body as unknown as TurnBody);
      expect(resumed?.last).toBeNull();
      expect(resumed?.screen).toEqual(fresh?.screen);
      expect(resumed?.elements).toEqual(fresh?.elements);
      expect(resumed?.visible_text_excerpt).toBe(fresh?.visible_text_excerpt);
      expect(picture(resumed?.screenshot_b64)).toEqual(picture(fresh?.screenshot_b64));
      expect(mock.trace.runs.get(runId)?.status).toBe('abandoned');
    }
    expect(await second.bridge.call('trace-load', { studyId: 'study-turn0' })).toEqual({ sessions: [] });
    expect([...first.failures, ...second.failures]).toEqual([]);
  }, 30_000);
});

// --- A Single persona study, from the request the panel builds ---------------

describe('a Single persona study', () => {
  it('runs one persona on the golden path to done, one run in one wave, and reports that run', async () => {
    const backend = createMockBackend({ thinkingPolls: 1, traceScripts: () => GOLDEN });
    const served = await serveMock(backend);
    const api = new ApiClient({ baseUrl: served.url, getToken: () => 'mock-token' });
    try {
      const fake = fakeFile();
      const plugin = openPlugin(fake);
      // The launch as the panel makes it: its request for the Single persona size, then factors, the persona, wave 1.
      const page = await readDocument(fake.api);
      const form = { ...EMPTY_FORM, startId: '1:2', goalId: '2:50', goal: 'Connect a business bank account', who: 'Founders who do their own books', size: 'single' as const };
      const body = buildStudyRequest(form, { doc: page, preflight: runPreflight(page, '1:2', '2:50'), pluginVersion: '0.1.0', knownFileKey: null });
      expect(body.design).toEqual({ mode: 'single', archetypeBudget: 1, repeatPolicy: 'explore' });
      const { studyId } = await api.createStudy<{ studyId: string }>(body);
      await api.identifyFactors(studyId);
      expect(await api.buildArchetypes(studyId)).toMatchObject({ archetypes: [{ role: 'baseline' }] });
      const wave = (await api.startRuns(studyId)) as { runs: Array<{ runId: string }> };
      expect(wave.runs).toHaveLength(1);
      const runId = wave.runs[0]!.runId;

      const clock = panelClock();
      const runner: RunnerStatus[] = [];
      const result = await runStudy(
        { studyId, owner: OWNER, read: await plugin.readDoc(), shareKey: null, startFrameId: '1:2', drawnOnly: false },
        {
          bridge: plugin.bridge, api, now: clock.now, sleep: clock.sleep, pluginVersion: '0.1.0', onSession: () => {}, onRunner: (st) => runner.push(st),
          watchFile: plugin.watchFile, readDoc: plugin.readDoc, postTurnTimeoutMs: 10_000, signal: plugin.signal,
        },
      );
      expect(result).toEqual({
        stop: 'done',
        reason: 'repeat policy explore runs a single wave',
        sessions: [{ runId, ended: { status: 'finalizing', reason: 'done' }, stop: 'ended', message: null }],
      });
      expect(runner.map((r) => r.phase)).toEqual(['running', 'next_wave', 'done']);
      const posts = backend.trace.posts.map((p) => p.body as unknown as TurnBody);
      expect(posts.map((b) => b.screen.title)).toEqual([
        'Dashboard', 'Billing settings', 'Connect bank', 'Connect bank', 'Connect bank', 'Connect bank', 'Connect bank', 'Verify phone', 'Bank connected',
      ]);
      // Only the first commit's look for a flow map the new study doesn't have yet.
      expect(backend.trace.refusals.map((r) => `${r.status} ${r.error}`)).toEqual(['404 flow_map_not_found']);

      const report = await api.getReport<StudyReport & { runs: unknown[] }>(studyId);
      expect(report).toMatchObject({ status: 'complete', partial: false, runsTotal: 1, runsScored: 1, archetypes: [{ role: 'baseline', completion: { k: 1, n: 1 } }] });
      expect(report.runs).toEqual([expect.objectContaining({ runId, status: 'completed', completed: true })]);
      const view = buildReportView(report, indexFrames(page));
      expect(view).toMatchObject({ headline: '1 of 1 try reached the goal.', personas: [{ roleLabel: 'Typical user', k: 1, n: 1, confidenceWords: null }] });
    } finally {
      await served.close();
    }
  }, 30_000);

  it('refuses a single design that asks for more than one persona once', async () => {
    const backend = createMockBackend();
    const served = await serveMock(backend);
    const api = new ApiClient({ baseUrl: served.url, getToken: () => 'mock-token' });
    try {
      const err = await api.createStudy({ title: 't', design: { mode: 'single', archetypeBudget: 5, repeatPolicy: 'explore' } }).then(() => null, (e: unknown) => e);
      expect(err).toMatchObject({ status: 400, code: 'invalid_study' });
      const odd = await api.createStudy({ title: 't', design: { mode: 'pairs', archetypeBudget: 2, repeatPolicy: 'explore' } }).then(() => null, (e: unknown) => e);
      expect(odd).toMatchObject({ status: 400, code: 'invalid_study' });
    } finally {
      await served.close();
    }
  });
});

// --- The mock backend itself: the rules of trace_turn_service.py ------------

describe('the mock backend', () => {
  let clock = 0;
  let own: MockBackend;
  let ownServer: { url: string; close(): Promise<void> };
  let api: ApiClient;

  beforeAll(async () => {
    own = createMockBackend({ clock: () => clock });
    ownServer = await serveMock(own);
    api = new ApiClient({ baseUrl: ownServer.url, getToken: () => 'mock-token' });
  });

  afterAll(async () => {
    await ownServer.close();
  });

  beforeEach(() => {
    clock = 1_000_000;
  });

  const browser = { engine: 'figma-trace' as const, version: '0.1.0', viewport: [1280, 800] as [number, number] };
  const BUTTON = { id: 'e1', label: 'Continue', role: 'button' as const, box: [10, 10, 100, 40] as [number, number, number, number] };

  function body(turn: number, extra: Partial<TurnBody> = {}): TurnBody {
    return {
      owner: OWNER,
      turn,
      screen: { url: 'figma-trace://Prototype/1-2?node-id=1-2', title: 'Dashboard', frameId: '1:2', overlays: [], viewport: [1280, 800], scroll: { x: 0, y: 0, maxX: 0, maxY: 0 } },
      screenshot_b64: 'AAAA',
      elements: [BUTTON],
      visible_text_excerpt: 'Continue',
      last: turn === 1 ? null : { action: { type: 'click', element: 'e1' }, outcome: 'navigated', target: 'Continue (e1)' },
      flags: [],
      elapsed_s: 1,
      client_ts: new Date(clock).toISOString(),
      ...extra,
    };
  }

  async function refused(work: Promise<unknown>): Promise<ApiError> {
    const err = await work.then(
      () => {
        throw new Error('The mock should have refused this');
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    return err as ApiError;
  }

  let n = 0;
  async function claimed(script: ScriptStep[]) {
    const runId = `run-mock-${++n}`;
    own.trace.addStudy({ studyId: `study-mock-${n}`, waves: [[{ runId, script }]] });
    await api.claimRun(runId, { browser, owner: OWNER, flowMapVersion: null });
    return runId;
  }

  it("claims a queued run once, answers its own owner's repeat claim again, and refuses another's, an unknown run and a bad owner", async () => {
    own.trace.addStudy({ studyId: 'study-claim', waves: [[{ runId: 'run-claim', script: [] }]] });
    expect(await refused(api.claimRun('run-claim', { browser, owner: 'not an owner!', flowMapVersion: null }))).toMatchObject({ status: 400, code: 'bad_request' });
    const briefing = await api.claimRun('run-claim', { browser, owner: OWNER, flowMapVersion: null });
    expect(briefing).toMatchObject({ runId: 'run-claim', persona: { name: 'run-claim' }, claimedAt: expect.any(String) });
    // The panel retries a claim whose answer it lost: the backend's own owner gets the same briefing (plugin_run_service.claim_run).
    clock += 5_000;
    expect(await api.claimRun('run-claim', { browser, owner: OWNER, flowMapVersion: null })).toEqual(briefing);
    expect(await refused(api.claimRun('run-claim', { browser, owner: 'panel-other', flowMapVersion: null }))).toMatchObject({ status: 409, code: 'already_claimed' });
    // The rest of 2f16ec9's rule: an owner is needed; and since e9c955a an owner comes only with the figma-trace engine.
    expect(await refused(api.request('POST', '/api/plugin/runs/run-claim/claim', { browser }))).toMatchObject({ status: 409, code: 'already_claimed' });
    for (const claimBody of [{ browser: { ...browser, engine: 'chrome' }, owner: OWNER }, { owner: OWNER }]) {
      const err = await refused(api.request('POST', '/api/plugin/runs/run-claim/claim', claimBody));
      expect(err).toMatchObject({ status: 400, code: 'bad_request' });
      expect(err.message).toBe("owner is only for a Figma panel's claim: browser.engine must be figma-trace.");
    }
    expect(await refused(api.claimRun('run-nobody', { browser, owner: OWNER, flowMapVersion: null }))).toMatchObject({ status: 404, code: 'run_not_found' });
  });

  it('claims with an owner only the runs of a plugin-mode study', async () => {
    own.trace.addStudy({ studyId: 'study-remote', execution: 'remote', waves: [[{ runId: 'run-remote', script: [] }]] });
    const err = await refused(api.claimRun('run-remote', { browser, owner: OWNER, flowMapVersion: null }));
    expect(err).toMatchObject({ status: 400, code: 'bad_request', message: 'run run-remote is not a run of a plugin-mode study: only those are claimed with an owner.' });
    // An actor that names no owner (a remote runner) still claims it.
    expect(await api.request('POST', '/api/plugin/runs/run-remote/claim', { browser: { engine: 'chrome' } })).toMatchObject({ runId: 'run-remote' });
  });

  it('bounds the turn body as the backend does since e9c955a', async () => {
    const runId = await claimed([{ click: 'Continue' }]);
    const screen = body(1).screen;
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ screen: { ...screen, title: 'T'.repeat(301) } }, /screen\.title must be a string of at most 300 characters/],
      [{ screen: { ...screen, overlays: Array.from({ length: 21 }, () => '3:1') } }, /screen\.overlays must be a list of at most 20 frame ids/],
      [{ screen: { ...screen, overlays: ['overlay'] } }, /screen\.overlays must be a list/],
      [{ screen: { ...screen, scroll: { x: 0, y: 0, maxX: 0 } } }, /screen\.scroll must be \{x, y, maxX, maxY\}/],
      [{ screen: { ...screen, scroll: { x: 0, y: -1, maxX: 0, maxY: 0 } } }, /screen\.scroll must be/],
      [{ screen: { ...screen, scroll: { x: 0, y: 0, maxX: 0, maxY: 0, z: 0 } } }, /screen\.scroll must be/],
      [{ elements: [{ ...BUTTON, label: 'L'.repeat(301) }] }, /elements\[0\]\.label must be a string of at most 300 characters/],
      [{ flags: ['missing_font', 'missing_font'] }, /each at most once/],
      [{ visible_text_excerpt: 'x'.repeat(301) }, /visible_text_excerpt must be a string of at most 300 characters/],
      [{ frame_name: 'Dashboard' }, /frame_name is not a turn field/],
      [{ turn: 10_001 }, /turn must be a whole number from 1 to 10000 \(got 10001\)/],
    ];
    for (const [change, message] of bad) {
      const err = await refused(api.postTurn(runId, { ...body(1), ...change } as TurnBody));
      expect(err, String(message)).toMatchObject({ status: 400, code: 'bad_request' });
      expect(err.message).toMatch(message);
    }
    // At the bounds, and a title of 300 characters some of which are outside the BMP (as Python counts them).
    expect(() => cleanTurn(body(1, { screen: { ...screen, title: '🏦'.repeat(300), overlays: Array.from({ length: 20 }, () => 'I3:1;6:2') } }))).not.toThrow();
    expect(await refused(api.getTurn(runId, 10_001))).toMatchObject({ status: 404, code: 'turn_not_found' });
  });

  it('refuses a turn body over 3 MB unread, with 413 payload_too_large', async () => {
    const runId = await claimed([{ click: 'Continue' }]);
    const err = await refused(api.postTurn(runId, body(1, { screenshot_b64: 'A'.repeat(3 * 1024 * 1024) })));
    expect(err).toMatchObject({ status: 413, code: 'payload_too_large' });
    expect(err.message).toBe('A turn body is at most 3 MB: a screenshot of at most 1.5 MB and what the screen shows.');
  });

  it("refuses a turn whose last.action is not the action the turn before chose", async () => {
    const runId = await claimed([{ click: 'Continue' }, { done: 'Done.' }]);
    await api.postTurn(runId, body(1));
    expect(await api.getTurn(runId, 1)).toMatchObject({ action: { type: 'click', element: 'e1' } });
    const other = body(2, { last: { action: { type: 'hover', element: 'e1' }, outcome: 'nothing_happened', target: 'Continue (e1)' } });
    const err = await refused(api.postTurn(runId, other));
    expect(err).toMatchObject({ status: 400, code: 'bad_request' });
    expect(err.message).toBe('last.action must be the action turn 1 chose, {"type":"click","element":"e1"} (got {"type":"hover","element":"e1"}).');
    // The same action with its fields in another order is that action.
    expect(await api.postTurn(runId, body(2, { last: { action: { element: 'e1', type: 'click' } as never, outcome: 'navigated', target: 'Continue (e1)' } }))).toMatchObject({ turn: 2, status: 'thinking' });
  });

  it('fails a turn the decider crashed on with decider_error, aborting the run, a code the panel cannot send', async () => {
    const runId = await claimed([{ fail: 'decider_error' }]);
    await api.postTurn(runId, body(1));
    expect(await api.getTurn(runId, 1)).toMatchObject({ status: 'failed', error: { code: 'decider_error' }, ended: { status: 'aborted', reason: 'decider_error' } });
    const other = await claimed([{ hold: 'never', click: 'Continue' }]);
    expect(await refused(api.abortRun(other, { owner: OWNER, code: 'decider_error' as 'engine_error', detail: 'x' }))).toMatchObject({ status: 400, code: 'bad_request' });
  });

  it('refuses a repeat claim of a run that ended, even from its own owner', async () => {
    const runId = await claimed([]);
    await api.abortRun(runId, { owner: OWNER, code: 'render_failed', detail: 'x' });
    expect(await refused(api.claimRun(runId, { browser, owner: OWNER, flowMapVersion: null }))).toMatchObject({ status: 409, code: 'already_claimed' });
  });

  it('refuses a repeat claim of a run that is finalizing, even from its own owner', async () => {
    const runId = await claimed([{ expect: 'Dashboard', done: 'Done here.', debrief: 'held' }]);
    await api.postTurn(runId, body(1));
    let view = await api.getTurn(runId, 1);
    for (let i = 0; i < 5 && view.status === 'thinking'; i++) view = await api.getTurn(runId, 1);
    expect(view).toMatchObject({ status: 'ready', ended: { status: 'finalizing' } });
    expect(await refused(api.claimRun(runId, { browser, owner: OWNER, flowMapVersion: null }))).toMatchObject({ status: 409, code: 'already_claimed' });
  });

  it('takes the claim of a start frame of fractional size, in the whole pixels the panel claims with', async () => {
    // Farside's "Enter your code" is 818.4 px tall: its viewport is what the panel claims with.
    const cut = frame('S', 1280, 818.4);
    const { width, height } = start(protoDoc([cut]), 'S').viewport;
    own.trace.addStudy({ studyId: 'study-pixels', waves: [[{ runId: 'run-pixels', script: [] }, { runId: 'run-fraction', script: [] }]] });
    expect(await api.claimRun('run-pixels', { browser: { ...browser, viewport: [width, height] }, owner: OWNER, flowMapVersion: null })).toMatchObject({ runId: 'run-pixels' });
    expect(await refused(api.claimRun('run-fraction', { browser: { ...browser, viewport: [cut.width, cut.height] }, owner: OWNER, flowMapVersion: null }))).toMatchObject({ status: 400, code: 'bad_request' });
  });

  it('takes turns in order: 202 thinking, then the poll decides; expected names the turn it takes next', async () => {
    const runId = await claimed([{ click: 'Continue' }, { click: 'Continue' }]);
    expect(await refused(api.postTurn(runId, body(2)))).toMatchObject({ status: 409, code: 'turn_out_of_order', expected: 1 });
    expect(await api.postTurn(runId, body(1))).toEqual({ turn: 1, status: 'thinking' });
    // Turn 1 is undecided: the run still takes turn 1.
    expect(await refused(api.postTurn(runId, body(2)))).toMatchObject({ status: 409, code: 'turn_out_of_order', expected: 1 });
    expect(await api.getTurn(runId, 1)).toMatchObject({ turn: 1, status: 'ready', action: { type: 'click', element: 'e1' }, state: { seq: 0 }, ended: null });
    expect(await refused(api.postTurn(runId, body(3)))).toMatchObject({ status: 409, code: 'turn_out_of_order', expected: 2 });
    expect(await refused(api.getTurn(runId, 7))).toMatchObject({ status: 404, code: 'turn_not_found' });
    expect(await refused(api.getTurn('run-nobody', 1))).toMatchObject({ status: 404, code: 'run_not_found' });
  });

  it('answers a re-post of the newest turn with its record, storing it once', async () => {
    const runId = await claimed([{ click: 'Continue' }]);
    await api.postTurn(runId, body(1));
    await api.getTurn(runId, 1);
    expect(await api.postTurn(runId, body(1))).toMatchObject({ turn: 1, status: 'ready', action: { type: 'click' } });
    expect(own.trace.runs.get(runId)?.turns.size).toBe(1);
  });

  it('refuses another panel and a run no panel claimed', async () => {
    const runId = await claimed([{ click: 'Continue' }]);
    expect(await refused(api.postTurn(runId, body(1, { owner: 'panel-other' })))).toMatchObject({ status: 409, code: 'not_owner' });
    expect(await refused(api.abortRun(runId, { owner: 'panel-other', code: 'render_failed', detail: 'x' }))).toMatchObject({ status: 409, code: 'not_owner' });
    own.trace.addStudy({ studyId: 'study-ownerless', waves: [[{ runId: 'run-ownerless', script: [] }]] });
    await api.request('POST', '/api/plugin/runs/run-ownerless/claim', { browser });
    const err = await refused(api.postTurn('run-ownerless', body(1)));
    expect(err).toMatchObject({ status: 409, code: 'not_owner' });
    expect(err.message).toMatch(/was not claimed by a Figma panel/);
  });

  it('validates turn bodies as the backend does', async () => {
    const runId = await claimed([{ click: 'Continue' }]);
    const bad: Array<[Partial<TurnBody> | Record<string, unknown>, RegExp]> = [
      [{ last: { action: { type: 'click' }, outcome: 'navigated', target: null } }, /last must be null on turn 1/],
      [{ elements: [{ ...BUTTON, id: 'x1' }] }, /elements\[0\]\.id must look like e4/],
      [{ elements: [BUTTON, BUTTON] }, /listed twice/],
      [{ elements: [{ ...BUTTON, role: 'switch' }] } as Record<string, unknown>, /role must be one of/],
      [{ screenshot_b64: 'not base64!' }, /not valid base64/],
      [{ flags: ['slow'] } as Record<string, unknown>, /flags must be a list/],
      [{ flags: [], flag_details: { timer_loop: { frames: ['1:2'] } } }, /needs the timer_loop flag/],
      [{ screen: { url: '', frameId: '1:2', viewport: [1280, 800] } } as Record<string, unknown>, /screen\.url is required/],
      [{ flags: undefined } as Record<string, unknown>, /flags must be a list/],
      [{ elements: Array.from({ length: 81 }, (_, i) => ({ ...BUTTON, id: `e${i + 1}` })) }, /elements has 81 items; at most 80/],
    ];
    for (const [change, message] of bad) {
      const err = await refused(api.postTurn(runId, { ...body(1), ...change } as TurnBody));
      expect(err).toMatchObject({ status: 400, code: 'bad_request' });
      expect(err.message).toMatch(message);
    }
    expect(() => cleanTurn(body(2, { last: { action: { type: 'click', element: 'e1' }, outcome: 'unsupported', target: null } }))).toThrow(/last\.unsupported is required/);
    expect(() => cleanTurn(body(2, { last: { action: { type: 'click', element: 'e1' }, outcome: 'navigated', target: null, unsupported: 'X' } }))).toThrow(/only allowed with the unsupported outcome/);
    const later = (last: Record<string, unknown>) => body(2, { last: { action: { type: 'click', element: 'e1' }, target: 'Continue (e1)', ...last } as TurnBody['last'] });
    expect(() => cleanTurn(body(2, { last: null }))).toThrow(/last is required on turn 2/);
    expect(() => cleanTurn(later({ outcome: 'unsupported', unsupported: 'x'.repeat(201) }))).toThrow(/at most 200 characters \(got 201\)/);
    expect(() => cleanTurn(later({ outcome: 'unsupported', unsupported: 'x'.repeat(200) }))).not.toThrow();
    const effects = (n: number) => Array.from({ length: n }, () => ({ type: 'left_prototype', detail: 'https://status.example.com' }));
    expect(() => cleanTurn(later({ outcome: 'timers_fired', timer_effects: effects(11) }))).toThrow(/at most 10/);
    expect(() => cleanTurn(later({ outcome: 'timers_fired', timer_effects: effects(10) }))).not.toThrow();
    expect(() => cleanTurn(body(1, { elements: Array.from({ length: 80 }, (_, i) => ({ ...BUTTON, id: `e${i + 1}` })) }))).not.toThrow();
    expect(() => cleanTurn(body(1, { flags: ['timer_loop'], flag_details: { timer_loop: { frames: ['1:2'] } } }))).not.toThrow();
    expect(() => cleanTurn(body(1))).not.toThrow();
  });

  it('fails a turn past its 150 s deadline with turn_timeout, aborting the run', async () => {
    const runId = await claimed([{ hold: 'never', click: 'Continue' }]);
    await api.postTurn(runId, body(1));
    expect(await api.getTurn(runId, 1)).toEqual({ turn: 1, status: 'thinking' });
    clock += 150_001;
    expect(await api.getTurn(runId, 1)).toMatchObject({ status: 'failed', error: { code: 'turn_timeout' }, ended: { status: 'aborted', reason: 'turn_timeout' } });
    expect(own.trace.runs.get(runId)).toMatchObject({ status: 'aborted', abortReason: 'turn_timeout' });
    expect(await refused(api.postTurn(runId, body(2)))).toMatchObject({ status: 409, code: 'run_ended' });
  });

  it('fails the turn and aborts the run when the brain names an element the screen does not list', async () => {
    const runId = await claimed([{ click: 'Cancel' }]);
    await api.postTurn(runId, body(1));
    expect(await api.getTurn(runId, 1)).toMatchObject({ status: 'failed', error: { code: 'brain_invalid_action' }, ended: { status: 'aborted', reason: 'brain_invalid_action' } });
  });

  it('ends a run through finalizing; a finalizing run takes no abort, and its last turn re-posts with how it ended', async () => {
    const runId = await claimed([{ click: 'Continue' }, { done: 'Done.', debrief: 'debrief' }]);
    await api.postTurn(runId, body(1));
    await api.getTurn(runId, 1);
    await api.postTurn(runId, body(2));
    expect(await api.getTurn(runId, 2)).toMatchObject({ status: 'ready', action: { type: 'done', claim: 'Done.' }, ended: { status: 'finalizing', reason: 'done' } });
    expect(await refused(api.abortRun(runId, { owner: OWNER, code: 'render_failed', detail: 'late' }))).toMatchObject({ status: 409, code: 'run_ended' });
    expect(await refused(api.postTurn(runId, body(3)))).toMatchObject({ status: 409, code: 'run_ended' });
    own.trace.release(runId, 'debrief');
    expect(await api.getTurn(runId, 2)).toMatchObject({ ended: { status: 'completed', reason: 'done' } });
    expect(await api.postTurn(runId, body(2))).toMatchObject({ status: 'ready', ended: { status: 'completed', reason: 'done' } });
  });

  it('aborts an open run with the panel code, failing its undecided turn', async () => {
    const runId = await claimed([{ hold: 'never', click: 'Continue' }]);
    await api.postTurn(runId, body(1));
    expect(await refused(api.abortRun(runId, { owner: OWNER, code: 'finalize_failed' as 'render_failed', detail: 'x' }))).toMatchObject({ status: 400 });
    expect(await refused(api.abortRun(runId, { owner: OWNER, code: 'render_failed', detail: '  ' }))).toMatchObject({ status: 400 });
    expect(await api.abortRun(runId, { owner: OWNER, code: 'render_failed', detail: 'The export failed twice.' })).toEqual({ runId, status: 'aborted', abortReason: 'render_failed' });
    expect(await api.getTurn(runId, 1)).toMatchObject({ status: 'failed', error: { code: 'render_failed', message: 'The export failed twice.' }, ended: { status: 'aborted', reason: 'render_failed' } });
    expect(await refused(api.abortRun(runId, { owner: OWNER, code: 'render_failed', detail: 'again' }))).toMatchObject({ status: 409, code: 'run_ended' });
  });

  it('starts the next wave once every run is over, then says done', async () => {
    own.trace.addStudy({
      studyId: 'study-waves',
      waves: [
        [{ runId: 'run-w1', archetypeId: 'a1', archetypeName: 'Mara', script: [{ give_up: 'No.' }] }],
        [{ runId: 'run-w2', archetypeId: 'a2', archetypeName: 'Dev', repeatIndex: 1, script: [] }],
      ],
    });
    expect(await refused(api.nextWave('study-waves'))).toMatchObject({ status: 409, code: 'wave_in_progress' });
    await api.claimRun('run-w1', { browser, owner: OWNER, flowMapVersion: null });
    await api.postTurn('run-w1', body(1));
    expect(await api.getTurn('run-w1', 1)).toMatchObject({ ended: { status: 'finalizing', reason: 'give_up' } });
    // The wave is open until the debrief ends the run; the next request sees it ended.
    expect(await api.nextWave('study-waves')).toEqual({
      studyId: 'study-waves', wave: 2, created: true, repeatPolicy: 'confirm',
      runs: [{ runId: 'run-w2', archetypeId: 'a2', archetypeName: 'Dev', repeatIndex: 1 }],
      reasons: [{ archetypeId: 'a2', archetypeName: 'Dev', count: 1, reason: 'the script adds it' }],
      baseline: null,
    });
    expect(own.trace.runs.get('run-w1')?.status).toBe('abandoned');
    expect(await api.getRuns('study-waves')).toMatchObject({
      studyId: 'study-waves', status: 'running', currentWave: 2,
      runs: [{ runId: 'run-w1', wave: 1, status: 'abandoned', lastStep: { seq: 1 } }, { runId: 'run-w2', wave: 2, repeatIndex: 1, status: 'queued', lastStep: null }],
    });
    expect(await refused(api.nextWave('study-waves'))).toMatchObject({ status: 409, code: 'wave_in_progress' });
    await api.claimRun('run-w2', { browser, owner: OWNER, flowMapVersion: null });
    await api.abortRun('run-w2', { owner: OWNER, code: 'render_failed', detail: 'x' });
    expect(await api.nextWave('study-waves')).toMatchObject({ studyId: 'study-waves', done: true, wave: 2 });
  });
});

// --- The flow map ------------------------------------------------------------------

describe('the flow map of the fake Farside page', () => {
  it('is committed before the claims, built from every candidate, and played by the runs claimed on it', async () => {
    mock.trace.addStudy({ studyId: 'study-map', waves: [[{ runId: 'run-map', script: GOLDEN }]], flowMap: { buildPolls: 2 } });
    const fake = fakeFile();
    const plugin = openPlugin(fake);
    const doc = await plugin.bridge.call('trace-read', { importLibraryVariants: true });
    const result = await study(plugin, doc, 'study-map');
    expect(result).toMatchObject({ stop: 'done' });
    const map = mock.trace.maps.latest('study-map');
    expect(map).toMatchObject({ version: 1, baseVersion: null, docHash: doc.docHash, model: 'mock:reader' });
    expect(map?.readings).toEqual(expect.arrayContaining([
      expect.objectContaining({ shareKey: 'L:2:20:2:27', nodes: ['2:20'], layerKeys: ['2:27'], label: 'Use routing number instead', kind: 'gap', by: 'model' }),
      // The spinner hidden in every button: one reading, wherever the button is.
      expect.objectContaining({ shareKey: 'C:6:2;6:4|spinner', nodes: expect.arrayContaining(['2:10', '2:20', '2:30']) }),
    ]));
    expect(mock.trace.runs.get('run-map')).toMatchObject({ status: 'completed', flowMapVersion: 1 });
    // Nothing the panel sent was refused; it only looked for the map the new study didn't have yet.
    expect(mock.trace.refusals.filter((r) => r.path.includes('study-map')).map((r) => `${r.method} ${r.status} ${r.error}`)).toEqual(['GET 404 flow_map_not_found']);
  }, 30_000);

  it("stops before any claim when the model couldn't read a screen, and launches with drawn connections only when the designer chooses", async () => {
    mock.trace.addStudy({ studyId: 'study-map-fails', waves: [[{ runId: 'run-map-fails', script: GOLDEN }]], flowMap: { buildFailures: [{ node: '2:20', reason: 'k2 has no reading' }] } });
    const fake = fakeFile();
    const plugin = openPlugin(fake);
    const doc = await plugin.bridge.call('trace-read', { importLibraryVariants: true });
    const failed = await study(plugin, doc, 'study-map-fails');
    expect(failed).toEqual({ stop: 'map_failed', message: "Couldn't read the flow of 'Connect bank': k2 has no reading.", sessions: [] });
    expect(mock.trace.runs.get('run-map-fails')?.status).toBe('queued');
    expect(mock.trace.maps.latest('study-map-fails')).toBeNull();

    const drawn = await study(plugin, doc, 'study-map-fails', { drawnOnly: true });
    expect(drawn).toMatchObject({ stop: 'done' });
    const map = mock.trace.maps.latest('study-map-fails');
    expect(map).toMatchObject({ version: 1, model: null, buildId: null });
    expect(new Set(map?.readings.map((r) => `${r.kind} ${String(r.by)}`))).toEqual(new Set(['gap bulk_gap']));
    expect(mock.trace.runs.get('run-map-fails')).toMatchObject({ status: 'completed', flowMapVersion: 1 });
  }, 30_000);
});
