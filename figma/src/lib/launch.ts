import { ApiError, type ApiClient, type StudyStatusValue } from './api';
import type { ProtoDoc } from './proto/model';
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

/** 409s that mean another request is doing this step right now. */
const BUSY_CODES = new Set(['generation_in_progress', 'wave_in_progress']);
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
      if (!(err instanceof ApiError) || err.status !== 409) throw err;
      if (BUSY_CODES.has(err.code)) {
        // Another request (an open panel, a retry) is on this step. Wait a
        // little and read again.
        await hooks.sleep(5_000);
        continue;
      }
      // Someone else may have moved the study on; if not, the conflict is
      // the answer (stale factors, a missing persona) and retrying hides it.
      const { status: after } = await api.getStatus(studyId);
      if (stageForStatus(after) === stage) throw err;
    }
  }
  throw new Error('The study did not move forward. Open it in Archetype to see where it stopped.');
}

/**
 * The library components testing would add to the file (spec, Data flow 1):
 * variants a CHANGE_TO in the flow shows, whose layers only their library
 * holds. The Plugin API names no library, so only the components are named.
 */
export function componentsToImport(doc: Pick<ProtoDoc, 'libraryVariants'>): string[] {
  return [...new Set(doc.libraryVariants.filter((v) => v.status === 'needs_import').map((v) => v.name))];
}

/** What the designer confirms before a launch imports them. */
export function importText(components: readonly string[]): string {
  const names = components.length > 1 ? `${components.slice(0, -1).join(', ')} and ${components[components.length - 1]}` : components[0];
  return `Testing this flow adds ${names} to this file, as using it in Figma would.`;
}
