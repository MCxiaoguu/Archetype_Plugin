import { render } from 'preact';
import { App } from './app';
import { onMain, toMain } from './bridge';
import { createEffects } from './effects';
import { createStore } from './store';

const store = createStore();
const fx = createEffects(store);
onMain((msg) => fx.handleMain(msg));
// Closing the plugin tears the panel down: its sessions stop where they are and resume when it reopens.
window.addEventListener('pagehide', () => fx.closePanel());
render(<App store={store} fx={fx} />, document.getElementById('app') as HTMLElement);
toMain({ type: 'ready' });
