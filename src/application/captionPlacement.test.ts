import { describe, expect, it } from "vitest";
import { MIN_NEW_CAPTION_SECONDS, planCaptionInsert } from "./captionPlacement";

// ＋ 文字 never puts a caption on top of existing text: the preview shows one caption at a time, so the new one would be
// hidden, and the caption check reports the overlap as an error. It goes to the next free spot instead.
describe("where ＋ 文字 places a new caption", () => {
  it("starts at the playhead for three seconds when the spot is free", () => {
    expect(planCaptionInsert([], 2, 30)).toEqual({ start: 2, duration: 3, moved: false });
    expect(planCaptionInsert([{ start: 10, duration: 2 }], 1, 30)).toEqual({ start: 1, duration: 3, moved: false });
  });

  it("starts where the existing text ends when the playhead is inside it", () => {
    expect(planCaptionInsert([{ start: 1, duration: 3 }], 2, 30)).toEqual({ start: 4, duration: 3, moved: true });
    // Back-to-back captions: it moves past all of them.
    expect(planCaptionInsert([{ start: 0, duration: 2 }, { start: 2, duration: 2 }], 0.5, 30)).toEqual({ start: 4, duration: 3, moved: true });
  });

  it("is shortened to end where the next caption starts, on the frame grid", () => {
    const plan = planCaptionInsert([{ start: 3.5, duration: 1 }], 2, 30);
    expect(plan).toEqual({ start: 2, duration: 1.5, moved: false });
    expect(plan.start + plan.duration).toBeLessThanOrEqual(3.5);
  });

  it("skips a gap too short to read", () => {
    const plan = planCaptionInsert([{ start: 0, duration: 2 }, { start: 2.2, duration: 1 }], 1, 30);
    expect(MIN_NEW_CAPTION_SECONDS).toBe(0.5);
    expect(plan).toEqual({ start: 3.2, duration: 3, moved: true });
  });

  it("never overlaps any existing caption", () => {
    const captions = [{ start: 0, duration: 1.5 }, { start: 1.8, duration: 0.9 }, { start: 3, duration: 4 }, { start: 7.4, duration: 0.3 }];
    for (let tenth = 0; tenth <= 90; tenth += 1) {
      const plan = planCaptionInsert(captions, tenth / 10, 30);
      expect(plan.duration).toBeGreaterThan(0);
      for (const cue of captions) {
        const overlap = Math.min(plan.start + plan.duration, cue.start + cue.duration) - Math.max(plan.start, cue.start);
        expect(overlap, `playhead ${tenth / 10}`).toBeLessThanOrEqual(1e-6);
      }
    }
  });

  it("aligns to the project's frames and survives a bad fps or playhead", () => {
    expect(planCaptionInsert([], 1.0133, 30).start).toBeCloseTo(1, 9);
    expect(planCaptionInsert([], Number.NaN, Number.NaN)).toEqual({ start: 0, duration: 3, moved: false });
  });
});
