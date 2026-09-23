import { describe, expect, it } from "vitest";
import { buildTimelineIntervalIndex, queryTimelineIntervalIndex, retainTimelineSelection, timelineRulerStep } from "./timelineViewport";

describe("timeline viewport index", () => {
  it("pins just the captured selection while scrolling and never duplicates it", () => {
    const visible = [{ id: "inside" }], selected = { id: "dragged-offscreen" };
    const index = buildTimelineIntervalIndex([...visible, selected], () => ({ start: 0, end: 1 }));
    expect(retainTimelineSelection(visible, selected, index)).toEqual([...visible, selected]);
    expect(retainTimelineSelection(visible, visible[0], index)).toBe(visible);
    expect(retainTimelineSelection(visible, undefined, index)).toBe(visible);
    expect(visible).toHaveLength(1);
  });
  it("does not reorder a captured leading clip when edge-scrolling removes it from the query", () => {
    const clips = [{ id: "captured", start: 0, end: 1 }, { id: "next", start: 1, end: 16 }];
    const index = buildTimelineIntervalIndex(clips, item => item);
    const before = retainTimelineSelection(queryTimelineIntervalIndex(index, 0, 10), clips[0], index);
    const after = retainTimelineSelection(queryTimelineIntervalIndex(index, 1.1, 11), clips[0], index);
    expect(after).toEqual(before);
    expect(after[0]).toBe(clips[0]);
  });
  it("keeps a pinned nested or equal-time item in stable index order", () => {
    const clips = [{ id: "bed", start: 0, end: 20 }, { id: "a", start: 1, end: 2 }, { id: "b", start: 1, end: 2 }, { id: "tail", start: 3, end: 12 }];
    const index = buildTimelineIntervalIndex(clips, item => item);
    const visible = queryTimelineIntervalIndex(index, 4, 10);
    expect(retainTimelineSelection(visible, clips[1], index).map(x => x.id)).toEqual(["bed", "a", "tail"]);
    expect(retainTimelineSelection(visible, clips[2], index).map(x => x.id)).toEqual(["bed", "b", "tail"]);
    expect(visible.map(x => x.id)).toEqual(["bed", "tail"]);
  });
  it("returns only intervals that overlap the half-open viewport", () => {
    const clips = [
      { id: "before", start: 0, end: 1 },
      { id: "long", start: 0.5, end: 20 },
      { id: "left-boundary", start: 1, end: 2 },
      { id: "inside", start: 2.5, end: 3.5 },
      { id: "right-boundary", start: 4, end: 5 },
    ];
    const index = buildTimelineIntervalIndex(clips, (clip) => clip);
    expect(queryTimelineIntervalIndex(index, 2, 4).map((clip) => clip.id)).toEqual(["long", "inside"]);
    expect(queryTimelineIntervalIndex(index, 20, 21)).toEqual([]);
    expect(queryTimelineIntervalIndex(index, 4, 4)).toEqual([]);
  });

  it("does not lose an early long-running interval behind short intervals", () => {
    const clips = [{ id: "bed", start: 0, end: 10_000 }];
    for (let index = 0; index < 10_000; index += 1) clips.push({ id: `cut-${index}`, start: index, end: index + 0.25 });
    const intervalIndex = buildTimelineIntervalIndex(clips, (clip) => clip);
    const result = queryTimelineIntervalIndex(intervalIndex, 9_999.5, 10_000);
    expect(result.map((clip) => clip.id)).toEqual(["bed"]);
  });

  it("chooses readable ruler spacing", () => {
    expect(timelineRulerStep(800)).toBe(0.1);
    expect(timelineRulerStep(80)).toBe(1);
    expect(timelineRulerStep(8)).toBe(10);
  });
});
