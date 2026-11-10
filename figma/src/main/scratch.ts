/**
 * What the trace's reading and rendering share on the main thread: the
 * mark on the scratch container the renderer draws in (which every reader
 * skips), the ids of the nodes it makes, and the one queue reads and
 * renders run through.
 */

/** Plugin data on the scratch container: `archetype.trace = "scratch"`. */
export const SCRATCH_KEY = 'archetype.trace';
export const SCRATCH_VALUE = 'scratch';
/**
 * The same mark in shared plugin data, under the namespace `archetype.trace`:
 * how a capture through a host that can't write this plugin's private data
 * (the Figma MCP server) marks the frames it leaves.
 */
export const SCRATCH_SHARED_NAMESPACE = 'archetype.trace';

export function isScratch(node: BaseNode): boolean {
  if ('getPluginData' in node && node.getPluginData(SCRATCH_KEY) === SCRATCH_VALUE) return true;
  return 'getSharedPluginData' in node && node.getSharedPluginData(SCRATCH_SHARED_NAMESPACE, SCRATCH_KEY) === SCRATCH_VALUE;
}

const made = new Set<string>();

/** Notes a node a render made: a container, a copy, a backdrop or a detached frame. */
export function recordScratchNode(id: string): void {
  made.add(id);
}

/**
 * Every node a render of this session made, removed ones included. The
 * change watchers ignore their CREATE and DELETE, by id, since a removed
 * node's plugin data can't be read any more.
 */
export function scratchNodeIds(): ReadonlySet<string> {
  return made;
}

const drawing = new Set<FrameNode>();

/**
 * The containers renders are drawing in right now. When the plugin closes
 * mid-render, the close handler removes them by reference, on whatever page
 * they are: the designer may have moved to another page since.
 */
export function holdContainer(container: FrameNode): void {
  drawing.add(container);
}

export function releaseContainer(container: FrameNode): void {
  drawing.delete(container);
}

export function heldContainers(): ReadonlySet<FrameNode> {
  return drawing;
}

const queues = new WeakMap<PluginAPI, Promise<unknown>>();

/**
 * Runs `work` after every read or render queued before it, with
 * `skipInvisibleInstanceChildren` off, so hidden layers inside instances
 * (which a variable or a variant can reveal) are reachable; the flag goes
 * back afterwards, also when `work` throws. The flag is global to the
 * plugin, so reads and renders never overlap. `hidden: false` runs the
 * work in the same queue with the flag as the plugin keeps it: the
 * panel's document read, which lists what the designer sees.
 */
export function exclusive<T>(api: PluginAPI, work: () => Promise<T>, { hidden = true }: { hidden?: boolean } = {}): Promise<T> {
  const before = queues.get(api) ?? Promise.resolve();
  const next = before.then(async () => {
    if (!hidden) return work();
    const saved = api.skipInvisibleInstanceChildren;
    api.skipInvisibleInstanceChildren = false;
    try {
      return await work();
    } finally {
      api.skipInvisibleInstanceChildren = saved;
    }
  });
  // The queue only orders the work; each job's own failure reaches its caller through `next`.
  queues.set(api, next.catch(() => undefined));
  return next;
}
