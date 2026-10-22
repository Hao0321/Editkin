import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { crumblePlan, crumblePose, T79_BOUNCE, T79_BOUNCE_HEIGHT, T79_DROP, T79_SETTLE_TILT, T79_TIP_TILT, tipPivot } from "./T79_crumbleDown";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T79";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: dropping in, the bounce, the hold, crumbling, falling out. */
const TIMES = [0.1, 0.3, 0.8, 1.35, 1.6] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "5003694ea2ef49c5af9656637469b6c625920c2ada1398091c7ee8399a08a6da",
    "783531a55c21c6c2ee939c127295d8f9ffe2bf9d7805187d5509e12ec64997a2",
    "80a64edbadb0b9eae51ab3b737f4e9da60221324c2328f0b9728575e5492c0df",
    "d42a05283b39d88e0cd2a4d968b66c4fb9bed44df74f8b5da81add235b17ee7a",
    "64cd291effb1ae1311f6ede3e7695c4fbbb9ff741cb4efe8373435badba4e568",
  ],
  landscape: [
    "3b7759a8707bd3bb1012733a278997fca4e19779755459fa354d772ef449b9eb",
    "1921f6ab8c05cd07274036147c9902a43117fe9e39c009bf149122f4a950eff7",
    "f803df04dfbe3db7b41e23986223c0b9c37fd6857e98020919d41f487cef90ae",
    "1530bf45406e9b8f0072e3369675b70c5eb605544f3ac86cfc3a88577860b08e",
    "bcb1e732e61032cc19d098c8ff5f861ae7b7943ff9d67f3c2f18c4f771e931b0",
  ],
};

