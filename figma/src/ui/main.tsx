import { render } from 'preact';
import { App } from './app';
import { onMain, toMain } from './bridge';
import { createEffects } from './effects';
import { createStore } from './store';

const store = createStore();
const fx = createEffects(store);
onMain((msg) => fx.handleMain(msg));
render(<App store={store} fx={fx} />, document.getElementById('app') as HTMLElement);
toMain({ type: 'ready' });
