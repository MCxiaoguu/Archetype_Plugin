import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fixtureJson from '../harness/fixtures/farside-proto.json';
import { cleanTurn, createMockBackend, serveMock, type MockBackend, type ScriptStep } from '../harness/mock-backend.mjs';
import { ApiClient, ApiError, type TurnBody } from '../src/lib/api';
import type { MainToUi, SavedSession, TraceRequestMessage, UiToMain } from '../src/lib/messages';
import { start } from '../src/lib/proto/engine';
import type { ProtoDoc } from '../src/lib/proto/model';
import type { RunnerStatus } from '../src/lib/runs';
import { heldContainers, isScratch, SCRATCH_KEY, SCRATCH_VALUE } from '../src/main/scratch';
import { createTraceMain } from '../src/main/trace';
import { createBridge, panelTransport } from '../src/ui/trace/bridge';
import { runStudy, WAVE_RETRY_MS, type RunnerResult } from '../src/ui/trace/runner';
import { NOTICE, runSession, type SessionResult, type SessionStatus } from '../src/ui/trace/session';
import { fakeFromFixture, type FakeNode, type ProtoFixture } from './fake-figma';
import { frame, protoDoc } from './trace-fixtures';

// A whole trace study in the plugin, in process: the real reader, renderer,
// engine, elements, bridge, main thread (trace.ts) and session, on the fake
// Farside page, against the mock backend's trace routes over HTTP. The mock
// follows the backend as built (services/trace_turn_service.py); its brain
// is a script per run that names what to do by label, as a persona reads it.

const OWNER = 'panel-e2e';
const STUDY = 'study-trace';

type Fake = ReturnType<typeof fakeFromFixture>;

function fakeFile(): Fake {
  const fake = fakeFromFixture(structuredClone(fixtureJson) as unknown as ProtoFixture);
  fake.world.exportsLater = true;
  return fake;
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

/**
 * The plugin as Figma runs it: the real main thread on the fake file, and
 * the panel's channel to it. postMessage copies what it carries and
 * delivers it in a later task, both ways.
 */
function openPlugin(fake: Fake) {
  const listeners = new Set<(msg: MainToUi) => void>();
  const posted: MainToUi[] = [];
  /** The type of every request the panel sent, in order. */
  const sent: string[] = [];
  const failures: unknown[] = [];
  /** The requests the main thread is answering, also after the plugin closed: the fake can't stop them as Figma does. */
  const answering = new Set<Promise<void>>();
  let open = true;
  /** trace-save requests held back, to reach the main thread together. */
  let held: { count: number; which: (msg: TraceRequestMessage) => boolean; saves: TraceRequestMessage[] } | null = null;
  /** When set, the other trace-saves reach the main thread one at a time, each after the one before was answered. */
  let serial: Promise<void> | null = null;
  const answer = (msg: TraceRequestMessage): Promise<void> => {
    // handle answers every request itself; a throw means a request it could not answer at all.
    const work = main.handle(msg).catch((err: unknown) => void failures.push(err));
    answering.add(work);
    void work.then(() => answering.delete(work));
    return work;
  };
  const deliver = (msgs: TraceRequestMessage[]) =>
    setTimeout(() => {
      if (open) for (const msg of msgs) void answer(msg);
    }, 0);
  const main = createTraceMain(fake.api, (msg) => {
    posted.push(msg);
    const copy = structuredClone(msg);
    setTimeout(() => {
      if (open) for (const listener of [...listeners]) listener(copy);
    }, 0);
  });
  const toMain = (msg: UiToMain) => {
    const copy = structuredClone(msg) as TraceRequestMessage;
    sent.push(copy.type);
    if (held && copy.type === 'trace-save' && held.which(copy)) {
      held.saves.push(copy);
      if (held.saves.length < held.count) return;
      const together = held.saves;
      held = null;
      deliver(together);
      return;
    }
    if (serial && copy.type === 'trace-save') {
      serial = serial.then(() => (open ? answer(copy) : undefined));
      return;
    }
    deliver([copy]);
  };
  const onMain = (handler: (msg: MainToUi) => void) => {
    listeners.add(handler);
    return () => void listeners.delete(handler);
  };
  const bridge = createBridge(panelTransport(toMain, onMain));
  // Fires as the plugin closes, before the bridge goes: the sessions stop where they are.
  const closing = new AbortController();
  const watchFile = (onChange: (frameIds: string[]) => void) =>
    onMain((msg) => {
      if (msg.type === 'trace-file-changed') onChange(msg.frameIds);
    });
  return {
    main,
    bridge,
    posted,
    sent,
    failures,
    watchFile,
    signal: closing.signal,
    /** Resolves once the main thread answered every request it took, the ones under way when the plugin closed too. */
    async settled() {
      while (answering.size) await Promise.all([...answering]);
    },
    /** Holds the next `count` trace-saves (of those `which` picks) until all of them are sent, then delivers them in one task. */
    holdSaves(count: number, which: (msg: TraceRequestMessage) => boolean = () => true) {
      held = { count, which, saves: [] };
    },
    /** Sends every trace-save not held on its own, after the one before it was answered. */
    serialSaves() {
      serial = Promise.resolve();
    },
    /**
     * The plugin closes, as Figma closes it: the panel fires its signal and
     * shuts the bridge (effects.closePanel), then the main thread's close
     * handler removes what renders hold (figma.on('close') in code.ts), and
     * nothing more reaches either side.
     */
    close() {
      if (!open) return;
      closing.abort();
      bridge.close();
      main.removeLeftovers();
      open = false;
    },
  };
}

type Plugin = ReturnType<typeof openPlugin>;

/** Every node of the file as it stands, by id, without the fake's links. */
function snapshot(fake: Fake): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [id, node] of fake.world.nodes) {
    const own: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === 'world' || typeof value === 'function' || typeof value === 'symbol') continue;
      if (key === 'parent') own.parent = (value as FakeNode | null)?.id ?? null;
      else if (key === 'kids') own.kids = (value as FakeNode[]).map((k) => k.id);
      else if (value instanceof Map) own[key] = [...value];
      else own[key] = structuredClone(value);
    }
    out.set(id, own);
  }
  return out;
}

