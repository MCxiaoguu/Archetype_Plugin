// The node side of the live trace run (tests/trace-live.test.ts): where it
// runs against and writes to, the wireframe drawer (wireframe.py, Pillow
// through uv) that turns the fake file's exports into real JPEGs, and
// writing the run's files.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'wireframe.py');

/**
 * TRACE_LIVE_URL turns the live run on; TRACE_LIVE_OUT is where runs are
 * written (default harness/live/, gitignored); TRACE_LIVE_SERVER_LOG is the
 * live server's log, which the run reads its refusals and model retries from.
 */
export function liveConfig() {
  const url = process.env.TRACE_LIVE_URL?.trim() || null;
  return {
    url: url ? url.replace(/\/+$/, '') : null,
    out: process.env.TRACE_LIVE_OUT?.trim() || join(here, 'live'),
    // The live server's dev auth acts as this header's user.
    user: process.env.TRACE_LIVE_USER?.trim() || 'live-designer',
    serverLog: process.env.TRACE_LIVE_SERVER_LOG?.trim() || null,
  };
}

/** A text file as it is now. */
export function readText(path) {
  return readFileSync(path, 'utf8');
}

/** Writes a file under `folder`, making its directories. */
export function saveFile(folder, path, data) {
  const file = join(folder, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
  return file;
}

/** Starts wireframe.py, which draws one scene per line until its stdin closes; answers come back in order. */
export function openWireframer() {
  const child = spawn('uv', ['run', '--no-project', '--quiet', '--with', 'pillow', 'python', SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const waiting = [];
  let stopped = null;
  const stop = (err) => {
    stopped = err;
    for (const pending of waiting.splice(0)) pending.reject(err);
  };
  child.on('exit', (code, signal) => stop(new Error(`The wireframe drawer stopped (${signal ?? `exit ${code}`}): ${stderr.trim() || 'no output'}`)));
  child.on('error', (err) => stop(new Error(`The wireframe drawer could not start (uv run ... ${SCRIPT}): ${err.message}`)));
  createInterface({ input: child.stdout }).on('line', (line) => {
    const pending = waiting.shift();
    if (!pending) {
      stop(new Error(`The wireframe drawer answered a scene nobody asked for: ${line.slice(0, 80)}`));
      return;
    }
    if (line.startsWith('OK ')) pending.resolve(new Uint8Array(Buffer.from(line.slice(3), 'base64')));
    else pending.reject(new Error(`The wireframe drawer could not draw the scene: ${line.replace(/^ERR /, '')}`));
  });
  return {
    draw(scene) {
      if (stopped) return Promise.reject(stopped);
      return new Promise((resolve, reject) => {
        waiting.push({ resolve, reject });
        child.stdin.write(`${JSON.stringify(scene)}\n`);
      });
    },
    close() {
      if (stopped) return Promise.resolve();
      return new Promise((resolve) => {
        child.once('exit', () => resolve());
        child.stdin.end();
      });
    },
  };
}
