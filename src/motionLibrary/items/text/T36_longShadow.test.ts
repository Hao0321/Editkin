import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { FlatPoint } from "../../svg/pathOps";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { longShadowDegrees, longShadowPlan, longShadowVector, signedArea, sweepQuadsPathD, T36_LENGTH, T36_LOOP_SECONDS } from "./T36_longShadow";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T36";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.4, 1.1, 1.9, 2.6] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "3326632cb9746040661d40fb0a0ec136c1f6c161ffcb120ed3d95e0433f207f6",
    "5e231a3c7c0896409f8dd5c6ba0122dcea8859fbde51bd62a8b92095ef053fe8",
    "030883f4b5978bf274d5a526450245e14e03c82ef7d2f506cff1f6a8c25f0e52",
    "66f8667cbf07700124f97c7d403233096ebaf4bee46f190ad5c149e4085a101e",
    "a0d8a77656e8e98887939d5cb7da4405056fee2aad4755efcf8afe7af1560a01",
  ],
  landscape: [
    "484d8492d443e8ebbce80150c6bcfb732b5d787289fe83601b1b3f752ee43d75",
    "0dc545cf5984204ec5e293f7ed281a25d3ed797ef3c451bd4646dcb9bc0d6451",
    "bae32aab7afe24f8c1173d854f1172aeb2a2affa0c5864e597be570c714c503f",
    "6ca58ffc6e841a2256992c54baab58976062a765a898071488d975d6e2e8b836",
    "eccb58bfcec917145bca74d264b1d3a746972c3ace6e1fe0eb541fc8ac70a182",
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
const PALETTE_A = { bg: "#101820", ink: "#0A0A0A", paper: "#FAFAF0", accent: "#E0A030", accent2: "#704010" };
const PALETTE_B = { bg: "#203040", ink: "#000814", paper: "#F0F8FF", accent: "#30C0E0", accent2: "#105070" };

/** Winding number of point p around a closed polygon (signed crossing rule). */
function winding(points: readonly FlatPoint[], px: number, py: number): number {
  let wind = 0;
  for (let index = 0; index < points.length; index += 1) {
    const [x0, y0] = points[index], [x1, y1] = points[(index + 1) % points.length];
    if (y0 <= py) { if (y1 > py && (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0) > 0) wind += 1; }
    else if (y1 <= py && (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0) < 0) wind -= 1;
  }
  return wind;
}
const glyphWinding = (contours: readonly (readonly FlatPoint[])[], px: number, py: number) => contours.reduce((sum, contour) => sum + winding(contour, px, py), 0);

describe("T36 Long Shadow", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: the frame at loopSeconds equals frame 0 (every format, energy and plate)", () => {
    expect(item.loopSeconds).toBe(T36_LOOP_SECONDS);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { energy: "calm" }, { plate: item.showcasePlate }]) {
        const start = frameText(0, size, input);
        expect(frameText(T36_LOOP_SECONDS, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2 * T36_LOOP_SECONDS, size, input)).toBe(start);
        expect(frameText(T36_LOOP_SECONDS * 0.37, size, input)).not.toBe(start);
      }
    }
    expect(frameText(90 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.5, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * T36_LOOP_SECONDS, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(1.1, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(1.1, PORTRAIT)).toBe(first);
  });

  it("the shadow is 2× the glyph height long and turns once clockwise per loop, starting at 45° to the lower right", () => {
    const plan = longShadowPlan(params(), PORTRAIT);
    expect(plan.length).toBeCloseTo(T36_LENGTH * plan.glyphHeight, 6);
    expect(longShadowDegrees(0)).toBe(45);
    expect(longShadowDegrees(0.25)).toBe(135);
    const [dx, dy] = longShadowVector(plan, 0);
    expect(dx).toBeCloseTo(plan.length * Math.SQRT1_2, 0);
    expect(dy).toBeCloseTo(plan.length * Math.SQRT1_2, 0);
    // One flat-colour shadow path under one text path: never a stack of copies.
    const svg = frameText(0.4, PORTRAIT);
    expect(svg.match(/<path /g)).toHaveLength(2);
    const palette = item.defaultParams.palette;
    expect(svg).toMatch(new RegExp(`<g><path d="M[^"]+" fill="${palette.accent}"/><path d="M[^"]+" fill="${palette.paper}"/></g>`));
    expect(longShadowPlan(params({ energy: "hype" }), PORTRAIT).length).toBeGreaterThan(plan.length);
  });

  it("the sweep is exact: its nonzero fill equals the union of the text swept along d, and matches the all-edges construction", () => {
    const size: MotionFrameSize = { width: 360, height: 640 };
    for (const lines of [["光與影"], ["回"]]) {
      const plan = longShadowPlan(params({ lines }), size);
      expect(plan.outerSign).toBe(plan.contours.reduce((sum, contour) => sum + signedArea(contour), 0) >= 0 ? 1 : -1);
      for (const u of [0, 0.13, 0.25, 0.61, 0.9]) {
        const [dx, dy] = longShadowVector(plan, u);
        // Quads as polygons: every emitted quad carries the outer winding sign.
        const quads = (faces: "away" | "all") => sweepQuadsPathD(plan.contours, dx, dy, plan.outerSign, faces).split("z").filter(Boolean).map(part => {
          const numbers = part.replace(/[Ml]/g, " ").trim().split(/\s+/).map(Number);
          const [x, y, a1, b1, a2, b2, a3, b3] = numbers;
          return [[x, y], [x + a1, y + b1], [x + a1 + a2, y + b1 + b2], [x + a1 + a2 + a3, y + b1 + b2 + b3]] as FlatPoint[];
        });
        const away = quads("away"), all = quads("all");
        expect(all.length).toBeGreaterThan(away.length);
        for (const quad of all) expect(signedArea(quad) * plan.outerSign).toBeGreaterThan(0);
        const xs = [plan.box.x0, plan.box.x1, plan.box.x0 + dx, plan.box.x1 + dx], ys = [plan.box.y0, plan.box.y1, plan.box.y0 + dy, plan.box.y1 + dy];
        let compared = 0, mismatchAll = 0, mismatchTruth = 0, textbookWins = 0;
        for (let gx = 0; gx < 36; gx += 1) {
          for (let gy = 0; gy < 36; gy += 1) {
            const px = Math.min(...xs) - 4 + ((Math.max(...xs) - Math.min(...xs) + 8) * (gx + 0.5)) / 36;
            const py = Math.min(...ys) - 4 + ((Math.max(...ys) - Math.min(...ys) + 8) * (gy + 0.5)) / 36;
            const ends = glyphWinding(plan.contours, px, py) + glyphWinding(plan.contours, px - dx, py - dy);
            const shipped = away.reduce((sum, quad) => sum + winding(quad, px, py), 0) + ends !== 0;
            const textbook = all.reduce((sum, quad) => sum + winding(quad, px, py), 0) + ends !== 0;
            let truth = false;
            for (let step = 0; step <= 80 && !truth; step += 1) truth = glyphWinding(plan.contours, px - (dx * step) / 80, py - (dy * step) / 80) !== 0;
            compared += 1;
            if (shipped !== textbook) { mismatchAll += 1; if (textbook === truth) textbookWins += 1; }
            if (shipped !== truth) mismatchTruth += 1;
          }
        }
        // The two constructions cover the same union; they can differ only inside the chord sagitta of a concave curve at the
        // far end, where the all-edges quads stick out past the glyph copy and the shipped sweep keeps the true curve.
        expect(mismatchAll / compared, `${lines} u=${u}`).toBeLessThan(0.005);
        expect(textbookWins, `${lines} u=${u}`).toBe(0);
        // The sampled truth can miss a point only where the segment grazes a stroke between two samples.
        expect(mismatchTruth / compared, `${lines} u=${u}`).toBeLessThan(0.01);
      }
    }
  }, 60_000);

  it("the word fills 80–90% of the title-safe width and stays inside it, at least 9% of the short side tall", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { lines: ["光"] }, { lines: ["光與影", "交錯"] }, { energy: "hype" }]) {
        const plan = longShadowPlan(params(input), size), safe = titleSafeBox(size);
        expect(plan.box.x0, JSON.stringify(input)).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
        expect(plan.box.x1).toBeLessThanOrEqual(safe.x1 + 1e-6);
        expect(plan.box.y0).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
        expect(plan.box.y1).toBeLessThanOrEqual(safe.y1 + 1e-6);
        expect(plan.glyphHeight).toBeGreaterThanOrEqual(0.09 * Math.min(size.width, size.height));
        if (input === undefined) {
          const fill = (plan.box.x1 - plan.box.x0) / safe.width;
          expect(fill).toBeGreaterThanOrEqual(0.8);
          expect(fill).toBeLessThanOrEqual(0.9);
        }
      }
    }
  });

  it("colours follow ART_DIRECTION §0: cream text and an accent shadow on dark, ink and accent2 on the accent card", () => {
    const palette = item.defaultParams.palette;
    const onDark = frameText(0.4, PORTRAIT);
    expect(onDark).toContain(`fill="${palette.accent}"`);
    expect(onDark).toContain(`fill="${palette.paper}"`);
    const onAccent = frameText(0.4, PORTRAIT, { plate: "accent" });
    expect(onAccent).toContain(`fill="${palette.ink}"`);
    expect(onAccent).toContain(`fill="${palette.accent2}"`);
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
        expect(none.startsWith(header(size) + plateRect(size, palette.bg))).toBe(false);
        expect(frameText(t, size, { plate: "none" })).toBe(none);
        const onBg = frameText(t, size, { plate: "bg" });
        expect(onBg.startsWith(header(size) + plateRect(size, palette.bg))).toBe(true);
        expect(onBg.replace(plateRect(size, palette.bg), "")).toBe(none);
        const onAccent = frameText(t, size, { plate: "accent" });
        expect(onAccent.startsWith(header(size) + plateRect(size, palette.accent))).toBe(true);
        expect(maskColors(onAccent.replace(plateRect(size, palette.accent), ""))).toBe(maskColors(none));
      }
    }
  });
});
