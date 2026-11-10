import { describe, expect, it, vi } from 'vitest';
import fixtureJson from '../harness/fixtures/farside-proto.json';
import type { StudyRecord, UiToMain } from '../src/lib/messages';
import { start } from '../src/lib/proto/engine';
import type { ProtoDoc, RawLayer } from '../src/lib/proto/model';
import { runPreflight } from '../src/lib/preflight';
import { clearPins, pinFindings, showNode } from '../src/main/canvas';
import { createController } from '../src/main/controller';
import { readDocument, reactionActions, selectedFrame, topFrameOf, topLevelFrames } from '../src/main/document';
import { isScratch, recordScratchNode, SCRATCH_KEY, SCRATCH_VALUE, scratchNodeIds } from '../src/main/scratch';
import * as store from '../src/main/storage';
import { designerChanges } from '../src/main/watch';
import { FakeNode, fakeFromFixture, makeFigma, type ProtoFixture } from './fake-figma';

const rec = (id: string, at: number): StudyRecord => ({ studyId: id, title: id, startName: 'A', goalName: 'B', size: 'quick', launchedAt: at, status: 'running' });

describe('reading the page', () => {
  it('finds top level frames, including frames inside sections', () => {
    const { api } = makeFigma();
    expect(topLevelFrames(api.currentPage).map((f) => f.name)).toEqual(['Dashboard', 'Billing settings', 'Connect bank', 'Bank connected', 'Bank sign in error', 'Plans']);
  });

  it('maps nested layers to their top level frame', () => {
    const { api, nodes } = makeFigma();
    expect(topFrameOf(nodes.get('1:8') as unknown as BaseNode)?.id).toBe('1:2');
    expect(topFrameOf(nodes.get('2:14') as unknown as BaseNode)?.id).toBe('2:10');
    expect(topFrameOf(nodes.get('2:10') as unknown as BaseNode)?.id).toBe('2:10');
    expect(topFrameOf(nodes.get('6:1') as unknown as BaseNode)).toBeNull();
    expect(topFrameOf(api.currentPage as unknown as BaseNode)).toBeNull();
  });

  it('flattens conditional and deprecated actions', () => {
    const actions = reactionActions([
      { trigger: { type: 'ON_CLICK' }, actions: [{ type: 'CONDITIONAL', conditionalBlocks: [{ actions: [{ type: 'BACK' }, { type: 'URL', url: 'https://x' }] }] }] },
      { trigger: { type: 'ON_CLICK' }, action: { type: 'CLOSE' } },
      { trigger: { type: 'ON_CLICK' }, actions: [{ type: 'SET_VARIABLE', variableId: null }] },
    ] as unknown as Reaction[]);
    expect(actions).toEqual([{ kind: 'back' }, { kind: 'url', url: 'https://x' }, { kind: 'close' }, { kind: 'other', type: 'SET_VARIABLE' }]);
  });

  it('builds a snapshot the preflight can use', async () => {
    const { api } = makeFigma();
    const doc = await readDocument(api);
    expect(doc.fileName).toBe('Farside billing');
    expect(doc.pageName).toBe('Prototype');
    expect(doc.flowStarts).toEqual([{ nodeId: '1:2', name: 'Connect a bank' }]);
    expect(doc.frames.find((f) => f.id === '3:1')?.closesOnOutsideClick).toBe(true);
    expect(doc.hotspots.map((h) => h.id).sort()).toEqual(['1:7', '1:8', '2:11', '2:13', '2:21', '2:22', '2:23', '2:24']);
    expect(doc.hotspots.find((h) => h.id === '2:11')).toMatchObject({ frameId: '2:10', textHint: 'Connect a bank' });
    expect(doc.hotspots.find((h) => h.id === '2:21')?.actions).toEqual([{ kind: 'node', navigation: 'OVERLAY', destinationId: '3:1' }]);
    expect(doc.destinations['9:99']).toEqual({ exists: false, frameId: null });
    expect(doc.destinations['7:1']).toEqual({ exists: true, frameId: null });
    expect(doc.destinations['2:20']).toEqual({ exists: true, frameId: '2:20' });

    const pf = runPreflight(doc, '1:2', '2:50');
    expect(pf.ok).toBe(true);
    expect(pf.path.map((p) => p.name)).toEqual(['Dashboard', 'Billing settings', 'Connect bank', 'Bank connected']);
    expect(pf.broken.map((b) => b.hotspotId)).toEqual(['2:23']);
    expect(pf.deadEnds.map((d) => d.name)).toEqual(['Plans']);
    expect(pf.genericNames.map((g) => g.name)).toEqual(['Rectangle 12', 'Frame 48']);
  });

  it('marks a component set as a frame the prototype cannot open', async () => {
    const { api, page } = makeFigma();
    const set = new FakeNode('8:1', 'Button', 'COMPONENT_SET');
    set.add(new FakeNode('8:2', 'State=Default', 'COMPONENT'));
    (page as FakeNode).add(set);
    const doc = await readDocument(api);
    expect(doc.frames.find((f) => f.id === '8:1')).toEqual({ id: '8:1', name: 'Button', notAScreen: 'component_set' });
    expect(doc.frames.filter((f) => f.notAScreen)).toHaveLength(1);
  });

  it('treats removed destinations as broken', async () => {
    const { api, nodes } = makeFigma();
    (nodes.get('2:50') as FakeNode).removed = true;
    const doc = await readDocument(api);
    expect(doc.destinations['2:50']?.exists).toBe(false);
  });

  it('reads the selected frame, or the frame around a selected layer', () => {
    const { api, nodes } = makeFigma();
    expect(selectedFrame(api)).toBeNull();
    (api.currentPage as unknown as FakeNode).selection = [nodes.get('2:14') as FakeNode];
    expect(selectedFrame(api)).toEqual({ id: '2:10', name: 'Billing settings' });
    (api.currentPage as unknown as FakeNode).selection = [nodes.get('1:2') as FakeNode, nodes.get('2:10') as FakeNode];
    expect(selectedFrame(api)).toBeNull();
  });
});

