import type { MainToUi, UiToMain } from '../lib/messages';

/** The panel talks to the main thread only through postMessage. */
export function toMain(msg: UiToMain): void {
  parent.postMessage({ pluginMessage: msg }, '*');
}

export function onMain(handler: (msg: MainToUi) => void): () => void {
  const listener = (event: MessageEvent) => {
    const data = event.data as { pluginMessage?: MainToUi } | null;
    if (data && typeof data === 'object' && data.pluginMessage && typeof data.pluginMessage.type === 'string') {
      handler(data.pluginMessage);
    }
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
