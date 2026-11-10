import { describe, expect, it } from 'vitest';
import type { RunRowApi } from '../src/lib/api';
import { frameForUrl, indexFrames } from '../src/lib/frames';
import { FAST_POLL_MS, SLOW_POLL_MS, isStudyDone, isTerminalRun, nextQueuedSince, pollDelay, runnerState } from '../src/lib/poll';
import { panelNotices, panelRunText, personaRows, rowUrl, type LiveRun } from '../src/lib/runs';
import { fixtureDoc, protoAt } from './helpers';

const run = (over: Partial<RunRowApi>): RunRowApi => ({ runId: 'r', archetypeId: 'a', archetypeName: 'Baseline founder', role: 'baseline', status: 'queued', ...over });

describe('polling cadence', () => {
  it('polls every 5 s, then every 15 s after two minutes', () => {
    expect(pollDelay(0)).toBe(FAST_POLL_MS);
    expect(pollDelay(119_999)).toBe(5000);
    expect(pollDelay(120_000)).toBe(SLOW_POLL_MS);
    expect(pollDelay(3_600_000)).toBe(15000);
  });

  it('knows terminal runs and finished studies', () => {
    expect(['completed', 'failed', 'aborted', 'abandoned'].every(isTerminalRun)).toBe(true);
    expect(isTerminalRun('running')).toBe(false);
    expect(isStudyDone('complete')).toBe(true);
    expect(isStudyDone('failed')).toBe(true);
    expect(isStudyDone('running')).toBe(false);
    expect(isStudyDone(null)).toBe(false);
  });
});

describe('runner state', () => {
  const queued = [run({ status: 'queued' }), run({ status: 'queued' })];
  it('says waiting for a runner only after three minutes queued with nothing running', () => {
    expect(runnerState([], null, 0)).toBe('none');
    expect(runnerState(queued, 0, 60_000)).toBe('queued');
    expect(runnerState(queued, 0, 180_001)).toBe('waiting_for_runner');
    expect(runnerState([...queued, run({ status: 'running' })], 0, 999_999)).toBe('running');
    expect(runnerState([run({ status: 'completed' })], 0, 999_999)).toBe('finishing');
    expect(runnerState(queued, null, 999_999)).toBe('queued');
  });

  it('remembers when the queue started waiting', () => {
    expect(nextQueuedSince(queued, null, 10)).toBe(10);
    expect(nextQueuedSince(queued, 5, 10)).toBe(5);
    expect(nextQueuedSince([run({ status: 'running' }), run({ status: 'queued' })], 5, 10)).toBeNull();
    expect(nextQueuedSince([run({ status: 'completed' })], 5, 10)).toBeNull();
  });
});

describe('step URL to frame', () => {
  const index = indexFrames(fixtureDoc());
  it('maps a runner URL to its frame', () => {
    expect(frameForUrl(protoAt('2-30'), index)).toEqual({ id: '2:30', name: 'Verify phone' });
    expect(frameForUrl(protoAt('8-8'), index)).toBeNull();
    expect(frameForUrl('https://farside-moon.pages.dev/settings', index)).toBeNull();
    expect(frameForUrl(undefined, index)).toBeNull();
    expect(indexFrames(null).byId.size).toBe(0);
  });
});