describe('canvas actions', () => {
  it('selects and zooms to a frame, switching pages when needed', async () => {
    const { api, other } = makeFigma();
    expect(await showNode(api, '2:20')).toEqual({ ok: true, message: null });
    expect(api.viewport.scrollAndZoomIntoView).toHaveBeenCalledTimes(1);
    expect((api.currentPage as unknown as FakeNode).selection.map((n) => n.id)).toEqual(['2:20']);
    await showNode(api, '7:1');
    expect(api.setCurrentPageAsync).toHaveBeenCalledWith(other);
    expect(await showNode(api, '404:1')).toMatchObject({ ok: false });
    expect(await showNode(api, '0:1')).toMatchObject({ ok: false });
  });

  it('pins one annotation per frame and keeps annotations that are not ours', async () => {
    const { api, nodes } = makeFigma();
    const bank = nodes.get('2:20') as FakeNode;
    bank.annotations = [{ label: 'Designer note' }, { label: 'Archetype: old' }];
    const r = await pinFindings(api, [
      { frameId: '2:20', frameName: 'Connect bank', label: 'Archetype: F1 Bank sign in fails' },
      { frameId: '2:50', frameName: 'Bank connected', label: `Archetype: ${'x'.repeat(2000)}` },
      { frameId: '99:1', frameName: 'Gone', label: 'Archetype: gone' },
    ]);
    expect(r).toMatchObject({ ok: true, count: 2 });
    expect(r.message).toMatch(/Pinned findings on 2 frames. 1 frame is gone/);
    expect(bank.annotations).toEqual([{ label: 'Designer note' }, { label: 'Archetype: F1 Bank sign in fails' }]);
    expect((nodes.get('2:50') as FakeNode).annotations[0]?.label?.length).toBeLessThanOrEqual(900);
  });

  it('falls back to the panel when Figma refuses annotations', async () => {
    const { api, nodes } = makeFigma();
    (nodes.get('2:20') as FakeNode).refuseAnnotations = true;
    const r = await pinFindings(api, [{ frameId: '2:20', frameName: 'Connect bank', label: 'Archetype: F1' }]);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/did not let the plugin add annotations/);
    const r2 = await pinFindings(api, [{ frameId: '1:404', frameName: 'x', label: 'Archetype: x' }]);
    expect(r2).toMatchObject({ ok: false, count: 0 });
  });

  it('clears only Archetype pins', async () => {
    const { api, nodes } = makeFigma();
    const bank = nodes.get('2:20') as FakeNode;
    bank.annotations = [{ label: 'Designer note' }, { label: 'Archetype: F1' }];
    (nodes.get('2:10') as FakeNode).annotations = [{ label: 'Archetype: F2' }];
    expect(clearPins(api)).toMatchObject({ ok: true, count: 2 });
    expect(bank.annotations).toEqual([{ label: 'Designer note' }]);
    expect(clearPins(api)).toMatchObject({ ok: true, count: 0, message: 'No Archetype pins on this page.' });
    bank.annotations = [{ label: 'Archetype: F1' }];
    bank.refuseAnnotations = true;
    expect(clearPins(api).ok).toBe(false);
  });
});

