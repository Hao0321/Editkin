import { describe, expect, it } from "vitest";
import { playbackFrameIndex } from "./playbackTiming";

describe("playback frame throttling", () => {
  it("coalesces animation ticks that belong to the same project frame", () => {
    expect(playbackFrameIndex(1, 30)).toBe(30);
    expect(playbackFrameIndex(1.01, 30)).toBe(30);
    expect(playbackFrameIndex(1.034, 30)).toBe(31);
  });

  it("falls back safely for invalid timing input", () => {
    expect(playbackFrameIndex(-1, 0)).toBe(0);
    expect(playbackFrameIndex(1, Number.NaN)).toBe(30);
  });
});
