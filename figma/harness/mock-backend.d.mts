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
  /** The flow map version its claim named; null for a run claimed without one. */
  flowMapVersion?: number | null;
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

/** How the mock's model reads a study's flow map candidates, and how its builds go. */
export interface MockFlowMap {
  /** The reading of a candidate (each share key once, on its first node); every one a gap when none is given. */
  read?: (candidate: { node: string; layerKey: string; shareKey: string; label: string; role: string }, nodes: Array<{ id: string; kind: string; name: string }>) =>
    { kind: 'edge'; to: string; reason?: string } | { kind: 'control' | 'gap'; reason?: string };
  /** Builds that fail, in order: the node (its id) the model could not read, and why. */
  buildFailures?: Array<{ node?: string; reason: string }>;
  /** How many polls of a build still see it building. */
  buildPolls?: number;
}

export interface MockFlowMaps {
  latest(studyId: string): (Record<string, unknown> & { version: number; readings: Array<Record<string, unknown> & { id: string; kind: string; to: string | null }> }) | null;
  studies: Map<string, { versions: Array<Record<string, unknown> & { version: number }>; builds: Map<string, unknown> }>;
}

export interface TraceRuns {
  handle(method: string, path: string, body: unknown, request: { bytes?: number; query?: URLSearchParams }): [number, Record<string, unknown>] | null;
  addStudy(study: { studyId: string; goal?: string; waves: TraceRunSpec[][]; execution?: 'plugin' | 'remote'; repeatPolicy?: 'explore' | 'confirm'; flowMap?: MockFlowMap }): unknown;
  release(runId: string, name: string): void;
  runs: Map<string, TraceRun>;
  studies: Map<string, unknown>;
  /** Every turn post the mock took, in order. */
  posts: TracePost[];
  /** Every request the trace routes refused, in order. */
  refusals: TraceRefusal[];
  /** Each plugin-mode study's flow map versions and builds. */
  maps: MockFlowMaps;
}

export interface MockBackend {
  handle(method: string, path: string, body: unknown, headers: Record<string, string | undefined>, request?: { bytes?: number; query?: URLSearchParams }): Promise<[number, unknown] | null>;
  studies: Map<string, unknown>;
  trace: TraceRuns;
}

/** A persona of a study the mock built: who the script given by `traceScripts` is for. */
export interface MockArchetype {
  archetypeId: string;
  archetypeName: string;
  role: string;
}

export function createMockBackend(opts?: {
  log?: (message: string) => void;
  clock?: () => number;
  thinkingPolls?: number;
  /** Plugin-mode studies created here run as trace runs, each persona playing the script this gives it. */
  traceScripts?: ((archetype: MockArchetype) => ScriptStep[]) | null;
}): MockBackend;

/** The backend's turn body validation: throws its 400 for a body it refuses. */
export function cleanTurn(body: unknown): { n: number; owner: string; observation: Record<string, unknown>; shot: string };

export function serveMock(mock: MockBackend, opts?: { port?: number }): Promise<{ url: string; close(): Promise<void> }>;
