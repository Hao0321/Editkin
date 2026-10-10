import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { TimelineClip, TimelineTrack } from "../domain/types";
import { formatTime } from "../lib/format";
import { TIMELINE_DRAG_THRESHOLD_PX, TIMELINE_MAGNET_THRESHOLD_PX, alignTimelineTime, nudgeTimelineTime, resolveTimelineDrag, resolveTimelineDropTarget, resolveTimelineTrim, timelineAutoScrollDelta, timelineTrackAutoScrollDelta, timelineFrameLabel, timelineTimeAtPointer, visibleTimelineDropLanes } from "./timelineInteraction";
import { EDITKIN_ASSET_DRAG_TYPE, resolveTimelineAssetDrop, timelineAssetDuration } from "./timelineAssetDrop";
import { INTERNAL_ASSET_POINTER_DRAG_EVENT, isInternalAssetPointerDragDetail, type InternalAssetPointerDragDetail } from "./internalAssetPointerDrag";
import { buildTimelineSnapIndex, queryTimelineSnapTimes } from "./timelineSnapping";
import { buildTimelineIntervalIndex, queryTimelineIntervalIndex, timelineRulerStep } from "./timelineViewport";
import { retainTimelineSelection } from "./timelineViewport";
import { cancelTimelinePointerEdits, createDeferredTimelineSelectionReveal, resolveTimelineSelectionReveal, timelineSelectionRevealKey } from "./timelineSelectionReveal";
import { scrollViewportByWheel } from "./wheelScroll";
import { libraryWheelDeltaPixels } from "./creativeLibraryPreview";
import { TrackOptions } from "./TrackOptions";
import { DRAG_HELP, LOCKED_HELP, MAX_PIXELS_PER_SECOND, MIN_PIXELS_PER_SECOND, TIMELINE_LABEL_WIDTH as LABEL_WIDTH, type CachedDragLane, type DragKind, type DragSession, type ScrubSession, type TimelineProps, type TrimSession } from "./timelineContract";
import "./timelineDirectManipulation.css";

