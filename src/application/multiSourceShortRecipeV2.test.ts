import { describe, expect, it } from "vitest";
import type { MediaProbe } from "../render/ffmpegContracts";
import { MULTI_SOURCE_SHORT_VERSION, multiSourceShortStartSchema, parseMultiSourceShort,
  planOrderedShortWindows, orderedShortCaptionCues, multiShortDiskNeed } from "./multiSourceShortRecipeV2";

const probe: MediaProbe = { duration: 60, width: 320, height: 240, hasVideo: true, hasAudio: true };
describe("ordered 20-40 second Short contract", () => {
  it("keeps source order and explicit in-points, with exact continuous frame ranges", () => {
    const result = planOrderedShortWindows([{ path: "c.mp4", in: 12, out: 22 }, { path: "a.mp4", in: 2, out: 12 },
      { path: "b.mp4", in: 40, out: 50 }], [probe, probe, probe]);
    expect(result.windows).toEqual([
      { index: 0, sourceStartFrame: 360, durationFrames: 300, timelineStartFrame: 0 },
      { index: 1, sourceStartFrame: 60, durationFrames: 300, timelineStartFrame: 300 },
      { index: 2, sourceStartFrame: 1200, durationFrames: 300, timelineStartFrame: 600 },
    ]);
    expect(result.durationFrames).toBe(900);
  });
  it("defaults each window to ten seconds without changing source speed", () => {
    expect(planOrderedShortWindows([{ path: "one" }, { path: "two" }], [probe, probe]).durationFrames).toBe(600);
  });
  it("refuses invalid source bounds and unsupported totals instead of silently trimming", () => {
    expect(() => planOrderedShortWindows([{ path: "a", in: 55, out: 65 }, { path: "b" }], [probe, probe])).toThrow("範圍");
    expect(() => planOrderedShortWindows([{ path: "a", out: 5 }, { path: "b", out: 5 }], [probe, probe])).toThrow("20–40");
    expect(() => planOrderedShortWindows(Array.from({ length: 5 }, (_, i) => ({ path: `${i}` })), Array(5).fill(probe))).toThrow("20–40");
    expect(() => planOrderedShortWindows([{ path: "a" }, { path: "b" }], [probe, { ...probe, hasVideo: false }])).toThrow("影片");
  });
  it("bounds canonical UTF-8 input to one KiB while permitting multiple paths", () => {
    const request = { schema: MULTI_SOURCE_SHORT_VERSION, genre: "travel", sources: [{ path: "media/a.mp4" }, { path: "media/b.mp4" }] };
    expect(parseMultiSourceShort(multiSourceShortStartSchema, request).sources).toHaveLength(2);
    expect(() => parseMultiSourceShort(multiSourceShortStartSchema, { ...request, sources: [{ path: "字".repeat(300) }, { path: "字".repeat(300) }] })).toThrow("1 KB");
  });
  it("maps only valid ASR windows to each clip's timeline, clamps edges and retains every valid cue", () => {
    const result = orderedShortCaptionCues([{ timelineStart: 0, duration: 10, cues: [{ start: 1, end: 3, text: "第一句" }] },
      { timelineStart: 10, duration: 10, cues: [{ start: 2, end: 4, text: "第二句" }, { start: 9, end: 12, text: "尾句" },
        { start: 5, end: 2, text: "壞區塊" }, { start: 0, end: 1, text: "" }] }], 30);
    expect(result.map(cue => [cue.start, cue.duration, cue.text])).toEqual([[1, 2, "第一句"], [12, 2, "第二句"], [19, 1, "尾句"]]);
  });
  it("preflights one output drive for both workspace and encoded candidates", () => {
    const need = multiShortDiskNeed(900);
    expect(need.workspace).toBe("beside-output");
    expect(need.combinedBytes).toBe(need.outputBytes + need.temporaryBytes);
    expect(() => multiShortDiskNeed(NaN)).toThrow();
  });
});
