import type { TimelineSelection } from "../application/timelineSelection";

export interface CanvasBox { left: number; top: number; right: number; bottom: number }
export function marqueeBox(x1: number, y1: number, x2: number, y2: number): CanvasBox {
  return { left: Math.min(x1, x2), top: Math.min(y1, y2), right: Math.max(x1, x2), bottom: Math.max(y1, y2) };
}
export function marqueeSelection(box: CanvasBox, items: { kind: "clip" | "caption"; id: string; box: CanvasBox }[], initial?: TimelineSelection): TimelineSelection {
  const hits = items.filter(item => item.box.left < box.right && item.box.right > box.left && item.box.top < box.bottom && item.box.bottom > box.top);
  const clipIds = [...new Set([...(initial?.clipIds ?? []), ...hits.filter(item => item.kind === "clip").map(item => item.id)])];
  const captionIds = [...new Set([...(initial?.captionIds ?? []), ...hits.filter(item => item.kind === "caption").map(item => item.id)])];
  return { clipIds, captionIds, primaryClipId: clipIds.at(-1), primaryCaptionId: !clipIds.length ? captionIds.at(-1) : undefined };
}
/** Whole pages; wait for the user's wheel/scrollbar gesture to settle before following playback again. */
export function playheadPageScroll(input: { playing: boolean; busy: boolean; now: number; userUntil: number; left: number; width: number; playheadX: number }): number | undefined {
  if (!input.playing || input.busy || input.now < input.userUntil || input.width <= 0) return undefined;
  if (input.playheadX >= input.left && input.playheadX < input.left + input.width) return undefined;
  return Math.max(0, Math.floor(input.playheadX / input.width) * input.width);
}
