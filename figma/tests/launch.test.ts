import { describe, expect, it, vi } from 'vitest';
import { ApiError, type StudyStatusValue } from '../src/lib/api';
import { continueLaunch, stageForStatus, type LaunchApi } from '../src/lib/launch';

function fakeApi(start: StudyStatusValue, opts: { busyOnce?: boolean; failAt?: 'factors' | 'archetypes' | 'runs' } = {}) {
  let status: StudyStatusValue = start;
  let busy = opts.busyOnce ?? false;
  const calls: string[] = [];
  const api: LaunchApi = {
    getStatus: vi.fn(async () => ({ studyId: 's', status, archetypeCount: 0, factorSpecReady: false, runs: { allTerminal: false, byStatus: {}, terminal: 0, total: 0 }, updatedAt: '' })) as LaunchApi['getStatus'],
    identifyFactors: vi.fn(async () => {
      calls.push('factors');
      if (opts.failAt === 'factors') throw new ApiError(500, 'internal_error', 'boom');
      status = 'factors_ready';
      return {};
    }),
    buildArchetypes: vi.fn(async () => {
      calls.push('archetypes');
      if (busy) {
        busy = false;
        throw new ApiError(409, 'generation_in_progress', 'busy');
      }
      if (opts.failAt === 'archetypes') throw new ApiError(0, 'timeout', 'slow');
      status = 'archetypes_ready';
      return {};
    }),
    startRuns: vi.fn(async () => {
      calls.push('runs');
      status = 'running';
      return {};
    }),
  };
  return { api, calls };
}

describe('launch steps', () => {
  it('maps study status to the next step', () => {
    expect(stageForStatus('draft')).toBe('factors');
    expect(stageForStatus('factors_ready')).toBe('archetypes');
    expect(stageForStatus('archetypes_ready')).toBe('runs');
    expect(stageForStatus('running')).toBe('watching');
    expect(stageForStatus('complete')).toBe('watching');
  });

  it('walks a new study through factors, personas and wave 1', async () => {
    const { api, calls } = fakeApi('draft');
    const stages: string[] = [];
    const r = await continueLaunch(api, 's', { onStage: (s) => stages.push(s), sleep: async () => undefined });
    expect(r).toBe('watching');
    expect(calls).toEqual(['factors', 'archetypes', 'runs']);
    expect(stages).toEqual(['factors', 'archetypes', 'runs', 'watching']);
  });

  it('resumes from where a study stopped', async () => {
    const { api, calls } = fakeApi('archetypes_ready');
    await continueLaunch(api, 's', { onStage: () => undefined, sleep: async () => undefined });
    expect(calls).toEqual(['runs']);
  });

  it('waits out a persona build already in progress', async () => {
    const { api, calls } = fakeApi('factors_ready', { busyOnce: true });
    const sleep = vi.fn(async () => undefined);
    await continueLaunch(api, 's', { onStage: () => undefined, sleep });
    expect(calls).toEqual(['archetypes', 'archetypes', 'runs']);
    expect(sleep).toHaveBeenCalledWith(5000);
  });

  it('surfaces real failures so the panel can offer a retry', async () => {
    const { api } = fakeApi('draft', { failAt: 'factors' });
    await expect(continueLaunch(api, 's', { onStage: () => undefined, sleep: async () => undefined })).rejects.toMatchObject({ code: 'internal_error' });
    const slow = fakeApi('factors_ready', { failAt: 'archetypes' });
    await expect(continueLaunch(slow.api, 's', { onStage: () => undefined, sleep: async () => undefined })).rejects.toMatchObject({ code: 'timeout' });
  });

  it('stops when cancelled', async () => {
    const { api, calls } = fakeApi('draft');
    expect(await continueLaunch(api, 's', { onStage: () => undefined, sleep: async () => undefined, cancelled: () => true })).toBe('cancelled');
    expect(calls).toEqual([]);
  });

  it('gives up when the study never moves', async () => {
    const api: LaunchApi = {
      getStatus: (async () => ({ status: 'draft' })) as unknown as LaunchApi['getStatus'],
      identifyFactors: async () => {
        throw new ApiError(409, 'not_editable', 'x');
      },
      buildArchetypes: async () => ({}),
      startRuns: async () => ({}),
    };
    await expect(continueLaunch(api, 's', { onStage: () => undefined, sleep: async () => undefined })).rejects.toThrow(/did not move forward/);
  });
});
