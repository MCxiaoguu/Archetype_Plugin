// Types of mock-backend.mjs, for the tests that drive it (the harness runs it as plain JS).

/** One turn of a run's script: what the persona does, by an element's label as it reads it. */
export type ScriptStep = (
  | { click: string }
  | { hover: string }
  | { scroll: 'up' | 'down' | 'left' | 'right'; amount?: 'page' | 'half'; over?: string }
  | { press: string }
  | { type: [label: string, text: string] }
  | { wait: number }
  | { back: true }
  | { give_up: string; debrief?: string }
  | { done: string; debrief?: string }
  | { fail: string }
) & {
  /** The screen's title this step expects; another screen fails the turn with brain_invalid_action. */
  expect?: string;
  /** Stays thinking until `release(runId, name)`. */
  hold?: string;
};

export interface TraceRunSpec {
  runId: string;
  archetypeId?: string;
  archetypeName?: string;
  repeatIndex?: number;
  script: ScriptStep[];
}

export interface TraceTurnRecord {
  turn: number;
  owner: string;
  status: 'thinking' | 'ready' | 'failed';
  observation: Record<string, unknown> & { screen: { title?: string; url: string; frameId: string } };
  deadlineAt: number;
  result: { action: Record<string, unknown> | null; state: Record<string, unknown> | null; ended: { status: string; reason: string | null } | null } | null;
  error: { code: string; message: string } | null;
}

export interface TraceRun {
  runId: string;
  studyId: string;
  wave: number;
  status: 'queued' | 'running' | 'completed' | 'abandoned' | 'aborted' | 'failed';
  owner: string | null;
  finalizing: { status: string; reason: string; hold: string | null } | null;
  abortReason: string | null;
  abortDetail?: string;
  browser: Record<string, unknown> | null;
  turns: Map<number, TraceTurnRecord>;
  turnList(): TraceTurnRecord[];
}

export interface TracePost {
  runId: string;
  turn: number;
  body: Record<string, unknown>;
  status: number;
}

export interface TraceRefusal {
  method: string;
  path: string;
  status: number;
  error: string;
  message: string;
  body: unknown;
}

export interface TraceRuns {
  handle(method: string, path: string, body: unknown): [number, Record<string, unknown>] | null;
  addStudy(study: { studyId: string; goal?: string; waves: TraceRunSpec[][] }): unknown;
  release(runId: string, name: string): void;
  runs: Map<string, TraceRun>;
  studies: Map<string, unknown>;
  /** Every turn post the mock took, in order. */
  posts: TracePost[];
  /** Every request the trace routes refused, in order. */
  refusals: TraceRefusal[];
}

export interface MockBackend {
  handle(method: string, path: string, body: unknown, headers: Record<string, string | undefined>): Promise<[number, unknown] | null>;
  studies: Map<string, unknown>;
  trace: TraceRuns;
}

export function createMockBackend(opts?: { log?: (message: string) => void; clock?: () => number; thinkingPolls?: number }): MockBackend;

/** The backend's turn body validation: throws its 400 for a body it refuses. */
export function cleanTurn(body: unknown): { n: number; owner: string; observation: Record<string, unknown>; shot: string };

export function serveMock(mock: MockBackend, opts?: { port?: number }): Promise<{ url: string; close(): Promise<void> }>;
