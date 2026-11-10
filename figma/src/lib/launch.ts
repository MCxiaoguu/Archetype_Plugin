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
 * reads the status and continues from the step that is missing. Returns the
 * status it left the study in (running, or past it), or cancelled.
 */
export async function continueLaunch(api: LaunchApi, studyId: string, hooks: LaunchHooks): Promise<StudyStatusValue | 'cancelled'> {
  for (let i = 0; i < MAX_STEPS; i++) {
    if (hooks.cancelled?.()) return 'cancelled';
    const { status } = await api.getStatus(studyId);
    const stage = stageForStatus(status);
    hooks.onStage(stage);
    if (stage === 'watching') return status;
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

/** A library component that testing tried to add to the file, and why Figma refused. */
export interface FailedImport {
  component: string;
  error: string;
}

/** The components the confirmed read could not import: a CHANGE_TO to them is reported unsupported. */
export function failedImports(doc: Pick<ProtoDoc, 'libraryVariants'>): FailedImport[] {
  return doc.libraryVariants
    .filter((v) => v.status === 'failed')
    .map((v) => {
      if (!v.error) throw new Error(`The read marked ${v.name} as not imported without saying why.`);
      return { component: v.name, error: v.error };
    });
}

/** What the designer reads before launching anyway. */
export function importFailedText(failures: readonly FailedImport[]): string {
  const each = failures.map((f) => `Couldn't add ${f.component}: ${f.error.replace(/[.\s]+$/, '')}.`).join(' ');
  return `${each} Steps that need ${failures.length > 1 ? 'them' : 'it'} will be reported as unsupported.`;
}
