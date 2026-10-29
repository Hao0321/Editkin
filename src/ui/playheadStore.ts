import { createContext, useContext, useLayoutEffect, useReducer, useRef, type SetStateAction } from "react";
import { reducePlayheadTransport, type PlayheadTransportAction, type PlayheadTransportState } from "./playheadTransport";

/**
 * The playhead and playback clock outside React state (PF1, 2026-10-23). A seek or a device clock tick used to set App
 * state, so every update re-rendered App, EditorShell and everything under them (75–106 components per playback tick).
 * Now only the components that show time subscribe; commands read the transport when they run.
 *
 * Two views of the same transport:
 *  - getSnapshot(): the latest seek/clock, applied in order by the same reducer (a stale device tick never undoes a seek);
 *  - rendered(): the transport the editor last rendered. Commands (split at the playhead, add a caption, an Inspector
 *    edit's transport check) read this, exactly as they read the App render's `playhead` before.
 */
export interface PlayheadStore {
  getSnapshot(): PlayheadTransportState;
  subscribe(listener: () => void): () => void;
  seek(value: SetStateAction<number>): void;
  clock(time: number, seekRevision: number): void;
  rendered(): PlayheadTransportState;
  /** Called while the one PlayheadRenderObserver renders a snapshot. */
  markRendered(state: PlayheadTransportState): void;
  /** Listeners for a newly rendered transport, notified after that render commits (like an effect on the transport). */
  subscribeRendered(listener: () => void): () => void;
  /** Called by the observer's effect after a commit. */
  publishRendered(): void;
}

export function createPlayheadStore(initial: PlayheadTransportState = { time: 0, seekRevision: 0 }): PlayheadStore {
  let state = initial, rendered = initial, published = initial;
  const listeners = new Set<() => void>(), renderedListeners = new Set<() => void>();
  const dispatch = (action: PlayheadTransportAction) => {
    const next = reducePlayheadTransport(state, action);
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    seek: value => dispatch({ kind: "seek", value }),
    clock: (time, seekRevision) => dispatch({ kind: "clock", time, seekRevision }),
    rendered: () => rendered,
    markRendered(next) { rendered = next; },
    subscribeRendered(listener) { renderedListeners.add(listener); return () => { renderedListeners.delete(listener); }; },
    publishRendered() {
      if (published === rendered) return;
      published = rendered;
      for (const listener of [...renderedListeners]) listener();
    },
  };
}

/** Provided by EditorShell; components that show time read it, tests that render a component alone pass `playhead`. */
export const PlayheadStoreContext = createContext<PlayheadStore | undefined>(undefined);
export const usePlayheadStoreContext = () => useContext(PlayheadStoreContext);

/**
 * A value derived from the transport, re-rendering its component only when it changes (`isEqual`). Without a store the
 * value comes from `fallback` (a component rendered alone, as in its tests).
 *
 * Not useSyncExternalStore on purpose: that renders every store change at sync priority, so the same-value state updates
 * the preview's effects make after each tick (resident GPU preview, media failures) became a second, empty render per
 * tick. A subscriber here is updated at the priority of the seek or clock that moved the playhead, exactly as App's
 * useReducer playhead was before PF1 (a device tick is a normal update, a click or key is a discrete one), so those
 * effect updates batch with the next tick again. The value is read from the store while rendering; renders at these
 * priorities are not time-sliced, so every subscriber of one render reads the same transport.
 */
export function usePlayheadSelection<T>(store: PlayheadStore | undefined, fallback: PlayheadTransportState,
  select: (state: PlayheadTransportState) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const memo = useRef<{ value: T } | undefined>(undefined);
  const computed = select(store ? store.getSnapshot() : fallback);
  const value = memo.current && isEqual(memo.current.value, computed) ? memo.current.value : computed;
  memo.current = { value };
  const latest = useRef({ select, isEqual, value });
  latest.current = { select, isEqual, value };
  useLayoutEffect(() => {
    if (!store) return;
    const check = () => { const current = latest.current; if (!current.isEqual(current.value, current.select(store.getSnapshot()))) rerender(); };
    check(); // A change between this render and the subscription.
    return store.subscribe(check);
  }, [store]);
  return value;
}

const wholeTransport = (state: PlayheadTransportState) => state;
/** The whole transport; the component re-renders on every seek and clock tick. */
export function usePlayheadSnapshot(store: PlayheadStore): PlayheadTransportState {
  return usePlayheadSelection(store, store.getSnapshot(), wholeTransport);
}

/** Shallow equality of two plain records (numbers, strings, booleans); nested objects compare by identity. */
export function shallowEqualRecord(a: object | undefined, b: object | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(key => Object.prototype.hasOwnProperty.call(right, key) && Object.is(left[key], right[key]));
}
