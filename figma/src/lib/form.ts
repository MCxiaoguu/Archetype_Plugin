/** The new test form's fields. Types only, so the main thread can keep a draft without the form's logic. */

/** How deep a test goes, in the order the form offers them. */
export const RUN_SIZE_KEYS = ['single', 'quick', 'thorough'] as const;
export type RunSize = (typeof RUN_SIZE_KEYS)[number];

export const isRunSize = (v: unknown): v is RunSize => typeof v === 'string' && (RUN_SIZE_KEYS as readonly string[]).includes(v);

export interface StudyForm {
  startId: string | null;
  goalId: string | null;
  goal: string;
  who: string;
  product: string;
  link: string;
  size: RunSize;
}
