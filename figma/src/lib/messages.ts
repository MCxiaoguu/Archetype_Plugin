import type { Pin } from './report';
import type { StudyForm, RunSize } from './study';
import type { DocSnapshot, NodeRef } from './types';

export interface Settings {
  apiBase: string;
  webBase: string;
}

export const DEFAULT_SETTINGS: Settings = {
  apiBase: 'https://api.syntheticarchetype.com',
  webBase: 'https://www.syntheticarchetype.com',
};

/**
 * An address the plugin may call or open: https anywhere, plain http only on
 * this machine (a local backend). Written without URL, which Figma's main
 * thread sandbox does not have.
 */
export function isSafeWebUrl(url: string): boolean {
  return (
    /^https:\/\/[^\s/?#@]+([/?#]\S*)?$/i.test(url) ||
    /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#]\S*)?$/i.test(url)
  );
}

export function studyWebUrl(webBase: string, studyId: string): string {
  return `${webBase.trim().replace(/\/+$/, '')}/workspace/studies/${encodeURIComponent(studyId)}`;
}

/** What the plugin remembers about a test it launched from this file. */
export interface StudyRecord {
  studyId: string;
  title: string;
  startName: string;
  goalName: string;
  size: RunSize;
  launchedAt: number;
  /** Last known study status, for the history list. */
  status: string;
  /** "3 of 5 reached the goal", once a report was seen. */
  outcome?: string | null;
}

export type Draft = Pick<StudyForm, 'goal' | 'who' | 'product' | 'link' | 'size'>;

export interface InitPayload {
  settings: Settings;
  token: string | null;
  fileKey: string | null;
  doc: DocSnapshot;
  selection: NodeRef | null;
  studies: StudyRecord[];
  lastStudyId: string | null;
  draft: Partial<Draft> | null;
  pluginVersion: string;
}

export type MainToUi =
  | ({ type: 'init' } & InitPayload)
  | { type: 'doc'; doc: DocSnapshot }
  | { type: 'selection'; selection: NodeRef | null }
  | { type: 'studies'; studies: StudyRecord[]; lastStudyId: string | null }
  | { type: 'pin-result'; ok: boolean; count: number; message: string }
  | { type: 'show-result'; ok: boolean; message: string | null };

export type UiToMain =
  | { type: 'ready' }
  | { type: 'resize'; width: number; height: number }
  | { type: 'refresh' }
  | { type: 'save-settings'; settings: Settings }
  | { type: 'save-token'; token: string | null }
  | { type: 'save-study'; record: StudyRecord }
  | { type: 'forget-last' }
  | { type: 'save-draft'; draft: Partial<Draft> }
  | { type: 'open-url'; url: string }
  | { type: 'show-node'; nodeId: string }
  | { type: 'pin'; pins: Pin[] }
  | { type: 'clear-pins' }
  | { type: 'notify'; text: string };

export const PIN_PREFIX = 'Archetype:';