export function Timeline({ project, duration, playhead, selectedClipId, selectedCaptionId, runtimeUrls, draggingAssetId, onInsertAsset, onEditStart, onSeek, onSelect, onSelectCaption, onMoveClip, onMoveCaption, onTrimClip, onTrimCaption, onAddCaption, onAddTrack, onRenameTrack, onToggleTrackLock, onDeleteTrack, onMakePictureInPicture, onPrecompose, onToggleMute, onSplit, onDelete }: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
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
  const [selectionReveal] = useState(createDeferredTimelineSelectionReveal);
  const [selectionRevealRevision, setSelectionRevealRevision] = useState(0);
  const [snapEnabled, setSnapEnabled] = useState(() => {
    try { return localStorage.getItem("editkin.timeline.snap") !== "off"; } catch { return true; }
  });
  const [pixelsPerSecond, setPixelsPerSecond] = useState(80);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(900);
  const draggingAsset = project.assets.find((asset) => asset.id === draggingAssetId);
  const visualDuration = Math.max(12, duration + (draggingAsset ? timelineAssetDuration(draggingAsset, project.fps) + 1 : 4));
  const timelineWidth = Math.max(720, visualDuration * pixelsPerSecond);
  const assetMap = useMemo(() => new Map(project.assets.map((asset) => [asset.id, asset])), [project.assets]);
  const clipIndexes = useMemo(() => new Map(project.tracks.map((track) => [track.id, buildTimelineIntervalIndex(track.clips, (clip) => ({ start: clip.timelineStart, end: clip.timelineStart + clip.duration }))])), [project.tracks]);
  const captionIndex = useMemo(() => buildTimelineIntervalIndex(project.captions, (caption) => ({ start: caption.start, end: caption.start + caption.duration })), [project.captions]);
  const snapIndex = useMemo(() => buildTimelineSnapIndex(project), [project.tracks, project.captions, project.director.markers]);
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

  const showEditPosition = (time?: number, snapTime?: number) => {
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
      output.hidden = time === undefined;
      if (time !== undefined) output.textContent = `${snapTime !== undefined ? "已吸附 · " : ""}${timelineFrameLabel(time, project.fps)} · 第 ${Math.round(time * project.fps)} 幀`;
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

  const pointerEditing = () => Boolean(dragRef.current || trimRef.current || assetPointerRef.current || scrubRef.current);
  const flushDeferredSelectionReveal = () => {
    if (selectionReveal.resume(pointerEditing())) setSelectionRevealRevision(revision => revision + 1);
  };

  useEffect(() => {
    if (!selectionRevealKey || !pinnedClip) { committedDragRevealRef.current = undefined; selectionReveal.clear(); return; }
    // Pointer owners retain their exact scroll geometry; release/cancel flushes once.
    if (pointerEditing()) { selectionReveal.defer(); return; }
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
    if (dragFrameRef.current !== undefined) cancelAnimationFrame(dragFrameRef.current);
    if (scrubFrameRef.current !== undefined) cancelAnimationFrame(scrubFrameRef.current);
    if (trimFrameRef.current !== undefined) cancelAnimationFrame(trimFrameRef.current);
    if (scrollFrameRef.current !== undefined) cancelAnimationFrame(scrollFrameRef.current);
    if (assetPointerFrameRef.current !== undefined) cancelAnimationFrame(assetPointerFrameRef.current);
    dragLastFrameRef.current = undefined;
    assetPointerLastFrameRef.current = undefined;
    assetPointerRef.current = undefined;
  }, []);

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

  function assetDropAtPoint(assetId: string, clientX: number, clientY: number, altKey: boolean) {
    const node = scrollRef.current, asset = project.assets.find(item => item.id === assetId);
    if (!node || !asset || !onInsertAsset) return undefined;
    const lane = resolveTimelineDropTarget(clientX, clientY, asset.kind === "audio" ? "audio" : "video", currentDropLanes());
    const track = project.tracks.find(item => item.id === lane?.trackId);
    if (!lane || !track || track.locked || track.kind !== lane.trackKind) return undefined;
    const rawTime = Math.max(0, (clientX - node.getBoundingClientRect().left - node.clientLeft - LABEL_WIDTH + node.scrollLeft) / pixelsPerSecond);
    const assetDuration = timelineAssetDuration(asset, project.fps);
    const margin = TIMELINE_MAGNET_THRESHOLD_PX / pixelsPerSecond + 1 / project.fps;
    const occupied = queryTimelineIntervalIndex(clipIndexes.get(track.id)!, Math.max(0, rawTime - margin), rawTime + assetDuration + margin);
    const preliminary = alignTimelineTime(rawTime, project.fps);
    const candidates = queryTimelineSnapTimes(snapIndex, `asset:${asset.id}`, [preliminary, preliminary + assetDuration], pixelsPerSecond, project.fps, playhead);
    return { trackId: track.id, lane: lane.element, result: resolveTimelineAssetDrop({ rawTime, duration: assetDuration,
      fps: project.fps, pixelsPerSecond, snapCandidates: candidates, occupied, magnetEnabled: snapEnabled && !altKey, collisionPolicy: "new-layer" }) };
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
    ghost.dataset.snapTime = result.snappedTo === undefined ? "" : String(result.snappedTo);
    showEditPosition(result.start, result.allowed ? result.snappedTo : undefined);
  };

  const assetDropAt = (event: ReactDragEvent<HTMLDivElement>) => {
    return draggingAssetId ? assetDropAtPoint(draggingAssetId, event.clientX, event.clientY, event.altKey) : undefined;
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
    if (event.dataTransfer.getData(EDITKIN_ASSET_DRAG_TYPE) !== draggingAssetId || !placement?.result.allowed) { showDropRejection(true); return; }
    onEditStart?.();
    if (onInsertAsset?.(draggingAssetId, placement.trackId, placement.result.start) === false) showDropRejection(true);
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
    let placement = assetDropAtPoint(session.assetId, session.clientX, session.clientY, session.altKey);
    const content = trackContentAtPoint(session.clientX, session.clientY);
    if (allowAutoScroll && content) {
      // Traversal is allowed past a locked/wrong-kind lane; drop admission stays
      // strict and is recalculated from the newly visible live lane geometry.
      let scrolled = scrollTrackStack(session.clientX, session.clientY, elapsedMs);
      if (scrolled) placement = assetDropAtPoint(session.assetId, session.clientX, session.clientY, session.altKey);
      const delta = timelineAutoScrollDelta(session.clientX, content.left, content.right, elapsedMs);
      if (delta) {
        const before = node.scrollLeft;
        node.scrollLeft = Math.max(0, before + delta);
        if (node.scrollLeft !== before) {
          placement = assetDropAtPoint(session.assetId, session.clientX, session.clientY, session.altKey);
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
      if (!onInsertAsset || dragRef.current || trimRef.current || scrubRef.current
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
    if (!placement?.result.allowed) { showDropRejection(true); return; }
    if (onInsertAsset?.(detail.assetId, placement.trackId, placement.result.start) === false) showDropRejection(true);
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
    return resolveTimelineDropTarget(session.currentClientX, session.currentClientY, session.trackKind, session.lanes)?.element;
  };

  const snapCandidatesFor = (session: Pick<DragSession, "kind" | "id">, edges: number[]) =>
    queryTimelineSnapTimes(snapIndex, `${session.kind}:${session.id}`, edges, pixelsPerSecond, project.fps, playhead);

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
    const resolved = resolveTimelineDrag({ originStart: session.originStart, duration: session.duration, originClientX: session.originClientX, currentClientX: session.currentClientX, originScrollLeft: session.originScrollLeft, currentScrollLeft: node.scrollLeft, pixelsPerSecond, fps: project.fps, snapCandidates: snapCandidatesFor(session, [preliminary.start, preliminary.start + session.duration]), magnetEnabled: snapEnabled && !session.altKey });
    const newLayer = session.kind === "clip" && session.canDrop && !isStartAllowed(resolved.start);
    session.targetStart = resolved.start;
    session.targetTrackId = targetTrackId;
    session.moved ||= resolved.moved || targetTrackId !== session.originTrackId
      || Math.hypot(session.currentClientX - session.originClientX, session.currentClientY - session.originClientY) >= TIMELINE_DRAG_THRESHOLD_PX;
    const targetLaneTop = targetLane?.getBoundingClientRect().top ?? session.sourceLaneTop;
    const sourceLaneTop = session.element.closest(".track-lane")?.getBoundingClientRect().top ?? session.sourceLaneTop;
    session.element.style.transform = `translate3d(${(resolved.start - session.originStart) * pixelsPerSecond}px, ${targetLane ? targetLaneTop - sourceLaneTop : session.currentClientY - session.originClientY + session.sourceLaneTop - sourceLaneTop}px, 0)`;
    session.element.dataset.timelineStart = String(session.targetStart);
    session.element.dataset.targetTrackId = targetTrackId;
    session.element.classList.toggle("is-dragging", session.moved);
    session.element.classList.toggle("is-snapped", session.canDrop && resolved.snappedTo !== undefined);
    session.element.classList.toggle("is-invalid-drop", session.moved && !session.canDrop);
    session.element.classList.toggle("is-new-layer-drop", session.moved && newLayer);
    showEditPosition(session.moved && session.canDrop ? resolved.start : undefined, session.moved && session.canDrop ? resolved.snappedTo : undefined);
    node.dataset.dropState = session.canDrop ? newLayer ? "new-layer" : "valid" : "invalid";
    if (session.activeDropLane !== targetLane) {
      session.activeDropLane?.classList.remove("is-drop-target");
      targetLane?.classList.add("is-drop-target");
      session.activeDropLane = targetLane;
    }
  }

  const beginItemDrag = (event: ReactPointerEvent<HTMLButtonElement>, item: { kind: DragKind; id: string; trackId: string; trackKind: TimelineTrack["kind"]; start: number; duration: number; locked: boolean }) => {
    if (event.button !== 0 || item.locked || pointerEditing()) return;
    suppressClickRef.current = undefined;
    committedDragRevealRef.current = undefined;
    event.preventDefault();
    onEditStart?.();
    event.stopPropagation();
    // Preserve keyboard focus without the browser scrolling the grabbed clip.
    event.currentTarget.focus?.({ preventScroll: true });
    if (item.kind === "clip") onSelect(item.id); else onSelectCaption(item.id);
    event.currentTarget.setPointerCapture(event.pointerId);
    dragLastFrameRef.current = undefined;
    dragRef.current = { kind: item.kind, id: item.id, trackKind: item.trackKind, originTrackId: item.trackId, targetTrackId: item.trackId, originStart: item.start, targetStart: item.start, duration: item.duration, originClientX: event.clientX, originClientY: event.clientY, currentClientX: event.clientX, currentClientY: event.clientY, originScrollLeft: scrollRef.current?.scrollLeft ?? 0, pointerId: event.pointerId, altKey: event.altKey, moved: false, canDrop: true, element: event.currentTarget, sourceLaneTop: event.currentTarget.closest(".track-lane")?.getBoundingClientRect().top ?? event.currentTarget.getBoundingClientRect().top, lanes: currentDropLanes() };
  };

  const moveItemDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
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
  };

  function abortDragSession(session: DragSession) {
    if (dragFrameRef.current !== undefined) cancelAnimationFrame(dragFrameRef.current);
    dragFrameRef.current = undefined;
    dragLastFrameRef.current = undefined;
    if (dragRef.current === session) dragRef.current = undefined;
    clearDragVisual(session);
    flushDeferredSelectionReveal();
  }

  const endItemDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const session = dragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
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
    const accepted = session.kind === "clip" ? onMoveClip(session.id, session.targetStart, session.targetTrackId)
      : onMoveCaption(session.id, session.targetStart);
    if (accepted === false) {
      committedDragRevealRef.current = undefined;
      selectionReveal.defer();
      flushDeferredSelectionReveal();
      showDropRejection();
    }
  };

  const cancelItemDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const session = dragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    if (dragFrameRef.current !== undefined) cancelAnimationFrame(dragFrameRef.current);
    dragFrameRef.current = undefined;
    dragLastFrameRef.current = undefined;
    dragRef.current = undefined;
    suppressClickRef.current = `${session.kind}:${session.id}`;
    clearDragVisual(session);
    flushDeferredSelectionReveal();
  };

  const clearTrimVisual = (session: TrimSession) => {
    showEditPosition();
    session.element.style.width = session.originWidthStyle;
    session.element.style.removeProperty("transform");
    session.element.classList.remove("is-trimming", "is-snapped");
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
    };
    const preliminary = resolveTimelineTrim({ ...input, magnetEnabled: false });
    const edgeTime = session.edge === "start" ? preliminary.start : preliminary.start + preliminary.duration;
    const resolved = resolveTimelineTrim({ ...input, snapCandidates: snapCandidatesFor(session, [edgeTime]), magnetEnabled: snapEnabled && !session.altKey });
    session.trimSeconds = resolved.trimSeconds;
    session.moved ||= resolved.moved;
    const shiftPixels = (resolved.start - session.originStart) * pixelsPerSecond;
    session.element.style.width = `${Math.max(12, resolved.duration * pixelsPerSecond)}px`;
    session.element.style.transform = `translate3d(${shiftPixels}px,0,0)`;
    session.element.classList.toggle("is-trimming", session.moved);
    session.element.classList.toggle("is-snapped", session.moved && resolved.snappedTo !== undefined);
    session.element.dataset.timelineStart = String(resolved.start);
    session.element.dataset.duration = String(resolved.duration);
    showEditPosition(session.moved ? (session.edge === "start" ? resolved.start : resolved.start + resolved.duration) : undefined, session.moved ? resolved.snappedTo : undefined);
  };

  const scheduleTrim = () => {
    if (trimFrameRef.current !== undefined) return;
    trimFrameRef.current = requestAnimationFrame(flushTrim);
  };

  const beginTrim = (event: ReactPointerEvent<HTMLElement>, item: { kind: DragKind; id: string; start: number; duration: number; locked: boolean }, edge: "start" | "end") => {
    if (event.button !== 0 || item.locked || pointerEditing()) return;
    suppressClickRef.current = undefined;
    event.preventDefault();
    event.stopPropagation();
    const element = event.currentTarget.closest<HTMLButtonElement>(".timeline-clip");
    if (!element) return;
    committedDragRevealRef.current = undefined;
    onEditStart?.();
    if (item.kind === "clip") onSelect(item.id); else onSelectCaption(item.id);
    event.currentTarget.setPointerCapture(event.pointerId);
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
      moved: false,
      element,
      originWidth: element.getBoundingClientRect().width,
      originWidthStyle: element.style.width,
    };
  };

  const moveTrim = (event: ReactPointerEvent<HTMLElement>) => {
    const session = trimRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    session.currentClientX = event.clientX;
    session.altKey = event.altKey;
    scheduleTrim();
  };

  const endTrim = (event: ReactPointerEvent<HTMLElement>) => {
    const session = trimRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    session.currentClientX = event.clientX;
    session.altKey = event.altKey;
    if (trimFrameRef.current !== undefined) cancelAnimationFrame(trimFrameRef.current);
    flushTrim();
    trimRef.current = undefined;
    clearTrimVisual(session);
    flushDeferredSelectionReveal();
    if (!session.moved || session.trimSeconds <= 0) return;
    suppressClickRef.current = `${session.kind}:${session.id}`;
    if (session.kind === "clip") onTrimClip(session.id, session.edge, session.trimSeconds);
    else onTrimCaption(session.id, session.edge, session.trimSeconds);
  };

  const cancelTrim = (event: ReactPointerEvent<HTMLElement>) => {
    const session = trimRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    event.stopPropagation();
    if (trimFrameRef.current !== undefined) cancelAnimationFrame(trimFrameRef.current);
    trimFrameRef.current = undefined;
    trimRef.current = undefined;
    clearTrimVisual(session);
    flushDeferredSelectionReveal();
  };

  const trimHandles = (item: { kind: DragKind; id: string; start: number; duration: number; locked: boolean }) => item.locked ? null : <>
    <span className="clip-trim-handle start" title="拖曳修剪開頭" aria-hidden="true" onPointerDown={(event) => beginTrim(event, item, "start")} onPointerMove={moveTrim} onPointerUp={endTrim} onPointerCancel={cancelTrim} onLostPointerCapture={cancelTrim} />
    <span className="clip-trim-handle end" title="拖曳修剪結尾" aria-hidden="true" onPointerDown={(event) => beginTrim(event, item, "end")} onPointerMove={moveTrim} onPointerUp={endTrim} onPointerCancel={cancelTrim} onLostPointerCapture={cancelTrim} />
  </>;

  const activateItem = (event: React.MouseEvent<HTMLButtonElement>, kind: DragKind, id: string, start: number) => {
    const key = `${kind}:${id}`;
    if (suppressClickRef.current === key) {
      suppressClickRef.current = undefined;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    committedDragRevealRef.current = undefined;
    event.stopPropagation();
    if (kind === "clip") onSelect(id); else onSelectCaption(id);
    onSeek(alignTimelineTime(start, project.fps));
  };

  const nudgeItem = (event: ReactKeyboardEvent<HTMLButtonElement>, kind: DragKind, id: string, trackId: string, start: number) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    committedDragRevealRef.current = undefined;
    event.preventDefault();
    event.stopPropagation();
    const frames = event.shiftKey ? 10 : 1;
    if (project.tracks.find(track => track.id === trackId)?.locked) return;
    onEditStart?.();
    const next = nudgeTimelineTime(start, event.key === "ArrowLeft" ? -frames : frames, project.fps);
    if (kind === "clip") onMoveClip(id, next, trackId); else onMoveCaption(id, next);
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

  const beginScrub = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || pointerEditing()) return;
    committedDragRevealRef.current = undefined;
    onEditStart?.();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.classList.add("is-scrubbing");
    scrubRef.current = { pointerId: event.pointerId, currentClientX: event.clientX, element: event.currentTarget };
    flushScrub();
  };

  const moveScrub = (event: ReactPointerEvent<HTMLDivElement>) => {
    const session = scrubRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    session.currentClientX = event.clientX;
    scheduleScrub();
  };

  const endScrub = (event: ReactPointerEvent<HTMLDivElement>) => {
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
    const session = scrubRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    if (scrubFrameRef.current !== undefined) cancelAnimationFrame(scrubFrameRef.current);
    scrubFrameRef.current = undefined;
    scrubRef.current = undefined;
    session.element.classList.remove("is-scrubbing");
    flushDeferredSelectionReveal();
  };

  const seekFromClick = (event: React.MouseEvent<HTMLDivElement>) => {
    onSeek(timelineTimeAtPointer(event.clientX, event.currentTarget.getBoundingClientRect().left, pixelsPerSecond, visualDuration, project.fps));
  };

  const renderClip = (clip: TimelineClip, track: TimelineTrack) => {
    const asset = assetMap.get(clip.assetId);
    const kind = track.kind as "video" | "audio";
    const role = clip.layer?.role ?? "content";
    const isController = role === "controller";
    const clipName = isController ? `Null · ${clip.id}` : asset?.name ?? clip.id;
    const clipHelp = isController ? "Null 控制器：只控制父子變換與透明度，不會顯示或解碼原始媒體" : DRAG_HELP;
    return <button type="button" key={clip.id} className={`timeline-clip ${isController ? "controller" : ""} ${selectedClipId === clip.id ? "selected" : ""} ${track.locked ? "locked" : ""}`} style={{ left: clip.timelineStart * pixelsPerSecond, width: Math.max(12, clip.duration * pixelsPerSecond) }} onPointerDown={(event) => beginItemDrag(event, { kind: "clip", id: clip.id, trackId: track.id, trackKind: track.kind, start: clip.timelineStart, duration: clip.duration, locked: track.locked })} onPointerMove={moveItemDrag} onPointerUp={endItemDrag} onPointerCancel={cancelItemDrag} onLostPointerCapture={cancelItemDrag} onClick={(event) => activateItem(event, "clip", clip.id, clip.timelineStart)} onKeyDown={(event) => nudgeItem(event, "clip", clip.id, track.id, clip.timelineStart)} data-testid={`timeline-clip-${clip.id}`} data-layer-role={role} data-timeline-start={clip.timelineStart} data-duration={clip.duration} aria-label={`${clipName}，${formatTime(clip.timelineStart)}，可拖曳移動`} aria-disabled={track.locked} title={track.locked ? LOCKED_HELP : clipHelp}>
      {runtimeUrls[`${asset?.id}:waveform`] && kind === "audio" && <img className="clip-media-strip" src={runtimeUrls[`${asset?.id}:waveform`]} alt="" draggable={false} />}
      {!isController && runtimeUrls[`${asset?.id}:thumbnail`] && kind === "video" && <img className="clip-media-strip" src={runtimeUrls[`${asset?.id}:thumbnail`]} alt="" draggable={false} />}
      <span className="clip-pattern" /><strong>{clipName}</strong><small>{isController ? "不渲染 · " : ""}{formatTime(clip.duration)}</small>
      {clip.keyframes.map((keyframe) => <i key={keyframe.id} className="keyframe-marker" style={{ left: `${(keyframe.time / clip.duration) * 100}%` }} />)}
      {trimHandles({ kind: "clip", id: clip.id, start: clip.timelineStart, duration: clip.duration, locked: track.locked })}
    </button>;
  };

  const cancelActiveEdit = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || (!dragRef.current && !trimRef.current)) return;
    event.preventDefault();
    event.stopPropagation();
    const session = cancelTimelinePointerEdits({ dragRef, trimRef, dragFrameRef, trimFrameRef,
      cancelFrame: cancelAnimationFrame, clearDrag: clearDragVisual, clearTrim: clearTrimVisual });
    if (!session) return;
    suppressClickRef.current = `${session.kind}:${session.id}`;
    flushDeferredSelectionReveal();
  };

  return <section className="timeline-shell" aria-label="時間軸" onKeyDown={cancelActiveEdit}>
    <output ref={positionRef} className="timeline-edit-position" hidden data-testid="timeline-edit-position" />
    <div className="timeline-toolbar">
      <div><strong><b>3</b> 拖曳微調</strong><span>拖中間移動 · 拖左右邊緣修剪</span><small>{project.tracks.reduce((sum, track) => sum + track.clips.length, 0)} 個片段 · {project.captions.length} 段字幕</small></div>
      <div className="timeline-actions">
        <div className="timeline-quick-actions" aria-label="常用時間軸操作">
          <button type="button" className="timeline-snap-toggle" onClick={toggleSnap} aria-pressed={snapEnabled} data-testid="timeline-snap-toggle" title="吸附片段、字幕、播放頭與標記；Alt 暫停吸附，始終逐幀移動">吸附{snapEnabled ? " 開" : " 關"}</button>
          <button type="button" onClick={zoomToFrames} data-testid="timeline-frame-zoom" title="放大到每幀至少 8 像素，方便逐幀拖放與查看刻度">逐幀</button>
          <button type="button" onClick={onSplit} disabled={!selectedClipId} data-testid="split-button" title="在播放頭切開片段（B）">切開</button>
          <button type="button" className="danger-action" onClick={onDelete} disabled={!selectedClipId && !selectedCaptionId} data-testid="delete-button" title="刪除並自動補空隙（Delete／Backspace）">刪除</button>
          <button type="button" onClick={() => onAddTrack("video")} data-testid="add-video-track-button">＋ 軌道</button>
          <button type="button" className="pip-action" onClick={onMakePictureInPicture} disabled={!selectedClipId} data-testid="picture-in-picture-button">畫中畫</button>
          <button type="button" onClick={fit} data-testid="timeline-fit-button">顯示全部</button>
        </div>
        <details className="timeline-more">
          <summary>更多工具</summary>
          <div className="timeline-more-popover">
            <strong>常用功能</strong>
            <div className="timeline-primary-actions"><button type="button" onClick={onAddCaption} data-testid="add-caption-button">＋ 文字</button><span className="ripple-default" title="刪除片段時，同步內容會自動往前補空隙">✓ 自動補空隙</span></div>
            <strong>時間軸大小</strong>
            <div className="timeline-zoom" aria-label="時間軸縮放"><button type="button" onClick={() => zoom(0.75)} title="縮小">− 縮小</button><button type="button" onClick={fit}>顯示全部</button><button type="button" onClick={() => zoom(1.34)} title="放大">＋ 放大</button></div>
            <strong>進階內容</strong>
            <div className="timeline-add-actions"><button type="button" onClick={() => onAddTrack("audio")}>＋ 聲音軌</button><button type="button" onClick={onPrecompose} disabled={!selectedClipId} data-testid="precompose-button">▣ 建立預合成</button></div>
          </div>
        </details>
      </div>
    </div>
    <div className="timeline-scroll" ref={scrollRef} onScroll={handleScroll} data-testid="timeline-scroll" data-timeline-viewport="true" data-pixels-per-second={pixelsPerSecond} data-fps={project.fps} data-timeline-pixels-per-second={pixelsPerSecond} data-timeline-fps={project.fps} tabIndex={0} aria-label="時間軸；Shift 加滾輪水平捲動，Ctrl 加滾輪縮放">
      <div className="timeline-canvas" style={{ width: LABEL_WIDTH + timelineWidth }}>
        <div className="timeline-row ruler-row">
          <div className="track-label ruler-label"><span title={`${project.fps} fps · 分:秒:幀（非丟幀）`}>{timelineFrameLabel(playhead, project.fps)}<small>分 : 秒 : 幀</small></span></div>
          <div className="timeline-ruler" onPointerDown={beginScrub} onPointerMove={moveScrub} onPointerUp={endScrub} onPointerCancel={cancelScrub} onClick={seekFromClick} data-testid="timeline-ruler">
            {frameTicks.map(time => <i className="timeline-frame-tick" aria-hidden="true" key={time} style={{ left: time * pixelsPerSecond }} />)}
            {marks.map((mark) => <span key={mark} style={{ left: mark * pixelsPerSecond }}><i />{timelineFrameLabel(mark, project.fps)}</span>)}
            {project.director.markers.map((marker) => <button type="button" key={marker.id} className={`director-marker ${marker.kind}`} style={{ left: marker.time * pixelsPerSecond }} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onSeek(marker.time); }} title={`${marker.title} · ${formatTime(marker.time)}`}>◆</button>)}
          </div>
        </div>
        {project.tracks.map((track) => <div className="timeline-row" key={track.id}>
          <div className="track-label" data-drop-zone="blocked" title="這裡是軌道名稱，不是片段投放區"><div className={`track-kind ${track.kind}`}>{track.kind === "video" ? "V" : track.kind === "audio" ? "A" : "T"}</div><div className="track-copy"><strong>{track.name}</strong><span>{track.locked ? "已鎖定" : track.kind === "video" ? "畫面" : track.kind === "audio" ? "聲音" : "文字"}</span></div><button type="button" className={`track-mute ${track.muted ? "active" : ""}`} onClick={() => onToggleMute(track.id)} aria-label={`${track.name} 靜音`}>{track.muted ? "M" : "●"}</button><TrackOptions track={track} onRename={onRenameTrack} onToggleLock={onToggleTrackLock} onDelete={onDeleteTrack} /></div>
          <div className={`track-lane ${track.kind}`} data-track-id={track.id} data-track-kind={track.kind} data-track-locked={track.locked} onPointerDown={beginScrub} onPointerMove={moveScrub} onPointerUp={endScrub} onPointerCancel={cancelScrub} onClick={seekFromClick} onDragOver={previewAssetDrop} onDragLeave={leaveAssetDrop} onDrop={commitAssetDrop}>
            {track.kind === "caption" && visibleCaptions.map((caption) => <button type="button" key={caption.id} className={`timeline-clip caption ${selectedCaptionId === caption.id ? "selected" : ""} ${track.locked ? "locked" : ""}`} style={{ left: caption.start * pixelsPerSecond, width: Math.max(12, caption.duration * pixelsPerSecond) }} onPointerDown={(event) => beginItemDrag(event, { kind: "caption", id: caption.id, trackId: track.id, trackKind: track.kind, start: caption.start, duration: caption.duration, locked: track.locked })} onPointerMove={moveItemDrag} onPointerUp={endItemDrag} onPointerCancel={cancelItemDrag} onLostPointerCapture={cancelItemDrag} onClick={(event) => activateItem(event, "caption", caption.id, caption.start)} onKeyDown={(event) => nudgeItem(event, "caption", caption.id, track.id, caption.start)} data-testid={`timeline-caption-${caption.id}`} data-timeline-start={caption.start} data-duration={caption.duration} aria-label={`${caption.text}${caption.translation ? `，英文 ${caption.translation.text}` : ""}，${formatTime(caption.start)}，可拖曳移動或修剪邊緣`} aria-disabled={track.locked} title={track.locked ? LOCKED_HELP : DRAG_HELP}><span className="clip-pattern" /><strong>{caption.text}{caption.translation && <em>EN</em>}</strong><small>{formatTime(caption.duration)}</small>{trimHandles({ kind: "caption", id: caption.id, start: caption.start, duration: caption.duration, locked: track.locked })}</button>)}
            {(visibleClips.get(track.id) ?? []).map((clip) => renderClip(clip, track))}
            <div className="playhead" style={{ left: playhead * pixelsPerSecond }} data-testid="timeline-playhead"><span /></div>
          </div>
        </div>)}
        <div ref={guideRef} className="timeline-snap-guide" data-testid="timeline-snap-guide" hidden aria-hidden="true" />
        <div ref={assetDropPreviewRef} className="timeline-asset-drop-preview" data-testid="timeline-asset-drop-preview" hidden aria-hidden="true" />
      </div>
    </div>
  </section>;
}