/**
 * The file as the runs left it, against `before`: the same nodes, unchanged,
 * except the file id the plugin keeps in the document's plugin data
 * (storage.ts), written with the first save.
 */
function expectUntouched(fake: Fake, before: Map<string, unknown>) {
  const after = snapshot(fake);
  const root = after.get('0:0') as { pluginData: Array<[string, string]> };
  expect(root.pluginData).toEqual([['archetypeFileId', expect.any(String)]]);
  root.pluginData = [];
  expect(after).toEqual(before);
}

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

const scratchOn = (fake: Fake) => fake.api.root.children.flatMap((page) => (page as unknown as FakeNode).children.filter((n) => isScratch(n as unknown as BaseNode)));

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
  return client.claimRun(runId, { browser: { engine: 'figma-trace', version: '0.1.0', viewport: [1280, 800] }, owner: OWNER });
}

function persona(
  plugin: Plugin,
  doc: ProtoDoc,
  runId: string,
  opts: { startFrameId?: string; resume?: SavedSession | null; sleep?: (ms: number) => Promise<void>; statuses?: SessionStatus[] } = {},
): Promise<SessionResult> {
  return runSession(
    { runId, studyId: STUDY, owner: OWNER, doc, shareKey: null, startFrameId: opts.startFrameId ?? '1:2', resume: opts.resume ?? null },
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
        { runId: 'run-resume', studyId: RESUME, owner: OWNER, doc, shareKey: null, startFrameId: '1:2', resume: null },
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
      { runId: 'run-resume', studyId: RESUME, owner: OWNER, doc: reread, shareKey: null, startFrameId: '1:2', resume: saved },
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
        { runId, studyId: 'study-together', owner: OWNER, doc, shareKey: null, startFrameId: '1:2', resume: null },
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
        { runId: saved.runId, studyId: 'study-together', owner: OWNER, doc: reread, shareKey: null, startFrameId: '1:2', resume: saved },
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
        { runId: 'run-ahead', studyId: 'study-ahead', owner: OWNER, doc, shareKey: null, startFrameId: '1:2', resume: null },
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
      { runId: 'run-ahead', studyId: 'study-ahead', owner: OWNER, doc: reread, shareKey: null, startFrameId: '1:2', resume: sessions[0] as SavedSession },
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
  opts: { sleep?: (ms: number) => Promise<void>; runner?: RunnerStatus[] } = {},
): Promise<RunnerResult> {
  const clock = panelClock();
  return runStudy(
    { studyId, owner: OWNER, doc, shareKey: null, startFrameId: '1:2' },
    {
      bridge: plugin.bridge,
      api: client,
      now: clock.now,
      sleep: opts.sleep ?? clock.sleep,
      pluginVersion: '0.1.0',
      onSession: () => {},
      onRunner: (status) => opts.runner?.push(status),
      watchFile: plugin.watchFile,
      postTurnTimeoutMs: 10_000,
      signal: plugin.signal,
    },
  );
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
    await client.claimRun('run-theirs', { browser: { engine: 'figma-trace', version: '0.1.0', viewport: [1280, 800] }, owner: 'panel-other' });
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
    await api.claimRun(runId, { browser, owner: OWNER });
    return runId;
  }

  it('claims a queued run once, and refuses a second claim, an unknown run and a bad owner', async () => {
    own.trace.addStudy({ studyId: 'study-claim', waves: [[{ runId: 'run-claim', script: [] }]] });
    expect(await refused(api.claimRun('run-claim', { browser, owner: 'not an owner!' }))).toMatchObject({ status: 400, code: 'bad_request' });
    const briefing = await api.claimRun('run-claim', { browser, owner: OWNER });
    expect(briefing).toMatchObject({ runId: 'run-claim', persona: { name: 'run-claim' }, claimedAt: expect.any(String) });
    expect(await refused(api.claimRun('run-claim', { browser, owner: OWNER }))).toMatchObject({ status: 409, code: 'already_claimed' });
    expect(await refused(api.claimRun('run-nobody', { browser, owner: OWNER }))).toMatchObject({ status: 404, code: 'run_not_found' });
  });

  it('takes the claim of a start frame of fractional size, in the whole pixels the panel claims with', async () => {
    // Farside's "Enter your code" is 818.4 px tall: its viewport is what the panel claims with.
    const cut = frame('S', 1280, 818.4);
    const { width, height } = start(protoDoc([cut]), 'S').viewport;
    own.trace.addStudy({ studyId: 'study-pixels', waves: [[{ runId: 'run-pixels', script: [] }, { runId: 'run-fraction', script: [] }]] });
    expect(await api.claimRun('run-pixels', { browser: { ...browser, viewport: [width, height] }, owner: OWNER })).toMatchObject({ runId: 'run-pixels' });
    expect(await refused(api.claimRun('run-fraction', { browser: { ...browser, viewport: [cut.width, cut.height] }, owner: OWNER }))).toMatchObject({ status: 400, code: 'bad_request' });
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
    await api.claimRun('run-w1', { browser, owner: OWNER });
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
    await api.claimRun('run-w2', { browser, owner: OWNER });
    await api.abortRun('run-w2', { owner: OWNER, code: 'render_failed', detail: 'x' });
    expect(await api.nextWave('study-waves')).toMatchObject({ studyId: 'study-waves', done: true, wave: 2 });
  });
});