describe('storage', () => {
  it('keeps settings and the token', async () => {
    const { api } = makeFigma();
    expect(await store.loadSettings(api)).toEqual({ apiBase: 'https://api.syntheticarchetype.com', webBase: 'https://www.syntheticarchetype.com' });
    await store.saveSettings(api, { apiBase: ' http://localhost:5013 ', webBase: '' });
    expect(await store.loadSettings(api)).toEqual({ apiBase: 'http://localhost:5013', webBase: 'https://www.syntheticarchetype.com' });
    expect(await store.loadToken(api)).toBeNull();
    await store.saveToken(api, 'tok');
    expect(await store.loadToken(api)).toBe('tok');
    await store.saveToken(api, null);
    expect(await store.loadToken(api)).toBeNull();
  });

  it('keeps the last study per file, newest first, capped', async () => {
    const { api } = makeFigma();
    expect(await store.loadStudies(api)).toEqual({ studies: [], lastStudyId: null });
    expect(store.fileId(api, false)).toBeNull();
    for (let i = 0; i < 25; i++) await store.saveStudy(api, rec(`s${i}`, i));
    const { studies, lastStudyId } = await store.loadStudies(api);
    expect(studies).toHaveLength(store.MAX_STUDIES);
    expect(studies[0]?.studyId).toBe('s24');
    expect(lastStudyId).toBe('s24');
    await store.saveStudy(api, { ...rec('s24', 24), status: 'complete' });
    expect((await store.loadStudies(api)).studies.filter((s) => s.studyId === 's24')).toHaveLength(1);
    await store.forgetLast(api);
    expect((await store.loadStudies(api)).lastStudyId).toBeNull();
  });

  it('keys history by file: fileKey when known, else an id in plugin data', async () => {
    const a = makeFigma({ fileKey: 'KEY123' });
    expect(store.fileId(a.api, true)).toBe('KEY123');
    const b = makeFigma();
    const id = store.fileId(b.api, true);
    expect(id).toMatch(/^f/);
    expect(store.fileId(b.api, false)).toBe(id);
    const c = makeFigma({ readOnlyRoot: true });
    expect(store.fileId(c.api, true)).toBe('name:Farside billing');
  });

  it('reads back what it saved in a view only file', async () => {
    const { api } = makeFigma({ readOnlyRoot: true });
    await store.saveStudy(api, rec('s1', 1));
    await store.saveStudy(api, rec('s2', 2));
    expect(await store.loadStudies(api)).toEqual({ studies: [rec('s2', 2), rec('s1', 1)], lastStudyId: 's2' });
    await store.forgetLast(api);
    expect((await store.loadStudies(api)).lastStudyId).toBeNull();
    await store.saveDraft(api, { who: 'Nurses' });
    expect(await store.loadDraft(api)).toEqual({ who: 'Nurses' });
  });

  it('saves the draft per file', async () => {
    const { api } = makeFigma();
    expect(await store.loadDraft(api)).toBeNull();
    await store.saveDraft(api, { who: 'Nurses', size: 'thorough' });
    expect(await store.loadDraft(api)).toEqual({ who: 'Nurses', size: 'thorough' });
  });
});

