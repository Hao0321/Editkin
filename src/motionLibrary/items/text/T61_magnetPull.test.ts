import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { T61_ARRIVE, T61_DAMPING, T61_OVERLAP, T61_SPRING_HZ, magnetPlan, magnetPose, magnetTimes } from "./T61_magnetPull";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T61";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: approaching (0.3), squeezed (0.45), springing back (0.6), the hold (1.2), fading (1.85). */
const TIMES = [0.3, 0.45, 0.6, 1.2, 1.85] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "8ee6a20f8c56c69fc17e2637fad07f45d8023870c736c5ac50e3e4a83483d0ec",
    "467fce01f50a0cdf11e8213580e4da1f15544fd68e29b2eb204b18bd7d9139e5",
    "3bb752db7627550950c4c4da8120b4b76492b3b85217c47659b7c8bad98a6887",
    "57e74b67f005b31f0db9a5fab2d3ed21dabdf1da1aa11d8f11f1d1b5fadd10be",
    "39ea232b5d65c13af719244b214d7edca38e1f253888abea3b3122409548b05e",
  ],
  landscape: [
    "99aada698e8ef7304073cf22907fbc6bbd596ae53db32630ea6ceab175560ac4",
    "65372a1f8b1b0958e1cb1ea001b61e34d86e314c927119f4c3211cd9b46c5ae7",
    "6f1abb786e3971680f1550f81fff5e46d37c407d1fe506f6da065fe9d025c5e4",
    "23f38a9fcc25d19631695853282091148893523271d724b3559fd8108309133a",
    "f12f07f76402a153c4dc160283a8671231a3e4a24ba292a6170f97803a972688",
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
/** The plate is painted first: right after the header and the (optional) <defs>. */
function paintsFirst(svg: string, size: MotionFrameSize, fill: string): boolean {
  const at = svg.indexOf(plateRect(size, fill));
  if (at < 0) return false;
  const prefix = svg.slice(0, at);
  return prefix === header(size) || (prefix.startsWith(`${header(size)}<defs>`) && prefix.endsWith("</defs>"));
}
const maskColors = (svg: string) => svg.replace(/#[0-9A-F]{6}/g, "#");
const colours = (svg: string) => new Set(svg.match(/#[0-9A-F]{6}/g) ?? []);
const PALETTE_A = { bg: "#101820", ink: "#0A0A0A", paper: "#FAFAF0", accent: "#E0A030", accent2: "#704010" };
const PALETTE_B = { bg: "#203040", ink: "#000814", paper: "#F0F8FF", accent: "#30C0E0", accent2: "#105070" };
const empty = (size: MotionFrameSize) => `${header(size)}</svg>`;

describe("T61 Magnet Pull", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.5, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * 2.3, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.6, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.6, PORTRAIT)).toBe(first);
  });

  it("starts every character off-frame on its own side (±10% vertical) and accelerates in on a cubic ease-in", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      const plan = magnetPlan(params(), size), times = magnetTimes(params());
      for (const glyph of plan.glyphs) {
        const start = magnetPose(plan, glyph, times, 0);
        const x = glyph.cx + start.dx;
        // Wholly off-frame, on the side of its half of the word (the middle one of an odd count picks a seeded side).
        expect(x + glyph.halfWidth <= 0 || x - glyph.halfWidth >= size.width, `${glyph.index}`).toBe(true);
        if (glyph.index === 0) expect(x).toBeLessThan(0);
        if (glyph.index === plan.glyphs.length - 1) expect(x).toBeGreaterThan(size.width);
        expect(Math.abs(start.dy)).toBeLessThanOrEqual(0.1 * size.height + 1e-6);
        // Accelerating: the second third of the approach covers more ground than the first.
        const arrive = glyph.arrive;
        const at = (t: number) => magnetPose(plan, glyph, times, t).dx;
        expect(Math.abs(at((2 * arrive) / 3) - at(arrive / 3))).toBeGreaterThan(Math.abs(at(arrive / 3) - at(0)));
        expect(arrive).toBeGreaterThanOrEqual(T61_ARRIVE[0]);
        expect(arrive).toBeLessThanOrEqual(T61_ARRIVE[1]);
      }
    }
  });

  it("snaps: overshoots so neighbours overlap by 30% of a glyph, springs back (ζ 0.5) crossing home by 0.6 s, holds to 1.6 s, fades by 2.0 s", () => {
    expect([T61_OVERLAP, T61_DAMPING, T61_SPRING_HZ]).toEqual([0.3, 0.5, 2.2]);
    const plan = magnetPlan(params(), LANDSCAPE), times = magnetTimes(params());
    // At arrival the word is squeezed: neighbouring ink boxes overlap by 30% of their mean width.
    const squeezed = plan.glyphs.map(glyph => glyph.cx + glyph.squeezeX);
    let overlapSum = 0, widthSum = 0;
    for (let index = 1; index < plan.glyphs.length; index += 1) {
      const a = plan.glyphs[index - 1], b = plan.glyphs[index];
      const overlap = (squeezed[index - 1] + a.halfWidth) - (squeezed[index] - b.halfWidth);
      expect(overlap / (a.halfWidth + b.halfWidth)).toBeGreaterThan(0.15);
      expect(overlap / (a.halfWidth + b.halfWidth)).toBeLessThan(0.45);
      overlapSum += overlap; widthSum += a.halfWidth + b.halfWidth;
    }
    expect(overlapSum / widthSum).toBeCloseTo(T61_OVERLAP, 2);
    for (const glyph of plan.glyphs) {
      const atArrival = magnetPose(plan, glyph, times, glyph.arrive);
      expect(atArrival.dx).toBeCloseTo(glyph.squeezeX, 6);
      // The spring crosses home within about 0.18 s of arrival (by 0.6 s at most) and rebounds past it.
      let crossed = -1;
      for (let t = glyph.arrive; t <= 0.7; t += 1 / 240) {
        if (Math.sign(magnetPose(plan, glyph, times, t).dx) !== Math.sign(glyph.squeezeX) && glyph.squeezeX !== 0) { crossed = t; break; }
      }
      if (glyph.squeezeX !== 0) {
        expect(crossed).toBeGreaterThan(0);
        expect(crossed).toBeLessThanOrEqual(0.66);
      }
      // Settled and opaque at the hold.
      expect(magnetPose(plan, glyph, times, 1.2)).toEqual({ dx: 0, dy: 0, opacity: 1 });
      expect(magnetPose(plan, glyph, times, 1.95).opacity).toBeLessThan(0.3);
      expect(magnetPose(plan, glyph, times, 2.0).opacity).toBe(0);
    }
    expect(frameText(2.05, LANDSCAPE)).toBe(empty(LANDSCAPE));
    expect(frameText(2.27, PORTRAIT)).toBe(empty(PORTRAIT));
    // A longer clip holds longer; the exit stays at the end.
    expect(magnetTimes(params({ durationSeconds: 4 })).exit).toBeCloseTo(3.3, 9);
  });

  it("keeps the word inside the 5% title-safe box at the hold, at least 9% of the short side tall", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { lines: ["吸"] }, { lines: ["吸引", "力量"] }]) {
        const plan = magnetPlan(params(input), size), safe = titleSafeBox(size), short = Math.min(size.width, size.height);
        const label = `${size.width}x${size.height} ${JSON.stringify(input)}`;
        expect(plan.box.x0, label).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
        expect(plan.box.x1, label).toBeLessThanOrEqual(safe.x1 + 1e-6);
        expect(plan.box.y0, label).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
        expect(plan.box.y1, label).toBeLessThanOrEqual(safe.y1 + 1e-6);
        expect(plan.glyphHeight, label).toBeGreaterThanOrEqual(0.09 * short);
      }
    }
  });

  it("colours alternate cream and violet on the dark card; ink and the deep shade on the accent card", () => {
    const palette = item.defaultParams.palette;
    expect(magnetPlan(params(), PORTRAIT).glyphs.map(glyph => glyph.color)).toEqual([palette.paper, palette.accent, palette.paper]);
    expect(magnetPlan(params({ plate: "accent" }), PORTRAIT).glyphs.map(glyph => glyph.color)).toEqual([palette.ink, palette.accent2, palette.ink]);
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
    expect(item.showcasePlate).toBe("bg");
    const palette = item.defaultParams.palette;
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const t of TIMES) {
        const none = frameText(t, size);
        expect(none.includes(plateRect(size, palette.bg))).toBe(false);
        expect(frameText(t, size, { plate: "none" })).toBe(none);
        const onBg = frameText(t, size, { plate: "bg" });
        expect(paintsFirst(onBg, size, palette.bg)).toBe(true);
        expect(onBg.replace(plateRect(size, palette.bg), "")).toBe(none);
        const onAccent = frameText(t, size, { plate: "accent" });
        expect(paintsFirst(onAccent, size, palette.accent)).toBe(true);
        expect(maskColors(onAccent.replace(plateRect(size, palette.accent), ""))).toBe(maskColors(none));
      }
    }
  });
});
