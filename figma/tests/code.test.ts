import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeNode, makeFigma } from './fake-figma';

type Handler = (event?: unknown) => void;

/** Loads the plugin's entry point against a fake figma global and returns its event handlers. */
async function boot() {
  const { api, page } = makeFigma();
  const figmaHandlers = new Map<string, Handler>();
  const pageHandlers: Handler[] = [];
  Object.assign(api, {
    showUI: vi.fn(),
    commitUndo: vi.fn(),
    on: (event: string, fn: Handler) => figmaHandlers.set(event, fn),
  });
  Object.assign(page, { on: (_event: string, fn: Handler) => pageHandlers.push(fn) });
  vi.stubGlobal('figma', api);
  vi.stubGlobal('__html__', '<html></html>');
  vi.stubGlobal('__PLUGIN_VERSION__', '0.1.0');
  vi.resetModules();
  await import('../src/code');
  return { api, page: page as FakeNode, pageHandlers, figmaHandlers };
}

/** A container the trace renderer left on the page, as a crash would. */
function scratchContainer(page: FakeNode): { container: FakeNode; inner: FakeNode } {
  const container = new FakeNode('S:1', 'Archetype trace (scratch)', 'FRAME');
  container.world = { nodes: new Map(), flags: { skipInvisibleInstanceChildren: true }, log: [] };
  container.setPluginData('archetype.trace', 'scratch');
  const inner = new FakeNode('S:2', 'Dashboard', 'FRAME');
  inner.world = container.world;
  container.add(inner);
  page.add(container);
  return { container, inner };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('plugin entry point', () => {
  it('tells the designer when re-reading the page fails instead of keeping a stale flow', async () => {
    vi.useFakeTimers();
    const { api, page, pageHandlers } = await boot();
    page.findAll = () => {
      throw new Error('The page could not be read');
    };
    // Figma's node changes always name their node.
    for (const h of pageHandlers) h({ nodeChanges: [{ type: 'PROPERTY_CHANGE', node: page.children[0], properties: ['reactions'] }] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.notify).toHaveBeenCalledWith('Archetype: The page could not be read', { error: true });
  });

  it('does not re-read the page for a trace render\'s own changes', async () => {
    vi.useFakeTimers();
    const { api, page, pageHandlers } = await boot();
    const { container, inner } = scratchContainer(page);
    const docPosts = () => (api.ui.postMessage as ReturnType<typeof vi.fn>).mock.calls.filter((c) => (c[0] as { type: string }).type === 'doc').length;
    for (const h of pageHandlers) {
      h({ nodeChanges: [
        { type: 'CREATE', node: container },
        { type: 'CREATE', node: inner },
        { type: 'PROPERTY_CHANGE', node: inner, properties: ['reactions', 'name'] },
      ] });
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(docPosts()).toBe(0);
    // The designer's own change still refreshes the flow.
    for (const h of pageHandlers) h({ nodeChanges: [{ type: 'PROPERTY_CHANGE', node: page.children[0], properties: ['reactions'] }] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(docPosts()).toBe(1);
  });

  it('removes a leftover scratch container when the plugin closes', async () => {
    const { api, page, figmaHandlers } = await boot();
    const { container } = scratchContainer(page);
    figmaHandlers.get('close')?.();
    expect(page.children).not.toContain(container);
    expect(container.removed).toBe(true);
    expect(api.commitUndo).not.toHaveBeenCalled();
  });
});