describe('persona rows', () => {
  const index = indexFrames(fixtureDoc());
  const runs: RunRowApi[] = [
    run({ runId: 'b0', status: 'completed', outcome: { completed: true }, metrics: { steps: 4 } }),
    run({ runId: 'v1', archetypeId: 'v', archetypeName: 'Low trust founder', role: 'variant', status: 'running', lastStep: { seq: 3, url: protoAt('2-30') }, metrics: null }),
    run({ runId: 's1', archetypeId: 's', archetypeName: 'Stress: everything at risk', role: 'stress', status: 'queued' }),
    run({ runId: 'b1', status: 'abandoned', outcome: { completed: false } }),
    run({ runId: 'i1', archetypeId: 'i', archetypeName: 'Impatient founder', role: 'variant', status: 'running', lastStep: { seq: 2, url: protoAt('2-20') } }),
  ];

  it('groups runs by persona with plain status words and the current screen', () => {
    const rows = personaRows(runs, index);
    expect(rows.map((r) => [r.name, r.phase, r.statusText, r.screen, r.steps])).toEqual([
      ['Baseline founder', 'done', 'Reached the goal 1 of 2 times', null, null],
      ['Low trust founder', 'running', 'On Verify phone', 'Verify phone', 3],
      ['Impatient founder', 'running', 'On Connect bank', 'Connect bank', 2],
      ['Stress: everything at risk', 'waiting', 'Waiting to start', null, null],
    ]);
    expect(rows[0]).toMatchObject({ runs: 2, finished: 2, completed: 1, gaveUp: 1 });
  });

  it('shows the screen and step from the session this panel runs, ahead of the runs list', () => {
    const live = (runId: string, phase: LiveRun['phase'], frameName: string, turn: number): LiveRun => ({ runId, phase, frameName, turn, notices: [] });
    const rows = personaRows(runs, index, {
      inPanel: true,
      live: {
        v1: live('v1', 'thinking', 'Bank connected', 7),
        i1: live('i1', 'paused', 'Connect bank', 4),
        // Queued in the last poll, already running here.
        s1: live('s1', 'acting', 'Dashboard', 1),
        // Ended here: the runs list says how.
        b1: live('b1', 'ended', 'Plans', 9),
      },
    });
    expect(rows.map((r) => [r.name, r.phase, r.statusText, r.screen, r.steps])).toEqual([
      ['Baseline founder', 'done', 'Reached the goal 1 of 2 times', null, null],
      ['Low trust founder', 'running', 'On Bank connected', 'Bank connected', 7],
      ['Impatient founder', 'running', 'Paused on Connect bank', 'Connect bank', 4],
      ['Stress: everything at risk', 'running', 'On Dashboard', 'Dashboard', 1],
    ]);
  });

  it('shows what the sessions and the runner say, each once, and the runner only while it is paused', () => {
    const LOST = 'Lost touch with Archetype. Retrying.';
    const live = (runId: string, phase: LiveRun['phase'], notices: string[]): LiveRun => ({ runId, phase, frameName: 'Dashboard', turn: 1, notices });
    const sessions = {
      r1: live('r1', 'paused', [LOST, 'Keep this tab visible, or use the desktop app.']),
      r2: live('r2', 'acting', ['This file changed while the test ran.']),
      r3: live('r3', 'paused', [LOST]),
    };
    expect(panelNotices(sessions, { phase: 'running', notice: null })).toEqual([LOST, 'Keep this tab visible, or use the desktop app.', 'This file changed while the test ran.']);
    expect(panelNotices({}, { phase: 'paused', notice: LOST })).toEqual([LOST]);
    expect(panelNotices({}, { phase: 'next_wave', notice: null })).toEqual([]);
    expect(panelNotices({}, null)).toEqual([]);
  });

  it('does not say a persona clicks through when no session in this panel runs it', () => {
    const rows = personaRows(runs, index, { inPanel: true, live: {} });
    expect(rows.map((r) => [r.name, r.phase, r.statusText, r.here])).toEqual([
      ['Baseline founder', 'done', 'Reached the goal 1 of 2 times', false],
      ['Low trust founder', 'waiting', 'Not running in this panel', false],
      ['Impatient founder', 'waiting', 'Not running in this panel', false],
      ['Stress: everything at risk', 'waiting', 'Waiting to start', false],
    ]);
  });

  it("words the Running screen by the panel's own runner and sessions", () => {
    const here = personaRows(runs, index, { inPanel: true, live: { v1: { runId: 'v1', phase: 'thinking', frameName: 'Verify phone', turn: 3, notices: [] } } });
    const none = personaRows(runs, index, { inPanel: true, live: {} });
    expect(panelRunText(here, { phase: 'running', notice: null }, 'running')).toBe('Personas are clicking through your prototype here in the panel.');
    expect(panelRunText(none, { phase: 'next_wave', notice: null }, 'finishing')).toBe('Starting the next round of tries.');
    expect(panelRunText(none, { phase: 'done', notice: null }, 'finishing')).toBe('All tries are in. Putting the results together.');
    expect(panelRunText(none, null, 'queued')).toBe('Starting the personas.');
    // Stopped: the banner says why, and nothing claims the personas go on.
    for (const phase of ['stuck', 'failed', 'other_page'] as const) {
      expect(panelRunText(none, { phase, notice: 'why' }, 'running')).toBe('');
      expect(panelRunText(here, { phase, notice: 'why' }, 'running')).toBe('');
    }
  });

  it('says what a single finished try did', () => {
    const rows = personaRows([run({ status: 'abandoned', outcome: { completed: false } })], index);
    expect(rows[0]?.statusText).toBe('Gave up');
    const ok = personaRows([run({ status: 'completed', outcome: { completed: true } })], index);
    expect(ok[0]?.statusText).toBe('Reached the goal');
  });

  it('does not count a try without a persona outcome as reached or given up', () => {
    // As the backend's report scores runs: an aborted run, or one with no
    // recorded outcome, is not a persona outcome.
    for (const r of [
      run({ status: 'aborted', outcome: null }),
      run({ status: 'aborted', outcome: { completed: false } }),
      run({ status: 'completed', outcome: null }),
      run({ status: 'failed' }),
    ]) {
      const [row] = personaRows([r], index);
      expect(row).toMatchObject({ phase: 'done', finished: 1, completed: 0, gaveUp: 0, statusText: 'Stopped before the end' });
    }
    const [mixed] = personaRows([run({ runId: 'a', status: 'completed', outcome: { completed: true } }), run({ runId: 'b', status: 'aborted' })], index);
    expect(mixed).toMatchObject({ completed: 1, gaveUp: 0, statusText: 'Reached the goal 1 of 2 times' });
  });

  it('counts partial progress while waiting', () => {
    const rows = personaRows([run({ runId: 'a', status: 'completed' }), run({ runId: 'b', status: 'queued' })], index);
    expect(rows[0]?.statusText).toBe('1 of 2 tries done');
  });

  it('falls back when the screen is unknown', () => {
    const rows = personaRows([run({ status: 'running', lastStep: { seq: 1, url: protoAt('99-1') } })], index);
    expect(rows[0]?.statusText).toBe('Clicking through');
    expect(personaRows([run({ status: 'running', lastStep: null })], index)[0]?.statusText).toBe('Clicking through');
  });

  it('reads the newest step from the run row', () => {
    expect(rowUrl(run({ lastStep: { seq: 4, url: 'x' } }))).toBe('x');
    expect(rowUrl(run({ lastStep: null }))).toBeNull();
    expect(rowUrl(run({}))).toBeNull();
  });
});
