/** The selected graph placement, independent of unrelated project mutations. */
export function timelineSelectionRevealKey(
  clipId: string | undefined,
  trackId: string | undefined,
  start: number | undefined,
  duration: number | undefined,
  fps: number,
): string | undefined {
  if (!clipId || !trackId || start === undefined || duration === undefined
    || ![start, duration, fps].every(Number.isFinite) || start < 0 || duration <= 0 || fps <= 0) return undefined;
  const startFrame = Math.round(start * fps), durationFrames = Math.round(duration * fps);
  if (!Number.isSafeInteger(startFrame) || !Number.isSafeInteger(durationFrames) || durationFrames < 1) return undefined;
  return JSON.stringify([clipId, trackId, fps, startFrame, durationFrames]);
}

export interface TimelineSelectionRevealGeometry {
  /** Client-box origin: bounding rect plus clientLeft/clientTop. */
  viewportLeft: number;
  viewportTop: number;
  clientWidth: number;
  clientHeight: number;
  labelWidth: number;
  /** Actual sticky ruler bottom in the same viewport coordinate system. */
  rulerBottom: number;
  scrollLeft: number;
  scrollTop: number;
  scrollWidth: number;
  scrollHeight: number;
  clip: Readonly<{ left: number; right: number; top: number; bottom: number }>;
}

/** Reveal the clip's leading 160px and its row, excluding labels/ruler/scrollbars. */
export function resolveTimelineSelectionReveal(input: TimelineSelectionRevealGeometry): Readonly<{ scrollLeft: number; scrollTop: number }> | undefined {
  const { clip } = input;
  const values = [input.viewportLeft, input.viewportTop, input.clientWidth, input.clientHeight, input.labelWidth,
    input.rulerBottom, input.scrollLeft, input.scrollTop, input.scrollWidth, input.scrollHeight,
    clip.left, clip.right, clip.top, clip.bottom];
  if (!values.every(Number.isFinite) || input.clientWidth <= 0 || input.clientHeight <= 0 || input.labelWidth < 0
    || input.scrollLeft < 0 || input.scrollTop < 0 || input.scrollWidth < 0 || input.scrollHeight < 0
    || clip.right <= clip.left || clip.bottom <= clip.top) return undefined;
  const left = input.viewportLeft + input.labelWidth, right = input.viewportLeft + input.clientWidth;
  const top = Math.max(input.viewportTop, input.rulerBottom), bottom = input.viewportTop + input.clientHeight;
  const width = right - left, height = bottom - top;
  if (![left, right, top, bottom, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return undefined;
  const focusWidth = Math.min(clip.right - clip.left, 160, width), focusHeight = Math.min(clip.bottom - clip.top, height);
  const padX = Math.min(24, Math.max(0, (width - focusWidth) / 2));
  const padY = Math.min(8, Math.max(0, (height - focusHeight) / 2));
  const dx = clip.left < left ? clip.left - left - padX
    : clip.left + focusWidth > right ? clip.left + focusWidth - right + padX : 0;
  const dy = clip.top < top ? clip.top - top - padY
    : clip.top + focusHeight > bottom ? clip.top + focusHeight - bottom + padY : 0;
  const scrollLeft = Math.max(0, Math.min(Math.max(0, input.scrollWidth - input.clientWidth), input.scrollLeft + dx));
  const scrollTop = Math.max(0, Math.min(Math.max(0, input.scrollHeight - input.clientHeight), input.scrollTop + dy));
  if (![scrollLeft, scrollTop].every(Number.isFinite)) return undefined;
  return Object.freeze({ scrollLeft, scrollTop });
}

/** One pending reveal per mounted Timeline, released only after all pointer owners finish. */
export function createDeferredTimelineSelectionReveal() {
  let pending = false;
  return Object.freeze({
    defer() { pending = true; },
    clear() { pending = false; },
    resume(pointerActive: boolean): boolean {
      if (pointerActive || !pending) return false;
      pending = false;
      return true;
    },
  });
}

/** Snapshot owned sessions before clearing refs, then clean only their RAFs/visuals. */
export function cancelTimelinePointerEdits<Drag extends { kind: string; id: string }, Trim extends { kind: string; id: string }>(input: {
  dragRef: { current: Drag | undefined };
  trimRef: { current: Trim | undefined };
  dragFrameRef: { current: number | undefined };
  trimFrameRef: { current: number | undefined };
  cancelFrame: (handle: number) => void;
  clearDrag: (session: Drag) => void;
  clearTrim: (session: Trim) => void;
}): Drag | Trim | undefined {
  const drag = input.dragRef.current, trim = input.trimRef.current;
  if (!drag && !trim) return undefined;
  const dragFrame = input.dragFrameRef.current, trimFrame = input.trimFrameRef.current;
  input.dragRef.current = input.trimRef.current = undefined;
  input.dragFrameRef.current = input.trimFrameRef.current = undefined;
  if (dragFrame !== undefined) input.cancelFrame(dragFrame);
  if (trimFrame !== undefined && trimFrame !== dragFrame) input.cancelFrame(trimFrame);
  if (drag) input.clearDrag(drag);
  if (trim) input.clearTrim(trim);
  return drag ?? trim;
}
