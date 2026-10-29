import { memo, useEffect, useMemo, type ReactNode } from "react";
import type { PlayheadTransportState } from "./playheadTransport";
import { usePlayheadSelection, usePlayheadSnapshot, usePlayheadStoreContext, type PlayheadStore } from "./playheadStore";
import { ClipLayerHostContextV1, useClipLayerHostV1, type ClipLayerHostV1 } from "./clipLayerHostV1";

/**
 * The editor's one transport observer (PF1): it renders on every seek and clock tick, records the transport the editor
 * rendered (commands read it when they run) and, after the commit, tells the listeners that drop number drafts and
 * follow the playhead. It draws nothing.
 */
export const PlayheadRenderObserver = memo(function PlayheadRenderObserver({ store, onRender, onCommit }: {
  store: PlayheadStore;
  /** While rendering, as App's own render did before the transport left App state (In/Out range ownership). */
  onRender?: (state: PlayheadTransportState) => void;
  onCommit?: (state: PlayheadTransportState) => void;
}) {
  const state = usePlayheadSnapshot(store);
  store.markRendered(state);
  onRender?.(state);
  useEffect(() => { store.publishRendered(); onCommit?.(state); }, [store, state, onCommit]);
  return null;
});

const identity = (time: number) => time;

/**
 * Renders `children(time, selected)` with the live playhead. With `select`, it re-renders only when the selected value
 * changes (`isEqual`), so `time` is the playhead of that render: use it only through `select`'s result, and read the
 * store when a command runs. Without a PlayheadStoreContext (a component rendered alone) `fallback` is the playhead.
 */
export function LivePlayhead<T = number>({ fallback, select, isEqual, children }: {
  fallback: number;
  select?: (time: number) => T;
  isEqual?: (a: T, b: T) => boolean;
  children: (time: number, selected: T) => ReactNode;
}) {
  const store = usePlayheadStoreContext();
  const pick = (select ?? identity) as (time: number) => T;
  const selected = usePlayheadSelection(store, { time: fallback, seekRevision: 0 }, state => pick(state.time), isEqual);
  return <>{children(store ? store.getSnapshot().time : fallback, selected)}</>;
}

/** Text that shows the live playhead (the toolbar's time); `fallback` without a store. */
export function LivePlayheadText({ fallback, format }: { fallback: number; format: (time: number) => string }) {
  const store = usePlayheadStoreContext();
  const text = usePlayheadSelection(store, { time: fallback, seekRevision: 0 }, state => format(state.time));
  return <>{text}</>;
}

type LayerAtPlayhead = { inside: boolean; keyframeId?: string; opacity?: number; opacityPreview?: number };
const sameLayerAtPlayhead = (a: LayerAtPlayhead, b: LayerAtPlayhead) => a.inside === b.inside && a.keyframeId === b.keyframeId
  && Object.is(a.opacity, b.opacity) && Object.is(a.opacityPreview, b.opacityPreview);

/**
 * Re-provides the shell's ClipLayerHostV1 with what depends on the playhead (the ◆ state's time, the opacity at the
 * playhead and its preview) for the live transport, re-rendering the 混合 row only when one of those changes. `playhead`
 * in the provided host is the playhead of that change: the ◆ state it gives equals the live one (keyframeAtPlayheadV1).
 */
export function LiveClipLayerHostV1({ children }: { children: ReactNode }) {
  const base = useClipLayerHostV1();
  const store = usePlayheadStoreContext();
  const clip = base?.clipId ? base.project.tracks.find(track => track.clips.some(item => item.id === base.clipId))?.clips.find(item => item.id === base.clipId) : undefined;
  const live = usePlayheadSelection(store, { time: base?.playhead ?? 0, seekRevision: 0 }, (state): LayerAtPlayhead => {
    if (!base) return { inside: false };
    const time = state.time, local = clip ? time - clip.timelineStart : -1;
    // The same test as keyframeAtPlayheadV1 (ClipBlendControlsV1): inside the clip, a keyframe within half a frame.
    const inside = Boolean(clip) && local >= 0 && local <= clip!.duration;
    return { inside, keyframeId: inside ? clip!.keyframes.find(keyframe => Math.abs(keyframe.time - local) <= .5 / base.fps)?.id : undefined,
      opacity: base.opacityAt ? base.opacityAt(time) : base.opacity, opacityPreview: base.opacityPreviewAt ? base.opacityPreviewAt(time) : base.opacityPreview };
  }, sameLayerAtPlayhead);
  // `time` is the playhead of the change that produced `live` (a later tick with the same `live` keeps this host).
  const time = store ? store.getSnapshot().time : base?.playhead ?? 0;
  const host = useMemo<ClipLayerHostV1 | undefined>(() => base && { ...base, playhead: time, opacity: live.opacity, opacityPreview: live.opacityPreview }, [base, live]);
  return <ClipLayerHostContextV1.Provider value={host}>{children}</ClipLayerHostContextV1.Provider>;
}
