import { afterEach, describe, expect, it, vi } from "vitest";
import { BLADE_SNAP_PX, bladeTarget, bladeTime } from "./timelineBlade";
import type { TimelineSnapPoint } from "./timelineSnapping";

// Where a 剪刀 click cuts: on the frame grid, pulled to the playhead or a clip or caption edge within 6 px; never to the
// clicked clip's own edges, markers or title blocks. 80 px a second, 30 fps: a frame is 2.67 px, 6 px is 0.075 s.
const index: TimelineSnapPoint[] = [
  { time: 0, owner: "origin" }, { time: 0, owner: "clip:A" }, { time: 4, owner: "clip:A" }, { time: 4, owner: "clip:B" },
  { time: 6, owner: "caption:c1" }, { time: 7, owner: "marker:m1" }, { time: 8, owner: "clip:B" }, { time: 9, owner: "motion:t1" },
].sort((left, right) => left.time - right.time);
/** A click `seconds` into the lane over clip B ([4, 8)), the playhead far away unless given. */
const at = (seconds: number, overrides: Partial<Parameters<typeof bladeTime>[0]> = {}) =>
  bladeTime({ clientX: 100 + seconds * 80, laneLeft: 100, pixelsPerSecond: 80, fps: 30, playhead: 20, snapIndex: index, excludeOwner: "clip:B", ...overrides });

describe("the time a 剪刀 click cuts at", () => {
  it("is the frame under the pointer when nothing is near", () => {
    expect(at(5.01)).toEqual({ time: 5 });
    expect(at(5.02)).toEqual({ time: 151 / 30 });
    expect(at(-1)).toEqual({ time: 0, snap: "edge" });
  });

  it("is pulled to the playhead within 6 px, and the playhead wins a tie with an edge", () => {
    expect(at(5.07, { playhead: 5.1 })).toEqual({ time: 5.1, snap: "playhead" });
    expect(at(5.1 + BLADE_SNAP_PX / 80 + 0.01, { playhead: 5.1 })).toEqual({ time: 156 / 30 });
    expect(at(6.03, { playhead: 6 })).toEqual({ time: 6, snap: "playhead" });
  });

  it("is pulled to another clip's or a caption's edge, never to the clicked clip's own, a marker or a title block", () => {
    expect(at(4.05)).toEqual({ time: 4, snap: "edge" });
    expect(at(5.95)).toEqual({ time: 6, snap: "edge" });
    expect(at(7.96)).toEqual({ time: 239 / 30 });
    expect(at(7.03)).toEqual({ time: 211 / 30 });
    expect(at(8.96)).toEqual({ time: 269 / 30 });
    expect(at(7.96, { excludeOwner: "clip:A" })).toEqual({ time: 8, snap: "edge" });
  });

  it("reaches 6 px whatever the zoom", () => {
    expect(at(0, { clientX: 100 + 6 * 400 - 6, pixelsPerSecond: 400 })).toEqual({ time: 6, snap: "edge" });
    expect(at(0, { clientX: 100 + 6 * 400 - 7, pixelsPerSecond: 400 }).snap).toBeUndefined();
  });
});

describe("what the 剪刀 pointer is over", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("is a picture or sound clip in its lane, locked or not; nothing over a caption or empty space", () => {
    const Element = class {};
    vi.stubGlobal("Element", Element);
    const node = (testid: string, caption: boolean, lane: { dataset: Record<string, string> }) => {
      const clip: object = Object.assign(Object.create(Element.prototype), { dataset: { testid },
        closest: (selector: string) => selector.startsWith(".timeline-clip") ? (caption ? null : clip) : selector.startsWith(".track-lane") ? lane : null });
      return clip as EventTarget;
    };
    const lane = { dataset: { trackId: "v", trackLocked: "false" } };
    expect(bladeTarget(node("timeline-clip-A", false, lane))).toMatchObject({ clipId: "A", locked: false });
    expect(bladeTarget(node("timeline-clip-B", false, { dataset: { trackId: "v", trackLocked: "true" } }))).toMatchObject({ clipId: "B", locked: true });
    expect(bladeTarget(node("timeline-caption-c", true, lane))).toBeUndefined();
    expect(bladeTarget(null)).toBeUndefined();
  });
});
