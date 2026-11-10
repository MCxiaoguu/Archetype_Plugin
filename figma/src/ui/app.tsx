import { useEffect, useRef, useState } from 'preact/hooks';
import type { AppState, Screen } from '../lib/state';
import { toMain } from './bridge';
import type { Effects } from './effects';
import { IconBack, IconClock, IconGear, Mark } from './icons';
import { Skeleton } from './parts';
import { History } from './screens/history';
import { NewTest } from './screens/newtest';
import { Progress } from './screens/progress';
import { Report } from './screens/report';
import { SettingsScreen } from './screens/settings';
import { SignIn } from './screens/signin';
import { useStore, type Store } from './store';

const TITLES: Partial<Record<Screen, string>> = {
  signin: 'Sign in',
  new: 'New test',
  progress: 'Running',
  report: 'Report',
  history: 'Past tests',
  settings: 'Settings',
};

function Header({ state, store, fx }: { state: AppState; store: Store; fx: Effects }) {
  const sub = state.screen === 'history' || state.screen === 'settings';
  const backTo: Screen = state.screen === 'settings' ? state.back : state.study ? (state.study.stage === 'done' && state.study.report ? 'report' : 'progress') : 'new';
  return (
    <header class="topbar">
      {sub ? (
        <button type="button" class="icon-btn" aria-label="Back" onClick={() => store.dispatch({ type: 'navigate', screen: state.token ? backTo : 'signin' })}>
          <IconBack />
        </button>
      ) : (
        <span class="brand" title="Archetype">
          <Mark size={15} />
          <span class="sr-only">Archetype</span>
        </span>
      )}
      <span class="topbar-title">
        {state.screen === 'progress' && state.study && ['creating', 'factors', 'archetypes', 'runs'].includes(state.study.stage) ? 'Launching' : TITLES[state.screen] ?? ''}
      </span>
      <nav class="topbar-actions" aria-label="Panel">
        {state.token && state.study && state.screen !== 'new' && !sub && (
          <button type="button" class="text-btn" onClick={() => fx.newTest()}>
            New test
          </button>
        )}
        {state.token && (
          <button
            type="button"
            class={`icon-btn${state.screen === 'history' ? ' is-on' : ''}`}
            aria-label="Past tests for this file"
            aria-pressed={state.screen === 'history'}
            title="Past tests"
            onClick={() => store.dispatch({ type: 'navigate', screen: state.screen === 'history' ? backTo : 'history' })}
          >
            <IconClock />
          </button>
        )}
        <button
          type="button"
          class={`icon-btn${state.screen === 'settings' ? ' is-on' : ''}`}
          aria-label="Settings"
          aria-pressed={state.screen === 'settings'}
          title="Settings"
          onClick={() => store.dispatch({ type: 'navigate', screen: state.screen === 'settings' ? state.back : 'settings' })}
        >
          <IconGear />
        </button>
      </nav>
    </header>
  );
}

function Toast({ state, store }: { state: AppState; store: Store }) {
  const n = state.notice;
  const inline = state.screen === 'signin' || state.screen === 'settings' || (state.screen === 'new' && n?.kind === 'error');
  // The toast stays while the pointer or keyboard focus is on it, so there is time to read it.
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!n || inline || held) return undefined;
    const id = setTimeout(() => store.dispatch({ type: 'notice', notice: null }), 5000);
    return () => clearTimeout(id);
  }, [n, inline, held, store]);
  if (!n || inline) return null;
  return (
    <div
      class={`toast toast-${n.kind}`}
      role={n.kind === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocusIn={() => setHeld(true)}
      onFocusOut={() => setHeld(false)}
    >
      <span>{n.text}</span>
      <button type="button" class="toast-x" aria-label="Dismiss" onClick={() => store.dispatch({ type: 'notice', notice: null })}>
        ×
      </button>
    </div>
  );
}

function ResizeHandle() {
  const start = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const onDown = (e: PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    start.current = { x: e.screenX, y: e.screenY, w: window.innerWidth, h: window.innerHeight };
  };
  const onMove = (e: PointerEvent) => {
    const s = start.current;
    if (!s) return;
    toMain({ type: 'resize', width: s.w + (e.screenX - s.x), height: s.h + (e.screenY - s.y) });
  };
  const onUp = (e: PointerEvent) => {
    start.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  };
  const onKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 60 : 20;
    const d: Record<string, [number, number]> = { ArrowRight: [step, 0], ArrowLeft: [-step, 0], ArrowDown: [0, step], ArrowUp: [0, -step] };
    const v = d[e.key];
    if (!v) return;
    e.preventDefault();
    toMain({ type: 'resize', width: window.innerWidth + v[0], height: window.innerHeight + v[1] });
  };
  return (
    <div
      class="resize"
      role="slider"
      tabIndex={0}
      aria-label="Resize panel (arrow keys)"
      aria-valuenow={window.innerWidth}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onKeyDown={onKey}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M9 3L3 9M9 6.5L6.5 9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
      </svg>
    </div>
  );
}

export function App({ store, fx }: { store: Store; fx: Effects }) {
  const state = useStore(store);
  let body;
  switch (state.screen) {
    case 'loading':
      body = (
        <div class="screen" aria-busy="true">
          <div class="scroll">
            <Skeleton lines={4} />
            <Skeleton lines={3} />
          </div>
        </div>
      );
      break;
    case 'signin':
      body = <SignIn state={state} fx={fx} />;
      break;
    case 'new':
      body = <NewTest state={state} store={store} fx={fx} />;
      break;
    case 'progress':
      body = <Progress state={state} fx={fx} />;
      break;
    case 'report':
      body = <Report state={state} fx={fx} />;
      break;
    case 'history':
      body = <History state={state} fx={fx} />;
      break;
    case 'settings':
      body = <SettingsScreen state={state} fx={fx} />;
      break;
  }
  return (
    <div class="app" data-screen={state.screen}>
      <Header state={state} store={store} fx={fx} />
      <main class="main">{body}</main>
      <Toast state={state} store={store} />
      <ResizeHandle />
    </div>
  );
}