describe('main thread controller', () => {
  it('answers ready with everything the panel needs', async () => {
    const { api } = makeFigma();
    await store.saveToken(api, 'tok');
    await store.saveStudy(api, rec('s1', 1));
    const c = createController(api, '0.1.0');
    await c.handle({ type: 'ready' });
    const init = api.ui.postMessage.mock.lastCall?.[0];
    expect(init).toMatchObject({ type: 'init', token: 'tok', fileKey: null, lastStudyId: 's1', pluginVersion: '0.1.0', selection: null });
    expect(init.doc.frames).toHaveLength(6);
    expect(init.studies).toHaveLength(1);
  });

  it('clamps resizes, opens only web links and routes canvas actions', async () => {
    const { api } = makeFigma();
    const c = createController(api, '0.1.0');
    await c.handle({ type: 'resize', width: 100, height: 5000 });
    expect(api.ui.resize).toHaveBeenCalledWith(320, 1200);
    await expect(c.handle({ type: 'open-url', url: 'javascript:alert(1)' })).rejects.toThrow(/link/);
    await c.handle({ type: 'open-url', url: 'https://www.syntheticarchetype.com/workspace/studies/s1' });
    expect(api.openExternal).toHaveBeenCalledTimes(1);
    await c.handle({ type: 'show-node', nodeId: '2:20' });
    expect(api.ui.postMessage).toHaveBeenLastCalledWith({ type: 'show-result', ok: true, message: null });
    await c.handle({ type: 'pin', pins: [{ frameId: '2:20', frameName: 'Connect bank', label: 'Archetype: F1' }] });
    expect(api.ui.postMessage).toHaveBeenLastCalledWith({ type: 'pin-result', ok: true, count: 1, message: 'Pinned findings on 1 frame.' });
    expect(api.notify).toHaveBeenCalled();
    await c.handle({ type: 'clear-pins' });
    expect(api.ui.postMessage).toHaveBeenLastCalledWith({ type: 'pin-result', ok: true, count: 1, message: 'Cleared pins from 1 frame.' });
  });

  it('refuses panel messages it cannot act on safely, and says so', async () => {
    const { api, nodes, storage } = makeFigma();
    const c = createController(api, '0.1.0');
    const bad: unknown[] = [
      { type: 'open-url', url: 'http://evil.example/activate?user_code=WDJB' },
      { type: 'open-url', url: 42 },
      { type: 'save-settings', settings: { apiBase: 'ftp://api.example.com', webBase: 'https://www.syntheticarchetype.com' } },
      { type: 'save-settings', settings: { apiBase: 'http://api.example.com', webBase: 'https://www.syntheticarchetype.com' } },
      { type: 'save-token', token: 42 },
      { type: 'save-study', record: null },
      { type: 'save-study', record: { ...rec('', 1) } },
      { type: 'save-draft', draft: 'x' },
      { type: 'resize', width: Number.NaN, height: 400 },
      { type: 'show-node', nodeId: null },
      // Clear pins removes only labels with the prefix, so a pin without it could never be cleared.
      { type: 'pin', pins: [{ frameId: '2:20', frameName: 'Connect bank', label: 'F1 Bank sign in fails' }] },
      { type: 'pin', pins: 'all' },
      { type: 'notify', text: { html: '<b>' } },
      { type: 'rename-frames' },
    ];
    for (const msg of bad) {
      await expect(c.handle(msg as UiToMain), JSON.stringify(msg)).rejects.toThrow(/^The panel sent/);
    }
    expect(api.openExternal).not.toHaveBeenCalled();
    expect(api.ui.resize).not.toHaveBeenCalled();
    expect(storage.size).toBe(0);
    expect((nodes.get('2:20') as FakeNode).annotations).toEqual([]);

    await c.handle({ type: 'open-url', url: 'http://localhost:5173/workspace/studies/s1' });
    await c.handle({ type: 'save-settings', settings: { apiBase: 'http://127.0.0.1:5013', webBase: 'http://localhost:5173' } });
    expect(api.openExternal).toHaveBeenCalledWith('http://localhost:5173/workspace/studies/s1');
    expect((await store.loadSettings(api)).apiBase).toBe('http://127.0.0.1:5013');
  });

  it('stores what the panel saves and echoes the history', async () => {
    const { api } = makeFigma();
    const c = createController(api, '0.1.0');
    await c.handle({ type: 'save-token', token: 't' });
    await c.handle({ type: 'save-settings', settings: { apiBase: 'http://localhost:5013', webBase: 'http://localhost:5173' } });
    await c.handle({ type: 'save-study', record: rec('s9', 9) });
    expect(api.ui.postMessage).toHaveBeenLastCalledWith({ type: 'studies', studies: [rec('s9', 9)], lastStudyId: 's9' });
    await c.handle({ type: 'save-draft', draft: { link: 'x' } });
    await c.handle({ type: 'forget-last' });
    await c.handle({ type: 'notify', text: 'hi' });
    await c.handle({ type: 'refresh' });
    expect(await store.loadToken(api)).toBe('t');
    expect((await store.loadSettings(api)).apiBase).toBe('http://localhost:5013');
    expect((await store.loadStudies(api)).lastStudyId).toBeNull();
    expect(await store.loadDraft(api)).toEqual({ link: 'x' });
    expect(api.ui.postMessage.mock.lastCall?.[0]).toEqual({ type: 'selection', selection: null });
    const calls = api.ui.postMessage.mock.calls;
    expect(calls[calls.length - 2]?.[0].type).toBe('doc');
  });
});

