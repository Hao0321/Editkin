import type { ParameterGestureLeaseV1 } from "../application/transientParameterGestureV1";
import type { NativeImeEventV1 } from "./nativeImeEventV1";

interface Target {
  setPointerCapture?: (id: number) => void;
  hasPointerCapture?: (id: number) => boolean;
  releasePointerCapture?: (id: number) => void;
}
interface Event {
  currentTarget: Target; pointerId?: number; button?: number; isPrimary?: boolean; key?: string; repeat?: boolean;
  nativeEvent?: NativeImeEventV1;
  preventDefault: () => void; stopPropagation?: () => void;
}
const rangeKeys = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

/** Stable per mounted parameter panel, not per render. Browser range input still owns value/pointer math. */
export function createParameterRangeGestureInputV1() {
  type Held = { key: string; target: Target; pointerId?: number; lease?: ParameterGestureLeaseV1; aborted?: boolean; pointerTerminated?: boolean };
  let held: Held | undefined;
  const releaseCapture = (g: Held) => {
    if (g.pointerId === undefined) return;
    try { if (!g.target.hasPointerCapture || g.target.hasPointerCapture(g.pointerId)) g.target.releasePointerCapture?.(g.pointerId); } catch { /* detached node */ }
  };
  const end = (commit: boolean) => {
    const g = held; held = undefined;
    if (!g) return;
    try { if (commit) g.lease?.commit(); else g.lease?.cancel(); }
    finally { releaseCapture(g); }
  };
  const block = (release = false) => {
    const g = held; if (!g) return;
    const lease = g.lease; g.lease = undefined; g.aborted = true;
    if (release) g.pointerTerminated = true;
    try { lease?.cancel(); } finally { if (release) releaseCapture(g); }
  };
  const start = (key: string, event: Event, begin: () => ParameterGestureLeaseV1 | undefined, pointer = false) => {
    const g: Held = { key, target: event.currentTarget, ...(pointer ? { pointerId: event.pointerId } : {}) };
    held = g;
    try {
      const lease = begin();
      if (held !== g || g.aborted) {
        lease?.cancel();
        if (!held) { g.aborted = true; held = g; }
      } else g.lease = lease;
    } catch { if (held === g) g.aborted = true; }
    return held === g;
  };
  const matches = (key: string, event: Event) => held?.key === key && held.target === event.currentTarget;
  return {
    cancel: () => end(false),
    bind: (key: string, begin: () => ParameterGestureLeaseV1 | undefined) => ({
      change: (target: Target, value: number): boolean => {
        if (!held) return false;
        try { if (held.key !== key || held.target !== target || held.lease?.update(value) === false) block(); }
        catch { try { block(); } catch { /* A refused adapter still cannot fall back. */ } }
        return true; // Refused/stale beginnings never fall back to an unscoped command.
      },
      events: {
        onPointerDown: (event: Event) => {
          if (event.isPrimary === false || event.button !== undefined && event.button !== 0) { event.preventDefault(); return; }
          if (held?.aborted) end(false);
          if (held) { event.preventDefault(); return; }
          if (!start(key, event, begin, true)) return;
          try { if (event.pointerId !== undefined) event.currentTarget.setPointerCapture?.(event.pointerId); }
          catch { block(true); }
        },
        onPointerUp: (event: Event) => { if (matches(key, event) && held?.pointerId === event.pointerId) end(true); },
        onPointerCancel: (event: Event) => { if (matches(key, event) && held?.pointerId === event.pointerId) block(true); },
        onLostPointerCapture: (event: Event) => { if (matches(key, event) && held?.pointerId === event.pointerId) block(true); },
        onKeyDown: (event: Event) => {
          if (event.nativeEvent?.isComposing || event.nativeEvent?.keyCode === 229) return;
          if (event.key === "Escape" && matches(key, event)) { event.preventDefault(); event.stopPropagation?.(); block(); return; }
          if (!rangeKeys.has(event.key ?? "")) return;
          // Canceled pointers do not necessarily get pointerup. A fresh key press may take over,
          // but an Escape-aborted pointer that still holds capture must wait for release.
          if (held?.aborted && (held.pointerId === undefined || held.pointerTerminated) && event.repeat !== true) end(false);
          if (held?.aborted) { event.preventDefault(); return; }
          if (!held) start(key, event, begin);
        },
        onKeyUp: (event: Event) => {
          if (event.nativeEvent?.isComposing || event.nativeEvent?.keyCode === 229) return;
          if (rangeKeys.has(event.key ?? "") && matches(key, event) && held?.pointerId === undefined) end(true);
        },
        onBlur: (event: Event) => { if (matches(key, event)) { if (held?.pointerId === undefined) end(true); else block(true); } },
      },
    }),
  };
}
