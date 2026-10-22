import { describe, expect, it } from "vitest";
import { marqueeBox, marqueeSelection, playheadPageScroll } from "./timelineCanvasGeometry";

describe("canvas selection and playback pages", () => {
  it("normalizes every drag direction and selects intersections in multiple lanes", () => {
    const box = marqueeBox(100, 100, 10, 10);
    expect(box).toEqual({ left: 10, top: 10, right: 100, bottom: 100 });
    const selection = marqueeSelection(box, [
      { kind: "clip", id: "a", box: { left: 0, top: 20, right: 20, bottom: 40 } },
      { kind: "caption", id: "b", box: { left: 50, top: 60, right: 120, bottom: 80 } },
      { kind: "clip", id: "outside", box: { left: 100, top: 20, right: 140, bottom: 40 } }]);
    expect(selection.clipIds).toEqual(["a"]); expect(selection.captionIds).toEqual(["b"]);
  });
  it("modifier marquee preserves the initial selection without duplicate ids", () => {
    const item = { kind: "clip" as const, id: "a", box: { left: 10, top: 10, right: 20, bottom: 20 } };
    expect(marqueeSelection(marqueeBox(0, 0, 50, 50), [item], { clipIds: ["a", "b"], captionIds: ["c"] })).toMatchObject({ clipIds: ["a", "b"], captionIds: ["c"] });
  });
  it("moves one whole page only when playback leaves the visible interval, including backwards", () => {
    const base = { playing: true, busy: false, now: 1000, userUntil: 0, width: 500, left: 0, playheadX: 499 };
    expect(playheadPageScroll(base)).toBeUndefined(); expect(playheadPageScroll({ ...base, playheadX: 501 })).toBe(500);
    expect(playheadPageScroll({ ...base, left: 1000, playheadX: 499 })).toBe(0);
  });
  it("never follows a user's active scroll or drag, a paused transport, or an unmeasured viewport", () => {
    const base = { playing: true, busy: false, now: 1000, userUntil: 0, width: 500, left: 0, playheadX: 800 };
    for (const patch of [{ busy: true }, { playing: false }, { userUntil: 1800 }, { width: 0 }]) expect(playheadPageScroll({ ...base, ...patch })).toBeUndefined();
  });
});
