import { translateUi as uiText, translateUiStatus, useI18n } from "./i18n/interfacePreferences";
import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { TimelineClip, TimelineTrack } from "../domain/types";
import { useTimelineClipMenuControls } from "./useTimelineClipMenuControls";
import { formatTime } from "../lib/format";
import { TIMELINE_DRAG_THRESHOLD_PX, TIMELINE_MAGNET_THRESHOLD_PX, alignTimelineTime, nudgeTimelineTime, resolveTimelineDrag, resolveTimelineDropTarget, resolveTimelineTrim, timelineAutoScrollDelta, timelineTrackAutoScrollDelta, timelineFrameLabel, timelineTimeAtPointer, visibleTimelineDropLanes } from "./timelineInteraction";
import { EDITKIN_ASSET_DRAG_TYPE, resolveTimelineAssetDrop, timelineAssetDuration } from "./timelineAssetDrop";
import { INTERNAL_ASSET_POINTER_DRAG_EVENT, isInternalAssetPointerDragDetail, type InternalAssetPointerDragDetail } from "./internalAssetPointerDrag";
import { buildTimelineSnapIndex, queryTimelineSnapTimes, queryTimelineSnapTimesExcluding } from "./timelineSnapping";
import { formatMotionSeconds, motionBlockTop, motionLaneLayout, MOTION_LANE_COMPACT_VISIBLE_ROWS, timelineMotionBlocks, type TimelineMotionBlock } from "./timelineMotionBlocks";
import { resolveMotionBlockMove, resolveMotionBlockTrim } from "./timelineMotionGestures";
import { captionClashForMove, clipAttachments, clipHasTemplate, edgeAlignedGraphicIds, editTouchesTemplates, hasClipAttachments, motionGraphicBounds, planClipExtensionWithAttachments, planClipExtensionWithTemplates,
  planClipMoveWithAttachments, planClipTrimWithAttachments, planClipTrimWithTemplates, planMotionGraphicDelete, planMotionGraphicRange, planTemplateMove,
  templateFollowGlyphs, type MotionEditPlan } from "../application/timelineMotionEdits";
import { trackTemplateFollow } from "../application/templateFollowProgress";
import { requestTemplateEditor } from "./templateEditorRequests";
import { makeId } from "../lib/format";
import type { EditorCommand } from "../domain/commandTypes";
import { buildTimelineIntervalIndex, queryTimelineIntervalIndex, timelineRulerStep } from "./timelineViewport";
import { retainTimelineSelection } from "./timelineViewport";
import { cancelTimelinePointerEdits, createDeferredTimelineSelectionReveal, resolveTimelineSelectionReveal, timelineSelectionRevealKey } from "./timelineSelectionReveal";
import { scrollViewportByWheel } from "./wheelScroll";
import { libraryWheelDeltaPixels } from "./creativeLibraryPreview";
import { TrackOptions } from "./TrackOptions";
import { TimelineToolbarFit } from "./TimelineToolbarFit";
import { clampProjectSeek } from "./playbackTiming";
import { BLADE_HELP, BLADE_TOOL_HELP, CLIP_DRAG_HELP, DRAG_HELP, LOCKED_HELP, MAX_PIXELS_PER_SECOND, MIN_PIXELS_PER_SECOND, MOTION_BLOCK_HELP, MOTION_LANE_READONLY_HELP, PENDING_MOVE_REFUSAL, SELECT_TOOL_BACK, SELECT_TOOL_HELP, TEMPLATE_BLOCK_HELP, TIMELINE_LABEL_WIDTH as LABEL_WIDTH, type CachedDragLane, type DragKind, type DragSession, type MotionSession, type ScrubSession, type SlipSession, type TimelineEditOptions, type TimelineProps, type TimelineTool, type TrimSession } from "./timelineContract";
import { findSplitTarget, planBladeCuts } from "../application/timelineSplitTarget";
import { bladeTime, useTimelineBladeLine } from "./timelineBlade";
import { EasyIcon } from "./easy/easyIcons";
import { captionTrackLocked, TRACK_LOCKED_MESSAGE } from "../domain/trackLock";
import { clipWaveformWindow } from "./timelineWaveform";
import { clipExtensionLimits, clipSourceEditBlocker, clipSourceLimitMessage, clipSourceWindow, formatEditSeconds, planClipExtension, type ClipExtensionPlan } from "../domain/clipSourceEdits";
import { TimelineZoomControl } from "./TimelineZoomControl";
import { useTimelineViewRequest } from "./timelineViewRequests";
import { selectLinkedTimelineItem } from "../application/timelineLinkedSelection";
import { clipLinkMembers, linkedClipIds } from "../domain/clipLinks";
import { createTimelineGestureAdmission } from "./timelineGestureAdmission";
import { showTimelineMainDropLabel } from "./timelineMainDropLabel";
import { planRippleTrim } from "../application/timelineRippleEdits";
import { useTimelineCanvasEditing } from "./useTimelineCanvasEditing";
import { TimelineRulerMarkers } from "./TimelineRulerMarkers";
import { TimelineRangeOverlay } from "./TimelineRangeOverlay";
import { useTimelineAdjacentEditing } from "./useTimelineAdjacentEditing";
import { resolveMainTrackDrop } from "./timelineMainTrackDrop";
import { TimelineAudioEnvelope } from "./TimelineAudioEnvelope";
import { TimelineFilmstrip } from "./TimelineFilmstrip";
import { useTimelineFilmstripUrls } from "./useTimelineFilmstripUrls";
import "./timelineAdjacentEditing.css";
import "./timelineCanvasEditing.css";
import "./timelineDirectManipulation.css";
import "./timelineSourceEdits.css";
import "./timelineMotionLane.css";
import "./timelineSimple.css";
import "./timelineBlade.css";

/** Readout for an outward trim: how much longer, and what moves to make room. */
function extensionReadout(plan: ClipExtensionPlan): string {
  const seconds = formatEditSeconds(plan.seconds);
  const grown = uiText(plan.edge === "start" ? "開頭延長 {seconds} 秒" : "結尾延長 {seconds} 秒", { seconds });
  return plan.pushSeconds > 0
    ? `${grown} · ${uiText("後面內容往後移 {seconds} 秒", { seconds: formatEditSeconds(plan.pushSeconds) })}`
    : grown;
}

