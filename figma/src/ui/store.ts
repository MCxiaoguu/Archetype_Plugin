import { useEffect, useState } from 'preact/hooks';
import { INITIAL_STATE, reducer, type Action, type AppState } from '../lib/state';

type Listener = (s: AppState) => void;

export interface Store {
  get(): AppState;
  dispatch(action: Action): void;
  subscribe(fn: Listener): () => void;
}

export function createStore(initial: AppState = INITIAL_STATE): Store {
  let state = initial;
  const listeners = new Set<Listener>();
  return {
    get: () => state,
    dispatch(action) {
      const next = reducer(state, action);
      if (next === state) return;
      state = next;
      for (const l of listeners) l(state);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

export function useStore(store: Store): AppState {
  const [s, set] = useState(store.get());
  useEffect(() => store.subscribe(set), [store]);
  return s;
}

/** Re-renders every `ms` while `active`, for elapsed time labels. */
export function useTicker(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return now;
}
