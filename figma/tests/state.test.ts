import { describe, expect, it } from 'vitest';
import type { RunRowApi } from '../src/lib/api';
import { DEFAULT_SETTINGS, type InitPayload, type StudyRecord } from '../src/lib/messages';
import { INITIAL_STATE, reducer, type Action, type AppState } from '../src/lib/state';
import { fixtureDoc, fixtureReport } from './helpers';

const record: StudyRecord = { studyId: 's1', title: 'Connect a bank', startName: 'Dashboard', goalName: 'Bank connected', size: 'quick', launchedAt: 1000, status: 'running' };

function init(over: Partial<InitPayload> = {}): AppState {
  const payload: InitPayload = {
    settings: DEFAULT_SETTINGS,
    token: 'tok',
    fileKey: null,
    doc: fixtureDoc(),
    selection: null,
    studies: [],
    lastStudyId: null,
    draft: null,
    pluginVersion: '0.1.0',
    ...over,
  };
  return reducer(INITIAL_STATE, { type: 'init', payload, now: 5000 });
}

const run = (a: Action[], s: AppState) => a.reduce(reducer, s);

describe('panel state machine', () => {
  it('starts on sign in without a token', () => {
    expect(init({ token: null }).screen).toBe('signin');
  });

  it('starts a new test with the first flow start as the start screen', () => {
    const s = init();
    expect(s.screen).toBe('new');
    expect(s.form.startId).toBe('1:2');
    expect(s.form.goalId).toBeNull();
  });

  it('returns to the last study of this file', () => {
    const s = init({ studies: [record], lastStudyId: 's1' });
    expect(s.screen).toBe('progress');
    expect(s.study).toMatchObject({ id: 's1', stage: 'watching', watchingSince: 5000 });
  });

  it('restores the draft', () => {
    const s = init({ draft: { link: 'https://www.figma.com/design/abcdefghijkl/x', who: 'Nurses', size: 'thorough' } });
    expect(s.form).toMatchObject({ link: 'https://www.figma.com/design/abcdefghijkl/x', who: 'Nurses', size: 'thorough' });
  });

  it('picks frames from the selection and the list', () => {
    let s = init();
    s = reducer(s, { type: 'use-selection', role: 'goal' });
    expect(s.notice?.text).toMatch(/Select one top level frame/);
    s = reducer(s, { type: 'selection', selection: { id: '2:50', name: 'Bank connected' } });
    s = reducer(s, { type: 'use-selection', role: 'goal' });
    expect(s.form.goalId).toBe('2:50');
    expect(s.notice).toBeNull();
    s = reducer(s, { type: 'pick', role: 'start', nodeId: '2:10' });
    expect(s.form.startId).toBe('2:10');
    s = reducer(s, { type: 'pick', role: 'start', nodeId: 'gone' });
    expect(s.form.startId).toBeNull();
  });

  it('never picks a frame the prototype cannot open', () => {
    const doc = fixtureDoc();
    doc.frames.push({ id: '8:1', name: 'Button', notAScreen: 'component_set' });
    doc.flowStarts = [{ nodeId: '8:1', name: 'Odd flow' }, ...doc.flowStarts];
    let s = init({ doc });
    expect(s.form.startId).toBe('1:2');
    s = reducer(s, { type: 'pick', role: 'goal', nodeId: '8:1' });
    expect(s.form.goalId).toBeNull();
    s = run([{ type: 'selection', selection: { id: '8:1', name: 'Button' } }, { type: 'use-selection', role: 'goal' }], s);
    expect(s.form.goalId).toBeNull();
    expect(s.notice?.text).toMatch(/component set/);
  });

  it('drops a pick that turns out not to be a screen', () => {
    let s = run([{ type: 'pick', role: 'goal', nodeId: '2:50' }, { type: 'pick', role: 'start', nodeId: '2:10' }], init());
    const doc = fixtureDoc();
    doc.frames = doc.frames.map((f) => (f.id === '2:50' || f.id === '2:10' ? { ...f, notAScreen: 'component_set' as const } : f));
    s = reducer(s, { type: 'doc', doc });
    expect(s.form).toMatchObject({ goalId: null, startId: '1:2' });
  });

  it('drops picks that vanish from the page', () => {
    let s = run([{ type: 'pick', role: 'goal', nodeId: '2:50' }, { type: 'pick', role: 'start', nodeId: '2:10' }], init());
    const doc = fixtureDoc();
    doc.frames = doc.frames.filter((f) => f.id !== '2:50' && f.id !== '2:10');
    s = reducer(s, { type: 'doc', doc });
    expect(s.form.goalId).toBeNull();
    expect(s.form.startId).toBe('1:2');
  });

  it('edits fields and size', () => {
    const s = run([{ type: 'field', field: 'goal', value: 'Pay' }, { type: 'size', size: 'thorough' }, { type: 'attempt-launch' }], init());
    expect(s.form.goal).toBe('Pay');
    expect(s.form.size).toBe('thorough');
    expect(s.touched).toBe(true);
  });

  it('runs a launch through its stages to the report', () => {
    let s = reducer(init(), { type: 'launch-started', now: 10 });
    expect(s.screen).toBe('progress');
    expect(s.study?.stage).toBe('creating');
    s = reducer(s, { type: 'study-created', record });
    expect(s.study?.id).toBe('s1');
    expect(s.history[0]?.studyId).toBe('s1');
    s = reducer(s, { type: 'stage', stage: 'factors', now: 20 });
    s = reducer(s, { type: 'stage', stage: 'archetypes', now: 30 });
    expect(s.study).toMatchObject({ stage: 'archetypes', stageStartedAt: 30 });
    s = reducer(s, { type: 'stage', stage: 'watching', now: 40 });
    expect(s.study?.watchingSince).toBe(40);
    const runs: RunRowApi[] = [{ runId: 'r', archetypeId: 'a', archetypeName: 'A', status: 'queued' }];
    s = reducer(s, { type: 'poll', status: 'running', runs, now: 50 });
    expect(s.study).toMatchObject({ status: 'running', runs, lastPolledAt: 50, queuedSince: 1000 });
    s = reducer(s, { type: 'report', report: fixtureReport(), now: 60 });
    expect(s.screen).toBe('report');
    expect(s.study?.stage).toBe('done');
    expect(s.history[0]?.outcome).toBe('6 of 15 reached the goal');
    expect(s.history[0]?.status).toBe('complete');
  });

  it('keeps watching on a partial report', () => {
    let s = run([{ type: 'launch-started', now: 1 }, { type: 'study-created', record }, { type: 'stage', stage: 'watching', now: 2 }], init());
    s = reducer(s, { type: 'report', report: { ...fixtureReport(), partial: true, status: 'running' }, now: 3 });
    expect(s.screen).toBe('progress');
    expect(s.study?.stage).toBe('watching');
  });

  it('records errors and clears them on retry', () => {
    let s = run([{ type: 'launch-started', now: 1 }, { type: 'launch-failed', message: 'Could not reach Archetype' }], init());
    expect(s.study?.error).toBe('Could not reach Archetype');
    s = reducer(s, { type: 'poll-failed', message: 'offline' });
    s = reducer(s, { type: 'report-failed', message: 'x' });
    s = reducer(s, { type: 'retry', now: 9 });
    expect(s.study).toMatchObject({ error: null, pollError: null, reportError: null, stageStartedAt: 9 });
  });

  it('opens a past study and starts a new test', () => {
    let s = reducer(init({ studies: [record] }), { type: 'navigate', screen: 'history' });
    expect(s.screen).toBe('history');
    s = reducer(s, { type: 'open-study', record, now: 7 });
    expect(s.screen).toBe('progress');
    expect(s.study?.id).toBe('s1');
    s = reducer(s, { type: 'new-test' });
    expect(s.screen).toBe('new');
    expect(s.study).toBeNull();
  });

  it('remembers where settings was opened from', () => {
    let s = reducer(init(), { type: 'navigate', screen: 'settings' });
    expect(s.back).toBe('new');
    s = reducer(s, { type: 'navigate', screen: 'settings' });
    expect(s.back).toBe('new');
    s = reducer(s, { type: 'settings', settings: { apiBase: 'http://localhost:5013', webBase: 'http://localhost:5173' } });
    expect(s.settings.apiBase).toBe('http://localhost:5013');
  });

  it('runs the device sign in states', () => {
    let s = init({ token: null });
    s = reducer(s, { type: 'signin-start', now: 1 });
    expect(s.auth.phase).toBe('starting');
    const code = { device_code: 'd', user_code: 'ABCD', verification_uri: 'u', verification_uri_complete: 'u?c', expires_in: 600, interval: 5 };
    s = reducer(s, { type: 'signin-code', code, now: 2 });
    expect(s.auth).toMatchObject({ phase: 'waiting', code });
    s = reducer(s, { type: 'signin-failed', message: 'expired' });
    expect(s.auth).toMatchObject({ phase: 'error', error: 'expired' });
    s = reducer(s, { type: 'signin-cancel' });
    expect(s.auth.phase).toBe('idle');
    s = reducer(s, { type: 'signed-in', token: 'new' });
    expect(s).toMatchObject({ token: 'new', screen: 'new' });
  });

  it('goes back to the running study after signing in', () => {
    let s = init({ token: null, studies: [record], lastStudyId: 's1' });
    expect(s.screen).toBe('signin');
    s = reducer(s, { type: 'signed-in', token: 't' });
    expect(s.screen).toBe('progress');
  });

  it('a 401 clears the token and returns to sign in with a note', () => {
    const s = reducer(init(), { type: 'signed-out', expired: true });
    expect(s).toMatchObject({ token: null, screen: 'signin' });
    expect(s.notice?.text).toMatch(/session ended/);
    expect(reducer(init(), { type: 'signed-out', expired: false }).notice).toBeNull();
  });

  it('keeps what each session and the runner in this panel say, for their own study only', () => {
    let s = run([{ type: 'launch-started', now: 1 }, { type: 'study-created', record }], init());
    const status = { runId: 'r1', phase: 'thinking' as const, frameName: 'Connect bank', turn: 3, notices: [] };
    s = reducer(s, { type: 'session', studyId: 's1', status });
    expect(s.study?.live).toEqual({ r1: status });
    s = reducer(s, { type: 'session', studyId: 's1', status: { ...status, phase: 'acting', turn: 4 } });
    expect(s.study?.live.r1).toMatchObject({ phase: 'acting', turn: 4 });
    s = reducer(s, { type: 'runner', studyId: 's1', status: { phase: 'paused', notice: 'Lost touch with Archetype. Retrying.' } });
    expect(s.study?.runner).toEqual({ phase: 'paused', notice: 'Lost touch with Archetype. Retrying.' });
    // A runner still going for a study the designer left.
    expect(reducer(s, { type: 'session', studyId: 's0', status })).toBe(s);
    expect(reducer(s, { type: 'runner', studyId: 's0', status: { phase: 'done', notice: null } })).toBe(s);
    expect(reducer(s, { type: 'open-study', record, now: 9 }).study).toMatchObject({ live: {}, runner: null });
  });

  it('holds the launch gate until the next launch', () => {
    let s = reducer(init(), { type: 'gate', gate: { kind: 'blocked', reason: 'Duplicate to your drafts to test', detail: 'Cannot create nodes' } });
    expect(s.gate).toEqual({ kind: 'blocked', reason: 'Duplicate to your drafts to test', detail: 'Cannot create nodes' });
    s = reducer(s, { type: 'gate', gate: { kind: 'confirm-import', components: ['State=Open'] } });
    expect(s.gate).toEqual({ kind: 'confirm-import', components: ['State=Open'] });
    expect(reducer(s, { type: 'launch-started', now: 1 }).gate).toBeNull();
    expect(reducer(s, { type: 'new-test' }).gate).toBeNull();
  });

  it('ignores study events when no study is active', () => {
    const s = init();
    expect(reducer(s, { type: 'poll', status: 'running', runs: [], now: 1 })).toBe(s);
    expect(reducer(s, { type: 'report', report: fixtureReport(), now: 1 })).toBe(s);
    expect(reducer(s, { type: 'stage', stage: 'runs', now: 1 })).toBe(s);
    expect(reducer(s, { type: 'launch-failed', message: 'x' })).toBe(s);
  });

  it('updates history and notices', () => {
    let s = reducer(init(), { type: 'studies', studies: [record] });
    expect(s.history).toHaveLength(1);
    s = reducer(s, { type: 'notice', notice: { kind: 'success', text: 'Pinned' } });
    expect(s.notice?.text).toBe('Pinned');
  });
});
