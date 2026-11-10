/**
 * What the trace's reading and rendering share on the main thread: the
 * mark on the scratch container the renderer draws in (which every reader
 * skips), and a way to see every layer inside instances.
 */

/** Plugin data on the scratch container: `archetype.trace = "scratch"`. */
export const SCRATCH_KEY = 'archetype.trace';
export const SCRATCH_VALUE = 'scratch';

export function isScratch(node: BaseNode): boolean {
  return 'getPluginData' in node && node.getPluginData(SCRATCH_KEY) === SCRATCH_VALUE;
}

const holds = new WeakMap<PluginAPI, { count: number; saved: boolean }>();

/**
 * Runs `work` with `skipInvisibleInstanceChildren` off, so hidden layers
 * inside instances (which a variable or a variant can reveal) are
 * reachable, and puts the flag back afterwards, also when `work` throws.
 * Reads and renders can overlap, so the flag goes back only when the last
 * of them ends.
 */
export async function withEveryInstanceChild<T>(api: PluginAPI, work: () => Promise<T>): Promise<T> {
  let hold = holds.get(api);
  if (!hold) {
    hold = { count: 0, saved: api.skipInvisibleInstanceChildren };
    holds.set(api, hold);
  }
  if (hold.count === 0) {
    hold.saved = api.skipInvisibleInstanceChildren;
    api.skipInvisibleInstanceChildren = false;
  }
  hold.count++;
  try {
    return await work();
  } finally {
    hold.count--;
    if (hold.count === 0) api.skipInvisibleInstanceChildren = hold.saved;
  }
}
