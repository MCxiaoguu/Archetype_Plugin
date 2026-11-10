import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeFigma, type FakeNode } from './fake-figma';

type Handler = (event?: unknown) => void;

/** Loads the plugin's entry point against a fake figma global and returns its event handlers. */
async function boot() {
  const { api, page } = makeFigma();
  const figmaHandlers = new Map<string, Handler>();
  const pageHandlers: Handler[] = [];
  Object.assign(api, {
    showUI: vi.fn(),
    on: (event: string, fn: Handler) => figmaHandlers.set(event, fn),
  });
  Object.assign(page, { on: (_event: string, fn: Handler) => pageHandlers.push(fn) });
  vi.stubGlobal('figma', api);
  vi.stubGlobal('__html__', '<html></html>');
  vi.stubGlobal('__PLUGIN_VERSION__', '0.1.0');
  vi.resetModules();
  await import('../src/code');
  return { api, page: page as FakeNode, pageHandlers };
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
    for (const h of pageHandlers) h({ nodeChanges: [{ type: 'PROPERTY_CHANGE', properties: ['reactions'] }] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.notify).toHaveBeenCalledWith('Archetype: The page could not be read', { error: true });
  });
});
