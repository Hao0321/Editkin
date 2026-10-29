import { memo, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";
import type { EditorCommand } from "../domain/commandTypes";
import type { CaptionCue, MediaAsset, TimelineClip, TimelineTrack } from "../domain/types";
import { formatTime } from "../lib/format";
import { translateUi as uiText } from "./i18n/interfacePreferences";
import { EasyIcon } from "./easy/easyIcons";
import { TimelineFilmstrip } from "./TimelineFilmstrip";
import { TimelineAudioEnvelope } from "./TimelineAudioEnvelope";
import { clipWaveformWindow } from "./timelineWaveform";
import { TrackNameEditorV1, TrackQuickTogglesV1 } from "./TrackHeaderControlsV1";
import { TrackOptions } from "./TrackOptions";
import { BLADE_HELP, DRAG_HELP, LOCKED_HELP, type DragKind } from "./timelineContract";
import { timelineFrameLabel } from "./timelineInteraction";
import { usePlayheadSelection, usePlayheadStoreContext } from "./playheadStore";

/**
 * PF2 (2026-10-23): the timeline's clips, captions and track headers are memoised as elements. Timeline keeps one
 * element per item and reuses it while the item's own data are unchanged, so a scroll (or any other timeline render)
 * re-renders only the items that changed or scrolled into view; React skips a reused element and its children. The
 * markup is exactly what Timeline.tsx rendered inline. Handlers are Timeline's own, reached through stable forwarders
 * to the latest render's (`TimelineItemRuntimeV1`).
 */
type ItemRef = { kind: DragKind; id: string; trackId: string; trackKind: TimelineTrack["kind"]; start: number; duration: number; locked: boolean };
type TrimRef = { kind: DragKind; id: string; start: number; duration: number; locked: boolean };
export interface TimelineItemHandlersV1 {
  beginItemDrag(event: ReactPointerEvent<HTMLButtonElement>, item: ItemRef): void;
  moveItemDrag(event: ReactPointerEvent<HTMLButtonElement>): void;
  endItemDrag(event: ReactPointerEvent<HTMLButtonElement>): void;
  cancelItemDrag(event: ReactPointerEvent<HTMLButtonElement>): void;
  activateItem(event: ReactMouseEvent<HTMLButtonElement>, kind: DragKind, id: string, start: number): void;
  contextMenu(event: ReactMouseEvent<HTMLButtonElement>, clip: TimelineClip, track: TimelineTrack, asset: MediaAsset | undefined): void;
  beginTrim(event: ReactPointerEvent<HTMLElement>, item: TrimRef, edge: "start" | "end"): void;
  moveTrim(event: ReactPointerEvent<HTMLElement>): void;
  endTrim(event: ReactPointerEvent<HTMLElement>): void;
  cancelTrim(event: ReactPointerEvent<HTMLElement>): void;
  command(command: EditorCommand, message?: string): boolean | void;
  editStart(): void;
  refused(message: string): void;
  // Track headers.
  renameTrack(trackId: string, name: string): void;
  startRename(trackId: string): void;
  stopRename(): void;
  toggleHidden(trackId: string): void;
  toggleMute(trackId: string): void;
  toggleLock(trackId: string): void;
  deleteTrack(trackId: string): void;
  /** 獨奏: one set_track_solo for this track's state (as the inline closure did). */
  toggleSolo(trackId: string, solo: boolean): void;
  // Ruler and zoom.
  seek(time: number): void;
  zoom(factor: number): void;
  fit(): void;
}
type Cached = { deps: readonly unknown[]; element: ReactElement };
export interface TimelineItemRuntimeV1 {
  /** This render's handlers; the forwarders below call them. */
  latest?: TimelineItemHandlersV1;
  readonly handlers: TimelineItemHandlersV1;
  /** One element per item, reused while its dependencies are the same (pruned to the items of the last render). */
  cache: Map<string, Cached>;
  used: Map<string, Cached>;
}

export function createTimelineItemRuntimeV1(): TimelineItemRuntimeV1 {
  const runtime: TimelineItemRuntimeV1 = { cache: new Map(), used: new Map(), handlers: undefined! };
  const call = <K extends keyof TimelineItemHandlersV1>(key: K) => ((...args: unknown[]) =>
    (runtime.latest![key] as (...values: unknown[]) => unknown)(...args)) as TimelineItemHandlersV1[K];
  const keys: Array<keyof TimelineItemHandlersV1> = ["beginItemDrag", "moveItemDrag", "endItemDrag", "cancelItemDrag", "activateItem", "contextMenu",
    "beginTrim", "moveTrim", "endTrim", "cancelTrim", "command", "editStart", "refused", "renameTrack", "startRename", "stopRename", "toggleHidden",
    "toggleMute", "toggleLock", "deleteTrack", "toggleSolo", "seek", "zoom", "fit"];
  (runtime as { handlers: TimelineItemHandlersV1 }).handlers = Object.fromEntries(keys.map(key => [key, call(key)])) as unknown as TimelineItemHandlersV1;
  return runtime;
}

/** Starts a render: it reuses the items the previous render used (the others are dropped) and records its own. */
export function beginTimelineItemsV1(runtime: TimelineItemRuntimeV1, latest: TimelineItemHandlersV1) {
  runtime.latest = latest;
  runtime.cache = runtime.used;
  runtime.used = new Map();
}

/** The element for `key`, rebuilt only when one of `deps` changed (Object.is), as useMemo would per item. */
export function cachedTimelineItemV1(runtime: TimelineItemRuntimeV1, key: string, deps: readonly unknown[], build: () => ReactElement): ReactElement {
  const previous = runtime.cache.get(key) ?? runtime.used.get(key);
  const entry = previous && previous.deps.length === deps.length && previous.deps.every((value, index) => Object.is(value, deps[index]))
    ? previous : { deps, element: build() };
  runtime.used.set(key, entry);
  return entry.element;
}

const trimHandles = (item: TrimRef, extendable: boolean, handlers: TimelineItemHandlersV1) => item.locked ? null : <>
  <span className="clip-trim-handle start" title={uiText(item.kind === "clip" && extendable ? "拖曳修剪或拉長開頭" : "拖曳修剪開頭")} aria-hidden="true" onPointerDown={(event) => handlers.beginTrim(event, item, "start")} onPointerMove={handlers.moveTrim} onPointerUp={handlers.endTrim} onPointerCancel={handlers.cancelTrim} onLostPointerCapture={handlers.cancelTrim} />
  <span className="clip-trim-handle end" title={uiText(item.kind === "clip" && extendable ? "拖曳修剪或拉長結尾" : "拖曳修剪結尾")} aria-hidden="true" onPointerDown={(event) => handlers.beginTrim(event, item, "end")} onPointerMove={handlers.moveTrim} onPointerUp={handlers.endTrim} onPointerCancel={handlers.cancelTrim} onLostPointerCapture={handlers.cancelTrim} />
</>;

export function renderTimelineClipItemV1({ clip, track, asset, pixelsPerSecond, selected, blade, linked, clipHelp, extendable, waveformUrl, filmstripUrl, envelope, handlers }: {
  clip: TimelineClip; track: TimelineTrack; asset?: MediaAsset; pixelsPerSecond: number; selected: boolean; blade: boolean; linked: boolean;
  clipHelp: string; extendable: boolean; waveformUrl?: string; filmstripUrl?: string; envelope: boolean; handlers: TimelineItemHandlersV1;
}) {
  const kind = track.kind as "video" | "audio";
  const role = clip.layer?.role ?? "content";
  const isController = role === "controller";
  // An adjustment layer grades what is below it; it shows no picture or sound of its own (its source is never read).
  const isAdjustment = role === "adjustment";
  const clipName = isController ? `Null · ${clip.id}` : isAdjustment ? uiText("調整圖層") : asset?.name ?? clip.id;
  // The asset's whole-file waveform, cropped to the part of the media this clip plays (sourceStart … +duration); a
  // picture clip with sound shows it along its lower edge.
  const waveform = waveformUrl && asset ? clipWaveformWindow(clip, asset) : undefined;
  return <button type="button" key={clip.id} className={`timeline-clip ${isController ? "controller" : isAdjustment ? "adjustment" : ""} ${selected ? "selected" : ""} ${track.locked ? "locked" : ""}`} style={{ left: clip.timelineStart * pixelsPerSecond, width: Math.max(12, clip.duration * pixelsPerSecond) }} onPointerDown={(event) => handlers.beginItemDrag(event, { kind: "clip", id: clip.id, trackId: track.id, trackKind: track.kind, start: clip.timelineStart, duration: clip.duration, locked: track.locked })} onPointerMove={handlers.moveItemDrag} onPointerUp={handlers.endItemDrag} onPointerCancel={handlers.cancelItemDrag} onLostPointerCapture={handlers.cancelItemDrag} onClick={(event) => handlers.activateItem(event, "clip", clip.id, clip.timelineStart)}
    onContextMenu={event => handlers.contextMenu(event, clip, track, asset)} data-link-group={clip.linkGroupId} data-testid={`timeline-clip-${clip.id}`} data-layer-role={role} data-timeline-start={clip.timelineStart} data-duration={clip.duration} aria-label={uiText("{value0}，{value1}，可拖曳移動", { value0: clipName, value1: formatTime(clip.timelineStart) })} aria-disabled={track.locked} title={uiText(track.locked ? LOCKED_HELP : blade ? BLADE_HELP : clipHelp)}>
    {!isController && !isAdjustment && kind === "video" && <TimelineFilmstrip url={filmstripUrl} width={clip.duration * pixelsPerSecond} />}
    {waveform && <span className={`clip-waveform${kind === "video" ? " under-picture" : ""}`} aria-hidden="true" data-testid={`timeline-clip-waveform-${clip.id}`}
      data-source-start={waveform.sourceStart} data-source-end={waveform.sourceEnd}>
      <img src={waveformUrl} alt="" draggable={false} style={{ left: `${waveform.leftPercent}%`, width: `${waveform.widthPercent}%` }} /></span>}
    <span className="clip-pattern" /><strong>{linked && <span title={uiText("連結的片段")} data-testid={`timeline-clip-link-${clip.id}`}><EasyIcon name="link" size={12} /></span>}{clipName}</strong><small>{isController ? uiText("不渲染 · ") : isAdjustment ? uiText("影響下方 · ") : ""}{formatTime(clip.duration)}</small>
    {clip.keyframes.map((keyframe) => <i key={keyframe.id} className="keyframe-marker" style={{ left: `${(keyframe.time / clip.duration) * 100}%` }} />)}
    {trimHandles({ kind: "clip", id: clip.id, start: clip.timelineStart, duration: clip.duration, locked: track.locked }, extendable, handlers)}
    {envelope && asset && <TimelineAudioEnvelope clip={clip} pixelsPerSecond={pixelsPerSecond} music={asset.role === "background-music"} locked={track.locked} onCommand={handlers.command} onEditStart={handlers.editStart} onRefused={handlers.refused} />}
  </button>;
}

export function renderTimelineCaptionItemV1({ caption, track, pixelsPerSecond, selected, extendable, handlers }: {
  caption: CaptionCue; track: TimelineTrack; pixelsPerSecond: number; selected: boolean; extendable: boolean; handlers: TimelineItemHandlersV1;
}) {
  return <button type="button" key={caption.id} className={`timeline-clip caption ${selected ? "selected" : ""} ${track.locked ? "locked" : ""}`} style={{ left: caption.start * pixelsPerSecond, width: Math.max(12, caption.duration * pixelsPerSecond) }} onPointerDown={(event) => handlers.beginItemDrag(event, { kind: "caption", id: caption.id, trackId: track.id, trackKind: track.kind, start: caption.start, duration: caption.duration, locked: track.locked })} onPointerMove={handlers.moveItemDrag} onPointerUp={handlers.endItemDrag} onPointerCancel={handlers.cancelItemDrag} onLostPointerCapture={handlers.cancelItemDrag} onClick={(event) => handlers.activateItem(event, "caption", caption.id, caption.start)} data-testid={`timeline-caption-${caption.id}`} data-timeline-start={caption.start} data-duration={caption.duration} aria-label={uiText("{value0}{value1}，{value2}，可拖曳移動或修剪邊緣", { value0: caption.text, value1: caption.translation ? uiText("，英文 {value0}", { value0: caption.translation.text }) : "", value2: formatTime(caption.start) })} aria-disabled={track.locked} title={uiText(track.locked ? LOCKED_HELP : DRAG_HELP)}><span className="clip-pattern" /><strong>{caption.text}{caption.translation && <em>EN</em>}</strong><small>{formatTime(caption.duration)}</small>{trimHandles({ kind: "caption", id: caption.id, start: caption.start, duration: caption.duration, locked: track.locked }, extendable, handlers)}</button>;
}

/** CapCut-style header: name (double-click renames in place), its state for screen readers, and the quick switches. */
export function renderTimelineTrackLabelV1({ track, renaming, canHide, canSolo, handlers }: {
  track: TimelineTrack; renaming: boolean; canHide: boolean; canSolo: boolean; handlers: TimelineItemHandlersV1;
}) {
  const toggleSolo = canSolo ? (id: string) => handlers.toggleSolo(id, Boolean(track.solo)) : undefined;
  const toggleHidden = canHide ? handlers.toggleHidden : undefined;
  return <div className="track-label" data-drop-zone="blocked" title={uiText("這裡是軌道名稱，不是片段投放區")}><div className={`track-kind ${track.kind}`}>{track.kind === "video" ? "V" : track.kind === "audio" ? "A" : "T"}</div><div className="track-copy">{renaming
    ? <TrackNameEditorV1 name={track.name} label={uiText("{value0} 軌道名稱", { value0: track.name })} onCommit={name => handlers.renameTrack(track.id, name)} onDone={handlers.stopRename} />
    : <strong onDoubleClick={() => handlers.startRename(track.id)}>{track.name}{track.kind !== "caption" && track.solo && <span style={{ fontWeight: 800, color: "var(--accent)" }} data-testid={`track-solo-${track.id}`}> S</span>}</strong>}<span className={track.locked ? "track-locked" : track.kind === "video" && track.hidden ? "track-hidden" : undefined}>{track.locked ? uiText("已鎖定") : track.kind === "video" && track.hidden ? uiText("畫面已隱藏") : track.kind === "video" ? uiText("畫面") : track.kind === "audio" ? uiText("聲音") : uiText("文字")}</span>
    <TrackQuickTogglesV1 track={track} onToggleHidden={toggleHidden} onToggleMute={handlers.toggleMute} onToggleSolo={toggleSolo} onToggleLock={handlers.toggleLock} /></div><TrackOptions track={track} onStartRename={handlers.startRename} onToggleLock={handlers.toggleLock} onToggleHidden={toggleHidden} onToggleSolo={toggleSolo} onDelete={handlers.deleteTrack} /></div>;
}

/**
 * PF2: one playhead layer instead of one React-positioned playhead per lane. It renders the same `.playhead` line in each
 * lane slot (measured once per layout: the same CSS, so the same reach above each lane and the same marker), inside one
 * zero-width container that alone moves with the playhead: a tick changes one `left`. Without a PlayheadStoreContext
 * (a timeline rendered alone) `fallback` is the playhead.
 */
export const TimelinePlayheadOverlayV1 = memo(function TimelinePlayheadOverlayV1({ fallback, pixelsPerSecond, labelWidth, layoutKey }: { fallback: number; pixelsPerSecond: number; labelWidth: number; layoutKey: string }) {
  const store = usePlayheadStoreContext();
  const time = usePlayheadSelection(store, { time: fallback, seekRevision: 0 }, state => state.time);
  const ref = useRef<HTMLDivElement>(null);
  const [lanes, setLanes] = useState<{ left: number; slots: Array<{ top: number; height: number }> }>();
  const measured = useRef(lanes);
  useLayoutEffect(() => {
    const canvas = ref.current?.parentElement;
    if (!canvas) return;
    const measure = () => {
      // Each slot is its lane's padding box (the old per-lane playhead's containing block), in canvas coordinates.
      const box = canvas.getBoundingClientRect(), originTop = box.top + canvas.clientTop, originLeft = box.left + canvas.clientLeft;
      const elements = [...canvas.querySelectorAll<HTMLElement>(":scope > .timeline-row > .track-lane")];
      const first = elements[0];
      const next = { left: first ? first.getBoundingClientRect().left - originLeft + first.clientLeft : labelWidth,
        slots: elements.map(lane => ({ top: lane.getBoundingClientRect().top - originTop + lane.clientTop, height: lane.clientHeight })) };
      const current = measured.current;
      // A zoom or a resize that leaves the lanes where they were schedules nothing.
      if (current && current.left === next.left && current.slots.length === next.slots.length
        && current.slots.every((slot, index) => slot.top === next.slots[index].top && slot.height === next.slots[index].height)) return;
      measured.current = next;
      setLanes(next);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(canvas);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [layoutKey, labelWidth]);
  const slots = useMemo(() => lanes?.slots.map((slot, index) => <div key={index} className="timeline-playhead-slot" style={{ position: "absolute", left: 0, top: slot.top, height: slot.height, width: 0 }}>
    <div className="playhead" style={{ left: 0 }}><span /></div></div>), [lanes]);
  return <div ref={ref} className="timeline-playhead-layer" data-testid="timeline-playhead" aria-hidden="true"
    style={{ position: "absolute", top: 0, left: (lanes?.left ?? labelWidth) + time * pixelsPerSecond, width: 0, height: 0, pointerEvents: "none" }}>{slots}</div>;
});

/** The ruler's 分:秒:幀 readout of the live playhead (re-renders when the label changes, not with the timeline). */
export const TimelineRulerTimeV1 = memo(function TimelineRulerTimeV1({ fallback, fps }: { fallback: number; fps: number }) {
  const store = usePlayheadStoreContext();
  return <>{usePlayheadSelection(store, { time: fallback, seekRevision: 0 }, state => timelineFrameLabel(state.time, fps))}</>;
});

/**
 * Re-renders the timeline when a value derived from the live playhead differs from the one it rendered (`expected`):
 * 切開's disabled state follows the clip under the playhead, while the timeline does not re-render on a tick. Draws nothing.
 */
export function PlayheadWatchV1<T>({ fallback, select, expected, onChange }: { fallback: number; select: (time: number) => T; expected: T; onChange: () => void }) {
  const store = usePlayheadStoreContext();
  const value = usePlayheadSelection(store, { time: fallback, seekRevision: 0 }, state => select(state.time));
  useLayoutEffect(() => { if (!Object.is(expected, value)) onChange(); }, [value, expected, onChange]);
  return null;
}
