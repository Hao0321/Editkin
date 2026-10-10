import { describe, expect, it } from "vitest";
import { nextShuttleRate, playbackResumeTime, stepPreviewFrame } from "./playbackControlsState";

describe("preview transport at clip boundaries", () => {
  it("starts a changed direction at normal speed and accelerates only the running direction", () => {
    expect(nextShuttleRate(8, true, -1)).toBe(-1);
    expect(nextShuttleRate(-4, false, -1)).toBe(-1);
    expect([nextShuttleRate(-1, true, -1), nextShuttleRate(-2, true, -1), nextShuttleRate(-4, true, -1), nextShuttleRate(-8, true, -1)]).toEqual([-2, -4, -8, -8]);
  });
  it("resumes reverse from a real final frame and forward from the beginning", () => {
    for (const fps of [30, 60, 30000 / 1001]) {
      const duration = 120 / fps;
      expect(playbackResumeTime(0, duration, fps, -1)).toBeCloseTo(119 / fps, 8);
      expect(playbackResumeTime(duration, duration, fps, -1)).toBeCloseTo(119 / fps, 8);
      expect(playbackResumeTime(duration, duration, fps, 2)).toBe(0);
    }
  });
  it("pausable frame positions stay on the fps grid and clamp both limits", () => {
    const fps = 30000 / 1001, duration = 120 / fps;
    expect(stepPreviewFrame(0, duration, fps, -1)).toBe(0);
    expect(stepPreviewFrame(0, duration, fps, 1)).toBeCloseTo(1 / fps, 8);
    expect(stepPreviewFrame(60.15 / fps, duration, fps, -1)).toBeCloseTo(59 / fps, 8);
    expect(stepPreviewFrame(duration, duration, fps, 1)).toBe(duration);
  });
});
