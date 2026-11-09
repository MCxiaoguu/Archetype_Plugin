import { describe, expect, it } from 'vitest';
import type { StudyRecord, UiToMain } from '../src/lib/messages';
import { runPreflight } from '../src/lib/preflight';
import { clearPins, pinFindings, showNode } from '../src/main/canvas';
import { createController } from '../src/main/controller';
import { readDocument, reactionActions, selectedFrame, topFrameOf, topLevelFrames } from '../src/main/document';
import * as store from '../src/main/storage';
import { makeFigma, type FakeNode } from './fake-figma';

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
