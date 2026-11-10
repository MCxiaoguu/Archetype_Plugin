// Types of live.mjs, for the live trace run (the harness runs it as plain JS).

import type { Scene } from '../tests/wireframe';

export interface LiveConfig {
  /** The live backend, without a trailing slash; null when the live run is off. */
  url: string | null;
  /** Where each run's folder is written. */
  out: string;
  /** The user the live server's dev auth acts as (X-User-Id). */
  user: string;
}

export function liveConfig(): LiveConfig;

/** Writes a file under `folder`, making its directories; returns its path. */
export function saveFile(folder: string, path: string, data: string | Uint8Array): string;

export interface Wireframer {
  /** The scene as a JPEG. */
  draw(scene: Scene): Promise<Uint8Array>;
  close(): Promise<void>;
}

export function openWireframer(): Wireframer;