// --- The trace runner's requests and watchers ---------------------------------

type Reply = { type: string; requestId?: string; result?: unknown; message?: string; frameIds?: string[] };

/** The main thread over the Farside prototype fixture, with the panel's side of postMessage and storage. */
function traceMain() {
  const fake = fakeFromFixture(structuredClone(fixtureJson) as unknown as ProtoFixture);
  const storage = new Map<string, unknown>();
  const pageHandlers = new Map<string, Array<(event: unknown) => void>>();
  for (const page of fake.pages as FakeNode[]) {
    Object.assign(page, {
      on: (_event: string, fn: (event: unknown) => void) => pageHandlers.set(page.id, [...(pageHandlers.get(page.id) ?? []), fn]),
    });
  }
  const postMessage = vi.fn();
  Object.assign(fake.api, {
    ui: { postMessage, resize: vi.fn() },
    notify: vi.fn(),
    clientStorage: {
      getAsync: vi.fn(async (k: string) => structuredClone(storage.get(k))),
      setAsync: vi.fn(async (k: string, v: unknown) => void storage.set(k, structuredClone(v))),
      deleteAsync: vi.fn(async (k: string) => void storage.delete(k)),
    },
  });
  const controller = createController(fake.api, '0.1.0');
  const posted = (): Reply[] => postMessage.mock.calls.map((c) => c[0] as Reply);
  const ask = async (msg: Record<string, unknown>): Promise<Reply> => {
    await controller.handle(msg as unknown as UiToMain);
    const reply = posted().find((r) => r.requestId === msg.requestId);
    if (!reply) throw new Error(`No reply to ${String(msg.requestId)}`);
    return reply;
  };
  const fire = (pageId: string, nodeChanges: unknown[]) => (pageHandlers.get(pageId) ?? []).forEach((fn) => fn({ nodeChanges }));
  return { ...fake, controller, ask, posted, postMessage, fire, pageHandlers };
}

const traceNode = (t: ReturnType<typeof traceMain>, id: string) => t.nodes.get(id) as FakeNode;

