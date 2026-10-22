import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../motionLibrary/catalog";
import { generateMotionFrame } from "../motionLibrary/frames";
import { resolveMotionLibraryParams } from "../motionLibrary/params";
import type { TextMotionItem } from "../motionLibrary/types";
import { composeMotionLibraryFrameV1, motionLibraryAnimationV1, motionLibraryStillTimeV1 } from "./motionLibraryFramesV1";

const size = { width: 384, height: 216 };

describe("Motion Library live thumbnails", () => {
  it("draws a text card with the item's own generator on its showcase plate, and the live preview exactly as given", () => {
    const item = getMotionLibraryItem("T02") as TextMotionItem;
    const t = motionLibraryStillTimeV1(item);
    const card = composeMotionLibraryFrameV1({ itemId: "T02", purpose: "card", size, t });
    expect(card).toBe(generateMotionFrame(item, resolveMotionLibraryParams(item, { plate: item.showcasePlate }), t, size));
    const preview = composeMotionLibraryFrameV1({ itemId: "T02", purpose: "preview", size, t, params: { lines: ["新字"] } });
    expect(preview).toBe(generateMotionFrame(item, resolveMotionLibraryParams(item, { lines: ["新字"] }), t, size));
  });

  it("draws a transition as mix(A, B, matte) over the demo planes with every embedded id namespaced", () => {
    const svg = composeMotionLibraryFrameV1({ itemId: "X01", purpose: "card", size, t: 0.25 });
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).toContain('<mask id="tvMatte"');
    expect(svg).toContain('mask="url(#tvMatte)"');
    const ids = [...svg.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const reference of svg.matchAll(/url\(#([^)]+)\)/g)) expect(ids).toContain(reference[1]);
  });

  it("draws a background frame and plans readable hover loops", () => {
    expect(composeMotionLibraryFrameV1({ itemId: "B09", purpose: "card", size, t: 0.6 })).toMatch(/^<svg [\s\S]*<\/svg>$/);
    const transition = motionLibraryAnimationV1("X01");
    // Held A at 0 and held B at the end are still in the cycle, around the mid-wipe still it starts on.
    expect(transition.times[0]).toBe(motionLibraryStillTimeV1(getMotionLibraryItem("X01")));
    expect(transition.frameMs[transition.times.indexOf(0)]).toBe(380);
    expect(transition.frameMs[transition.times.lastIndexOf(0.5)]).toBe(620);
    const text = motionLibraryAnimationV1("T01");
    expect(text.times.length).toBeGreaterThan(20);
    expect(Math.max(...text.times)).toBeLessThan(4);
    const exit = getMotionLibraryItem("T44");
    expect(motionLibraryStillTimeV1(exit)).toBeLessThan(0.5);
  });

  it("starts the hover loop on the card still and plays the item's whole duration from there (T05 enters late)", () => {
    for (const id of ["T05", "T01", "T11", "T30", "T56", "X01", "X20", "B01", "B09"]) {
      const item = getMotionLibraryItem(id), still = motionLibraryStillTimeV1(item);
      const loop = motionLibraryAnimationV1(id);
      // Frame 0 is the very request the card already shows (exact time, so the same cache key and the same SVG).
      expect(loop.times[0]).toBe(still);
      expect(composeMotionLibraryFrameV1({ itemId: id, purpose: "card", size, t: loop.times[0] }))
        .toBe(composeMotionLibraryFrameV1({ itemId: id, purpose: "card", size, t: still }));
      // Forward from the still, then once round: the start of the item comes back after its end.
      const wrap = loop.times.findIndex((time, index) => index > 0 && time < loop.times[index - 1]);
      expect(wrap).toBeGreaterThan(0);
      expect(loop.times.slice(1, wrap).every(time => time > still)).toBe(true);
      expect(loop.times.slice(wrap).every(time => time < still)).toBe(true);
      expect(loop.times.length).toBeLessThanOrEqual(160);
      expect(loop.frameMs.every(ms => ms > 0)).toBe(true);
    }
    // T05's stack lands by 0.7 s: frame 0 of the item is empty plate, the still is not; the hover now opens on the still.
    const t05 = getMotionLibraryItem("T05") as TextMotionItem;
    expect(motionLibraryStillTimeV1(t05)).toBeGreaterThan(0.7);
    const loop = motionLibraryAnimationV1("T05");
    expect(Math.min(...loop.times)).toBe(0);
    // One full pass of the 2.4 s item in real time (20 fps), plus the 0.7 s hold on its last frame.
    expect(loop.times.length).toBe(48);
    expect(loop.frameMs.reduce((sum, ms) => sum + ms, 0)).toBeCloseTo(2400 - 50 + 700, 6);
    expect(loop.frameMs[loop.times.indexOf(Math.max(...loop.times))]).toBe(700);
    // Longer items loop their whole duration, not just the first 4 s: the 8 s ring loop (T56), the 4.5 s one-shot (T30).
    expect(Math.max(...motionLibraryAnimationV1("T56").times)).toBeGreaterThan(7.9);
    expect(Math.max(...motionLibraryAnimationV1("T30").times)).toBeGreaterThan(4.4);
    // An explicit start (the inspector's still at other params) is honoured the same way.
    expect(motionLibraryAnimationV1("T05", { energy: "calm" }, 1.0).times[0]).toBe(1.0);
  });
});
