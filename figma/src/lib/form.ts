/** The new test form's fields. Types only, so the main thread can keep a draft without the form's logic. */

export type RunSize = 'quick' | 'thorough';

export interface StudyForm {
  startId: string | null;
  goalId: string | null;
  goal: string;
  who: string;
  product: string;
  link: string;
  size: RunSize;
}