describe('trace requests on the main thread', () => {
  it('answers each of the five requests with its request id', async () => {
    const t = traceMain();
    const read = await t.ask({ type: 'trace-read', requestId: 'q1', importLibraryVariants: true });
    expect(read).toMatchObject({ type: 'trace-result', requestId: 'q1' });
    const doc = read.result as ProtoDoc;
    expect(doc.frames.map((f) => f.id)).toContain('1:2');
    const state = start(doc, '1:2');

    const render = await t.ask({ type: 'trace-render', requestId: 'q2', doc, state });
    expect(render).toMatchObject({ type: 'trace-result', requestId: 'q2' });
    const drawn = render.result as { image: Uint8Array; layers: RawLayer[]; viewport: { width: number; height: number }; notes: unknown[] };
    // The bytes cross the plugin boundary as a Uint8Array (structured clone keeps typed arrays).
    expect(drawn.image).toBeInstanceOf(Uint8Array);
    expect(drawn.image.length).toBeGreaterThan(0);
    expect(drawn.layers.map((l) => l.key)).toContain('1:7');
    expect(drawn.viewport).toEqual(state.viewport);

    const session = { owner: 'p_7f3a', runId: 'r1', turn: 3, state, lastOutcome: { action: { type: 'click', element: 'e1' }, outcome: 'navigated', target: 'Billing (e1)' } };
    expect(await t.ask({ type: 'trace-save', requestId: 'q3', studyId: 's1', runId: 'r1', session })).toEqual({ type: 'trace-result', requestId: 'q3', result: null });
    expect(await t.ask({ type: 'trace-load', requestId: 'q4', studyId: 's1' })).toEqual({ type: 'trace-result', requestId: 'q4', result: { sessions: [session] } });
    expect((await t.ask({ type: 'trace-load', requestId: 'q5', studyId: 's2' })).result).toEqual({ sessions: [] });
    await t.ask({ type: 'trace-save', requestId: 'q6', studyId: 's1', runId: 'r1', session: null });
    expect((await t.ask({ type: 'trace-load', requestId: 'q7', studyId: 's1' })).result).toEqual({ sessions: [] });

    expect(await t.ask({ type: 'trace-scratch-check', requestId: 'q8' })).toEqual({ type: 'trace-result', requestId: 'q8', result: { ok: true, reason: null } });
    // Neither the render nor the check leaves a container on the canvas.
    expect((t.api.currentPage as unknown as FakeNode).children.filter((n) => isScratch(n as unknown as BaseNode))).toEqual([]);
    expect(t.api.notify).not.toHaveBeenCalled();
  });

  it('keeps sessions per study and per file', async () => {
    const t = traceMain();
    const doc = (await t.ask({ type: 'trace-read', requestId: 'a', importLibraryVariants: false })).result as ProtoDoc;
    const state = start(doc, '1:2');
    const one = { owner: 'p_1', runId: 'r1', turn: 1, state, lastOutcome: null };
    const two = { owner: 'p_1', runId: 'r2', turn: 4, state, lastOutcome: null };
    await t.ask({ type: 'trace-save', requestId: 'b', studyId: 's1', runId: 'r1', session: one });
    await t.ask({ type: 'trace-save', requestId: 'c', studyId: 's1', runId: 'r2', session: two });
    expect((await t.ask({ type: 'trace-load', requestId: 'd', studyId: 's1' })).result).toEqual({ sessions: [one, two] });
    const keys = (t.api.clientStorage.setAsync as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^archetype\.file\.[^.]+\.trace\.s1$/);
  });

  it('answers a malformed request with trace-error naming what is wrong, not an exception', async () => {
    const t = traceMain();
    const doc = (await t.ask({ type: 'trace-read', requestId: 'ok', importLibraryVariants: false })).result as ProtoDoc;
    const state = start(doc, '1:2');
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ type: 'trace-read', requestId: 'm1', importLibraryVariants: 'yes' }, 'importLibraryVariants'],
      [{ type: 'trace-render', requestId: 'm2', doc: null, state }, 'doc'],
      [{ type: 'trace-render', requestId: 'm3', doc, state: { ...state, frameId: 7 } }, 'state'],
      [{ type: 'trace-render', requestId: 'm4', doc, state: { ...state, viewport: null } }, 'state'],
      [{ type: 'trace-save', requestId: 'm5', studyId: 's1', runId: 'r1', session: { owner: 'p', runId: 'r2', turn: 1, state, lastOutcome: null } }, 'runId'],
      [{ type: 'trace-save', requestId: 'm6', studyId: 's1', runId: 'r1', session: { owner: '', runId: 'r1', turn: 1, state, lastOutcome: null } }, 'owner'],
      [{ type: 'trace-save', requestId: 'm7', studyId: 's1', runId: 'r1', session: { owner: 'p', runId: 'r1', turn: -1, state, lastOutcome: null } }, 'turn'],
      [{ type: 'trace-save', requestId: 'm8', studyId: 's1', runId: 'r1', session: { owner: 'p', runId: 'r1', turn: 1, state: {}, lastOutcome: null } }, 'state'],
      [{ type: 'trace-save', requestId: 'm9', studyId: 's1', runId: 'r1', session: { owner: 'p', runId: 'r1', turn: 1, state, lastOutcome: 'clicked' } }, 'lastOutcome'],
      [{ type: 'trace-save', requestId: 'm10', studyId: '', runId: 'r1', session: null }, 'study'],
      [{ type: 'trace-save', requestId: 'm11', studyId: 's1', session: null }, 'run'],
      [{ type: 'trace-load', requestId: 'm12' }, 'study'],
    ];
    for (const [msg, words] of cases) {
      const reply = await t.ask(msg);
      expect(reply, String(msg.requestId)).toMatchObject({ type: 'trace-error', requestId: msg.requestId });
      expect(reply.message, String(msg.requestId)).toContain(words);
    }
    expect(t.api.notify).not.toHaveBeenCalled();
  });

  it('answers a render that fails with its reason', async () => {
    const t = traceMain();
    const doc = (await t.ask({ type: 'trace-read', requestId: 'r', importLibraryVariants: false })).result as ProtoDoc;
    t.world.exportFails = 'throw';
    expect(await t.ask({ type: 'trace-render', requestId: 'x', doc, state: start(doc, '1:2') })).toEqual({ type: 'trace-error', requestId: 'x', message: 'Export failed' });
  });

  it('refuses a trace request it cannot answer, loudly', async () => {
    const t = traceMain();
    await expect(t.controller.handle({ type: 'trace-read', importLibraryVariants: true } as unknown as UiToMain)).rejects.toThrow(/request id/);
    expect(t.posted()).toEqual([]);
  });

  it('fails the scratch check where nodes cannot be made, as in a view only file', async () => {
    const t = traceMain();
    t.api.createFrame = vi.fn(() => {
      throw new Error('Cannot create nodes in a read-only document');
    }) as unknown as typeof t.api.createFrame;
    expect(await t.ask({ type: 'trace-scratch-check', requestId: 'v1' })).toEqual({
      type: 'trace-result',
      requestId: 'v1',
      result: { ok: false, reason: 'Duplicate to your drafts to test' },
    });
  });

  it('tells the panel when a frame of the ProtoDoc changes, and nothing else', async () => {
    const t = traceMain();
    const doc = (await t.ask({ type: 'trace-read', requestId: 'r', importLibraryVariants: false })).result as ProtoDoc;
    t.postMessage.mockClear();
    const changes = () => t.posted().filter((m) => m.type === 'trace-file-changed');

    t.fire('0:1', [{ type: 'PROPERTY_CHANGE', node: traceNode(t, '1:7'), properties: ['characters'] }]);
    expect(changes()).toEqual([{ type: 'trace-file-changed', frameIds: ['1:2'] }]);
    t.postMessage.mockClear();

    // A frame inside a section, and a whole frame removed.
    const gone = { id: '3:3', type: 'FRAME', removed: true };
    t.fire('0:1', [{ type: 'PROPERTY_CHANGE', node: traceNode(t, '2:70'), properties: ['reactions'] }, { type: 'DELETE', node: gone }]);
    expect(changes()).toEqual([{ type: 'trace-file-changed', frameIds: ['2:20', '3:3'] }]);
    t.postMessage.mockClear();

    // Not a ProtoDoc frame: a sticky note on the canvas, a layer removed from somewhere unknown.
    t.fire('0:1', [{ type: 'PROPERTY_CHANGE', node: traceNode(t, '6:9'), properties: ['characters'] }, { type: 'DELETE', node: { id: '99:1', type: 'TEXT', removed: true } }]);
    // A render's own copies, while their container lives and after it is gone.
    const render = t.controller.handle({ type: 'trace-render', requestId: 'rr', doc, state: start(doc, '1:2') } as unknown as UiToMain);
    await render;
    const ids = [...scratchNodeIds()];
    const container = ids[ids.length - 1] as string;
    t.fire('0:1', [{ type: 'CREATE', node: { id: container, type: 'FRAME', removed: true } }, { type: 'DELETE', node: { id: container, type: 'FRAME', removed: true } }]);
    expect(changes()).toEqual([]);
    expect(doc.frames.length).toBeGreaterThan(1);
  });
});

