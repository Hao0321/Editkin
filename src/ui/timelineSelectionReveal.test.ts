import { describe, expect, it, vi } from "vitest";
import { applyCommand } from "../domain/commands";
import { createDemoProject } from "../domain/demo";
import { findClip } from "../domain/editGraph";
import { planTimelineClipMove } from "../application/timelinePlacement";
import { cancelTimelinePointerEdits, createDeferredTimelineSelectionReveal, resolveTimelineSelectionReveal,
  timelineSelectionRevealKey, type TimelineSelectionRevealGeometry } from "./timelineSelectionReveal";

// Client-box geometry represents borders, sticky labels/ruler and actual scroll extent.
// These source controls do not mount a browser or claim physical media observation.
function geometry(overrides: Partial<TimelineSelectionRevealGeometry> = {}): TimelineSelectionRevealGeometry {
  return { viewportLeft: 101, viewportTop: 201, clientWidth: 800, clientHeight: 220, labelWidth: 188,
    rulerBottom: 253, scrollLeft: 400, scrollTop: 100, scrollWidth: 2400, scrollHeight: 800,
    clip: { left: 340, right: 500, top: 280, bottom: 322 }, ...overrides };
}

describe("selected timeline placement visibility", () => {
  it("reveals an unchanged clip ID after an actual collision move appends a lower layer", () => {
    const project = createDemoProject();
    const original = findClip(project, "clip-demo");
    project.tracks.push({ id: "other-video", name: "Other video", kind: "video", locked: false, muted: false,
      clips: [{ ...structuredClone(original), id: "moving", trackId: "other-video", timelineStart: 20 }] });
    const before = findClip(project, "moving");
    const edited = applyCommand(project, planTimelineClipMove(project, "moving", "video-main", 1, () => "appended-video").command);
    const after = findClip(edited, "moving");
    expect(after.id).toBe(before.id);
    expect(edited.tracks.at(-1)?.id).toBe(after.trackId);
    expect(timelineSelectionRevealKey(after.id, after.trackId, after.timelineStart, after.duration, edited.fps))
      .not.toBe(timelineSelectionRevealKey(before.id, before.trackId, before.timelineStart, before.duration, project.fps));
    const input = geometry({ clip: { left: 340, right: 1300, top: 520, bottom: 562 } });
    const result = resolveTimelineSelectionReveal(input)!;
    expect(result).toEqual({ scrollLeft: 400, scrollTop: 249 });
    expect(input.clip.bottom - (result.scrollTop - input.scrollTop)).toBeLessThanOrEqual(input.viewportTop + input.clientHeight);
    expect(project.tracks.find(track => track.id === "other-video")?.clips[0].timelineStart).toBe(20);
  });

  it("keys same-ID one-frame moves at 30, 60 and fractional fps without unrelated graph identity", () => {
    for (const fps of [30, 60, 30000 / 1001]) {
      const initial = timelineSelectionRevealKey("selected", "video", 2 / fps, 30 / fps, fps);
      expect(timelineSelectionRevealKey("selected", "video", 3 / fps, 30 / fps, fps)).not.toBe(initial);
      expect(timelineSelectionRevealKey("selected", "video", (2 + 0.1) / fps, 30 / fps, fps)).toBe(initial);
      expect(timelineSelectionRevealKey("selected", "lower-video", 2 / fps, 30 / fps, fps)).not.toBe(initial);
      expect(timelineSelectionRevealKey("selected", "video", 2 / fps, 29 / fps, fps)).not.toBe(initial);
    }
  });

  it("moves a selected clip out from under the sticky label and ruler using live client geometry", () => {
    const input = geometry({ clip: { left: 260, right: 420, top: 220, bottom: 262 } });
    const result = resolveTimelineSelectionReveal(input)!;
    expect(result).toEqual({ scrollLeft: 347, scrollTop: 59 });
    expect(input.clip.left - (result.scrollLeft - input.scrollLeft)).toBe(313);
    expect(input.clip.top - (result.scrollTop - input.scrollTop)).toBe(261);
  });

  it("keeps a fully visible leading region still even at viewport edges or for a long clip", () => {
    const edge = geometry({ clip: { left: 289, right: 449, top: 253, bottom: 295 } });
    expect(resolveTimelineSelectionReveal(edge)).toEqual({ scrollLeft: 400, scrollTop: 100 });
    expect(resolveTimelineSelectionReveal(geometry({ clip: { left: 340, right: 10000, top: 280, bottom: 322 } })))
      .toEqual({ scrollLeft: 400, scrollTop: 100 });
  });

  it("reveals a far selected start and clamps scroll to actual content extents", () => {
    expect(resolveTimelineSelectionReveal(geometry({ clip: { left: 1100, right: 1300, top: 520, bottom: 562 } })))
      .toEqual({ scrollLeft: 783, scrollTop: 249 });
    expect(resolveTimelineSelectionReveal(geometry({ clip: { left: 1961, right: 2101, top: 859, bottom: 901 } })))
      .toEqual({ scrollLeft: 1600, scrollTop: 580 });
    expect(resolveTimelineSelectionReveal(geometry({ scrollLeft: 0, scrollTop: 0,
      clip: { left: 180, right: 340, top: 210, bottom: 252 } }))).toEqual({ scrollLeft: 0, scrollTop: 0 });
  });

  it("rejects missing selection and impossible or nonfinite viewport geometry without a scroll result", () => {
    expect(timelineSelectionRevealKey(undefined, "video", 0, 1, 30)).toBeUndefined();
    expect(timelineSelectionRevealKey("clip", undefined, 0, 1, 30)).toBeUndefined();
    expect(timelineSelectionRevealKey("clip", "video", Infinity, 1, 30)).toBeUndefined();
    expect(timelineSelectionRevealKey("clip", "video", Number.MAX_VALUE, 1, 60)).toBeUndefined();
    expect(resolveTimelineSelectionReveal(geometry({ clientWidth: 188 }))).toBeUndefined();
    expect(resolveTimelineSelectionReveal(geometry({ rulerBottom: 422 }))).toBeUndefined();
    expect(resolveTimelineSelectionReveal(geometry({ clientHeight: NaN }))).toBeUndefined();
    expect(resolveTimelineSelectionReveal(geometry({ clip: { left: 400, right: 399, top: 280, bottom: 322 } }))).toBeUndefined();
  });

  it("coalesces pending selection changes while drag and trim own scroll then flushes once after release", () => {
    const gate = createDeferredTimelineSelectionReveal(), scroll = vi.fn();
    gate.defer();
    gate.defer();
    if (gate.resume(true)) scroll(); // captured drag remains active
    expect(scroll).not.toHaveBeenCalled();
    if (gate.resume(true)) scroll(); // trim still owns the viewport
    expect(scroll).not.toHaveBeenCalled();
    if (gate.resume(false)) scroll();
    if (gate.resume(false)) scroll();
    expect(scroll).toHaveBeenCalledTimes(1);
    gate.defer();
    gate.clear(); // selected object was removed
    expect(gate.resume(false)).toBe(false);
  });

  it("cancels Escape from session snapshots before clearing refs and cleans only owned work once", () => {
    const drag = { kind: "clip", id: "same-id", originStart: 2 }, trim = { kind: "clip", id: "trim-id", originDuration: 4 };
    const dragRef = { current: drag as typeof drag | undefined }, trimRef = { current: trim as typeof trim | undefined };
    const dragFrameRef = { current: 7 as number | undefined }, trimFrameRef = { current: 9 as number | undefined };
    const order: string[] = [], gate = createDeferredTimelineSelectionReveal();
    gate.defer();
    const clearDrag = vi.fn((session: typeof drag) => {
      expect(session).toBe(drag);
      expect(dragRef.current).toBeUndefined(); expect(trimRef.current).toBeUndefined();
      order.push(`drag:${session.id}`);
    });
    const clearTrim = vi.fn((session: typeof trim) => { expect(session).toBe(trim); order.push(`trim:${session.id}`); });
    const input = { dragRef, trimRef, dragFrameRef, trimFrameRef,
      cancelFrame: (handle: number) => { expect(dragFrameRef.current).toBeUndefined(); expect(trimFrameRef.current).toBeUndefined(); order.push(`raf:${handle}`); },
      clearDrag, clearTrim };
    expect(cancelTimelinePointerEdits(input)).toBe(drag);
    expect(order).toEqual(["raf:7", "raf:9", "drag:same-id", "trim:trim-id"]);
    expect(gate.resume(Boolean(dragRef.current || trimRef.current))).toBe(true);
    expect(cancelTimelinePointerEdits(input)).toBeUndefined();
    expect(clearDrag).toHaveBeenCalledTimes(1); expect(clearTrim).toHaveBeenCalledTimes(1);
    expect(order).toHaveLength(4);
  });
});