export function Timeline({ project, duration, playhead, selectedClipId, selectedCaptionId, selectedClipIds, selectedCaptionIds, onSelectionChange, markRange, markers, playing = false, onAddTitle, viewRequest, onFreezeFrame, onDetachAudio, onLinkClips, clipMediaBusy, runtimeUrls, draggingAssetId, onInsertAsset, onEditStart, onSeek: requestSeek, onSelect, onSelectCaption, onMoveClip, onMoveCaption, onTrimClip, onTrimCaption, onExtendClip, onSlipClip, onEditRefused, onCommand, onAddCaption, onEditSelection, onActivateSelection, onAddTrack, onRenameTrack, onToggleTrackLock, onDeleteTrack, onMakePictureInPicture, onPrecompose, onToggleMute, onToggleHidden, onSplit, onDelete, onCut, onStatus, keyboardActions, renderTrackOverlay }: TimelineProps) {
  const { mode: interfaceMode, locale: interfaceLocale, scale: interfaceScale } = useI18n();
  // Simple mode: the basic timeline behaviour just works (snapping always on, Alt pauses it while dragging) and the
  // toolbar shows only ＋ 文字, 切開, 刪除 and the zoom. Advanced mode keeps every tool and the 吸附 switch.
  const simpleMode = interfaceMode === "simple";
  // The ruler draws past the end for drops, but the playhead stops at the real
  // project end so it agrees with the transport readouts.
  const onSeek = (time: number) => requestSeek(clampProjectSeek(time, duration));
  const scrollRef = useRef<HTMLDivElement>(null);
  const [gestureAdmission] = useState(() => createTimelineGestureAdmission({ members: clipLinkMembers, captionsLocked: captionTrackLocked }));
  const dragRef = useRef<DragSession | undefined>(undefined);
  const dragFrameRef = useRef<number | undefined>(undefined);
  const dragLastFrameRef = useRef<number | undefined>(undefined);
  const assetPointerRef = useRef<InternalAssetPointerDragDetail | undefined>(undefined);
  const assetPointerFrameRef = useRef<number | undefined>(undefined);
  const assetPointerLastFrameRef = useRef<number | undefined>(undefined);
  const assetPointerHandlerRef = useRef<(detail: InternalAssetPointerDragDetail) => void>(() => {});
  const assetPointerFlushRef = useRef<(autoScroll: boolean, elapsedMs?: number) => ReturnType<typeof assetDropAtPoint>>(() => undefined);
  const scrubRef = useRef<ScrubSession | undefined>(undefined);
  const scrubFrameRef = useRef<number | undefined>(undefined);
  const trimRef = useRef<TrimSession | undefined>(undefined);
  const trimFrameRef = useRef<number | undefined>(undefined);
  const scrollFrameRef = useRef<number | undefined>(undefined);
  const latestScrollLeftRef = useRef(0);
  const suppressClickRef = useRef<string | undefined>(undefined);
  const committedDragRevealRef = useRef<{
    projectId: string; clipId: string; sourceKey: string | undefined;
    trackId: string; allowNewLayer: boolean; fps: number; startFrame: number; durationFrames: number;
  } | undefined>(undefined);
  const guideRef = useRef<HTMLDivElement>(null);
  const assetDropPreviewRef = useRef<HTMLDivElement>(null);
  const positionRef = useRef<HTMLOutputElement>(null);
  const slipRef = useRef<SlipSession | undefined>(undefined);
  const slipFrameRef = useRef<number | undefined>(undefined);
  const [selectionReveal] = useState(createDeferredTimelineSelectionReveal);
  const [selectionRevealRevision, setSelectionRevealRevision] = useState(0);
  const clipMenuControls = useTimelineClipMenuControls({ project, selectedClipIds, selectedClipId, onFreezeFrame, onDetachAudio, onLinkClips,
    clipMediaBusy, onSelect, setMotionSelection: value => setMotionSelection(value) });
  const [snapEnabled, setSnapEnabled] = useState(() => {
    try { return localStorage.getItem("editkin.timeline.snap") !== "off"; } catch { return true; }
  });
  // An 「off」 saved by an older version (or by the advanced switch) never turns snapping off in simple mode.
  const snapActive = simpleMode || snapEnabled;
  const [pixelsPerSecond, setPixelsPerSecond] = useState(80);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(900);
  // 標題與圖卡 lane: one gesture at a time, the selected block, and the live project for async commits.
  const motionRef = useRef<MotionSession | undefined>(undefined);
  const motionFrameRef = useRef<number | undefined>(undefined);
  const latestProjectRef = useRef(project);
  latestProjectRef.current = project;
  const [motionSelection, setMotionSelection] = useState<string>();
  // The editor selection a block was picked with; choosing anything else ends the block selection.
  const motionSelectionAnchorRef = useRef<{ clipId?: string; captionId?: string }>({});
  // Picking a title selects its main clip; the view must not jump away from the title that was just clicked.
  const motionRevealSkipRef = useRef<string | undefined>(undefined);
  // A clip move that carries titles is planned asynchronously; until it lands, more moves wait instead of piling up.
  const pendingClipMoveRef = useRef<Promise<boolean> | undefined>(undefined);
  const draggingAsset = project.assets.find((asset) => asset.id === draggingAssetId);
  const visualDuration = Math.max(12, duration + (draggingAsset ? timelineAssetDuration(draggingAsset, project.fps) + 1 : 4));
  const timelineWidth = Math.max(720, visualDuration * pixelsPerSecond);
  const assetMap = useMemo(() => new Map(project.assets.map((asset) => [asset.id, asset])), [project.assets]);
  const clipIndexes = useMemo(() => new Map(project.tracks.map((track) => [track.id, buildTimelineIntervalIndex(track.clips, (clip) => ({ start: clip.timelineStart, end: clip.timelineStart + clip.duration }))])), [project.tracks]);
  const captionIndex = useMemo(() => buildTimelineIntervalIndex(project.captions, (caption) => ({ start: caption.start, end: caption.start + caption.duration })), [project.captions]);
  const motionBlocks = useMemo(() => timelineMotionBlocks(project), [project.motionGraphics, project.referenceMotionInstances, project.motionScenes,
    project.tracks, project.motionTracks, project.fps]);
  const motionBlockById = useMemo(() => new Map(motionBlocks.map(block => [block.id, block])), [motionBlocks]);
  const selectedMotionBlock = motionSelection ? motionBlockById.get(motionSelection) : undefined;
  // Simple mode: overlapping titles get compact one-line rows, two at a time, so 主畫面 stays in view in a short window.
  // The rest open from 「還有 N 個」; a selected title in a later row (e.g. just dragged there) keeps them open.
  const [motionLaneOpen, setMotionLaneOpen] = useState(false);
  const motionLane = motionLaneLayout(motionBlocks, { simple: interfaceMode === "simple",
    expanded: motionLaneOpen || (selectedMotionBlock?.row ?? 0) >= MOTION_LANE_COMPACT_VISIBLE_ROWS });
  const toggleMotionLane = () => {
    const opening = motionLane.visibleRows < motionLane.rows;
    setMotionLaneOpen(opening);
    if (!opening && selectedMotionBlock && selectedMotionBlock.row >= MOTION_LANE_COMPACT_VISIBLE_ROWS) setMotionSelection(undefined);
  };
  const snapIndex = useMemo(() => buildTimelineSnapIndex(project, motionBlocks), [project.tracks, project.captions, project.director.markers, motionBlocks]);
  // The timeline's tool: 選取 (A) picks, drags and trims; 剪刀 (B) cuts the clip where it is clicked and nothing else: no
  // drag, move or trim, and the lanes do not move the playhead (the ruler still does). It stays on until A or Esc.
  const [tool, setTool] = useState<TimelineTool>("select");
  const blade = tool === "blade";
  const bladeLine = useTimelineBladeLine({ active: blade, pixelsPerSecond, fps: project.fps, playhead, snapIndex, labelWidth: LABEL_WIDTH });
  const chooseTool = (next: TimelineTool) => {
    if (next === tool) return;
    setTool(next);
    onStatus?.(next === "blade" ? BLADE_HELP : SELECT_TOOL_BACK);
  };
  const visibleStart = Math.max(0, scrollLeft / pixelsPerSecond - 2);
  const visibleEnd = Math.min(visualDuration, (scrollLeft + Math.max(1, viewportWidth - LABEL_WIDTH)) / pixelsPerSecond + 2);
  const pinnedClip = useMemo(() => {
    if (!selectedClipId) return undefined;
    for (const track of project.tracks) {
      const clip = track.clips.find(item => item.id === selectedClipId);
      if (clip) return { trackId: track.id, clip };
    }
    return undefined;
  }, [project.tracks, selectedClipId]);
  const selectionRevealKey = timelineSelectionRevealKey(selectedClipId, pinnedClip?.trackId,
    pinnedClip?.clip.timelineStart, pinnedClip?.clip.duration, project.fps);
  const pinnedCaption = useMemo(() => project.captions.find(caption => caption.id === selectedCaptionId), [project.captions, selectedCaptionId]);
  // A captured drag target must survive virtualization while edge-scrolling.
  const visibleClips = useMemo(() => new Map(project.tracks.map((track) => [track.id, track.kind === "caption" ? [] : retainTimelineSelection(queryTimelineIntervalIndex(clipIndexes.get(track.id)!, visibleStart, visibleEnd), pinnedClip?.trackId === track.id ? pinnedClip.clip : undefined, clipIndexes.get(track.id)!)])), [clipIndexes, project.tracks, visibleEnd, visibleStart, pinnedClip]);
  const filmstripUrls = useTimelineFilmstripUrls({ project, runtimeUrls, visibleClips, pixelsPerSecond, assetMap });
  const visibleCaptions = useMemo(() => retainTimelineSelection(queryTimelineIntervalIndex(captionIndex, visibleStart, visibleEnd), pinnedCaption, captionIndex), [captionIndex, visibleEnd, visibleStart, pinnedCaption]);
  const rulerStep = Math.max(1, Math.ceil(timelineRulerStep(pixelsPerSecond) * project.fps)) / project.fps;
  const marks = useMemo(() => {
    const first = Math.max(0, Math.floor(visibleStart / rulerStep) * rulerStep);
    const output: number[] = [];
    for (let value = first; value <= visibleEnd + rulerStep; value += rulerStep) output.push(Number(value.toFixed(6)));
    return output;
  }, [rulerStep, visibleEnd, visibleStart]);
  const frameTicks = useMemo(() => {
    if (pixelsPerSecond / project.fps < 5) return [];
    const first = Math.ceil(visibleStart * project.fps), last = Math.floor(visibleEnd * project.fps);
    return Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => (first + index) / project.fps);
  }, [project.fps, pixelsPerSecond, visibleStart, visibleEnd]);

  const toggleSnap = () => setSnapEnabled(value => {
    try { localStorage.setItem("editkin.timeline.snap", value ? "off" : "on"); } catch { /* A restricted profile still works in memory. */ }
    return !value;
  });

  const showEditPosition = (time?: number, snapTime?: number, detail?: string, tone?: "limit") => {
    const node = scrollRef.current;
    const guide = guideRef.current;
    const output = positionRef.current;
    if (guide) {
      // Keep the guide in the scrolling canvas, never across the sticky track labels.
      const inView = snapTime !== undefined && snapTime * pixelsPerSecond >= (node?.scrollLeft ?? 0);
      guide.hidden = !inView;
      if (inView) {
        guide.style.left = `${LABEL_WIDTH + snapTime * pixelsPerSecond}px`;
        guide.dataset.snapTime = String(snapTime);
      } else delete guide.dataset.snapTime;
    }
    if (output) {
      output.hidden = time === undefined && detail === undefined;
      if (tone) output.dataset.tone = tone; else delete output.dataset.tone;
      const position = time === undefined ? undefined
        : `${snapTime !== undefined ? "已吸附 · " : ""}${timelineFrameLabel(time, project.fps)} · 第 ${Math.round(time * project.fps)} 幀`;
      if (!output.hidden) output.textContent = [position, detail].filter(Boolean).join(" · ");
    }
  };

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const update = () => setViewportWidth(node.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const canvas = useTimelineCanvasEditing({ project, scrollRef, pixelsPerSecond, playing, playhead,
    selection: { clipIds: selectedClipIds ?? (selectedClipId ? [selectedClipId] : []), captionIds: selectedCaptionIds ?? (selectedCaptionId ? [selectedCaptionId] : []) },
    onSelectionChange, onEditStart, onCommand, onRefused: onEditRefused,
    otherBusy: () => Boolean(adjacent.active() || dragRef.current || trimRef.current || slipRef.current || assetPointerRef.current || scrubRef.current || motionRef.current) });
  const adjacent = useTimelineAdjacentEditing({ project, scrollRef, pixelsPerSecond, onCommand, onSelect, onEditStart, onRefused: onEditRefused,
    readout: (message, limited) => showEditPosition(undefined, undefined, message, limited ? "limit" : undefined),
    suppressClick: id => { suppressClickRef.current = `clip:${id}`; }, onDone: () => flushDeferredSelectionReveal() });
  const pointerEditing = () => Boolean(adjacent.active() || canvas.busy() || dragRef.current || trimRef.current || slipRef.current || assetPointerRef.current || scrubRef.current || motionRef.current);
  const flushDeferredSelectionReveal = () => {
    if (selectionReveal.resume(pointerEditing())) setSelectionRevealRevision(revision => revision + 1);
  };

  useEffect(() => {
    if (!selectionRevealKey || !pinnedClip) { committedDragRevealRef.current = undefined; selectionReveal.clear(); return; }
    // Pointer owners retain their exact scroll geometry; release/cancel flushes once.
    if (pointerEditing()) { selectionReveal.defer(); return; }
    if (motionRevealSkipRef.current !== undefined && motionRevealSkipRef.current === selectedClipId) {
      motionRevealSkipRef.current = undefined;
      selectionReveal.clear();
      return;
    }
    const committedDrag = committedDragRevealRef.current;
    if (committedDrag) {
      const sameClip = project.id === committedDrag.projectId && selectedClipId === committedDrag.clipId;
      const committedPlacement = sameClip && project.fps === committedDrag.fps
        && Math.round(pinnedClip.clip.timelineStart * project.fps) === committedDrag.startFrame
        && Math.round(pinnedClip.clip.duration * project.fps) === committedDrag.durationFrames
        && (pinnedClip.trackId === committedDrag.trackId || committedDrag.allowNewLayer);
      if (sameClip && selectionRevealKey === committedDrag.sourceKey) {
        // Controlled props may still contain the selected source after acceptance.
        selectionReveal.clear();
        return;
      }
      committedDragRevealRef.current = undefined;
      // A collision may append an offscreen layer; reveal its actual row after commit.
      if (committedPlacement && pinnedClip.trackId === committedDrag.trackId) { selectionReveal.clear(); return; }
    }
    selectionReveal.clear();
    const node = scrollRef.current;
    if (!node) return;
    const lane = [...node.querySelectorAll<HTMLElement>(".track-lane[data-track-id]")]
      .find(item => item.dataset.trackId === pinnedClip.trackId);
    const button = lane && [...lane.querySelectorAll<HTMLButtonElement>(".timeline-clip")]
      .find(item => item.dataset.testid === `timeline-clip-${pinnedClip.clip.id}`);
    if (!button?.isConnected || !node.contains(button)) return;
    const box = node.getBoundingClientRect(), clip = button.getBoundingClientRect();
    const next = resolveTimelineSelectionReveal({ viewportLeft: box.left + node.clientLeft, viewportTop: box.top + node.clientTop,
      clientWidth: node.clientWidth, clientHeight: node.clientHeight, labelWidth: LABEL_WIDTH,
      rulerBottom: node.querySelector<HTMLElement>(".ruler-row")?.getBoundingClientRect().bottom ?? box.top + node.clientTop,
      scrollLeft: node.scrollLeft, scrollTop: node.scrollTop, scrollWidth: node.scrollWidth, scrollHeight: node.scrollHeight, clip });
    if (!next) return;
    if (node.scrollLeft !== next.scrollLeft) node.scrollLeft = next.scrollLeft;
    if (node.scrollTop !== next.scrollTop) node.scrollTop = next.scrollTop;
  }, [project.id, selectionRevealKey, selectionRevealRevision]);

  useEffect(() => () => {
    gestureAdmission.clear();
    if (dragFrameRef.current !== undefined) cancelAnimationFrame(dragFrameRef.current);
    if (scrubFrameRef.current !== undefined) cancelAnimationFrame(scrubFrameRef.current);
    if (trimFrameRef.current !== undefined) cancelAnimationFrame(trimFrameRef.current);
    if (slipFrameRef.current !== undefined) cancelAnimationFrame(slipFrameRef.current);
    if (scrollFrameRef.current !== undefined) cancelAnimationFrame(scrollFrameRef.current);
    if (assetPointerFrameRef.current !== undefined) cancelAnimationFrame(assetPointerFrameRef.current);
    if (motionFrameRef.current !== undefined) cancelAnimationFrame(motionFrameRef.current);
    dragLastFrameRef.current = undefined;
    assetPointerLastFrameRef.current = undefined;
    assetPointerRef.current = undefined;
    motionRef.current = undefined;
  }, []);

  // A block stays selected until the creator picks another clip or caption, or the block is gone (deleted or undone).
  useEffect(() => {
    if (!motionSelection) return;
    const anchor = motionSelectionAnchorRef.current;
    if (!motionBlockById.has(motionSelection) || anchor.clipId !== selectedClipId || anchor.captionId !== selectedCaptionId) setMotionSelection(undefined);
  }, [selectedClipId, selectedCaptionId, motionBlockById, motionSelection]);

  const fit = () => {
    if (pointerEditing()) return;
    setPixelsPerSecond(Math.max(MIN_PIXELS_PER_SECOND, Math.min(MAX_PIXELS_PER_SECOND, (viewportWidth - LABEL_WIDTH - 24) / visualDuration)));
  };
  const zoom = (factor: number, anchorClientX?: number) => {
    // Captured gestures use one pixel/time clock until release. Changing scale
    // midway mixes the old grab offset with a new clock and jumps the clip.
    if (pointerEditing()) return;
    const node = scrollRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const anchorViewportX = anchorClientX === undefined ? Math.max(0, viewportWidth - LABEL_WIDTH) / 2 : Math.max(0, anchorClientX - rect.left - LABEL_WIDTH);
    const anchorTime = Math.max(0, node.scrollLeft + anchorViewportX) / pixelsPerSecond;
    const next = Math.max(MIN_PIXELS_PER_SECOND, Math.min(MAX_PIXELS_PER_SECOND, pixelsPerSecond * factor));
    setPixelsPerSecond(next);
    requestAnimationFrame(() => { node.scrollLeft = Math.max(0, anchorTime * next - anchorViewportX); });
  };
  const zoomToFrames = () => {
    const node = scrollRef.current;
    const anchorTime = pinnedClip?.clip.timelineStart ?? playhead;
    const position = anchorTime * pixelsPerSecond - (node?.scrollLeft ?? 0);
    const anchorClientX = node && position >= 0 && position <= node.clientWidth - LABEL_WIDTH
      ? node.getBoundingClientRect().left + LABEL_WIDTH + position : undefined;
    zoom(Math.max(1, Math.min(MAX_PIXELS_PER_SECOND, project.fps * 8) / pixelsPerSecond), anchorClientX);
  };

  useTimelineViewRequest(viewRequest, { busy: pointerEditing, simpleMode, zoom, fit, frames: zoomToFrames, toggleSnap });

  const clearAssetDropVisual = () => {
    if (assetDropPreviewRef.current) {
      assetDropPreviewRef.current.hidden = true;
      delete assetDropPreviewRef.current.dataset.newLayer;
    }
    if (scrollRef.current?.dataset.dropState?.startsWith("asset-")) delete scrollRef.current.dataset.dropState;
    showEditPosition();
  };

  useEffect(() => {
    if (!draggingAssetId && !assetPointerRef.current && scrollRef.current?.dataset.dropState !== "asset-rejected") clearAssetDropVisual();
  }, [draggingAssetId]);

  const showDropRejection = (asset = false) => {
    if (scrollRef.current) scrollRef.current.dataset.dropState = asset ? "asset-rejected" : "rejected";
    if (positionRef.current) {
      positionRef.current.hidden = false;
      positionRef.current.textContent = asset ? "素材未加入；請選擇有效的軌道與位置" : "未套用拖移；位置保持不變";
    }
  };

  function assetDropAtPoint(assetId: string, clientX: number, clientY: number, altKey: boolean, ctrlKey: boolean) {
    const node = scrollRef.current, asset = project.assets.find(item => item.id === assetId);
    if (!node || !asset || !onInsertAsset) return undefined;
    const lane = resolveTimelineDropTarget(clientX, clientY, asset.kind === "audio" ? "audio" : "video", currentDropLanes().map(item => ({ ...item, locked: false })));
    const track = project.tracks.find(item => item.id === lane?.trackId);
    if (!lane || !track || track.kind !== lane.trackKind) return undefined;
    const rawTime = Math.max(0, (clientX - node.getBoundingClientRect().left - node.clientLeft - LABEL_WIDTH + node.scrollLeft) / pixelsPerSecond);
    const assetDuration = timelineAssetDuration(asset, project.fps);
    if (track.id === "video-main") return { trackId: track.id, lane: lane.element, ...resolveMainTrackDrop(track, rawTime, assetDuration, project.fps, ctrlKey) };
    const margin = TIMELINE_MAGNET_THRESHOLD_PX / pixelsPerSecond + 1 / project.fps;
    const occupied = queryTimelineIntervalIndex(clipIndexes.get(track.id)!, Math.max(0, rawTime - margin), rawTime + assetDuration + margin);
    const preliminary = alignTimelineTime(rawTime, project.fps);
    const candidates = queryTimelineSnapTimes(snapIndex, `asset:${asset.id}`, [preliminary, preliminary + assetDuration], pixelsPerSecond, project.fps, playhead);
    const result = resolveTimelineAssetDrop({ rawTime, duration: assetDuration,
      fps: project.fps, pixelsPerSecond, snapCandidates: candidates, occupied, magnetEnabled: snapActive && !altKey, collisionPolicy: "new-layer" });
    return { trackId: track.id, lane: lane.element, mode: undefined, result: { ...result, allowed: !track.locked && result.allowed } };
  }

  const showAssetDrop = (placement: ReturnType<typeof assetDropAtPoint>) => {
    const node = scrollRef.current, ghost = assetDropPreviewRef.current;
    if (node) node.dataset.dropState = !placement ? "asset-incompatible" : placement.result.allowed
      ? placement.result.newLayer ? "asset-new-layer" : "asset-valid" : "asset-rejected";
    if (!node || !ghost || !placement) { if (ghost) ghost.hidden = true; showEditPosition(); return; }
    const { result, lane } = placement, nodeRect = node.getBoundingClientRect(), laneRect = lane.getBoundingClientRect();
    ghost.hidden = false;
    ghost.style.left = `${LABEL_WIDTH + result.start * pixelsPerSecond}px`;
    ghost.style.top = `${laneRect.top - nodeRect.top - node.clientTop + node.scrollTop + 5}px`;
    ghost.style.width = `${Math.max(12, result.duration * pixelsPerSecond)}px`;
    ghost.style.height = `${Math.max(12, lane.clientHeight - 10)}px`;
    ghost.dataset.timelineStart = String(result.start);
    ghost.dataset.targetTrackId = placement.trackId;
    ghost.dataset.allowed = String(result.allowed);
    ghost.dataset.newLayer = String(result.newLayer);
    showTimelineMainDropLabel(ghost, placement);
    ghost.dataset.snapTime = result.snappedTo === undefined ? "" : String(result.snappedTo);
    showEditPosition(result.start, result.allowed && !placement.mode ? result.snappedTo : undefined);
  };

  const assetDropAt = (event: ReactDragEvent<HTMLDivElement>) => {
    return draggingAssetId ? assetDropAtPoint(draggingAssetId, event.clientX, event.clientY, event.altKey, event.ctrlKey) : undefined;
  };

  const previewAssetDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!draggingAssetId || !event.dataTransfer.types.includes(EDITKIN_ASSET_DRAG_TYPE)) return;
    event.preventDefault();
    event.stopPropagation();
    const placement = assetDropAt(event);
    event.dataTransfer.dropEffect = placement?.result.allowed ? "copy" : "none";
    showAssetDrop(placement);
  };

  const leaveAssetDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    clearAssetDropVisual();
  };

  const commitAssetDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!draggingAssetId || !event.dataTransfer.types.includes(EDITKIN_ASSET_DRAG_TYPE)) return;
    event.preventDefault();
    event.stopPropagation();
    const placement = assetDropAt(event);
    clearAssetDropVisual();
    if (event.dataTransfer.getData(EDITKIN_ASSET_DRAG_TYPE) !== draggingAssetId || !placement?.result.allowed) {
      if (placement && project.tracks.find(track => track.id === placement.trackId)?.locked) onEditRefused?.(TRACK_LOCKED_MESSAGE);
      showDropRejection(true); return;
    }
    onEditStart?.();
    if (onInsertAsset?.(draggingAssetId, placement.trackId, placement.result.start, placement.mode) === false) showDropRejection(true);
  };

  const handleWheel = (event: WheelEvent) => {
    const node = scrollRef.current;
    if (!node) return;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      zoom(Math.exp(-libraryWheelDeltaPixels(event.deltaY, event.deltaMode, node.clientHeight) * 0.002), event.clientX);
    } else {
      const horizontal = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY) || node.scrollHeight <= node.clientHeight + 1;
      scrollViewportByWheel(node, event, horizontal ? "horizontal" : "vertical");
    }
  };

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.addEventListener("wheel", handleWheel, { passive: false });
    return () => node.removeEventListener("wheel", handleWheel);
  }, [pixelsPerSecond, viewportWidth]);

  const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
    latestScrollLeftRef.current = event.currentTarget.scrollLeft;
    // The time under a resting 剪刀 pointer changes when the timeline scrolls under it.
    if (blade) bladeLine.refresh();
    if (scrollFrameRef.current !== undefined) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = undefined;
      setScrollLeft(latestScrollLeftRef.current);
    });
  };

  const currentDropLanes = (): CachedDragLane[] => {
    const node = scrollRef.current;
    if (!node) return [];
    const rect = node.getBoundingClientRect(), left = rect.left + node.clientLeft, top = rect.top + node.clientTop;
    const ruler = node.querySelector<HTMLElement>(".ruler-row")?.getBoundingClientRect();
    const viewport = { left: left + LABEL_WIDTH, right: left + node.clientWidth,
      top: Math.max(top, ruler?.bottom ?? top), bottom: top + node.clientHeight };
    const lanes = [...node.querySelectorAll<HTMLElement>(".track-lane[data-track-id]")].map(lane => {
      const box = lane.getBoundingClientRect();
      return { element: lane, trackId: lane.dataset.trackId ?? "", trackKind: lane.dataset.trackKind as TimelineTrack["kind"],
        locked: lane.dataset.trackLocked === "true", left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    });
    return visibleTimelineDropLanes(lanes, viewport);
  };

  const trackContentAtPoint = (clientX: number, clientY: number) => {
    const node = scrollRef.current;
    if (!node || ![clientX, clientY].every(Number.isFinite)) return undefined;
    const rect = node.getBoundingClientRect(), left = rect.left + node.clientLeft, top = rect.top + node.clientTop;
    // Labels, the sticky ruler and actual scrollbars are never edge targets.
    const ruler = node.querySelector<HTMLElement>(".ruler-row")?.getBoundingClientRect();
    const content = { left: left + LABEL_WIDTH, right: left + node.clientWidth,
      top: Math.max(top, ruler?.bottom ?? top), bottom: top + node.clientHeight };
    return clientX >= content.left && clientX < content.right && clientY >= content.top && clientY < content.bottom
      ? content : undefined;
  };

  const scrollTrackStack = (clientX: number, clientY: number, elapsedMs: number): boolean => {
    const node = scrollRef.current, content = trackContentAtPoint(clientX, clientY);
    if (!node || !content || !Number.isFinite(elapsedMs)) return false;
    const delta = timelineTrackAutoScrollDelta(clientY, content.top, content.bottom, elapsedMs);
    if (!delta) return false;
    const before = node.scrollTop;
    node.scrollTop = Math.max(0, Math.min(Math.max(0, node.scrollHeight - node.clientHeight), before + delta));
    return node.scrollTop !== before;
  };

  function scheduleAssetPointer() {
    if (assetPointerFrameRef.current !== undefined) return;
    assetPointerLastFrameRef.current ??= performance.now();
    assetPointerFrameRef.current = requestAnimationFrame(timestamp => {
      assetPointerFrameRef.current = undefined;
      const elapsedMs = Math.max(0, timestamp - (assetPointerLastFrameRef.current ?? timestamp));
      assetPointerLastFrameRef.current = timestamp;
      assetPointerFlushRef.current(true, elapsedMs);
      if (assetPointerFrameRef.current === undefined) assetPointerLastFrameRef.current = undefined;
    });
  }

  assetPointerFlushRef.current = (allowAutoScroll, elapsedMs = 0) => {
    const session = assetPointerRef.current, node = scrollRef.current;
    if (!session || !node || !session.moved) return undefined;
    if (!session.sourceElement.isConnected || !session.scopeElement.contains(session.sourceElement)
      || session.scopeElement !== node.closest(".app-shell")) {
      assetPointerRef.current = undefined;
      assetPointerLastFrameRef.current = undefined;
      clearAssetDropVisual();
      flushDeferredSelectionReveal();
      return undefined;
    }
    let placement = assetDropAtPoint(session.assetId, session.clientX, session.clientY, session.altKey, session.ctrlKey);
    const content = trackContentAtPoint(session.clientX, session.clientY);
    if (allowAutoScroll && content) {
      // Traversal is allowed past a locked/wrong-kind lane; drop admission stays
      // strict and is recalculated from the newly visible live lane geometry.
      let scrolled = scrollTrackStack(session.clientX, session.clientY, elapsedMs);
      if (scrolled) placement = assetDropAtPoint(session.assetId, session.clientX, session.clientY, session.altKey, session.ctrlKey);
      const delta = timelineAutoScrollDelta(session.clientX, content.left, content.right, elapsedMs);
      if (delta) {
        const before = node.scrollLeft;
        node.scrollLeft = Math.max(0, before + delta);
        if (node.scrollLeft !== before) {
          placement = assetDropAtPoint(session.assetId, session.clientX, session.clientY, session.altKey, session.ctrlKey);
          scrolled = true;
        }
      }
      if (scrolled) scheduleAssetPointer();
    }
    showAssetDrop(placement);
    return placement;
  };

  assetPointerHandlerRef.current = (detail) => {
    const scope = scrollRef.current?.closest(".app-shell");
    if (!scope || detail.scopeElement !== scope) return;
    const previous = assetPointerRef.current;
    if (detail.phase === "start") {
      if (!onInsertAsset || dragRef.current || trimRef.current || slipRef.current || scrubRef.current
        || !project.assets.some(asset => asset.id === detail.assetId)) return;
      onEditStart?.();
      committedDragRevealRef.current = undefined;
      if (assetPointerFrameRef.current !== undefined) cancelAnimationFrame(assetPointerFrameRef.current);
      assetPointerFrameRef.current = undefined;
      assetPointerLastFrameRef.current = undefined;
      clearAssetDropVisual();
      assetPointerRef.current = detail;
      return;
    }
    if (!previous || previous.sessionId !== detail.sessionId || previous.pointerId !== detail.pointerId
      || previous.assetId !== detail.assetId || previous.sourceElement !== detail.sourceElement) return;
    if (detail.phase === "cancel") {
      if (assetPointerFrameRef.current !== undefined) cancelAnimationFrame(assetPointerFrameRef.current);
      assetPointerFrameRef.current = undefined;
      assetPointerLastFrameRef.current = undefined;
      assetPointerRef.current = undefined;
      clearAssetDropVisual();
      flushDeferredSelectionReveal();
      return;
    }
    assetPointerRef.current = detail;
    if (detail.phase === "move") { if (detail.moved) scheduleAssetPointer(); return; }
    if (assetPointerFrameRef.current !== undefined) cancelAnimationFrame(assetPointerFrameRef.current);
    assetPointerFrameRef.current = undefined;
    assetPointerLastFrameRef.current = undefined;
    // Release uses current live geometry and current project, not a prior RAF's candidate.
    const placement = assetPointerFlushRef.current(false);
    assetPointerRef.current = undefined;
    clearAssetDropVisual();
    flushDeferredSelectionReveal();
    if (!detail.moved) return;
    if (!placement?.result.allowed) {
      if (placement && project.tracks.find(track => track.id === placement.trackId)?.locked) onEditRefused?.(TRACK_LOCKED_MESSAGE);
      showDropRejection(true); return;
    }
    if (onInsertAsset?.(detail.assetId, placement.trackId, placement.result.start, placement.mode) === false) showDropRejection(true);
  };

  useEffect(() => {
    const document = scrollRef.current?.ownerDocument;
    if (!document) return;
    const handle = (event: Event) => {
      const detail: unknown = (event as CustomEvent<unknown>).detail;
      if (isInternalAssetPointerDragDetail(detail)) assetPointerHandlerRef.current(detail);
    };
    document.addEventListener(INTERNAL_ASSET_POINTER_DRAG_EVENT, handle);
    return () => {
      document.removeEventListener(INTERNAL_ASSET_POINTER_DRAG_EVENT, handle);
      if (assetPointerFrameRef.current !== undefined) cancelAnimationFrame(assetPointerFrameRef.current);
      assetPointerFrameRef.current = undefined;
      assetPointerLastFrameRef.current = undefined;
      assetPointerRef.current = undefined;
    };
  }, []);

  const compatibleLaneAtPointer = (session: DragSession): HTMLElement | undefined => {
    session.lanes = currentDropLanes();
    // A clip under a title template keeps its track: the template is bound to it there.
    if (session.lockTrack) return session.element.closest<HTMLElement>(".track-lane") ?? undefined;
    return resolveTimelineDropTarget(session.currentClientX, session.currentClientY, session.trackKind, session.lanes)?.element;
  };

  /** Run a plan as one command; a refusal is shown in plain words and changes nothing. */
  const runPlan = (make: () => MotionEditPlan | undefined, options?: TimelineEditOptions): boolean => {
    let plan: MotionEditPlan | undefined;
    try { plan = make(); } catch (error) { onEditRefused?.(error instanceof Error ? error.message : uiText("這次調整沒有套用。")); return false; }
    return Boolean(plan) && runEdit(plan!, options) !== false;
  };

  /** Hand one plan to the editor; `options` (a held nudge's shared Undo step) only when there are any. */
  const runEdit = (plan: MotionEditPlan, options?: TimelineEditOptions) => options
    ? onCommand?.(plan.command, plan.message, options) : onCommand?.(plan.command, plan.message);

  /** Template moves re-record the template asynchronously; the result applies only to the project it was planned on. */
  const runAsyncPlan = async (make: () => Promise<MotionEditPlan | undefined>, base: typeof project, onRefused?: () => void,
    staleMessage = "專案剛剛有變更，這次移動沒有套用；請再拖一次。", options?: TimelineEditOptions): Promise<boolean> => {
    try {
      const plan = await make();
      if (!plan) return false;
      if (latestProjectRef.current !== base) {
        onEditRefused?.(uiText(staleMessage));
        onRefused?.();
        return false;
      }
      const accepted = runEdit(plan, options) !== false;
      if (!accepted) onRefused?.();
      return accepted;
    } catch (error) {
      onEditRefused?.(error instanceof Error ? error.message : uiText("這次調整沒有套用。"));
      onRefused?.();
      return false;
    }
  };

  /** A clip edit with following titles: true when it ran as one command; false keeps the editor's plain edit. */
  const commitWithFollowers = (make: () => MotionEditPlan | undefined): boolean => {
    let plan: MotionEditPlan | undefined;
    try { plan = make(); } catch { return false; }
    if (!plan) return false;
    onCommand?.(plan.command, plan.message);
    return true;
  };

  /** A clip and the titles, captions and template that follow it move as one command; a plain clip keeps the editor's own move. */
  const commitClipMove = (clipId: string, start: number, trackId: string, onRefused?: () => void, options?: TimelineEditOptions): boolean | void => {
    const base = latestProjectRef.current;
    if (!onCommand || !hasClipAttachments(base, clipId)) return options ? onMoveClip(clipId, start, trackId, options) : onMoveClip(clipId, start, trackId);
    if (pendingClipMoveRef.current) { onEditRefused?.(uiText(PENDING_MOVE_REFUSAL)); return false; }
    const glyphs = templateFollowGlyphs();
    const moving = runAsyncPlan(() => planClipMoveWithAttachments(base, clipId, trackId, start, makeId, glyphs), base, onRefused, undefined, options).finally(glyphs.dispose);
    void trackPendingMove(clipHasTemplate(base, clipId) ? trackTemplateFollow(moving, { stillCurrent: () => latestProjectRef.current === base }) : moving);
    return undefined;
  };

  /** A trim or extension of a clip under a title template: the template is laid out again on the edited clip, one command. */
  const commitTemplateClipEdit = (make: (glyphs: ReturnType<typeof templateFollowGlyphs>, base: typeof project) => Promise<MotionEditPlan | undefined>) => {
    if (pendingClipMoveRef.current) { onEditRefused?.(uiText(PENDING_MOVE_REFUSAL)); return; }
    const base = latestProjectRef.current, glyphs = templateFollowGlyphs();
    void trackPendingMove(trackTemplateFollow(runAsyncPlan(() => make(glyphs, base), base, undefined, "專案剛剛有變更，這次修剪沒有套用；請再試一次。").finally(glyphs.dispose),
      { stillCurrent: () => latestProjectRef.current === base }));
  };

  /** One asynchronous move at a time: the next one would start from a place that is about to change. */
  const trackPendingMove = (pending: Promise<boolean>): Promise<boolean> => {
    const tracked: Promise<boolean> = pending.finally(() => { if (pendingClipMoveRef.current === tracked) pendingClipMoveRef.current = undefined; });
    pendingClipMoveRef.current = tracked;
    return tracked;
  };

  /** What moves with a clip during a drag preview: the title blocks bound to it and the captions inside it. */
  const clipFollowers = (clipId: string) => {
    const bound = motionBlocks.filter(block => block.boundClipId === clipId && block.kind !== "scene");
    const ids = new Set(bound.map(block => block.id));
    const elements = [...(scrollRef.current?.querySelectorAll<HTMLElement>("[data-motion-block-id]") ?? [])]
      .filter(element => ids.has(element.dataset.motionBlockId ?? ""));
    let captionIds: string[] = [];
    try { captionIds = clipAttachments(latestProjectRef.current, clipId).captions.map(caption => caption.id); } catch { /* An invalid clock moves nothing. */ }
    const escape = (id: string) => typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id;
    for (const id of captionIds) {
      const element = scrollRef.current?.querySelector<HTMLElement>(`[data-testid="${escape(`timeline-caption-${id}`)}"]`);
      if (element) elements.push(element);
    }
    return { elements, owners: new Set([`clip:${clipId}`, ...[...ids].map(id => `motion:${id}`), ...captionIds.map(id => `caption:${id}`)]),
      lockTrack: bound.some(block => block.kind === "template"), titles: ids.size, captionIds };
  };

  // Things that move together never snap to each other's old place: a clip skips the titles that follow it.
  const snapCandidatesFor = (session: Pick<DragSession, "kind" | "id" | "movingOwners">, edges: number[]) => session.movingOwners
    ? queryTimelineSnapTimesExcluding(snapIndex, session.movingOwners, edges, pixelsPerSecond, project.fps, playhead)
    : queryTimelineSnapTimes(snapIndex, `${session.kind}:${session.id}`, edges, pixelsPerSecond, project.fps, playhead);

  function scheduleDrag() {
    if (dragFrameRef.current !== undefined) return;
    dragLastFrameRef.current ??= performance.now();
    dragFrameRef.current = requestAnimationFrame(timestamp => {
      const elapsedMs = Math.max(0, timestamp - (dragLastFrameRef.current ?? timestamp));
      dragLastFrameRef.current = timestamp;
      flushDrag(true, elapsedMs);
      if (dragFrameRef.current === undefined) dragLastFrameRef.current = undefined;
    });
  }

  function flushDrag(allowAutoScroll = true, elapsedMs = 0) {
    dragFrameRef.current = undefined;
    const session = dragRef.current;
    const node = scrollRef.current;
    if (!session || !node) return;
    if (!session.element.isConnected || !node.contains(session.element)) {
      abortDragSession(session);
      return;
    }
    let targetLane = compatibleLaneAtPointer(session);
    session.canDrop = Boolean(targetLane);
    const content = trackContentAtPoint(session.currentClientX, session.currentClientY);
    const canScroll = allowAutoScroll && content && (session.moved || Math.hypot(session.currentClientX - session.originClientX,
      session.currentClientY - session.originClientY) >= TIMELINE_DRAG_THRESHOLD_PX);
    if (canScroll
      && scrollTrackStack(session.currentClientX, session.currentClientY, elapsedMs)) {
      targetLane = compatibleLaneAtPointer(session);
      session.canDrop = Boolean(targetLane);
      scheduleDrag();
    }
    if (canScroll && content) {
      const delta = timelineAutoScrollDelta(session.currentClientX, content.left, content.right, elapsedMs);
      if (delta) {
        const before = node.scrollLeft;
        node.scrollLeft = Math.max(0, node.scrollLeft + delta);
        if (node.scrollLeft !== before) {
          scheduleDrag();
          targetLane = compatibleLaneAtPointer(session);
          session.canDrop = Boolean(targetLane);
        }
      }
    }
    const targetTrackId = targetLane?.dataset.trackId ?? session.originTrackId;
    const preliminary = resolveTimelineDrag({ originStart: session.originStart, duration: session.duration, originClientX: session.originClientX, currentClientX: session.currentClientX, originScrollLeft: session.originScrollLeft, currentScrollLeft: node.scrollLeft, pixelsPerSecond, fps: project.fps, magnetEnabled: false });
    const occupied = session.kind === "clip" && clipIndexes.has(targetTrackId)
      ? queryTimelineIntervalIndex(clipIndexes.get(targetTrackId)!, preliminary.start - 12 / pixelsPerSecond, preliminary.start + session.duration + 12 / pixelsPerSecond).filter(clip => clip.id !== session.id)
      : [];
    const isStartAllowed = (start: number) => occupied.every(clip => start + session.duration <= clip.timelineStart + 1e-6 || start >= clip.timelineStart + clip.duration - 1e-6);
    const resolved = resolveTimelineDrag({ originStart: session.originStart, duration: session.duration, originClientX: session.originClientX, currentClientX: session.currentClientX, originScrollLeft: session.originScrollLeft, currentScrollLeft: node.scrollLeft, pixelsPerSecond, fps: project.fps, snapCandidates: snapCandidatesFor(session, [preliminary.start, preliminary.start + session.duration]), magnetEnabled: snapActive && !session.altKey });
    const newLayer = session.kind === "clip" && session.canDrop && !isStartAllowed(resolved.start);
    // A clip under a title template cannot jump to a new layer: the template is bound to its track.
    if (session.lockTrack && newLayer) session.canDrop = false;
    session.targetStart = resolved.start;
    session.targetTrackId = targetTrackId;
    session.moved ||= resolved.moved || targetTrackId !== session.originTrackId
      || Math.hypot(session.currentClientX - session.originClientX, session.currentClientY - session.originClientY) >= TIMELINE_DRAG_THRESHOLD_PX;
    // Captions riding with the clip never land on captions that stay: say so before the drop, not after it.
    session.captionClash = undefined;
    if (session.followingCaptionIds?.length && session.moved && Math.round((resolved.start - session.originStart) * project.fps) !== 0) {
      try { session.captionClash = captionClashForMove(latestProjectRef.current, session.followingCaptionIds, resolved.start - session.originStart); }
      catch { session.captionClash = undefined; }
    }
    if (session.captionClash) session.canDrop = false;
    const targetLaneTop = targetLane?.getBoundingClientRect().top ?? session.sourceLaneTop;
    const sourceLaneTop = session.element.closest(".track-lane")?.getBoundingClientRect().top ?? session.sourceLaneTop;
    session.element.style.transform = `translate3d(${(resolved.start - session.originStart) * pixelsPerSecond}px, ${targetLane ? targetLaneTop - sourceLaneTop : session.currentClientY - session.originClientY + session.sourceLaneTop - sourceLaneTop}px, 0)`;
    session.element.dataset.timelineStart = String(session.targetStart);
    session.element.dataset.targetTrackId = targetTrackId;
    session.element.classList.toggle("is-dragging", session.moved);
    session.element.classList.toggle("is-snapped", session.canDrop && resolved.snappedTo !== undefined);
    session.element.classList.toggle("is-invalid-drop", session.moved && !session.canDrop);
    session.element.classList.toggle("is-new-layer-drop", session.moved && newLayer);
    // The titles bound to this clip ride along in the preview, exactly as they will after release.
    const followShift = (resolved.start - session.originStart) * pixelsPerSecond;
    for (const follower of session.followers ?? []) {
      follower.style.transform = `translate3d(${followShift}px,0,0)`;
      follower.classList.toggle("is-following", session.moved);
    }
    const templateBlocked = Boolean(session.lockTrack && !session.canDrop && !session.captionClash);
    const captions = session.followingCaptionIds?.length ?? 0, titles = session.followingTitles ?? (session.followers?.length ?? 0) - captions;
    const followDetail = templateBlocked ? uiText("這裡已有片段；有標題模板的片段只能放在同一軌的空位")
      : session.captionClash ? translateUiStatus(session.captionClash)
        : session.moved && session.followers?.length
          ? session.lockTrack ? uiText("標題模板一起移動 · 只能左右移動")
            : captions && titles ? uiText("上面的標題和 {count} 段字幕一起移動", { count: captions })
              : captions ? uiText("上面的 {count} 段字幕一起移動", { count: captions })
                : uiText("上面的 {count} 個標題和圖卡一起移動", { count: titles })
          : undefined;
    showEditPosition(session.moved && session.canDrop ? resolved.start : undefined, session.moved && session.canDrop ? resolved.snappedTo : undefined,
      session.moved ? followDetail : undefined, templateBlocked || session.captionClash ? "limit" : undefined);
    node.dataset.dropState = templateBlocked ? "template-blocked" : session.captionClash ? "caption-blocked"
      : session.canDrop ? newLayer ? "new-layer" : "valid" : "invalid";
    if (session.activeDropLane !== targetLane) {
      session.activeDropLane?.classList.remove("is-drop-target");
      targetLane?.classList.add("is-drop-target");
      session.activeDropLane = targetLane;
    }
  }

  const beginItemDrag = (event: ReactPointerEvent<HTMLButtonElement>, item: { kind: DragKind; id: string; trackId: string; trackKind: TimelineTrack["kind"]; start: number; duration: number; locked: boolean }) => {
    // 剪刀 never drags, moves or slips a clip, and the press does not reach the lane as a scrub: the click cuts.
    if (blade) { event.stopPropagation(); return; }
    if (event.button !== 0 || pointerEditing()) return;
    if (item.kind === "clip" && event.altKey && onCommand && adjacent.beginSlide(event, item.id)) return;
    if (canvas.beginGroup(event, item)) return;
    // A modifier click toggles on click; do not replace that selection on pointer-down or start a drag.
    if (onSelectionChange && !event.altKey && (event.shiftKey || event.ctrlKey || event.metaKey)) {
      event.stopPropagation();
      return;
    }
    // Alt at the start of a clip drag chooses a new in-point; Alt pressed later only pauses snapping.
    if (item.kind === "clip" && event.altKey && onSlipClip) {
      if (item.locked) {
        // Refuse with the reason; the press must not fall through to the lane as a scrub or seek.
        event.preventDefault();
        event.stopPropagation();
        suppressClickRef.current = `clip:${item.id}`;
        onEditRefused?.(clipSourceEditBlocker(project, item.id, "slip") ?? uiText(LOCKED_HELP));
        return;
      }
      beginSlip(event, item.id);
      return;
    }
    // A locked clip or caption is picked by its click like any other (B, Delete and Alt+← → then say the track is locked)
    // but never dragged, and the press does not fall through to the lane as a scrub: picking never moves the playhead.
    if (item.locked) { event.stopPropagation(); return; }
    suppressClickRef.current = undefined;
    committedDragRevealRef.current = undefined;
    motionRevealSkipRef.current = undefined;
    event.preventDefault();
    onEditStart?.();
    event.stopPropagation();
    // Preserve keyboard focus without the browser scrolling the grabbed clip.
    event.currentTarget.focus?.({ preventScroll: true });
    if (item.kind === "clip") onSelect(item.id); else onSelectCaption(item.id);
    event.currentTarget.setPointerCapture(event.pointerId);
    dragLastFrameRef.current = undefined;
    gestureAdmission.begin(project, item.kind, item.id);
    dragRef.current = { kind: item.kind, id: item.id, trackKind: item.trackKind, originTrackId: item.trackId, targetTrackId: item.trackId, originStart: item.start, targetStart: item.start, duration: item.duration, originClientX: event.clientX, originClientY: event.clientY, currentClientX: event.clientX, currentClientY: event.clientY, originScrollLeft: scrollRef.current?.scrollLeft ?? 0, pointerId: event.pointerId, altKey: event.altKey, moved: false, canDrop: true, element: event.currentTarget, sourceLaneTop: event.currentTarget.closest(".track-lane")?.getBoundingClientRect().top ?? event.currentTarget.getBoundingClientRect().top, lanes: currentDropLanes() };
    // With a command runner the titles bound to this clip move with it, so they are previewed with it.
    if (item.kind === "clip" && onCommand) {
      const followers = clipFollowers(item.id);
      if (followers.owners.size > 1) Object.assign(dragRef.current, { followers: followers.elements, movingOwners: followers.owners, lockTrack: followers.lockTrack,
        followingTitles: followers.titles, followingCaptionIds: followers.captionIds });
    }
  };

  const moveItemDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (adjacent.move(event)) return;
    if (canvas.moveGroup(event)) return;
    if (slipRef.current) { moveSlip(event); return; }
    const session = dragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    event.preventDefault();
    session.currentClientX = event.clientX;
    session.currentClientY = event.clientY;
    session.altKey = event.altKey;
    scheduleDrag();
  };

  const clearDragVisual = (session: DragSession) => {
    showEditPosition();
    session.element.style.removeProperty("transform");
    session.element.classList.remove("is-dragging", "is-snapped", "is-invalid-drop", "is-new-layer-drop");
    session.element.dataset.timelineStart = String(session.originStart);
    delete session.element.dataset.targetTrackId;
    const node = scrollRef.current;
    if (node) delete node.dataset.dropState;
    session.activeDropLane?.classList.remove("is-drop-target");
    session.activeDropLane = undefined;
    for (const follower of session.followers ?? []) {
      follower.style.removeProperty("transform");
      follower.classList.remove("is-following");
    }
  };

  function abortDragSession(session: DragSession) {
    if (dragFrameRef.current !== undefined) cancelAnimationFrame(dragFrameRef.current);
    dragFrameRef.current = undefined;
    dragLastFrameRef.current = undefined;
    if (dragRef.current === session) { dragRef.current = undefined; gestureAdmission.clear(); }
    clearDragVisual(session);
    flushDeferredSelectionReveal();
  }

  const endItemDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (adjacent.finish(event)) return;
    if (canvas.finishGroup(event)) return;
    if (slipRef.current) { endSlip(event); return; }
    const session = dragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    if (!gestureAdmission.isCurrent(latestProjectRef.current)) {
      cancelItemDrag(event);
      onEditRefused?.(uiText(gestureAdmission.refusalMessage));
      return;
    }
    gestureAdmission.clear();
    session.currentClientX = event.clientX;
    session.currentClientY = event.clientY;
    session.altKey = event.altKey;
    if (dragFrameRef.current !== undefined) cancelAnimationFrame(dragFrameRef.current);
    flushDrag(false);
    if (dragRef.current !== session) return;
    dragRef.current = undefined;
    if (dragFrameRef.current !== undefined) cancelAnimationFrame(dragFrameRef.current);
    dragFrameRef.current = undefined;
    dragLastFrameRef.current = undefined;
    const newLayer = session.element.classList.contains("is-new-layer-drop");
    clearDragVisual(session);
    // Pointer capture can deliver a click to the source even after an invalid
    // drop. It must not seek back to the source or undo the chosen viewport.
    if (session.moved) suppressClickRef.current = `${session.kind}:${session.id}`;
    if (session.moved && session.captionClash) onEditRefused?.(session.captionClash);
    else if (session.moved && session.lockTrack && !session.canDrop) onEditRefused?.(uiText("這裡已有片段；有標題模板的片段只能放在同一軌的空位。"));
    const frameChanged = Math.round(session.targetStart * project.fps) !== Math.round(session.originStart * project.fps);
    if (!session.moved || !session.canDrop || (!frameChanged && session.targetTrackId === session.originTrackId)) {
      flushDeferredSelectionReveal();
      return;
    }
    suppressClickRef.current = `${session.kind}:${session.id}`;
    if (session.kind === "clip") {
      committedDragRevealRef.current = { projectId: project.id, clipId: session.id, sourceKey: selectionRevealKey,
        trackId: session.targetTrackId, allowNewLayer: newLayer, fps: project.fps,
        startFrame: Math.round(session.targetStart * project.fps), durationFrames: Math.round(session.duration * project.fps) };
      // The accepted drag already chose its viewport. Do not reveal its old source.
      selectionReveal.clear();
    } else flushDeferredSelectionReveal();
    const refused = () => {
      committedDragRevealRef.current = undefined;
      selectionReveal.defer();
      flushDeferredSelectionReveal();
      showDropRejection();
    };
    const accepted = session.kind === "clip" ? commitClipMove(session.id, session.targetStart, session.targetTrackId, refused)
      : onMoveCaption(session.id, session.targetStart);
    if (accepted === false) refused();
  };

  const cancelItemDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (adjacent.finish(event, true)) return;
    if (canvas.finishGroup(event, true)) return;
    if (slipRef.current) { if (slipRef.current.pointerId === event.pointerId) cancelSlip(); return; }
    const session = dragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    gestureAdmission.clear();
    if (dragFrameRef.current !== undefined) cancelAnimationFrame(dragFrameRef.current);
    dragFrameRef.current = undefined;
    dragLastFrameRef.current = undefined;
    dragRef.current = undefined;
    suppressClickRef.current = `${session.kind}:${session.id}`;
    clearDragVisual(session);
    flushDeferredSelectionReveal();
  };

  function beginSlip(event: ReactPointerEvent<HTMLButtonElement>, clipId: string) {
    const clip = project.tracks.flatMap(track => track.clips).find(candidate => candidate.id === clipId);
    if (!clip) return;
    suppressClickRef.current = undefined;
    committedDragRevealRef.current = undefined;
    event.preventDefault();
    onEditStart?.();
    event.stopPropagation();
    event.currentTarget.focus?.({ preventScroll: true });
    onSelect(clipId);
    event.currentTarget.setPointerCapture(event.pointerId);
    const origin = Math.round(clip.sourceStart * project.fps);
    slipRef.current = { id: clipId, pointerId: event.pointerId, element: event.currentTarget, originClientX: event.clientX,
      currentClientX: event.clientX, originScrollLeft: scrollRef.current?.scrollLeft ?? 0, originSourceFrame: origin,
      targetSourceFrame: origin, maxSourceFrame: clipSourceWindow(project, clipId)?.maxSourceStartFrame ?? origin,
      blocker: clipSourceEditBlocker(project, clipId, "slip"), moved: false, limited: false };
  }

  function flushSlip() {
    slipFrameRef.current = undefined;
    const session = slipRef.current;
    if (!session) return;
    const deltaPixels = session.currentClientX - session.originClientX + (scrollRef.current?.scrollLeft ?? 0) - session.originScrollLeft;
    session.moved ||= Math.abs(deltaPixels) >= TIMELINE_DRAG_THRESHOLD_PX;
    if (!session.moved) return;
    // Like sliding film under a fixed window: dragging right shows earlier source.
    const requested = session.originSourceFrame - Math.round(deltaPixels / Math.max(1, pixelsPerSecond) * project.fps);
    const target = session.blocker ? session.originSourceFrame : Math.max(0, Math.min(session.maxSourceFrame, requested));
    session.targetSourceFrame = target;
    session.limited = !session.blocker && target !== requested;
    session.element.classList.add("is-slipping");
    session.element.classList.toggle("is-slip-blocked", Boolean(session.blocker));
    session.element.style.setProperty("--clip-slip-offset", `${(session.originSourceFrame - target) / project.fps * pixelsPerSecond}px`);
    session.element.dataset.sourceStart = String(target / project.fps);
    const readout = uiText("換入點：素材從 {seconds} 秒開始（第 {frame} 幀）", { seconds: formatEditSeconds(target / project.fps), frame: target });
    const limit = session.limited ? uiText(requested < 0 ? "已到素材開頭" : "已到素材結尾，片段長度不變") : undefined;
    showEditPosition(undefined, undefined, session.blocker ? translateUiStatus(session.blocker) : [readout, limit].filter(Boolean).join(" · "),
      session.blocker || session.limited ? "limit" : undefined);
  }

  function moveSlip(event: ReactPointerEvent<HTMLButtonElement>) {
    const session = slipRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    event.preventDefault();
    session.currentClientX = event.clientX;
    if (slipFrameRef.current === undefined) slipFrameRef.current = requestAnimationFrame(flushSlip);
  }

  function clearSlipVisual(session: SlipSession) {
    showEditPosition();
    session.element.classList.remove("is-slipping", "is-slip-blocked");
    session.element.style.removeProperty("--clip-slip-offset");
    delete session.element.dataset.sourceStart;
  }

  function endSlip(event: ReactPointerEvent<HTMLButtonElement>) {
    const session = slipRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    event.preventDefault();
    session.currentClientX = event.clientX;
    if (slipFrameRef.current !== undefined) cancelAnimationFrame(slipFrameRef.current);
    flushSlip();
    slipRef.current = undefined;
    clearSlipVisual(session);
    flushDeferredSelectionReveal();
    if (!session.moved) return;
    suppressClickRef.current = `clip:${session.id}`;
    if (session.blocker) { onEditRefused?.(session.blocker); return; }
    if (session.targetSourceFrame !== session.originSourceFrame) onSlipClip?.(session.id, session.targetSourceFrame / project.fps);
  }

  function cancelSlip() {
    const session = slipRef.current;
    if (!session) return;
    if (slipFrameRef.current !== undefined) cancelAnimationFrame(slipFrameRef.current);
    slipFrameRef.current = undefined;
    slipRef.current = undefined;
    suppressClickRef.current = `clip:${session.id}`;
    clearSlipVisual(session);
    flushDeferredSelectionReveal();
  }

  /** Clips and captions an extension will push later are shown at their new place during the drag. */
  function showPushedPreview(session: TrimSession, plan?: ClipExtensionPlan) {
    const node = scrollRef.current, pushed: HTMLElement[] = [];
    if (node && plan?.push && plan.pushSeconds > 0) {
      const escape = (id: string) => typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id;
      const testIds = [...plan.push.clipIds.map(id => `timeline-clip-${id}`), ...plan.push.captionIds.map(id => `timeline-caption-${id}`)];
      for (const testId of testIds) {
        const element = node.querySelector<HTMLElement>(`[data-testid="${escape(testId)}"]`);
        if (element) pushed.push(element);
      }
      for (const element of pushed) {
        element.style.transform = `translate3d(${plan.pushSeconds * pixelsPerSecond}px,0,0)`;
        element.classList.add("is-pushed");
      }
    }
    for (const element of session.pushedElements ?? []) {
      if (pushed.includes(element)) continue;
      element.style.removeProperty("transform");
      element.classList.remove("is-pushed");
    }
    session.pushedElements = pushed;
  }

  const clearTrimVisual = (session: TrimSession) => {
    showPushedPreview(session);
    showEditPosition();
    session.element.style.width = session.originWidthStyle;
    session.element.style.removeProperty("transform");
    session.element.classList.remove("is-trimming", "is-snapped", "is-extending");
    session.element.dataset.timelineStart = String(session.originStart);
    session.element.dataset.duration = String(session.originDuration);
  };

  const flushTrim = () => {
    trimFrameRef.current = undefined;
    const session = trimRef.current;
    if (!session) return;
    const input = {
      edge: session.edge,
      originStart: session.originStart,
      duration: session.originDuration,
      originClientX: session.originClientX,
      currentClientX: session.currentClientX + (scrollRef.current?.scrollLeft ?? 0) - session.originScrollLeft,
      pixelsPerSecond,
      fps: project.fps,
      maxExtendFrames: session.maxExtendFrames ?? 0,
    };
    const preliminary = resolveTimelineTrim({ ...input, magnetEnabled: false });
    const edgeTime = session.edge === "start" ? preliminary.start : preliminary.start + preliminary.duration;
    const resolved = resolveTimelineTrim({ ...input, snapCandidates: snapCandidatesFor(session, [edgeTime]), magnetEnabled: snapActive && !session.altKey });
    session.trimSeconds = resolved.trimSeconds;
    session.extendSeconds = resolved.extendSeconds;
    session.extendLimited = resolved.extendLimited && session.extendLimit !== undefined;
    session.moved ||= resolved.moved;
    let start = resolved.start, length = resolved.duration, detail: string | undefined;
    let plan: ClipExtensionPlan | undefined;
    if (session.kind === "clip" && resolved.extendSeconds > 0) {
      // Preview the committed geometry: free space first, then growing later past a neighbour.
      try {
        plan = planClipExtension(project, session.id, session.edge, Math.round(resolved.extendSeconds * project.fps));
        start = plan.timelineStart; length = plan.duration; detail = extensionReadout(plan);
      } catch (error) { detail = error instanceof Error ? translateUiStatus(error.message) : undefined; }
    }
    showPushedPreview(session, plan);
    if (session.extendLimited) detail = [detail, translateUiStatus(session.extendLimit ?? "")].filter(Boolean).join(" · ");
    if (session.edgeFollowers && resolved.moved) detail = [detail, uiText("貼齊這個邊的標題會一起調整")].filter(Boolean).join(" · ");
    const shiftPixels = (start - session.originStart) * pixelsPerSecond;
    session.element.style.width = `${Math.max(12, length * pixelsPerSecond)}px`;
    session.element.style.transform = `translate3d(${shiftPixels}px,0,0)`;
    session.element.classList.toggle("is-trimming", session.moved);
    session.element.classList.toggle("is-extending", resolved.extendSeconds > 0);
    session.element.classList.toggle("is-snapped", session.moved && resolved.snappedTo !== undefined);
    session.element.dataset.timelineStart = String(start);
    session.element.dataset.duration = String(length);
    const shown = session.moved || session.extendLimited;
    showEditPosition(shown ? (session.edge === "start" ? start : start + length) : undefined, session.moved ? resolved.snappedTo : undefined,
      shown ? detail : undefined, session.extendLimited ? "limit" : undefined);
  };

  const scheduleTrim = () => {
    if (trimFrameRef.current !== undefined) return;
    trimFrameRef.current = requestAnimationFrame(flushTrim);
  };

  const beginTrim = (event: ReactPointerEvent<HTMLElement>, item: { kind: DragKind; id: string; start: number; duration: number; locked: boolean }, edge: "start" | "end") => {
    if (blade) return;
    if (event.button !== 0 || item.locked || pointerEditing()) return;
    if (item.kind === "clip" && adjacent.beginRoll(event, item.id, edge)) return;
    suppressClickRef.current = undefined;
    event.preventDefault();
    event.stopPropagation();
    const element = event.currentTarget.closest<HTMLButtonElement>(".timeline-clip");
    if (!element) return;
    committedDragRevealRef.current = undefined;
    onEditStart?.();
    if (item.kind === "clip") onSelect(item.id); else onSelectCaption(item.id);
    event.currentTarget.setPointerCapture(event.pointerId);
    // Escape cancels a trim even when focus was elsewhere before the gesture.
    element.focus?.({ preventScroll: true });
    // Clip edges may also grow outward, up to the real media and only past content that may move.
    const limits = item.kind === "clip" && onExtendClip ? clipExtensionLimits(project, item.id, edge) : undefined;
    gestureAdmission.begin(project, item.kind, item.id);
    trimRef.current = {
      kind: item.kind,
      id: item.id,
      edge,
      originStart: item.start,
      originDuration: item.duration,
      originClientX: event.clientX,
      currentClientX: event.clientX,
      pointerId: event.pointerId,
      altKey: event.altKey,
      originScrollLeft: scrollRef.current?.scrollLeft ?? 0,
      trimSeconds: 0,
      ripple: item.kind === "clip" && event.shiftKey && !!onCommand,
      moved: false,
      element,
      originWidth: element.getBoundingClientRect().width,
      originWidthStyle: element.style.width,
      maxExtendFrames: limits && typeof limits !== "string" ? limits.maxFrames : 0,
      extendLimit: limits === undefined ? undefined : typeof limits === "string" ? limits
        : limits.maxFrames < limits.sourceFrames && limits.pushBlockedReason ? limits.pushBlockedReason
          : clipSourceLimitMessage(edge, limits.sourceFrames, project.fps),
      extendSeconds: 0,
      extendLimited: false,
      edgeFollowers: item.kind === "clip" && onCommand ? edgeAlignedGraphicIds(project, item.id, edge).length : 0,
    };
  };

  const moveTrim = (event: ReactPointerEvent<HTMLElement>) => {
    if (adjacent.move(event)) return;
    const session = trimRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    session.currentClientX = event.clientX;
    session.altKey = event.altKey;
    scheduleTrim();
  };

  const endTrim = (event: ReactPointerEvent<HTMLElement>) => {
    if (adjacent.finish(event)) return;
    const session = trimRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    if (!gestureAdmission.isCurrent(latestProjectRef.current)) {
      cancelTrim(event);
      onEditRefused?.(uiText(gestureAdmission.refusalMessage));
      return;
    }
    gestureAdmission.clear();
    event.preventDefault();
    event.stopPropagation();
    session.currentClientX = event.clientX;
    session.altKey = event.altKey;
    if (trimFrameRef.current !== undefined) cancelAnimationFrame(trimFrameRef.current);
    flushTrim();
    trimRef.current = undefined;
    clearTrimVisual(session);
    flushDeferredSelectionReveal();
    if (session.ripple && session.moved && session.trimSeconds > 0 && onCommand) {
      suppressClickRef.current = `${session.kind}:${session.id}`;
      try { const plan = planRippleTrim(latestProjectRef.current, session.id, session.edge, session.trimSeconds); if (plan) onCommand(plan.command, plan.message); }
      catch (error) { onEditRefused?.(error instanceof Error ? error.message : String(error)); }
      return;
    }
    if (session.kind === "clip" && (session.extendSeconds ?? 0) > 0) {
      suppressClickRef.current = `${session.kind}:${session.id}`;
      // A title template on the clip is laid out again on the longer clip, and one further on that the extension pushes
      // later moves with it, in the same command.
      const extension: EditorCommand = { type: "extend_clip", clipId: session.id, edge: session.edge,
        seconds: Math.round(session.extendSeconds! * project.fps) / project.fps };
      if (onCommand && editTouchesTemplates(latestProjectRef.current, [extension])) {
        commitTemplateClipEdit((glyphs, base) => planClipExtensionWithTemplates(base, session.id, session.edge, session.extendSeconds!, glyphs));
        return;
      }
      // Titles lined up with the growing edge grow with it, in the same command; otherwise the plain extension.
      if (onCommand && commitWithFollowers(() => planClipExtensionWithAttachments(latestProjectRef.current, session.id, session.edge, session.extendSeconds!))) return;
      onExtendClip?.(session.id, session.edge, session.extendSeconds!);
      return;
    }
    if (session.moved && session.trimSeconds > 0) {
      suppressClickRef.current = `${session.kind}:${session.id}`;
      if (session.kind === "clip") {
        if (onCommand && clipHasTemplate(latestProjectRef.current, session.id)) {
          commitTemplateClipEdit((glyphs, base) => planClipTrimWithTemplates(base, session.id, session.edge, session.trimSeconds, glyphs));
          return;
        }
        if (onCommand && commitWithFollowers(() => planClipTrimWithAttachments(latestProjectRef.current, session.id, session.edge, session.trimSeconds))) return;
        onTrimClip(session.id, session.edge, session.trimSeconds);
      } else onTrimCaption(session.id, session.edge, session.trimSeconds);
      return;
    }
    // Nothing changed because the edge could not grow: say why instead of snapping back silently.
    if (session.extendLimited && session.extendLimit) {
      suppressClickRef.current = `${session.kind}:${session.id}`;
      onEditRefused?.(session.extendLimit);
    }
  };

  const cancelTrim = (event: ReactPointerEvent<HTMLElement>) => {
    if (adjacent.finish(event, true)) return;
    const session = trimRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    gestureAdmission.clear();
    event.stopPropagation();
    if (trimFrameRef.current !== undefined) cancelAnimationFrame(trimFrameRef.current);
    trimFrameRef.current = undefined;
    trimRef.current = undefined;
    clearTrimVisual(session);
    flushDeferredSelectionReveal();
  };

  const trimHandles = (item: { kind: DragKind; id: string; start: number; duration: number; locked: boolean }) => item.locked ? null : <>
    <span className="clip-trim-handle start" title={uiText(item.kind === "clip" && onExtendClip ? "拖曳修剪或拉長開頭" : "拖曳修剪開頭")} aria-hidden="true" onPointerDown={(event) => beginTrim(event, item, "start")} onPointerMove={moveTrim} onPointerUp={endTrim} onPointerCancel={cancelTrim} onLostPointerCapture={cancelTrim} />
    <span className="clip-trim-handle end" title={uiText(item.kind === "clip" && onExtendClip ? "拖曳修剪或拉長結尾" : "拖曳修剪結尾")} aria-hidden="true" onPointerDown={(event) => beginTrim(event, item, "end")} onPointerMove={moveTrim} onPointerUp={endTrim} onPointerCancel={cancelTrim} onLostPointerCapture={cancelTrim} />
  </>;

  const activateItem = (event: React.MouseEvent<HTMLButtonElement>, kind: DragKind, id: string, start: number) => {
    if (canvas.consumeClick("item")) { event.preventDefault(); event.stopPropagation(); return; }
    // 剪刀 cuts a picture or sound clip where it is clicked; captions have no split, so it leaves them alone.
    if (blade) { if (kind === "clip") bladeCut(event, id); else event.stopPropagation(); return; }
    const key = `${kind}:${id}`;
    if (suppressClickRef.current === key) {
      suppressClickRef.current = undefined;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    committedDragRevealRef.current = undefined;
    motionRevealSkipRef.current = undefined;
    event.stopPropagation();
    setMotionSelection(undefined);
    if (onSelectionChange) onSelectionChange(selectLinkedTimelineItem(project, {
      clipIds: selectedClipIds ?? (selectedClipId ? [selectedClipId] : []),
      captionIds: selectedCaptionIds ?? (selectedCaptionId ? [selectedCaptionId] : []),
      primaryClipId: selectedClipId, primaryCaptionId: selectedCaptionId,
    }, { kind, id }, !event.altKey && (event.shiftKey || event.ctrlKey || event.metaKey)));
    else if (kind === "clip") onSelect(id); else onSelectCaption(id);
    // Picking never moves the playhead: it stays where the creator parked it, so B then cuts the picked clip there.
    // A click (not a drag or a trim) picks it: simple mode opens its panel.
    onActivateSelection?.();
  };

  const flushScrub = () => {
    scrubFrameRef.current = undefined;
    const session = scrubRef.current;
    if (!session) return;
    onSeek(timelineTimeAtPointer(session.currentClientX, session.element.getBoundingClientRect().left, pixelsPerSecond, visualDuration, project.fps));
  };

  const scheduleScrub = () => {
    if (scrubFrameRef.current !== undefined) return;
    scrubFrameRef.current = requestAnimationFrame(flushScrub);
  };

  // With 剪刀 only the ruler moves the playhead: a click on empty track space does nothing.
  const rulerOnly = (element: HTMLElement) => blade && !element.classList.contains("timeline-ruler");
  const beginScrub = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || pointerEditing() || rulerOnly(event.currentTarget)) return;
    if (!blade && canvas.beginMarquee(event)) return;
    committedDragRevealRef.current = undefined;
    onEditStart?.();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.classList.add("is-scrubbing");
    scrubRef.current = { pointerId: event.pointerId, currentClientX: event.clientX, element: event.currentTarget };
    flushScrub();
  };

  const moveScrub = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (canvas.moveMarquee(event)) return;
    const session = scrubRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    session.currentClientX = event.clientX;
    scheduleScrub();
  };

  const endScrub = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (canvas.finishMarquee(event)) return;
    const session = scrubRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    session.currentClientX = event.clientX;
    if (scrubFrameRef.current !== undefined) cancelAnimationFrame(scrubFrameRef.current);
    flushScrub();
    scrubRef.current = undefined;
    session.element.classList.remove("is-scrubbing");
    flushDeferredSelectionReveal();
  };

  const cancelScrub = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (canvas.finishMarquee(event, true)) return;
    const session = scrubRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    if (scrubFrameRef.current !== undefined) cancelAnimationFrame(scrubFrameRef.current);
    scrubFrameRef.current = undefined;
    scrubRef.current = undefined;
    session.element.classList.remove("is-scrubbing");
    flushDeferredSelectionReveal();
  };

  const seekFromClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (canvas.consumeClick("lane")) return;
    if (rulerOnly(event.currentTarget)) return;
    onSeek(timelineTimeAtPointer(event.clientX, event.currentTarget.getBoundingClientRect().left, pixelsPerSecond, visualDuration, project.fps));
  };

  // ---- 標題與圖卡 lane: templates and graphics as blocks, with the same frame grid and snapping as clips. ----

  const openTemplateEditor = (block: TimelineMotionBlock) => {
    if (!block.instanceId) return;
    onEditStart?.();
    requestTemplateEditor(block.instanceId, "timeline");
  };

  /** Selecting a block also selects the main clip it follows, so the Inspector shows that clip and its template. */
  const selectMotionBlock = (block: TimelineMotionBlock) => {
    committedDragRevealRef.current = undefined;
    const bound = block.boundClipId && project.tracks.some(track => track.clips.some(clip => clip.id === block.boundClipId)) ? block.boundClipId : undefined;
    motionSelectionAnchorRef.current = bound ? { clipId: bound } : { clipId: selectedClipId, captionId: selectedCaptionId };
    if (bound && (bound !== selectedClipId || selectedCaptionId)) { motionRevealSkipRef.current = bound; onSelect(bound); }
    setMotionSelection(block.id);
  };

  /** The main clip and the other titles that move with a template block. */
  const templateFollowers = (block: TimelineMotionBlock): HTMLElement[] => {
    const node = scrollRef.current;
    if (!node || block.kind !== "template" || !block.boundClipId) return [];
    return [...node.querySelectorAll<HTMLElement>(".timeline-clip, [data-motion-block-id]")].filter(element =>
      element.dataset.testid === `timeline-clip-${block.boundClipId}`
      || (element.dataset.boundClipId === block.boundClipId && element.dataset.motionBlockId !== block.id));
  };

  const clearMotionVisual = (session: MotionSession) => {
    showEditPosition();
    session.element.style.removeProperty("transform");
    session.element.style.width = session.originWidthStyle;
    session.element.classList.remove("is-dragging", "is-snapped", "is-trimming", "is-blocked");
    for (const follower of session.followers) {
      follower.style.removeProperty("transform");
      follower.classList.remove("is-following");
    }
  };

  const commitMotionBlock = (block: TimelineMotionBlock, startFrame: number, durationFrames: number, done: () => void, options?: TimelineEditOptions) => {
    if (block.kind === "template" && block.instanceId) {
      const base = latestProjectRef.current;
      if (pendingClipMoveRef.current) { onEditRefused?.(uiText(PENDING_MOVE_REFUSAL)); done(); return; }
      const glyphs = templateFollowGlyphs();
      void trackPendingMove(trackTemplateFollow(runAsyncPlan(() => planTemplateMove(base, block.instanceId!, startFrame - block.startFrame, makeId, glyphs), base, undefined, undefined, options),
        { stillCurrent: () => latestProjectRef.current === base }))
        .finally(() => { glyphs.dispose(); done(); });
      return;
    }
    if (block.graphicId) runPlan(() => planMotionGraphicRange(latestProjectRef.current, block.graphicId!, startFrame, durationFrames), options);
    done();
  };

  const deleteMotionBlock = (block: TimelineMotionBlock) => {
    if (!onCommand) { onEditRefused?.(uiText(MOTION_LANE_READONLY_HELP)); return; }
    if (!block.remove.allowed) { onEditRefused?.(block.remove.reason); return; }
    onEditStart?.();
    if (block.graphicId && runPlan(() => planMotionGraphicDelete(latestProjectRef.current, block.graphicId!))) setMotionSelection(undefined);
  };

  function flushMotion(final = false) {
    motionFrameRef.current = undefined;
    const session = motionRef.current, node = scrollRef.current;
    if (!session || !node) return;
    const deltaPixels = session.currentClientX - session.originClientX + node.scrollLeft - session.originScrollLeft;
    if (!session.moved && Math.abs(deltaPixels) < TIMELINE_DRAG_THRESHOLD_PX) return;
    if (session.blocker) {
      session.moved = true;
      session.element.classList.add("is-blocked");
      showEditPosition(undefined, undefined, translateUiStatus(session.blocker), "limit");
      return;
    }
    const fps = project.fps, magnet = snapActive && !session.altKey;
    const block = motionBlockById.get(session.blockId);
    if (session.mode === "move") {
      const shiftSeconds = deltaPixels / Math.max(1, pixelsPerSecond);
      const edges = [session.originStartFrame / fps + shiftSeconds, (session.originStartFrame + session.durationFrames) / fps + shiftSeconds];
      const result = resolveMotionBlockMove({ originStartFrame: session.originStartFrame, durationFrames: session.durationFrames,
        originClientX: session.originClientX, currentClientX: session.currentClientX, originScrollLeft: session.originScrollLeft, currentScrollLeft: node.scrollLeft,
        pixelsPerSecond, fps, snapCandidates: queryTimelineSnapTimesExcluding(snapIndex, session.movingOwners, edges, pixelsPerSecond, fps, playhead),
        magnetEnabled: magnet, minStartFrame: session.minStartFrame, maxStartFrame: session.maxStartFrame });
      session.moved ||= result.moved;
      session.targetStartFrame = result.startFrame;
      const shift = (result.startFrame - session.originStartFrame) / fps * pixelsPerSecond;
      session.element.style.transform = `translate3d(${shift}px,0,0)`;
      session.element.classList.toggle("is-dragging", session.moved);
      session.element.classList.toggle("is-snapped", result.snappedTo !== undefined);
      for (const follower of session.followers) {
        follower.style.transform = `translate3d(${shift}px,0,0)`;
        follower.classList.toggle("is-following", session.moved);
      }
      const detail = [block?.kind === "template" ? uiText("主片段和上面的標題一起移動") : undefined,
        result.limited ? uiText(block?.tracked ? "追蹤標籤只能放在追蹤的片段裡" : "已到影片開頭") : undefined];
      showEditPosition(result.startFrame / fps, result.snappedTo, detail.filter(Boolean).join(" · ") || undefined, result.limited ? "limit" : undefined);
    } else {
      const edgeTime = (session.mode === "start" ? session.originStartFrame : session.originStartFrame + session.durationFrames) / fps + deltaPixels / Math.max(1, pixelsPerSecond);
      const result = resolveMotionBlockTrim({ edge: session.mode, originStartFrame: session.originStartFrame, durationFrames: session.durationFrames,
        deltaPixels, pixelsPerSecond, fps, snapCandidates: queryTimelineSnapTimesExcluding(snapIndex, session.movingOwners, [edgeTime], pixelsPerSecond, fps, playhead),
        magnetEnabled: magnet, minDurationFrames: session.minDurationFrames, maxDurationFrames: session.maxDurationFrames,
        minStartFrame: session.minStartFrame, maxEndFrame: session.maxEndFrame });
      session.moved ||= result.moved;
      session.targetStartFrame = result.startFrame;
      session.targetDurationFrames = result.durationFrames;
      session.element.style.width = `${Math.max(12, result.durationFrames / fps * pixelsPerSecond)}px`;
      session.element.style.transform = `translate3d(${(result.startFrame - session.originStartFrame) / fps * pixelsPerSecond}px,0,0)`;
      session.element.classList.toggle("is-trimming", session.moved);
      const limit = result.limit === "shortest" ? uiText("最短 {seconds} 秒，才放得下進場和退場動畫", { seconds: formatMotionSeconds(session.minDurationFrames / fps) })
        : result.limit === "longest" ? uiText("最長 {seconds} 秒", { seconds: formatMotionSeconds(session.maxDurationFrames / fps) })
          : result.limit === "range" ? uiText(block?.tracked ? "追蹤標籤只能放在追蹤的片段裡" : "已到影片開頭") : undefined;
      const length = uiText("長 {seconds} 秒", { seconds: formatMotionSeconds(result.durationFrames / fps) });
      showEditPosition((session.mode === "start" ? result.startFrame : result.startFrame + result.durationFrames) / fps, result.snappedTo,
        [length, limit].filter(Boolean).join(" · "), result.limited ? "limit" : undefined);
    }
    if (final) return;
    // Near the left or right edge, the view scrolls at a steady speed and the block keeps following the pointer.
    const box = node.getBoundingClientRect(), left = box.left + node.clientLeft + LABEL_WIDTH, right = box.left + node.clientLeft + node.clientWidth;
    const scroll = timelineAutoScrollDelta(session.currentClientX, left, right);
    if (scroll) {
      const before = node.scrollLeft;
      node.scrollLeft = Math.max(0, before + scroll);
      if (node.scrollLeft !== before) scheduleMotion();
    }
  }

  function scheduleMotion() {
    if (motionFrameRef.current === undefined) motionFrameRef.current = requestAnimationFrame(() => flushMotion());
  }

  const beginMotionGesture = (event: ReactPointerEvent<HTMLElement>, block: TimelineMotionBlock, mode: MotionSession["mode"]) => {
    // Titles and cards have no split: 剪刀 leaves them where they are (and the press does not reach the lane).
    if (blade) { event.stopPropagation(); return; }
    if (event.button !== 0 || pointerEditing()) return;
    const element = event.currentTarget.closest<HTMLButtonElement>(".motion-block");
    if (!element) return;
    event.preventDefault();
    event.stopPropagation();
    onEditStart?.();
    suppressClickRef.current = undefined;
    selectMotionBlock(block);
    element.focus?.({ preventScroll: true });
    const permission = mode === "move" ? block.move : block.trim;
    let blocker = !onCommand ? uiText(MOTION_LANE_READONLY_HELP) : permission.allowed ? undefined : permission.reason;
    const durationFrames = block.endFrame - block.startFrame;
    let bounds = { minStartFrame: 0, maxStartFrame: Number.MAX_SAFE_INTEGER, minDurationFrames: 1, maxDurationFrames: Number.MAX_SAFE_INTEGER, maxEndFrame: Number.MAX_SAFE_INTEGER };
    if (!blocker && block.graphicId) {
      try {
        const limits = motionGraphicBounds(project, block.graphicId);
        bounds = { minStartFrame: limits.minStartFrame, maxStartFrame: limits.maxStartFrame, minDurationFrames: limits.minDurationFrames,
          maxDurationFrames: limits.maxDurationFrames, maxEndFrame: limits.trackedRange?.[1] ?? Number.MAX_SAFE_INTEGER };
      } catch (error) { blocker = error instanceof Error ? error.message : uiText("這次調整沒有套用。"); }
    }
    if (!blocker && block.kind === "template" && block.boundClipId) {
      // The template moves with its main clip, which cannot start before 0.
      const clip = project.tracks.flatMap(track => track.clips).find(item => item.id === block.boundClipId);
      if (clip) bounds.minStartFrame = Math.max(0, block.startFrame - Math.round(clip.timelineStart * project.fps));
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const followers = mode === "move" && !blocker ? templateFollowers(block) : [];
    const owners = new Set([`motion:${block.id}`]);
    if (block.kind === "template" && block.boundClipId) {
      owners.add(`clip:${block.boundClipId}`);
      for (const other of motionBlocks) if (other.boundClipId === block.boundClipId) owners.add(`motion:${other.id}`);
    }
    motionRef.current = { blockId: block.id, mode, pointerId: event.pointerId, element, originClientX: event.clientX, currentClientX: event.clientX,
      originScrollLeft: scrollRef.current?.scrollLeft ?? 0, altKey: event.altKey, originStartFrame: block.startFrame, durationFrames,
      targetStartFrame: block.startFrame, targetDurationFrames: durationFrames, ...bounds, blocker, moved: false, followers, movingOwners: owners,
      originWidthStyle: element.style.width };
  };

  const moveMotion = (event: ReactPointerEvent<HTMLElement>) => {
    const session = motionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    session.currentClientX = event.clientX;
    session.altKey = event.altKey;
    scheduleMotion();
  };

  const endMotion = (event: ReactPointerEvent<HTMLElement>) => {
    const session = motionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    session.currentClientX = event.clientX;
    session.altKey = event.altKey;
    if (motionFrameRef.current !== undefined) cancelAnimationFrame(motionFrameRef.current);
    flushMotion(true);
    motionRef.current = undefined;
    flushDeferredSelectionReveal();
    const block = motionBlockById.get(session.blockId);
    if (!session.moved) { clearMotionVisual(session); return; }
    suppressClickRef.current = `motion:${session.blockId}`;
    if (session.blocker) { clearMotionVisual(session); onEditRefused?.(session.blocker); return; }
    const changed = session.targetStartFrame !== session.originStartFrame || session.targetDurationFrames !== session.durationFrames;
    if (!block || !changed) { clearMotionVisual(session); return; }
    commitMotionBlock(block, session.targetStartFrame, session.targetDurationFrames, () => clearMotionVisual(session));
  };

  const cancelMotion = (event?: { pointerId: number }) => {
    const session = motionRef.current;
    if (!session || (event && session.pointerId !== event.pointerId)) return;
    if (motionFrameRef.current !== undefined) cancelAnimationFrame(motionFrameRef.current);
    motionFrameRef.current = undefined;
    motionRef.current = undefined;
    suppressClickRef.current = `motion:${session.blockId}`;
    clearMotionVisual(session);
    flushDeferredSelectionReveal();
  };

  const activateMotionBlock = (event: React.MouseEvent<HTMLButtonElement>, block: TimelineMotionBlock) => {
    if (blade) { event.stopPropagation(); return; }
    const key = `motion:${block.id}`;
    if (suppressClickRef.current === key) {
      suppressClickRef.current = undefined;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    event.stopPropagation();
    selectMotionBlock(block);
    // Picking a title never moves the playhead either.
    onActivateSelection?.();
  };

  /**
   * Alt+← → from the editor's key owner (App, useEditorShortcuts): the picked title moves, else the selected clip (with
   * what follows it), else the selected caption. One command per press; a held key's commands share `coalesce`, so the
   * whole hold is ONE Undo step. ← → alone step the playhead and never reach here.
   */
  const nudgeSelection = (frames: number, coalesce: string) => {
    committedDragRevealRef.current = undefined;
    const options: TimelineEditOptions = { coalesce };
    if (selectedMotionBlock) {
      const block = selectedMotionBlock;
      if (!onCommand) { onEditRefused?.(uiText(MOTION_LANE_READONLY_HELP)); return; }
      if (!block.move.allowed) { onEditRefused?.(block.move.reason); return; }
      // A held key repeats faster than a template is re-recorded: skip repeats until the last move lands.
      if (block.kind === "template" && pendingClipMoveRef.current) return;
      onEditStart?.();
      commitMotionBlock(block, Math.max(0, block.startFrame + frames), block.endFrame - block.startFrame, () => {}, options);
      return;
    }
    if (pinnedClip) {
      if (project.tracks.find(track => track.id === pinnedClip.trackId)?.locked) { onEditRefused?.(TRACK_LOCKED_MESSAGE); return; }
      // A held key repeats faster than a clip with titles is re-planned: skip repeats until the last move lands.
      if (pendingClipMoveRef.current) return;
      onEditStart?.();
      commitClipMove(pinnedClip.clip.id, nudgeTimelineTime(pinnedClip.clip.timelineStart, frames, project.fps), pinnedClip.trackId, undefined, options);
      return;
    }
    if (pinnedCaption) {
      if (captionTrackLocked(project)) { onEditRefused?.(TRACK_LOCKED_MESSAGE); return; }
      onEditStart?.();
      onMoveCaption(pinnedCaption.id, nudgeTimelineTime(pinnedCaption.start, frames, project.fps), options);
    }
  };
  /** Delete from the editor's key owner: a title or card picked on the lane is deleted here, as the 刪除 button does. */
  const deleteSelection = (): boolean => {
    if (!selectedMotionBlock) return false;
    deleteMotionBlock(selectedMotionBlock);
    return true;
  };
  /** A click with 剪刀: the clip (with Shift, every unlocked track's clip there) is cut at the line's time. A keyboard
   * "click" (Enter on a focused clip) has no pointer position, so it cuts nothing. */
  const bladeCut = (event: React.MouseEvent<HTMLButtonElement>, clipId: string) => {
    event.stopPropagation();
    const lane = event.currentTarget.closest<HTMLElement>(".track-lane");
    if (event.detail === 0 || !lane) return;
    const { time } = bladeTime({ clientX: event.clientX, laneLeft: lane.getBoundingClientRect().left, pixelsPerSecond, fps: project.fps,
      playhead, snapIndex, excludeOwner: `clip:${clipId}` });
    const plan = planBladeCuts(project, clipId, time, event.shiftKey);
    if ("refusal" in plan) onEditRefused?.(plan.refusal); else onCut?.(plan.cuts);
    bladeLine.refresh();
  };
  if (keyboardActions) keyboardActions.current = { nudge: nudgeSelection, deleteSelection, setTool: chooseTool,
    escapeTool: () => { if (!blade) return false; chooseTool("select"); return true; },
    clearMotionSelection: () => { if (!motionSelection) return false; setMotionSelection(undefined); return true; },
    nudgeMotionSelection: (frames, coalesce) => { if (!selectedMotionBlock) return false; nudgeSelection(frames, coalesce); return true; } };
  useEffect(() => () => { if (keyboardActions) keyboardActions.current = undefined; }, [keyboardActions]);

  const motionBlockKey = (event: ReactKeyboardEvent<HTMLButtonElement>, block: TimelineMotionBlock) => {
    if (event.key === "Enter" && block.kind === "template") {
      event.preventDefault();
      event.stopPropagation();
      selectMotionBlock(block);
      openTemplateEditor(block);
      return;
    }
    // ← → step the playhead (the editor's key owner); Alt+← → move the picked title (nudgeSelection).
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      event.stopPropagation();
      deleteMotionBlock(block);
    }
  };

  const motionKindLabel = (block: TimelineMotionBlock) => uiText(block.detail);

  const renderMotionBlock = (block: TimelineMotionBlock) => {
    const editable = Boolean(onCommand);
    const help = !editable ? MOTION_LANE_READONLY_HELP : block.kind === "template" ? TEMPLATE_BLOCK_HELP : block.move.allowed ? MOTION_BLOCK_HELP : undefined;
    const range = uiText("{start} 秒到 {end} 秒", { start: formatMotionSeconds(block.start), end: formatMotionSeconds(block.start + block.duration) });
    const handles = editable && block.kind !== "scene";
    return <button type="button" key={block.id}
      className={`motion-block ${block.kind}${motionLane.compact ? " compact" : ""}${motionSelection === block.id ? " selected" : ""}${block.stale ? " stale" : ""}${editable && block.move.allowed ? "" : " fixed"}`}
      style={{ left: block.start * pixelsPerSecond, width: Math.max(12, block.duration * pixelsPerSecond), top: motionBlockTop(motionLane, block.row) }}
      data-testid={`motion-block-${block.id}`} data-motion-block-id={block.id} data-motion-kind={block.kind} data-motion-row={block.row} data-bound-clip-id={block.boundClipId}
      data-start-frame={block.startFrame} data-end-frame={block.endFrame}
      aria-label={uiText("{kind}「{label}」，{range}", { kind: motionKindLabel(block), label: block.label, range })}
      title={help ? uiText(help) : block.move.allowed ? undefined : translateUiStatus(block.move.reason)}
      onPointerDown={event => beginMotionGesture(event, block, "move")} onPointerMove={moveMotion} onPointerUp={endMotion}
      onPointerCancel={cancelMotion} onLostPointerCapture={cancelMotion} onClick={event => activateMotionBlock(event, block)}
      onDoubleClick={event => { if (blade || block.kind !== "template") return; event.stopPropagation(); openTemplateEditor(block); }}
      onKeyDown={event => motionBlockKey(event, block)}>
      <strong>{block.label}</strong>
      <small>{motionKindLabel(block)}{block.recipeName ? ` · ${block.recipeName}` : ""}</small>
      {block.stale && <em className="motion-block-stale">{uiText("要重新套用才能改字")}</em>}
      {handles && <>
        <span className="clip-trim-handle start motion-trim-handle" aria-hidden="true" title={uiText(block.trim.allowed ? "拖曳改開始時間" : "模板長度跟著主片段")}
          onPointerDown={event => beginMotionGesture(event, block, "start")} onPointerMove={moveMotion} onPointerUp={endMotion} onPointerCancel={cancelMotion} onLostPointerCapture={cancelMotion} />
        <span className="clip-trim-handle end motion-trim-handle" aria-hidden="true" title={uiText(block.trim.allowed ? "拖曳改結束時間" : "模板長度跟著主片段")}
          onPointerDown={event => beginMotionGesture(event, block, "end")} onPointerMove={moveMotion} onPointerUp={endMotion} onPointerCancel={cancelMotion} onLostPointerCapture={cancelMotion} />
      </>}
    </button>;
  };

  const renderClip = (clip: TimelineClip, track: TimelineTrack) => {
    const asset = assetMap.get(clip.assetId);
    const kind = track.kind as "video" | "audio";
    const role = clip.layer?.role ?? "content";
    const isController = role === "controller";
    const clipName = isController ? `Null · ${clip.id}` : asset?.name ?? clip.id;
    const clipHelp = isController ? "Null 控制器：只控制父子變換與透明度，不會顯示或解碼原始媒體" : onCommand ? "逐幀拖曳 · 拖邊緣修剪或拉長 · Ctrl＋拖剪接點一起修剪 · Alt＋拖曳滑動片段" : onExtendClip || onSlipClip ? CLIP_DRAG_HELP : DRAG_HELP;
    // The asset's whole-file waveform, cropped to the part of the media this clip plays (sourceStart … +duration); a
    // picture clip with sound shows it along its lower edge.
    const waveformUrl = !isController && asset ? runtimeUrls[`${asset.id}:waveform`] : undefined;
    const waveform = waveformUrl && asset ? clipWaveformWindow(clip, asset) : undefined;
    return <button type="button" key={clip.id} className={`timeline-clip ${isController ? "controller" : ""} ${(selectedClipIds?.includes(clip.id) ?? (selectedClipId === clip.id)) ? "selected" : ""} ${track.locked ? "locked" : ""}`} style={{ left: clip.timelineStart * pixelsPerSecond, width: Math.max(12, clip.duration * pixelsPerSecond) }} onPointerDown={(event) => beginItemDrag(event, { kind: "clip", id: clip.id, trackId: track.id, trackKind: track.kind, start: clip.timelineStart, duration: clip.duration, locked: track.locked })} onPointerMove={moveItemDrag} onPointerUp={endItemDrag} onPointerCancel={cancelItemDrag} onLostPointerCapture={cancelItemDrag} onClick={(event) => activateItem(event, "clip", clip.id, clip.timelineStart)}
      onContextMenu={event => clipMenuControls.onContextMenu(event, clip, track, asset)} data-link-group={clip.linkGroupId} data-testid={`timeline-clip-${clip.id}`} data-layer-role={role} data-timeline-start={clip.timelineStart} data-duration={clip.duration} aria-label={uiText("{value0}，{value1}，可拖曳移動", { value0: clipName, value1: formatTime(clip.timelineStart) })} aria-disabled={track.locked} title={uiText(track.locked ? LOCKED_HELP : blade ? BLADE_HELP : clipHelp)}>
      {!isController && kind === "video" && <TimelineFilmstrip url={runtimeUrls[`${asset?.id}:thumbnail`] ?? filmstripUrls[clip.assetId]} width={clip.duration * pixelsPerSecond} />}
      {waveform && <span className={`clip-waveform${kind === "video" ? " under-picture" : ""}`} aria-hidden="true" data-testid={`timeline-clip-waveform-${clip.id}`}
        data-source-start={waveform.sourceStart} data-source-end={waveform.sourceEnd}>
        <img src={waveformUrl} alt="" draggable={false} style={{ left: `${waveform.leftPercent}%`, width: `${waveform.widthPercent}%` }} /></span>}
      <span className="clip-pattern" /><strong>{linkedClipIds(project, clip.id).length > 1 && <span title={uiText("連結的片段")} data-testid={`timeline-clip-link-${clip.id}`}><EasyIcon name="link" size={12} /></span>}{clipName}</strong><small>{isController ? uiText("不渲染 · ") : ""}{formatTime(clip.duration)}</small>
      {clip.keyframes.map((keyframe) => <i key={keyframe.id} className="keyframe-marker" style={{ left: `${(keyframe.time / clip.duration) * 100}%` }} />)}
      {trimHandles({ kind: "clip", id: clip.id, start: clip.timelineStart, duration: clip.duration, locked: track.locked })}
      {onCommand && !isController && asset && asset.kind !== "image" && !asset.compositionId && (selectedClipIds?.includes(clip.id) ?? selectedClipId === clip.id) && <TimelineAudioEnvelope clip={clip} pixelsPerSecond={pixelsPerSecond} music={asset.role === "background-music"} locked={track.locked} onCommand={onCommand} onEditStart={onEditStart} onRefused={onEditRefused} />}
    </button>;
  };

  const cancelActiveEdit = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && adjacent.cancel()) { event.preventDefault(); event.stopPropagation(); return; }
    if (event.key !== "Escape" || (!dragRef.current && !trimRef.current && !slipRef.current && !motionRef.current)) return;
    event.preventDefault();
    event.stopPropagation();
    if (slipRef.current) { cancelSlip(); return; }
    if (motionRef.current) { cancelMotion(); return; }
    gestureAdmission.clear();
    const session = cancelTimelinePointerEdits({ dragRef, trimRef, dragFrameRef, trimFrameRef,
      cancelFrame: cancelAnimationFrame, clearDrag: clearDragVisual, clearTrim: clearTrimVisual });
    if (!session) return;
    suppressClickRef.current = `${session.kind}:${session.id}`;
    flushDeferredSelectionReveal();
  };

  // The toolbar measures itself again when its words change: language, size, mode, 調整片段／字幕, 改標題文字, 吸附 開／關, counts.
  const toolbarFitKey = [interfaceLocale, interfaceScale, pinnedCaption ? "caption" : "clip", selectedMotionBlock?.kind === "template" ? "template" : "",
    snapEnabled ? "snap" : "free", project.tracks.reduce((sum, track) => sum + track.clips.length, 0), project.captions.length, simpleMode ? "simple" : "advanced"].join("|");
  return <section className="timeline-shell" aria-label={uiText("時間軸")} onKeyDown={cancelActiveEdit} data-interface-mode={simpleMode ? "simple" : "advanced"} data-tool={tool}>
    {clipMenuControls.renderMenu()}
    <output ref={positionRef} className="timeline-edit-position" hidden data-testid="timeline-edit-position" />
    <TimelineToolbarFit fitKey={toolbarFitKey}>
      <div><strong>{uiText("時間軸")}</strong><span>{uiText(blade ? BLADE_HELP : onCommand ? "拖中間移動 · Ctrl＋拖剪接點一起修剪 · Alt＋拖曳滑動片段" : onExtendClip || onSlipClip ? "拖中間移動 · 拖邊緣修剪或拉長 · Alt＋拖曳換入點" : "拖中間移動 · 拖左右邊緣修剪")}</span>{!simpleMode && <small>{project.tracks.reduce((sum, track) => sum + track.clips.length, 0)} {uiText("個片段 ·")}{project.captions.length} {uiText("段字幕")}</small>}</div>
      <div className="timeline-actions">
        <div className="timeline-quick-actions" aria-label={uiText("常用時間軸操作")}>
          {/* The two tools, in both modes: 選取 (A) and 剪刀 (B), as in CapCut, DaVinci and Final Cut. */}
          <div className="timeline-tool-toggle" role="group" aria-label={uiText("時間軸工具")} data-testid="timeline-tool-toggle">
            <button type="button" aria-pressed={!blade} aria-keyshortcuts="A" onClick={() => chooseTool("select")} data-testid="timeline-tool-select"
              title={uiText(SELECT_TOOL_HELP)}><EasyIcon name="pointer" />{uiText("選取")}<kbd aria-hidden="true">A</kbd></button>
            <button type="button" aria-pressed={blade} aria-keyshortcuts="B" onClick={() => chooseTool("blade")} data-testid="timeline-tool-blade"
              title={uiText(BLADE_TOOL_HELP)}><EasyIcon name="scissors" />{uiText("剪刀")}<kbd aria-hidden="true">B</kbd></button>
          </div>
          <button type="button" onClick={onAddCaption} data-testid="add-caption-button">{uiText("＋ 文字")}</button>
          {!simpleMode && onAddTitle && <button type="button" onClick={onAddTitle} data-testid="timeline-add-title" data-overflow-step="3">{uiText("＋ 標題")}</button>}
          {/* Simple mode: picking a clip, text or title opens its panel by itself, so these switches and extra tools are advanced-only. */}
          {!simpleMode && onEditSelection && <button type="button" disabled={!pinnedClip && !pinnedCaption} data-testid="edit-selection-button"
            onClick={() => { if (pinnedClip || pinnedCaption) onEditSelection(); }}>{uiText(pinnedCaption ? "調整字幕" : "調整片段")}</button>}
          {!simpleMode && selectedMotionBlock?.kind === "template" && <button type="button" className="motion-edit-template-action" data-testid="timeline-edit-template"
            onClick={() => openTemplateEditor(selectedMotionBlock)}>{uiText("改標題文字")}</button>}
          {!simpleMode && <button type="button" className="timeline-snap-toggle" onClick={toggleSnap} aria-pressed={snapEnabled} data-testid="timeline-snap-toggle" title={uiText(onSlipClip ? "吸附片段、字幕、播放頭與標記；拖曳中按 Alt 暫停吸附，始終逐幀移動" : "吸附片段、字幕、播放頭與標記；Alt 暫停吸附，始終逐幀移動")}>{uiText("吸附")}{snapEnabled ? uiText(" 開") : uiText(" 關")}</button>}
          {!simpleMode && <button type="button" onClick={zoomToFrames} data-testid="timeline-frame-zoom" data-overflow-step="1" title={uiText("放大到每幀至少 8 像素，方便逐幀拖放與查看刻度")}>{uiText("逐幀")}</button>}
          <button type="button" className="timeline-icon-action" onClick={onSplit} disabled={!selectedClipId && !("target" in findSplitTarget(project, playhead, selectedClipId))} data-testid="split-button"
            aria-keyshortcuts="Control+B" title={uiText("在播放頭切開（Ctrl+B）")}><EasyIcon name="split" />{uiText("切開")}</button>
          {selectedMotionBlock
            ? <button type="button" className="danger-action timeline-icon-action" onClick={() => deleteMotionBlock(selectedMotionBlock)} data-testid="delete-button" aria-keyshortcuts="Delete"
              title={uiText("刪除選取的標題或圖卡（Delete）")}><EasyIcon name="trash" />{uiText("刪除")}</button>
            : <button type="button" className="danger-action timeline-icon-action" onClick={onDelete} disabled={!selectedClipId && !selectedCaptionId} data-testid="delete-button" aria-keyshortcuts="Delete"
              title={uiText("刪除選取的片段（Delete）")}><EasyIcon name="trash" />{uiText("刪除")}</button>}
          {!simpleMode && <>
            <button type="button" onClick={() => onAddTrack("video")} data-testid="add-video-track-button" data-overflow-step="3">{uiText("＋ 軌道")}</button>
            <button type="button" className="pip-action" onClick={onMakePictureInPicture} disabled={!selectedClipId} data-testid="picture-in-picture-button" data-overflow-step="2">{uiText("畫中畫")}</button>
            <button type="button" onClick={fit} data-testid="timeline-fit-button" data-overflow-step="4">{uiText("顯示全部")}</button>
          </>}
        </div>
        {simpleMode
          ? <TimelineZoomControl pixelsPerSecond={pixelsPerSecond} min={MIN_PIXELS_PER_SECOND} max={MAX_PIXELS_PER_SECOND}
            onZoom={factor => zoom(factor)} onFit={fit} />
          : <details className="timeline-more">
          <summary>{uiText("更多工具")}</summary>
          <div className="timeline-more-popover">
            <strong>{uiText("常用功能")}</strong>
            <div className="timeline-primary-actions"><span className="ripple-default" title={uiText("刪除片段時，同步內容會自動往前補空隙")}>{uiText("✓ 自動補空隙")}</span>
              <button type="button" className="pip-action" onClick={onMakePictureInPicture} disabled={!selectedClipId} data-testid="timeline-more-picture-in-picture" data-overflow-copy="2">{uiText("畫中畫")}</button></div>
            <strong>{uiText("時間軸大小")}</strong>
            <div className="timeline-zoom" aria-label={uiText("時間軸縮放")}><button type="button" onClick={() => zoom(0.75)} title={uiText("縮小")}>{uiText("− 縮小")}</button><button type="button" onClick={fit}>{uiText("顯示全部")}</button><button type="button" onClick={() => zoom(1.34)} title={uiText("放大")}>{uiText("＋ 放大")}</button>
              <button type="button" onClick={zoomToFrames} data-testid="timeline-more-frame-zoom" data-overflow-copy="1" title={uiText("放大到每幀至少 8 像素，方便逐幀拖放與查看刻度")}>{uiText("逐幀")}</button></div>
            <strong>{uiText("進階內容")}</strong>
            <div className="timeline-add-actions"><button type="button" onClick={() => onAddTrack("video")} data-testid="timeline-more-add-video-track" data-overflow-copy="3">{uiText("＋ 軌道")}</button>
              {onAddTitle && <button type="button" onClick={onAddTitle} data-testid="timeline-more-add-title" data-overflow-copy="3">{uiText("＋ 標題")}</button>}
              <button type="button" onClick={() => onAddTrack("audio")}>{uiText("＋ 聲音軌")}</button><button type="button" onClick={onPrecompose} disabled={!selectedClipId} data-testid="precompose-button">{uiText("▣ 建立預合成")}</button></div>
          </div>
        </details>}
      </div>
    </TimelineToolbarFit>
    <div className="timeline-scroll" ref={scrollRef} onScroll={handleScroll} onPointerMove={blade ? bladeLine.onPointerMove : undefined}
      onPointerLeave={blade ? bladeLine.onPointerLeave : undefined} data-testid="timeline-scroll" data-timeline-viewport="true" data-pixels-per-second={pixelsPerSecond} data-fps={project.fps} data-timeline-pixels-per-second={pixelsPerSecond} data-timeline-fps={project.fps} tabIndex={0} aria-label={uiText("時間軸；Shift 加滾輪水平捲動，Ctrl 加滾輪縮放")}>
      <div className="timeline-canvas" style={{ width: LABEL_WIDTH + timelineWidth }}>
        <div className="timeline-row ruler-row">
          <div className="track-label ruler-label"><span title={uiText("{value0} fps · 分:秒:幀（非丟幀）", { value0: project.fps })}>{timelineFrameLabel(playhead, project.fps)}<small>{uiText("分 : 秒 : 幀")}</small></span></div>
          <div className="timeline-ruler" onPointerDown={beginScrub} onPointerMove={moveScrub} onPointerUp={endScrub} onPointerCancel={cancelScrub} onClick={seekFromClick} onDoubleClick={fit} data-testid="timeline-ruler" title={uiText("點一下移動播放頭；雙擊顯示全部")}>
            {frameTicks.map(time => <i className="timeline-frame-tick" aria-hidden="true" key={time} style={{ left: time * pixelsPerSecond }} />)}
            {marks.map((mark) => <span key={mark} className={mark > duration + 1e-6 ? "beyond-end" : undefined} style={{ left: mark * pixelsPerSecond }}><i />{timelineFrameLabel(mark, project.fps)}</span>)}
            {/* The canvas keeps drop room after the end; seeking and the playhead stop at the real end. */}
            {duration > 0 && <>
              <div className="timeline-beyond-end" aria-hidden="true" style={{ left: duration * pixelsPerSecond }} />
              <div className="timeline-project-end" data-testid="timeline-project-end" data-duration={duration} style={{ left: duration * pixelsPerSecond }}
                title={uiText("影片在這裡結束：{time}", { time: timelineFrameLabel(duration, project.fps) })}><span>{uiText("片尾")}</span></div>
            </>}
            <TimelineRulerMarkers markers={markers ?? project.director.markers} pixelsPerSecond={pixelsPerSecond} fps={project.fps} duration={duration}
              onSeek={onSeek} onEditStart={onEditStart} onCommand={onCommand} />
            <TimelineRangeOverlay range={markRange} pixelsPerSecond={pixelsPerSecond} ruler />
          </div>
        </div>
        {motionBlocks.length > 0 && <div className={`timeline-row motion-row${motionLane.compact ? " compact" : ""}`} style={{ height: motionLane.height }} data-testid="motion-lane-row"
          data-motion-rows={motionLane.rows} data-motion-visible-rows={motionLane.visibleRows}>
          <div className="track-label motion-track-label" data-drop-zone="blocked" title={uiText("標題、圖卡和模板；跟著下面的主片段移動")}>
            <div className="track-kind motion" aria-hidden="true">{uiText("標")}</div>
            <div className="track-copy"><strong>{uiText("標題與圖卡")}</strong>
              {motionLane.overflow
                ? <button type="button" className="motion-lane-more" data-testid="motion-lane-more" aria-expanded={motionLane.visibleRows >= motionLane.rows}
                  aria-label={motionLane.visibleRows < motionLane.rows ? uiText("還有 {count} 個標題或圖卡沒顯示，按一下全部顯示", { count: motionLane.hidden }) : uiText("收起，只顯示兩排標題")}
                  onClick={toggleMotionLane}>{motionLane.visibleRows < motionLane.rows ? uiText("還有 {count} 個", { count: motionLane.hidden }) : uiText("收起")}</button>
                : <span>{onCommand ? uiText("跟著主片段走") : uiText("只能查看")}</span>}</div>
          </div>
          <div className="track-lane motion-lane" data-testid="motion-lane" aria-label={uiText("標題與圖卡")} onPointerDown={beginScrub} onPointerMove={moveScrub}
            onPointerUp={endScrub} onPointerCancel={cancelScrub} onClick={seekFromClick}>
            {motionBlocks.filter(block => block.row < motionLane.visibleRows).map(renderMotionBlock)}
            <div className="playhead" style={{ left: playhead * pixelsPerSecond }}><span /></div>
          </div>
        </div>}
        {project.tracks.map((track) => <div className="timeline-row" key={track.id}>
          <div className="track-label" data-drop-zone="blocked" title={uiText("這裡是軌道名稱，不是片段投放區")}><div className={`track-kind ${track.kind}`}>{track.kind === "video" ? "V" : track.kind === "audio" ? "A" : "T"}</div><div className="track-copy"><strong>{track.name}{track.kind !== "caption" && track.solo && <span style={{ fontWeight: 800, color: "var(--accent)" }} data-testid={`track-solo-${track.id}`}> S</span>}</strong><span className={track.locked ? "track-locked" : track.kind === "video" && track.hidden ? "track-hidden" : undefined}>{track.locked ? uiText("已鎖定") : track.kind === "video" && track.hidden ? uiText("畫面已隱藏") : track.kind === "video" ? uiText("畫面") : track.kind === "audio" ? uiText("聲音") : uiText("文字")}</span></div><button type="button" className={`track-mute ${track.muted ? "active" : ""}`} onClick={() => onToggleMute(track.id)} aria-label={uiText("{value0} 靜音", { value0: track.name })} aria-pressed={track.muted} title={uiText(track.kind === "video" ? "靜音：只關聲音，畫面照常" : "靜音")}>{track.muted ? "M" : "●"}</button><TrackOptions track={track} onRename={onRenameTrack} onToggleLock={onToggleTrackLock} onToggleHidden={onToggleHidden} onToggleSolo={onCommand ? id => { onEditStart?.(); onCommand({ type: "set_track_solo", trackId: id, solo: !Boolean(track.solo) }, track.solo ? "已取消軌道獨奏。" : "已獨奏這條軌道。"); } : undefined} onDelete={onDeleteTrack} /></div>
          <div className={`track-lane ${track.kind}${track.kind === "video" && track.hidden ? " is-hidden" : ""}${track.muted ? " is-muted" : ""}`} data-track-id={track.id} data-track-kind={track.kind} data-track-locked={track.locked} data-track-hidden={track.kind === "video" ? Boolean(track.hidden) : undefined} onPointerDown={beginScrub} onPointerMove={moveScrub} onPointerUp={endScrub} onPointerCancel={cancelScrub} onClick={seekFromClick} onContextMenu={canvas.contextGap} onDragOver={previewAssetDrop} onDragLeave={leaveAssetDrop} onDrop={commitAssetDrop}>
            <TimelineRangeOverlay range={markRange} pixelsPerSecond={pixelsPerSecond} />
            {track.kind === "caption" && visibleCaptions.map((caption) => <button type="button" key={caption.id} className={`timeline-clip caption ${(selectedCaptionIds?.includes(caption.id) ?? (selectedCaptionId === caption.id)) ? "selected" : ""} ${track.locked ? "locked" : ""}`} style={{ left: caption.start * pixelsPerSecond, width: Math.max(12, caption.duration * pixelsPerSecond) }} onPointerDown={(event) => beginItemDrag(event, { kind: "caption", id: caption.id, trackId: track.id, trackKind: track.kind, start: caption.start, duration: caption.duration, locked: track.locked })} onPointerMove={moveItemDrag} onPointerUp={endItemDrag} onPointerCancel={cancelItemDrag} onLostPointerCapture={cancelItemDrag} onClick={(event) => activateItem(event, "caption", caption.id, caption.start)} data-testid={`timeline-caption-${caption.id}`} data-timeline-start={caption.start} data-duration={caption.duration} aria-label={uiText("{value0}{value1}，{value2}，可拖曳移動或修剪邊緣", { value0: caption.text, value1: caption.translation ? uiText("，英文 {value0}", { value0: caption.translation.text }) : "", value2: formatTime(caption.start) })} aria-disabled={track.locked} title={uiText(track.locked ? LOCKED_HELP : DRAG_HELP)}><span className="clip-pattern" /><strong>{caption.text}{caption.translation && <em>EN</em>}</strong><small>{formatTime(caption.duration)}</small>{trimHandles({ kind: "caption", id: caption.id, start: caption.start, duration: caption.duration, locked: track.locked })}</button>)}
            {(visibleClips.get(track.id) ?? []).map((clip) => renderClip(clip, track))}
            {renderTrackOverlay?.(track, pixelsPerSecond)}
            <div className="playhead" style={{ left: playhead * pixelsPerSecond }} data-testid="timeline-playhead"><span /></div>
          </div>
        </div>)}
        {canvas.overlays}
        <div ref={guideRef} className="timeline-snap-guide" data-testid="timeline-snap-guide" hidden aria-hidden="true" />
        <div ref={assetDropPreviewRef} className="timeline-asset-drop-preview" data-testid="timeline-asset-drop-preview" hidden aria-hidden="true"><span className="timeline-asset-drop-label" hidden /></div>
        <div ref={bladeLine.lineRef} className="timeline-blade-line" data-testid="timeline-blade-line" hidden aria-hidden="true"><span /></div>
      </div>
    </div>
  </section>;
}
