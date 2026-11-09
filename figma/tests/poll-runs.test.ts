import { describe, expect, it } from 'vitest';
import type { RunRowApi } from '../src/lib/api';
import { frameForUrl, indexFrames } from '../src/lib/frames';
import { FAST_POLL_MS, SLOW_POLL_MS, isStudyDone, isTerminalRun, nextQueuedSince, pollDelay, runnerState } from '../src/lib/poll';
import { latestStepOf, personaRows, rowUrl, runsToPeek } from '../src/lib/runs';
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
    run({ runId: 'v1', archetypeId: 'v', archetypeName: 'Low trust founder', role: 'variant', status: 'running', lastUrl: protoAt('2-30'), metrics: { steps: 3 } }),
    run({ runId: 's1', archetypeId: 's', archetypeName: 'Stress: everything at risk', role: 'stress', status: 'queued' }),
    run({ runId: 'b1', status: 'abandoned', outcome: { completed: false } }),
    run({ runId: 'i1', archetypeId: 'i', archetypeName: 'Impatient founder', role: 'variant', status: 'running' }),
  ];

  it('groups runs by persona with plain status words and the current screen', () => {
    const rows = personaRows(runs, { i1: { url: protoAt('2-20'), seq: 2 } }, index);
    expect(rows.map((r) => [r.name, r.phase, r.statusText, r.screen, r.steps])).toEqual([
      ['Baseline founder', 'done', 'Reached the goal 1 of 2 times', null, null],
      ['Low trust founder', 'running', 'On Verify phone', 'Verify phone', 3],
      ['Impatient founder', 'running', 'On Connect bank', 'Connect bank', 2],
      ['Stress: everything at risk', 'waiting', 'Waiting to start', null, null],
    ]);
    expect(rows[0]).toMatchObject({ runs: 2, finished: 2, completed: 1, gaveUp: 1 });
  });

  it('says what a single finished try did', () => {
    const rows = personaRows([run({ status: 'abandoned', outcome: { completed: false } })], {}, index);
    expect(rows[0]?.statusText).toBe('Gave up');
    const ok = personaRows([run({ status: 'completed' })], {}, index);
    expect(ok[0]?.statusText).toBe('Reached the goal');
  });

  it('counts partial progress while waiting', () => {
    const rows = personaRows([run({ runId: 'a', status: 'completed' }), run({ runId: 'b', status: 'queued' })], {}, index);
    expect(rows[0]?.statusText).toBe('1 of 2 tries done');
  });

  it('falls back when the screen is unknown', () => {
    const rows = personaRows([run({ status: 'running', lastUrl: protoAt('99-1') })], {}, index);
    expect(rows[0]?.statusText).toBe('Clicking through');
  });

  it('reads the latest step and picks runs worth peeking at', () => {
    expect(latestStepOf([{ seq: 1, url: 'a' }, { seq: 3, url: 'c' }, { seq: 2, url: 'b' }])).toEqual({ url: 'c', seq: 3 });
    expect(latestStepOf([])).toBeNull();
    expect(latestStepOf(undefined)).toBeNull();
    expect(rowUrl(run({ lastStep: { url: 'x' } }))).toBe('x');
    expect(rowUrl(run({ currentUrl: 'y' }))).toBe('y');
    expect(runsToPeek(runs)).toEqual(['i1']);
    expect(runsToPeek(Array.from({ length: 10 }, (_, i) => run({ runId: `r${i}`, status: 'running' })), 3)).toHaveLength(3);
  });
});
