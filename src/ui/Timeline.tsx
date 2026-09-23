import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { TimelineClip, TimelineTrack } from "../domain/types";
import { formatTime } from "../lib/format";
import { alignTimelineTime, nudgeTimelineTime, resolveTimelineDrag, resolveTimelineDropTarget, resolveTimelineTrim, timelineAutoScrollDelta, timelineFrameLabel, timelineTimeAtPointer } from "./timelineInteraction";
import { buildTimelineSnapIndex, queryTimelineSnapTimes } from "./timelineSnapping";
import { buildTimelineIntervalIndex, queryTimelineIntervalIndex, timelineRulerStep } from "./timelineViewport";
import { retainTimelineSelection } from "./timelineViewport";
import { scrollViewportByWheel } from "./wheelScroll";
import { libraryWheelDeltaPixels } from "./creativeLibraryPreview";
import { TrackOptions } from "./TrackOptions";
import { DRAG_HELP, LOCKED_HELP, MAX_PIXELS_PER_SECOND, MIN_PIXELS_PER_SECOND, TIMELINE_LABEL_WIDTH as LABEL_WIDTH, type DragKind, type DragSession, type ScrubSession, type TimelineProps, type TrimSession } from "./timelineContract";
import "./timelineDirectManipulation.css";

export function Timeline({ project, duration, playhead, selectedClipId, selectedCaptionId, runtimeUrls, onSeek, onSelect, onSelectCaption, onMoveClip, onMoveCaption, onTrimClip, onTrimCaption, onAddCaption, onAddTrack, onRenameTrack, onToggleTrackLock, onDeleteTrack, onMakePictureInPicture, onPrecompose, onToggleMute, onSplit, onDelete }: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragSession | undefined>(undefined);
  const dragFrameRef = useRef<number | undefined>(undefined);
  const scrubRef = useRef<ScrubSession | undefined>(undefined);
  const scrubFrameRef = useRef<number | undefined>(undefined);
  const trimRef = useRef<TrimSession | undefined>(undefined);
  const trimFrameRef = useRef<number | undefined>(undefined);
  const scrollFrameRef = useRef<number | undefined>(undefined);
  const latestScrollLeftRef = useRef(0);
  const suppressClickRef = useRef<string | undefined>(undefined);
  const guideRef = useRef<HTMLDivElement>(null);
  const positionRef = useRef<HTMLOutputElement>(null);
  const [snapEnabled, setSnapEnabled] = useState(() => {
    try { return localStorage.getItem("editkin.timeline.snap") !== "off"; } catch { return true; }
  });
  const [pixelsPerSecond, setPixelsPerSecond] = useState(80);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(900);
  const visualDuration = Math.max(12, duration);
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

  useEffect(() => {
    if (!selectedClipId) return;
    const node = scrollRef.current;
    const clip = project.tracks.flatMap(track => track.clips).find(item => item.id === selectedClipId);
    if (!node || !clip) return;
    const contentWidth = Math.max(1, node.clientWidth - LABEL_WIDTH);
    const clipStart = clip.timelineStart * pixelsPerSecond;
    const focusWidth = Math.min(Math.max(12, clip.duration * pixelsPerSecond), 160);
    const padding = 24;
    if (clipStart < node.scrollLeft + padding) {
      node.scrollLeft = Math.max(0, clipStart - padding);
    } else if (clipStart + focusWidth > node.scrollLeft + contentWidth - padding) {
      node.scrollLeft = Math.max(0, clipStart + focusWidth - contentWidth + padding);
    }
  }, [selectedClipId]);

  useEffect(() => () => {
    if (dragFrameRef.current !== undefined) cancelAnimationFrame(dragFrameRef.current);
    if (scrubFrameRef.current !== undefined) cancelAnimationFrame(scrubFrameRef.current);
    if (trimFrameRef.current !== undefined) cancelAnimationFrame(trimFrameRef.current);
    if (scrollFrameRef.current !== undefined) cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  const fit = () => setPixelsPerSecond(Math.max(MIN_PIXELS_PER_SECOND, Math.min(MAX_PIXELS_PER_SECOND, (viewportWidth - LABEL_WIDTH - 24) / visualDuration)));
  const zoom = (factor: number, anchorClientX?: number) => {
    const node = scrollRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const anchorViewportX = anchorClientX === undefined ? Math.max(0, viewportWidth - LABEL_WIDTH) / 2 : Math.max(0, anchorClientX - rect.left - LABEL_WIDTH);
    const anchorTime = Math.max(0, node.scrollLeft + anchorViewportX) / pixelsPerSecond;
    const next = Math.max(MIN_PIXELS_PER_SECOND, Math.min(MAX_PIXELS_PER_SECOND, pixelsPerSecond * factor));
    setPixelsPerSecond(next);
    requestAnimationFrame(() => { node.scrollLeft = Math.max(0, anchorTime * next - anchorViewportX); });
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

  const compatibleLaneAtPointer = (session: DragSession): HTMLElement | undefined => {
    const target = resolveTimelineDropTarget(session.currentClientX, session.currentClientY, session.trackKind, session.lanes);
    return target ? session.lanes.find((lane) => lane.trackId === target.trackId)?.element : undefined;
  };

  const snapCandidatesFor = (session: Pick<DragSession, "kind" | "id">, edges: number[]) =>
    queryTimelineSnapTimes(snapIndex, `${session.kind}:${session.id}`, edges, pixelsPerSecond, project.fps, playhead);

  function scheduleDrag() {
    if (dragFrameRef.current !== undefined) return;
    dragFrameRef.current = requestAnimationFrame(() => flushDrag());
  }

  function flushDrag(allowAutoScroll = true) {
    dragFrameRef.current = undefined;
    const session = dragRef.current;
    const node = scrollRef.current;
    if (!session || !node) return;
    const targetLane = compatibleLaneAtPointer(session);
    session.canDrop = Boolean(targetLane);
    if (allowAutoScroll && session.canDrop) {
      const rect = node.getBoundingClientRect();
      const delta = timelineAutoScrollDelta(session.currentClientX, rect.left + LABEL_WIDTH, rect.right);
      if (delta) {
        const before = node.scrollLeft;
        node.scrollLeft = Math.max(0, node.scrollLeft + delta);
        if (node.scrollLeft !== before) scheduleDrag();
      }
    }
    const targetTrackId = targetLane?.dataset.trackId ?? session.originTrackId;
    const preliminary = resolveTimelineDrag({ originStart: session.originStart, duration: session.duration, originClientX: session.originClientX, currentClientX: session.currentClientX, originScrollLeft: session.originScrollLeft, currentScrollLeft: node.scrollLeft, pixelsPerSecond, fps: project.fps, magnetEnabled: false });
    const occupied = session.kind === "clip" && clipIndexes.has(targetTrackId)
      ? queryTimelineIntervalIndex(clipIndexes.get(targetTrackId)!, preliminary.start - 12 / pixelsPerSecond, preliminary.start + session.duration + 12 / pixelsPerSecond).filter(clip => clip.id !== session.id)
      : [];
    const isStartAllowed = (start: number) => occupied.every(clip => start + session.duration <= clip.timelineStart + 1e-6 || start >= clip.timelineStart + clip.duration - 1e-6);
    const resolved = resolveTimelineDrag({ originStart: session.originStart, duration: session.duration, originClientX: session.originClientX, currentClientX: session.currentClientX, originScrollLeft: session.originScrollLeft, currentScrollLeft: node.scrollLeft, pixelsPerSecond, fps: project.fps, snapCandidates: snapCandidatesFor(session, [preliminary.start, preliminary.start + session.duration]), magnetEnabled: snapEnabled && !session.altKey, isStartAllowed });
    session.canDrop &&= isStartAllowed(resolved.start);
    session.targetStart = session.canDrop ? resolved.start : session.originStart;
    session.targetTrackId = session.canDrop ? targetTrackId : session.originTrackId;
    session.moved ||= resolved.moved || targetTrackId !== session.originTrackId;
    const targetLaneTop = targetLane?.getBoundingClientRect().top ?? session.sourceLaneTop;
    session.element.style.transform = session.canDrop
      ? `translate3d(${(resolved.start - session.originStart) * pixelsPerSecond}px, ${targetLaneTop - session.sourceLaneTop}px, 0)`
      : "translate3d(0, 0, 0)";
    session.element.dataset.timelineStart = String(session.targetStart);
    session.element.dataset.targetTrackId = targetTrackId;
    session.element.classList.toggle("is-dragging", session.moved);
    session.element.classList.toggle("is-snapped", session.canDrop && resolved.snappedTo !== undefined);
    session.element.classList.toggle("is-invalid-drop", session.moved && !session.canDrop);
    showEditPosition(session.moved && session.canDrop ? resolved.start : undefined, session.moved && session.canDrop ? resolved.snappedTo : undefined);
    node.dataset.dropState = session.canDrop ? "valid" : targetLane ? "overlap" : "invalid";
    if (session.activeDropLane !== targetLane) {
      session.activeDropLane?.classList.remove("is-drop-target");
      targetLane?.classList.add("is-drop-target");
      session.activeDropLane = targetLane;
    }
  }

  const beginItemDrag = (event: ReactPointerEvent<HTMLButtonElement>, item: { kind: DragKind; id: string; trackId: string; trackKind: TimelineTrack["kind"]; start: number; duration: number; locked: boolean }) => {
    if (event.button !== 0 || item.locked) return;
    event.stopPropagation();
    if (item.kind === "clip") onSelect(item.id); else onSelectCaption(item.id);
    event.currentTarget.setPointerCapture(event.pointerId);
    const lanes = [...document.querySelectorAll<HTMLElement>(".track-lane[data-track-id]")].map((lane) => {
      const rect = lane.getBoundingClientRect();
      return { element: lane, trackId: lane.dataset.trackId ?? "", trackKind: (lane.dataset.trackKind ?? "video") as TimelineTrack["kind"], locked: lane.dataset.trackLocked === "true", left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    });
    dragRef.current = { kind: item.kind, id: item.id, trackKind: item.trackKind, originTrackId: item.trackId, targetTrackId: item.trackId, originStart: item.start, targetStart: item.start, duration: item.duration, originClientX: event.clientX, currentClientX: event.clientX, currentClientY: event.clientY, originScrollLeft: scrollRef.current?.scrollLeft ?? 0, pointerId: event.pointerId, altKey: event.altKey, moved: false, canDrop: true, element: event.currentTarget, sourceLaneTop: event.currentTarget.closest(".track-lane")?.getBoundingClientRect().top ?? event.currentTarget.getBoundingClientRect().top, lanes };
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
    session.element.classList.remove("is-dragging", "is-snapped", "is-invalid-drop");
    session.element.dataset.timelineStart = String(session.originStart);
    delete session.element.dataset.targetTrackId;
    const node = scrollRef.current;
    if (node) delete node.dataset.dropState;
    session.activeDropLane?.classList.remove("is-drop-target");
    session.activeDropLane = undefined;
  };

  const endItemDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const session = dragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    session.currentClientX = event.clientX;
    session.currentClientY = event.clientY;
    session.altKey = event.altKey;
    if (dragFrameRef.current !== undefined) cancelAnimationFrame(dragFrameRef.current);
    flushDrag(false);
    dragRef.current = undefined;
    if (dragFrameRef.current !== undefined) cancelAnimationFrame(dragFrameRef.current);
    dragFrameRef.current = undefined;
    clearDragVisual(session);
    if (!session.moved || !session.canDrop) return;
    suppressClickRef.current = `${session.kind}:${session.id}`;
    if (session.kind === "clip") onMoveClip(session.id, session.targetStart, session.targetTrackId);
    else onMoveCaption(session.id, session.targetStart);
  };

  const cancelItemDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const session = dragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    if (dragFrameRef.current !== undefined) cancelAnimationFrame(dragFrameRef.current);
    dragFrameRef.current = undefined;
    dragRef.current = undefined;
    clearDragVisual(session);
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
    if (event.button !== 0 || item.locked) return;
    event.preventDefault();
    event.stopPropagation();
    const element = event.currentTarget.closest<HTMLButtonElement>(".timeline-clip");
    if (!element) return;
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
    event.stopPropagation();
    if (kind === "clip") onSelect(id); else onSelectCaption(id);
    onSeek(alignTimelineTime(start, project.fps));
  };

  const nudgeItem = (event: ReactKeyboardEvent<HTMLButtonElement>, kind: DragKind, id: string, trackId: string, start: number) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    const frames = event.shiftKey ? 10 : 1;
    if (project.tracks.find(track => track.id === trackId)?.locked) return;
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
    if (event.button !== 0) return;
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
  };

  const cancelScrub = (event: ReactPointerEvent<HTMLDivElement>) => {
    const session = scrubRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    if (scrubFrameRef.current !== undefined) cancelAnimationFrame(scrubFrameRef.current);
    scrubFrameRef.current = undefined;
    scrubRef.current = undefined;
    session.element.classList.remove("is-scrubbing");
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
    if (dragFrameRef.current !== undefined) cancelAnimationFrame(dragFrameRef.current);
    if (trimFrameRef.current !== undefined) cancelAnimationFrame(trimFrameRef.current);
    dragFrameRef.current = trimFrameRef.current = undefined;
    const session = dragRef.current ?? trimRef.current!;
    suppressClickRef.current = `${session.kind}:${session.id}`;
    if (dragRef.current) clearDragVisual(dragRef.current);
    if (trimRef.current) clearTrimVisual(trimRef.current);
    dragRef.current = trimRef.current = undefined;
  };

  return <section className="timeline-shell" aria-label="時間軸" onKeyDown={cancelActiveEdit}>
    <output ref={positionRef} className="timeline-edit-position" hidden data-testid="timeline-edit-position" />
    <div className="timeline-toolbar">
      <div><strong><b>3</b> 拖曳微調</strong><span>拖中間移動 · 拖左右邊緣修剪</span><small>{project.tracks.reduce((sum, track) => sum + track.clips.length, 0)} 個片段 · {project.captions.length} 段字幕</small></div>
      <div className="timeline-actions">
        <div className="timeline-quick-actions" aria-label="常用時間軸操作">
          <button type="button" className="timeline-snap-toggle" onClick={toggleSnap} aria-pressed={snapEnabled} data-testid="timeline-snap-toggle" title="吸附片段、字幕、播放頭與標記；Alt 暫停吸附，始終逐幀移動">吸附{snapEnabled ? " 開" : " 關"}</button>
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
    <div className="timeline-scroll" ref={scrollRef} onScroll={handleScroll} data-testid="timeline-scroll" tabIndex={0} aria-label="時間軸；Shift 加滾輪水平捲動，Ctrl 加滾輪縮放">
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
          <div className={`track-lane ${track.kind}`} data-track-id={track.id} data-track-kind={track.kind} data-track-locked={track.locked} onPointerDown={beginScrub} onPointerMove={moveScrub} onPointerUp={endScrub} onPointerCancel={cancelScrub} onClick={seekFromClick}>
            {track.kind === "caption" && visibleCaptions.map((caption) => <button type="button" key={caption.id} className={`timeline-clip caption ${selectedCaptionId === caption.id ? "selected" : ""} ${track.locked ? "locked" : ""}`} style={{ left: caption.start * pixelsPerSecond, width: Math.max(12, caption.duration * pixelsPerSecond) }} onPointerDown={(event) => beginItemDrag(event, { kind: "caption", id: caption.id, trackId: track.id, trackKind: track.kind, start: caption.start, duration: caption.duration, locked: track.locked })} onPointerMove={moveItemDrag} onPointerUp={endItemDrag} onPointerCancel={cancelItemDrag} onLostPointerCapture={cancelItemDrag} onClick={(event) => activateItem(event, "caption", caption.id, caption.start)} onKeyDown={(event) => nudgeItem(event, "caption", caption.id, track.id, caption.start)} data-testid={`timeline-caption-${caption.id}`} data-timeline-start={caption.start} data-duration={caption.duration} aria-label={`${caption.text}${caption.translation ? `，英文 ${caption.translation.text}` : ""}，${formatTime(caption.start)}，可拖曳移動或修剪邊緣`} aria-disabled={track.locked} title={track.locked ? LOCKED_HELP : DRAG_HELP}><span className="clip-pattern" /><strong>{caption.text}{caption.translation && <em>EN</em>}</strong><small>{formatTime(caption.duration)}</small>{trimHandles({ kind: "caption", id: caption.id, start: caption.start, duration: caption.duration, locked: track.locked })}</button>)}
            {(visibleClips.get(track.id) ?? []).map((clip) => renderClip(clip, track))}
            <div className="playhead" style={{ left: playhead * pixelsPerSecond }} data-testid="timeline-playhead"><span /></div>
          </div>
        </div>)}
        <div ref={guideRef} className="timeline-snap-guide" data-testid="timeline-snap-guide" hidden aria-hidden="true" />
      </div>
    </div>
  </section>;
}