const item = getMotionLibraryItem(ID) as TextMotionItem;
const params = (input?: unknown): TextMotionParams => resolveMotionLibraryParams(item, input);
function frameText(t: number, size: MotionFrameSize, input?: unknown): string {
  const frame = generateAnyMotionFrame(item, params(input), t, size);
  return "svg" in frame ? frame.svg : frame.matte;
}
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const header = (size: MotionFrameSize) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}">`;
const plateRect = (size: MotionFrameSize, fill: string) => `<rect x="0" y="0" width="${size.width}" height="${size.height}" fill="${fill}"/>`;
const maskColors = (svg: string) => svg.replace(/#[0-9A-F]{6}/g, "#");
const colours = (svg: string) => new Set(svg.match(/#[0-9A-F]{6}/g) ?? []);
const paths = (svg: string) => (svg.match(/<path /g) ?? []).length;
const PALETTE_A = { bg: "#101820", ink: "#0A0A0A", paper: "#FAFAF0", accent: "#E0A030", accent2: "#704010" };
const PALETTE_B = { bg: "#203040", ink: "#000814", paper: "#F0F8FF", accent: "#30C0E0", accent2: "#105070" };

/** Corners of a glyph's ink box under a crumble pose (tilt about the centre, extra turn about the tip pivot, then dy). */
function poseCorners(glyph: ReturnType<typeof crumblePlan>["glyphs"][number], pose: NonNullable<ReturnType<typeof crumblePose>>): Array<[number, number]> {
  const rotate = (x: number, y: number, cx: number, cy: number, degrees: number): [number, number] => {
    const r = (degrees * Math.PI) / 180;
    return [cx + (x - cx) * Math.cos(r) - (y - cy) * Math.sin(r), cy + (x - cx) * Math.sin(r) + (y - cy) * Math.cos(r)];
  };
  const [px, py] = tipPivot(glyph);
  return [[glyph.box.x0, glyph.box.y0], [glyph.box.x1, glyph.box.y0], [glyph.box.x0, glyph.box.y1], [glyph.box.x1, glyph.box.y1]].map(([x, y]) => {
    const tilted = rotate(x, y, glyph.cx, glyph.cy, pose.tilt), turned = rotate(tilted[0], tilted[1], px, py, pose.extra);
    return [turned[0], turned[1] + pose.dy];
  });
}

describe("T79 Crumble Down", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.3, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * 2.2, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(1.35, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(1.35, PORTRAIT)).toBe(first);
  });

  it("drops in 0.06 s apart under gravity from above the frame, bounces 6% and settles at ±3–6° by 0.45 s (the last lower)", () => {
    expect([T79_SETTLE_TILT, T79_BOUNCE_HEIGHT]).toEqual([[3, 6], 0.06]);
    const plan = crumblePlan(params(), PORTRAIT);
    expect(plan.dropStagger).toBeCloseTo(0.06, 12);
    expect(3 * plan.dropStagger + T79_DROP + T79_BOUNCE).toBeLessThanOrEqual(0.46 + 1e-9);
    for (const glyph of plan.glyphs) {
      expect(Math.abs(glyph.tilt)).toBeGreaterThanOrEqual(3);
      expect(Math.abs(glyph.tilt)).toBeLessThanOrEqual(6);
      const start = glyph.index * plan.dropStagger;
      expect(crumblePose(plan, glyph, start - 1e-6)).toBeNull();
      // At the start the whole glyph is above the frame.
      const first = crumblePose(plan, glyph, start)!;
      expect(Math.max(...poseCorners(glyph, first).map(corner => corner[1]))).toBeLessThan(0);
      // Constant acceleration on the way down (quadIn): the second half covers three times the first.
      const at = (p: number) => crumblePose(plan, glyph, start + p * T79_DROP)!.dy;
      expect(at(1 - 1e-9) - at(0.5)).toBeCloseTo(3 * (at(0.5) - at(0)), 0);
      // The bounce lifts it up to 6% of the glyph height.
      const hop = crumblePose(plan, glyph, start + T79_DROP + T79_BOUNCE / 2)!;
      expect(glyph.drop - hop.dy).toBeCloseTo(0.06 * plan.glyphHeight, 6);
      expect(crumblePose(plan, glyph, 0.8)).toEqual({ dy: glyph.drop, tilt: glyph.tilt, extra: 0, opacity: 1 });
    }
    expect(plan.glyphs[plan.glyphs.length - 1].drop).toBeGreaterThan(0);
    expect(plan.glyphs[0].drop).toBe(0);
    expect(frameText(0.5, PORTRAIT)).toBe(frameText(1.15, PORTRAIT));
  });

  it("crumbles from 1.2 s left to right, 0.07 s apart: tips to ±25–40° about its leaning corner, falls out of frame, fading", () => {
    expect(T79_TIP_TILT).toEqual([25, 40]);
    const plan = crumblePlan(params(), PORTRAIT);
    for (const glyph of plan.glyphs) {
      expect(Math.abs(glyph.tip)).toBeGreaterThanOrEqual(25);
      expect(Math.abs(glyph.tip)).toBeLessThanOrEqual(40);
      expect(Math.sign(glyph.tip)).toBe(Math.sign(glyph.tilt));
      const tipStart = 1.2 + glyph.index * plan.crumbleStagger;
      // Continuous into the tip: no jump when the pivot changes.
      const before = crumblePose(plan, glyph, tipStart - 1e-6)!, after = crumblePose(plan, glyph, tipStart + 1e-6)!;
      poseCorners(glyph, before).forEach(([x, y], index) => {
        const [x2, y2] = poseCorners(glyph, after)[index];
        expect(Math.hypot(x2 - x, y2 - y)).toBeLessThan(0.5);
      });
      const tipped = crumblePose(plan, glyph, tipStart + 0.12 - 1e-6)!;
      expect(tipped.tilt + tipped.extra).toBeCloseTo(glyph.tip, 2);
      // Falling: below the frame by the end, fading over the last 30%.
      const late = crumblePose(plan, glyph, tipStart + 0.12 + 0.39)!;
      expect(late.opacity).toBeLessThan(0.1);
      const last = crumblePose(plan, glyph, tipStart + 0.12 + 0.4 - 1e-6)!;
      expect(Math.min(...poseCorners(glyph, last).map(corner => corner[1]))).toBeGreaterThan(1920);
      expect(crumblePose(plan, glyph, tipStart + 0.53)).toBeNull();
    }
    expect(paths(frameText(2.1, PORTRAIT))).toBe(0);
  });

  it("the settled word fills 80–90% of the safe width and stays inside the safe box with its tilts", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { lines: ["崩"] }, { lines: ["崩塌", "落下"] }]) {
        const plan = crumblePlan(params(input), size), safe = titleSafeBox(size), short = Math.min(size.width, size.height);
        expect(plan.glyphHeight, JSON.stringify(input)).toBeGreaterThanOrEqual(0.09 * short);
        if (input === undefined) {
          const fill = (plan.box.x1 - plan.box.x0) / safe.width;
          expect(fill).toBeGreaterThanOrEqual(0.8);
          expect(fill).toBeLessThanOrEqual(0.9);
        }
        for (const glyph of plan.glyphs) {
          for (const [x, y] of poseCorners(glyph, crumblePose(plan, glyph, 0.8)!)) {
            expect(x).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
            expect(x).toBeLessThanOrEqual(safe.x1 + 1e-6);
            expect(y).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
            expect(y).toBeLessThanOrEqual(safe.y1 + 1e-6);
          }
        }
      }
    }
  });

  it("serif; colours alternate ink and the deep gold on cream (gold is 1.4:1 there), cream and gold on the dark card", () => {
    const palette = item.defaultParams.palette;
    expect(item.showcasePlate).toBe("paper");
    expect(item.defaultParams.font).toBe("serif");
    expect(crumblePlan(params({ plate: "paper" }), PORTRAIT).glyphs.map(glyph => glyph.color)).toEqual([palette.ink, palette.accent2, palette.ink, palette.accent2]);
    expect(crumblePlan(params(), PORTRAIT).glyphs.map(glyph => glyph.color)).toEqual([palette.paper, palette.accent, palette.paper, palette.accent]);
  });

  it("draws palette roles only: two unrelated palettes share no colour", () => {
    for (const t of TIMES) {
      const a = colours(frameText(t, PORTRAIT, { palette: PALETTE_A, plate: "bg" }));
      const b = colours(frameText(t, PORTRAIT, { palette: PALETTE_B, plate: "bg" }));
      expect([...a].filter(colour => b.has(colour)), `t=${t}`).toEqual([]);
    }
  });

  it("plates: transparent by default; a plate paints first and changes nothing else (ART_DIRECTION §9)", () => {
    expect(item.defaultParams.plate).toBe("none");
    const palette = item.defaultParams.palette;
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const t of TIMES) {
        const none = frameText(t, size);
        expect(none.startsWith(header(size) + plateRect(size, palette.bg))).toBe(false);
        expect(frameText(t, size, { plate: "none" })).toBe(none);
        const onBg = frameText(t, size, { plate: "bg" });
        expect(onBg.startsWith(header(size) + plateRect(size, palette.bg))).toBe(true);
        expect(onBg.replace(plateRect(size, palette.bg), "")).toBe(none);
        for (const plate of ["accent", "paper"] as const) {
          const onPlate = frameText(t, size, { plate });
          expect(onPlate.startsWith(header(size) + plateRect(size, palette[plate]))).toBe(true);
          expect(maskColors(onPlate.replace(plateRect(size, palette[plate]), ""))).toBe(maskColors(none));
        }
      }
    }
  });
});
