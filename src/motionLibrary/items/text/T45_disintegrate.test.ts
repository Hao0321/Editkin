import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { frameUnit, titleSafeBox } from "../shared";
import { T45_ACCENT_SHARE, T45_CELL, T45_DRIFT_X, T45_DRIFT_Y, T45_SPIN, disintegratePlan, disintegrateTimes, frontX } from "./T45_disintegrate";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T45";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: the hold (0.4), the front crossing (0.95, 1.05), the dust (1.4), fading back in (1.9). */
const TIMES = [0.4, 0.95, 1.05, 1.4, 1.9] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "7f2b299e88ecbd5b0380c16514c09c433e9b8e188f801058a80fca7d2fc69fa6",
    "9d3a0d5b49d3ed94785345adc15f5bba22dc24a3df6170b007e4ca52d0e22627",
    "cf54ac23f51fa86c71cce0bf75209160bba7980ea2c5fc92c199deee4833e91d",
    "3ec392cd846e8f636e8341708c208fa5e5587e8668a6898f1ce9d5c1fdb2084e",
    "5364eceb303cab64c4991f67f439ad7747c7632dcca29e7b0e8f7c12302d33c6",
  ],
  landscape: [
    "333ca85c109dda9ea298af18fb3c7fc3763f05ba280a0ad1d7696bdaa70b9a87",
    "a186e4eeafc6b3443dd57d998141ebea2a7909f81837b13144a29bb5019264bd",
    "0be242befb3cb6efcb8128944e48c968a5a711627fbc8d27c68d176380dc1149",
    "0b5e32644d5106a130351591d72145574c5751c5d81557f799d8e8f5eb988382",
    "5b2683223d8a49710f05b7d471671140fc88f7ae1d50655e9efcf19bd5e285b1",
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

describe("T45 Disintegrate", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.5, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * 2, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(1.05, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(1.05, PORTRAIT)).toBe(first);
  });

  it("holds 0–0.8 s, dissolves left to right 0.8–1.6 s, is empty 1.6–1.8 s and fades back in by 2.0 s (the end matches the start)", () => {
    const times = disintegrateTimes(params());
    expect([times.dissolve, times.sweep, times.life, times.fadeIn, times.end]).toEqual([0.8, 0.3, 0.5, 1.8, 2]);
    const hold = frameText(0, PORTRAIT);
    expect(frameText(0.79, PORTRAIT)).toBe(hold);
    expect(hold).not.toContain("clip-path");
    expect(frameText(0.95, PORTRAIT)).toContain("clip-path");
    for (const t of [1.61, 1.7, 1.79]) expect(frameText(t, PORTRAIT), `t=${t}`).toBe(empty(PORTRAIT));
    expect(frameText(1.9, PORTRAIT)).toMatch(/opacity="0\.\d+"/);
    // The clip's end is its start: repeated, it loops without a seam.
    for (const size of [PORTRAIT, LANDSCAPE]) expect(frameText(2, size)).toBe(frameText(0, size));
    // A longer clip holds longer; the dissolve stays 1.2 s before the end.
    expect(disintegrateTimes(params({ durationSeconds: 5 })).dissolve).toBeCloseTo(3.8, 9);
  });

  it("samples glyph cells of 6% of the glyph height that drift up and right 20–60 / 30–90 px at 1080, spin ≤ 45°, ~30% accent", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      const plan = disintegratePlan(params(), size), unit = frameUnit(size);
      expect(plan.cells.length).toBeGreaterThan(150);
      for (const cell of plan.cells) {
        expect(cell.size).toBeCloseTo(T45_CELL * plan.glyphHeight, 1);
        expect(cell.dx / unit).toBeGreaterThanOrEqual(T45_DRIFT_X[0] - 1e-9);
        expect(cell.dx / unit).toBeLessThanOrEqual(T45_DRIFT_X[1] + 1e-9);
        expect(-cell.dy / unit).toBeGreaterThanOrEqual(T45_DRIFT_Y[0] - 1e-9);
        expect(-cell.dy / unit).toBeLessThanOrEqual(T45_DRIFT_Y[1] + 1e-9);
        expect(Math.abs(cell.spin)).toBeLessThanOrEqual(T45_SPIN);
      }
      const accent = plan.cells.filter(cell => cell.color !== plan.textColor).length / plan.cells.length;
      expect(Math.abs(accent - T45_ACCENT_SHARE)).toBeLessThan(0.07);
      // The front starts left of the word and ends right of it, leaning: the top runs ahead.
      expect(frontX(plan, 0, plan.box.y0)).toBeLessThan(plan.box.x0);
      expect(frontX(plan, 1, plan.box.y1)).toBeGreaterThan(plan.box.x1);
      expect(frontX(plan, 0.5, plan.box.y0)).toBeGreaterThan(frontX(plan, 0.5, plan.box.y1));
    }
    // Seeded: another seed gives other drifts and colours, the same seed the same ones.
    const a = disintegratePlan(params(), PORTRAIT), b = disintegratePlan(params({ seed: 7 }), PORTRAIT);
    expect(a.cells.map(cell => cell.dx)).not.toEqual(b.cells.map(cell => cell.dx));
    expect(disintegratePlan(params(), PORTRAIT).cells.map(cell => cell.dx)).toEqual(a.cells.map(cell => cell.dx));
  });

  it("keeps the word inside the 5% title-safe box at the hold, at least 9% of the short side tall, 80–90% of the safe width", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { lines: ["消"] }, { lines: ["消散", "不見"] }]) {
        const plan = disintegratePlan(params(input), size), safe = titleSafeBox(size), short = Math.min(size.width, size.height);
        const label = `${size.width}x${size.height} ${JSON.stringify(input)}`;
        expect(plan.box.x0, label).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
        expect(plan.box.x1, label).toBeLessThanOrEqual(safe.x1 + 1e-6);
        expect(plan.box.y0, label).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
        expect(plan.box.y1, label).toBeLessThanOrEqual(safe.y1 + 1e-6);
        expect(plan.glyphHeight, label).toBeGreaterThanOrEqual(0.09 * short);
      }
    }
    const plan = disintegratePlan(params(), PORTRAIT), safe = titleSafeBox(PORTRAIT);
    const fill = (plan.box.x1 - plan.box.x0) / safe.width;
    expect(fill).toBeGreaterThanOrEqual(0.8);
    expect(fill).toBeLessThanOrEqual(0.9);
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
