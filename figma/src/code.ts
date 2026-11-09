import type { UiToMain } from './lib/messages';
import { createController } from './main/controller';

declare const __PLUGIN_VERSION__: string;

figma.skipInvisibleInstanceChildren = true;
figma.showUI(__html__, { width: 380, height: 620, themeColors: true, title: 'Archetype' });

const controller = createController(figma, __PLUGIN_VERSION__);

function reportError(err: unknown) {
  const text = err instanceof Error ? err.message : String(err);
  figma.notify(`Archetype: ${text}`, { error: true });
}

figma.ui.onmessage = (msg: UiToMain) => {
  controller.handle(msg).catch(reportError);
};

figma.on('selectionchange', () => controller.pushSelection());

// Keep the flow graph fresh while the designer edits connections or names.
let timer: ReturnType<typeof setTimeout> | null = null;
function scheduleRefresh() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    // A failed read leaves the panel on the old flow, so say so.
    controller.refreshDoc().catch(reportError);
  }, 800);
}

function watchPage(page: PageNode) {
  page.on('nodechange', (event) => {
    const relevant = event.nodeChanges.some(
      (c) => c.type === 'CREATE' || c.type === 'DELETE' || (c.type === 'PROPERTY_CHANGE' && c.properties.some((p) => p === 'reactions' || p === 'name' || p === 'parent')),
    );
    if (relevant) scheduleRefresh();
  });
}

watchPage(figma.currentPage);
figma.on('currentpagechange', () => {
  watchPage(figma.currentPage);
  scheduleRefresh();
  controller.pushSelection();
});