describe('deleted prototype layers', () => {
  it('flag a file change by id, since a removed node has no parent to trace', async () => {
    const t = traceMain();
    const doc = (await t.ask({ type: 'trace-read', requestId: 'r', importLibraryVariants: true })).result as ProtoDoc;
    const changes = () => t.posted().filter((m) => m.type === 'trace-file-changed');
    const deleted = (id: string, type = 'TEXT') => ({ type: 'DELETE', node: { id, type, removed: true } });
    t.postMessage.mockClear();

    // A layer with reactions, inside the Dashboard: the button the persona was about to press.
    expect(doc.reactions['1:7']).toBeDefined();
    t.fire('0:1', [deleted('1:7')]);
    expect(changes()).toEqual([{ type: 'trace-file-changed', frameIds: ['1:2'] }]);
    t.postMessage.mockClear();

    // A layer without reactions is known once a render measured it.
    t.fire('0:1', [deleted('1:5')]);
    expect(changes()).toEqual([]);
    await t.ask({ type: 'trace-render', requestId: 'p', doc, state: start(doc, '1:2') });
    t.postMessage.mockClear();
    t.fire('0:1', [deleted('1:5')]);
    expect(changes()).toEqual([{ type: 'trace-file-changed', frameIds: ['1:2'] }]);
    t.postMessage.mockClear();

    // A variant a CHANGE_TO shows names the frame its instance is in.
    const [, set] = Object.entries(doc.variantSets)[0] as [string, ProtoDoc['variantSets'][string]];
    t.fire('0:1', [deleted(set.variants[0]!.id, 'COMPONENT')]);
    expect(changes()).toEqual([{ type: 'trace-file-changed', frameIds: [set.frameId] }]);
    t.postMessage.mockClear();

    // Nodes the prototype never referenced.
    t.fire('0:1', [deleted('6:9'), deleted('99:1')]);
    expect(changes()).toEqual([]);
  });
});

