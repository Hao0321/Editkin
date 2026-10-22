import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { alignTimelineTime, timelineFrameLabel } from "./timelineInteraction";
import type { TimelineSnapPoint } from "./timelineSnapping";

/**
 * The 剪刀 (blade) tool's cut line. While the pointer is over a picture or sound clip, a thin line follows it at the time
 * a click would cut: on the frame grid, pulled to the playhead or to a clip or caption edge within BLADE_SNAP_PX (the
 * clip's own edges are left out: a cut there would cut nothing). The line is one element moved by direct style writes in
 * an animation frame, like the drag and trim visuals, so hovering never re-renders the timeline.
 */
export const BLADE_SNAP_PX = 6;

export interface BladeTimeInput {
  clientX: number;
  /** The lane's left edge on screen (time 0). */
  laneLeft: number;
  pixelsPerSecond: number;
  fps: number;
  playhead: number;
  /** The timeline's edge index (buildTimelineSnapIndex), sorted by time. */
  snapIndex: readonly TimelineSnapPoint[];
  /** The clip under the pointer, `clip:<id>`: its own edges never pull the line. */
  excludeOwner?: string;
}

export interface BladeTime {
  time: number;
  /** What pulled the line there, if anything. */
  snap?: "playhead" | "edge";
}

/** The time a 剪刀 click at `clientX` cuts at. The playhead wins a tie with an edge. */
export function bladeTime(input: BladeTimeInput): BladeTime {
  const pps = Math.max(1, input.pixelsPerSecond);
  const raw = Math.max(0, (input.clientX - input.laneLeft) / pps);
  const reach = BLADE_SNAP_PX / pps;
  let best: { time: number; snap: "playhead" | "edge"; distance: number } | undefined;
  const consider = (time: number, snap: "playhead" | "edge") => {
    const distance = Math.abs(time - raw);
    if (distance <= reach + 1e-9 && (!best || distance < best.distance - 1e-9)) best = { time, snap, distance };
  };
  if (Number.isFinite(input.playhead) && input.playhead >= 0) consider(input.playhead, "playhead");
  let low = 0, high = input.snapIndex.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (input.snapIndex[middle].time < raw - reach) low = middle + 1; else high = middle;
  }
  for (let cursor = low; cursor < input.snapIndex.length && input.snapIndex[cursor].time <= raw + reach; cursor += 1) {
    const point = input.snapIndex[cursor];
    if (point.owner !== input.excludeOwner && (point.owner.startsWith("clip:") || point.owner.startsWith("caption:"))) consider(point.time, "edge");
  }
  const time = alignTimelineTime(best?.time ?? raw, input.fps);
  return best ? { time, snap: best.snap } : { time };
}

/** The clip a 剪刀 pointer is over (picture or sound, not a caption) and its lane; undefined elsewhere. */
export function bladeTarget(target: EventTarget | null): { clipId: string; clip: HTMLElement; lane: HTMLElement; locked: boolean } | undefined {
  const clip = target instanceof Element ? target.closest<HTMLElement>(".timeline-clip:not(.caption)") : null;
  const lane = clip?.closest<HTMLElement>(".track-lane[data-track-id]");
  const id = clip?.dataset.testid?.startsWith("timeline-clip-") ? clip.dataset.testid.slice("timeline-clip-".length) : undefined;
  return clip && lane && id ? { clipId: id, clip, lane, locked: lane.dataset.trackLocked === "true" } : undefined;
}

interface BladeLineInput {
  active: boolean;
  pixelsPerSecond: number;
  fps: number;
  playhead: number;
  snapIndex: readonly TimelineSnapPoint[];
  /** Where time 0 is drawn inside the canvas (the sticky track labels' width). */
  labelWidth: number;
}

/** The line's element and the pointer handlers that move it (only while 剪刀 is on). */
export function useTimelineBladeLine(input: BladeLineInput) {
  const lineRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<{ clientX: number; target: EventTarget | null; shiftKey: boolean } | undefined>(undefined);
  const frameRef = useRef<number | undefined>(undefined);
  const latest = useRef(input);
  latest.current = input;

  const hide = () => { if (lineRef.current) lineRef.current.hidden = true; };
  const flush = () => {
    frameRef.current = undefined;
    const line = lineRef.current, pointer = pointerRef.current, canvas = line?.parentElement;
    const over = pointer && latest.current.active ? bladeTarget(pointer.target) : undefined;
    if (!line || !canvas || !pointer || !over || over.locked) { hide(); return; }
    const { pixelsPerSecond, fps, playhead, snapIndex, labelWidth } = latest.current;
    const cut = bladeTime({ clientX: pointer.clientX, laneLeft: over.lane.getBoundingClientRect().left, pixelsPerSecond, fps, playhead, snapIndex, excludeOwner: `clip:${over.clipId}` });
    // One lane, or with Shift every track (a Shift+click cuts them all).
    const rows = pointer.shiftKey ? [...canvas.querySelectorAll<HTMLElement>(".track-lane[data-track-id]")] : [over.lane];
    const top = rows[0].getBoundingClientRect().top, bottom = rows[rows.length - 1].getBoundingClientRect().bottom, origin = canvas.getBoundingClientRect().top;
    line.style.left = `${labelWidth + cut.time * pixelsPerSecond}px`;
    line.style.top = `${top - origin}px`;
    line.style.height = `${Math.max(0, bottom - top)}px`;
    line.dataset.time = String(cut.time);
    line.dataset.snap = cut.snap ?? "";
    const readout = line.firstElementChild;
    if (readout) readout.textContent = timelineFrameLabel(cut.time, fps);
    line.hidden = false;
  };
  const schedule = () => {
    if (frameRef.current === undefined) frameRef.current = requestAnimationFrame(flush);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    pointerRef.current = { clientX: event.clientX, target: event.target, shiftKey: event.shiftKey };
    schedule();
  };
  const onPointerLeave = () => { pointerRef.current = undefined; schedule(); };

  // Shift pressed or let go while the pointer rests: the line grows to every track or back to one. Leaving 剪刀 hides it.
  useEffect(() => {
    if (!input.active) { pointerRef.current = undefined; hide(); return; }
    const shift = (event: KeyboardEvent) => {
      if (event.key !== "Shift" || !pointerRef.current) return;
      pointerRef.current = { ...pointerRef.current, shiftKey: event.type === "keydown" };
      schedule();
    };
    window.addEventListener("keydown", shift);
    window.addEventListener("keyup", shift);
    return () => {
      window.removeEventListener("keydown", shift);
      window.removeEventListener("keyup", shift);
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
      frameRef.current = undefined;
    };
  }, [input.active]);

  return { lineRef, onPointerMove, onPointerLeave, refresh: schedule };
}
