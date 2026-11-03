import { ApiError, type ApiClient, type StudyStatusValue } from './api';
import type { Stage } from './state';

export type LaunchApi = Pick<ApiClient, 'identifyFactors' | 'buildArchetypes' | 'startRuns' | 'getStatus'>;

export interface LaunchHooks {
  onStage: (stage: Stage) => void;
  sleep: (ms: number) => Promise<void>;
  cancelled?: () => boolean;
}

/** The launch step a study in this status needs next. */
export function stageForStatus(status: StudyStatusValue | string): Stage {
  switch (status) {
    case 'draft':
      return 'factors';
    case 'factors_ready':
      return 'archetypes';
    case 'archetypes_ready':
      return 'runs';
    default:
      return 'watching';
  }
}

const BUSY_CODES = new Set(['generation_in_progress']);
const MAX_STEPS = 60;

/**
 * Walks a created study to "running": factors, personas, then the first wave
 * of runs. Safe to call again after a failure or when the panel reopens: it
 * reads the status and continues from the step that is missing.
 */
export async function continueLaunch(api: LaunchApi, studyId: string, hooks: LaunchHooks): Promise<'watching' | 'cancelled'> {
  for (let i = 0; i < MAX_STEPS; i++) {
    if (hooks.cancelled?.()) return 'cancelled';
    const { status } = await api.getStatus(studyId);
    const stage = stageForStatus(status);
    hooks.onStage(stage);
    if (stage === 'watching') return 'watching';
    try {
      if (stage === 'factors') await api.identifyFactors(studyId);
      else if (stage === 'archetypes') await api.buildArchetypes(studyId);
      else if (stage === 'runs') await api.startRuns(studyId);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Someone else (another open panel, a retry) moved the study on, or
        // personas are still being built. Wait a little and read again.
        if (BUSY_CODES.has(err.code)) await hooks.sleep(5_000);
        continue;
      }
      throw err;
    }
  }
  throw new Error('The study did not move forward. Open it in Archetype to see where it stopped.');
}
