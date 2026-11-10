import { describe, expect, it, vi } from 'vitest';
import { ApiError, type StudyStatusValue } from '../src/lib/api';
import { componentsToImport, continueLaunch, failedImports, importFailedText, importText, stageForStatus, type LaunchApi } from '../src/lib/launch';
import type { LibraryVariant } from '../src/lib/proto/model';

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
    // The status it reached: the panel runs a study's personas only while it is running.
    expect(r).toBe('running');
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

  it('surfaces a conflict that leaves the study where it was, without retrying it', async () => {
    const buildArchetypes = vi.fn(async () => {
      throw new ApiError(409, 'factors_stale', 'The factors are stale (the study changed); regenerate them with POST /factors first.');
    });
    const api: LaunchApi = {
      getStatus: (async () => ({ status: 'factors_ready' })) as unknown as LaunchApi['getStatus'],
      identifyFactors: async () => ({}),
      buildArchetypes,
      startRuns: async () => ({}),
    };
    await expect(continueLaunch(api, 's', { onStage: () => undefined, sleep: async () => undefined })).rejects.toMatchObject({
      code: 'factors_stale',
      message: expect.stringMatching(/factors are stale/),
    });
    expect(buildArchetypes).toHaveBeenCalledTimes(1);
  });

  it('moves on when a conflict means someone else advanced the study', async () => {
    let status: StudyStatusValue = 'archetypes_ready';
    const api: LaunchApi = {
      getStatus: (async () => ({ status })) as unknown as LaunchApi['getStatus'],
      identifyFactors: async () => ({}),
      buildArchetypes: async () => ({}),
      startRuns: async () => {
        status = 'running';
        throw new ApiError(409, 'not_editable', 'This study is running; wave 1 can only start from archetypes_ready.');
      },
    };
    expect(await continueLaunch(api, 's', { onStage: () => undefined, sleep: async () => undefined })).toBe('running');
  });

  it('gives up when someone else keeps the study busy', async () => {
    const sleep = vi.fn(async () => undefined);
    const api: LaunchApi = {
      getStatus: (async () => ({ status: 'archetypes_ready' })) as unknown as LaunchApi['getStatus'],
      identifyFactors: async () => ({}),
      buildArchetypes: async () => ({}),
      startRuns: async () => {
        throw new ApiError(409, 'wave_in_progress', 'Wave 1 is being created by another request; read the study again.');
      },
    };
    await expect(continueLaunch(api, 's', { onStage: () => undefined, sleep })).rejects.toThrow(/did not move forward/);
    expect(sleep).toHaveBeenCalledWith(5000);
  });
});

describe('the library components a launch would add', () => {
  const variant = (name: string, status: LibraryVariant['status']): LibraryVariant => ({ variantId: `5:${name.length}`, key: `k-${name}`, name, status, error: null });

  it('names each component the read was not allowed to import, once', () => {
    const doc = { libraryVariants: [variant('State=Open', 'needs_import'), variant('State=Open', 'needs_import'), variant('Size=Large', 'needs_import'), variant('State=Done', 'imported'), variant('State=Gone', 'failed')] };
    expect(componentsToImport(doc)).toEqual(['State=Open', 'Size=Large']);
    expect(componentsToImport({ libraryVariants: [] })).toEqual([]);
  });

  it('tells the designer what testing adds to the file', () => {
    expect(importText(['State=Open'])).toBe('Testing this flow adds State=Open to this file, as using it in Figma would.');
    expect(importText(['A', 'B', 'C'])).toBe('Testing this flow adds A, B and C to this file, as using it in Figma would.');
  });
});

describe('library components that could not be added', () => {
  it('names each with what Figma said, and what that means for the steps', () => {
    const doc = {
      libraryVariants: [
        { variantId: '5:1', key: 'a', name: 'State=Open', status: 'imported' as const, error: null },
        { variantId: '5:2', key: 'b', name: 'State=Closed', status: 'failed' as const, error: 'The library is not enabled for this file' },
      ],
    };
    expect(failedImports(doc)).toEqual([{ component: 'State=Closed', error: 'The library is not enabled for this file' }]);
    expect(importFailedText(failedImports(doc))).toBe("Couldn't add State=Closed: The library is not enabled for this file. Steps that need it will be reported as unsupported.");
    expect(importFailedText([{ component: 'A', error: 'x' }, { component: 'B', error: 'y' }])).toBe("Couldn't add A: x. Couldn't add B: y. Steps that need them will be reported as unsupported.");
  });
});

describe('a study already past its runs', () => {
  it('reports the status it found, so a finished study is only shown', async () => {
    const { api, calls } = fakeApi('complete');
    expect(await continueLaunch(api, 's', { onStage: () => undefined, sleep: async () => undefined })).toBe('complete');
    expect(calls).toEqual([]);
  });
});