describe('telling the renderer\'s changes from the designer\'s', () => {
  function world() {
    const fake = fakeFromFixture(structuredClone(fixtureJson) as unknown as ProtoFixture);
    const container = fake.api.createFrame() as unknown as FakeNode;
    container.setPluginData(SCRATCH_KEY, SCRATCH_VALUE);
    recordScratchNode(container.id);
    return { fake, container };
  }

  it('drops every change inside a scratch container, while it lives and once it is gone', () => {
    const { fake, container } = world();
    const copy = (fake.nodes.get('1:2') as FakeNode).clone();
    container.appendChild(copy);
    const inner = copy.children[0] as FakeNode;
    const alive = [
      { type: 'CREATE', node: container },
      { type: 'CREATE', node: copy },
      { type: 'PROPERTY_CHANGE', node: inner, properties: ['x'] },
    ];
    expect(designerChanges(alive as unknown as NodeChange[])).toEqual([]);
    container.remove();
    // A removed node's parent can't be read: the layers seen inside the container are known by id.
    const removed = [container, copy, inner].map((n) => ({ type: 'DELETE', node: { id: n.id, type: n.type, removed: true } }));
    expect(designerChanges(removed as unknown as NodeChange[])).toEqual([]);
  });

  it('drops a node created and removed before its changes arrive, which changed nothing', () => {
    const { fake, container } = world();
    const copy = (fake.nodes.get('2:10') as FakeNode).clone();
    container.appendChild(copy);
    container.remove();
    const late = [
      { type: 'CREATE', node: { id: container.id, type: 'FRAME', removed: true } },
      { type: 'CREATE', node: { id: copy.id, type: 'FRAME', removed: true } },
      { type: 'DELETE', node: { id: copy.id, type: 'FRAME', removed: true } },
      { type: 'DELETE', node: { id: container.id, type: 'FRAME', removed: true } },
    ];
    expect(designerChanges(late as unknown as NodeChange[])).toEqual([]);
  });

  it('keeps the designer\'s changes', () => {
    const { fake } = world();
    const edit = { type: 'PROPERTY_CHANGE', node: fake.nodes.get('1:7'), properties: ['reactions'] };
    const deleted = { type: 'DELETE', node: { id: '1:10', type: 'TEXT', removed: true } };
    const made = { type: 'CREATE', node: fake.nodes.get('1:5') };
    expect(designerChanges([edit, deleted, made] as unknown as NodeChange[])).toEqual([edit, deleted, made]);
  });
});
