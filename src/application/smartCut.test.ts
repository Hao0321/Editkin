import { describe, expect, it } from "vitest";
import { parseSilenceDetect, planSmartCutReference } from "./smartCut";

describe("Smart Cut analysis", () => {
  it("parses paired, leading and trailing FFmpeg silence events", () => {
    const parsed = parseSilenceDetect([
      "[silencedetect] silence_end: 0.5 | silence_duration: 0.5",
      "[silencedetect] silence_start: 2.25",
      "[silencedetect] silence_end: 3.5 | silence_duration: 1.25",
      "[silencedetect] silence_start: 8.75",
    ].join("\n"), 10);
    expect(parsed).toEqual([{ start: 0, end: 0.5 }, { start: 2.25, end: 3.5 }, { start: 8.75, end: 10 }]);
  });

  it("creates deterministic frame-aligned fallback ranges", () => {
    const plan = planSmartCutReference({
      fps: 30,
      duration: 10,
      silences: [{ start: 2, end: 4 }, { start: 6, end: 7 }],
      options: { padding: 0.1, minSilence: 0.35, minKeep: 0.25 },
    });
    expect(plan.ranges).toEqual([
      { startFrame: 0, endFrame: 63 },
      { startFrame: 117, endFrame: 183 },
      { startFrame: 207, endFrame: 300 },
    ]);
    expect(plan.removedFrames).toBe(78);
  });
});
