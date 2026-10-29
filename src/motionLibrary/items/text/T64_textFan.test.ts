import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { backOut } from "../../svg/easing";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import {
  T64_CLOSE_END, T64_CLOSE_START, T64_COPIES, T64_HINGE, T64_LOOP_SECONDS, T64_OPEN_END, T64_SPREAD, T64_STAGGER, fanAngle, fanPlan, fanSlot,
} from "./T64_textFan";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T64";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: opening (0.12, 0.3), open (0.8), closing (1.3), at rest (1.6). */
const TIMES = [0.12, 0.3, 0.8, 1.3, 1.6] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "44fa0d97bd13aa7a75ff0d6f2a301c59acec6991d495caf4b4b887287e88672e",
    "c042d72db3d0ea38066ae6a395fbd1dcf615cde47389c695b4806cc091f8f45c",
    "7f7204097e2d2e7b88dc475f3698144387cf3314213ca4927e9a7e30e25e271e",
    "82599b74349971c84bc12aa0573a382361ae868f4888ac54900eda3101884814",
    "9b2d71813705ddd670d503535f0371c9a2846487c49118da1c69af9473ce7e00",
  ],
  landscape: [
    "5bfe620c6ca495a0702197cb099d29a1b27520d2037dbea9e9d2c3382f565da7",
    "6cd025f81f7e113aa11a8b3d0fa905bf08eead5c58e4eeb9e3877f956f773d14",
    "53a270ac374d8b5f58c2b84937ef16c6155459922b35982546bd705fb10a62ca",
    "39f993088c72275166d77eb410b2c9128b450bf7b1045370be6bebdbb377494d",
    "1e2f3a629611034f953c2f53ab7427d2d82b92c9f082eee563fda7e02cddb132",
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

describe("T64 Text Fan", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: the frame at loopSeconds equals frame 0 (every format, energy and plate)", () => {
    expect(item.loopSeconds).toBe(T64_LOOP_SECONDS);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { energy: "calm" }, { plate: "accent" }, { lines: ["扇子"] }]) {
        const start = frameText(0, size, input);
        expect(frameText(T64_LOOP_SECONDS, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2 * T64_LOOP_SECONDS, size, input)).toBe(start);
        expect(frameText(T64_LOOP_SECONDS * 0.37, size, input)).not.toBe(start);
      }
    }
    expect(frameText(54 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.5, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * T64_LOOP_SECONDS, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.3, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.3, PORTRAIT)).toBe(first);
  });

  it("fans nine copies from stacked to −80…+80° in 0.5 s (backOut, 0.03 s stagger), holds 0.6 s, closes in 0.35 s, rests", () => {
    expect([T64_COPIES, T64_SPREAD, T64_HINGE, T64_OPEN_END, T64_STAGGER, T64_CLOSE_START, T64_CLOSE_END]).toEqual([9, 80, 1.6, 0.5, 0.03, 1.1, 1.45]);
    expect(Array.from({ length: 9 }, (_, index) => fanSlot(index))).toEqual([-80, -60, -40, -20, 0, 20, 40, 60, 80]);
    const plan = fanPlan(params(), LANDSCAPE), at = (index: number, t: number) => fanAngle(plan, index, t / T64_LOOP_SECONDS);
    // Stacked at the start and at rest.
    for (let index = 0; index < 9; index += 1) {
      expect(at(index, 0)).toBe(0);
      expect(at(index, 1.5)).toBe(0);
      expect(at(index, 1.79)).toBe(0);
      expect(at(index, 0.5)).toBeCloseTo(fanSlot(index), 9);
      expect(at(index, 1.0)).toBe(fanSlot(index));
    }
    // backOut: the blades overshoot their slots before settling.
    let peak = 0;
    for (let t = 0; t <= 0.5; t += 0.005) peak = Math.max(peak, at(8, t));
    expect(peak).toBeGreaterThan(80);
    expect(peak).toBeCloseTo(80 * Math.max(...Array.from({ length: 201 }, (_, step) => backOut(step / 200))), 1);
    // The pairs leave the middle 0.03 s apart: the inner pair moves first.
    expect(at(5, 0.02)).toBeGreaterThan(0);
    expect(at(8, 0.02)).toBe(0);
    expect(at(8, 0.1)).toBeGreaterThan(0);
    // Closing on an ease-in: slow first, fast at the end.
    const close = [1.1, 1.2, 1.3, 1.4].map(t => at(8, t));
    expect(close[0] - close[1]).toBeLessThan(close[2] - close[3]);
    // The hinge sits 1.6 glyph heights below the glyph centre.
    expect(plan.radius / plan.glyphHeight).toBeCloseTo(T64_HINGE, 6);
  });

  it("keeps every blade inside the 5% title-safe box at every phase (overshoot included); the glyph is far above 9% of the short side", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { lines: ["扇子"] }]) {
        const plan = fanPlan(params(input), size), safe = titleSafeBox(size), short = Math.min(size.width, size.height);
        const w = plan.ink.x1 - plan.ink.x0, h = plan.ink.y1 - plan.ink.y0;
        if (input === undefined) expect(h).toBeGreaterThanOrEqual(0.09 * short);
        for (let step = 0; step < 108; step += 1) {
          for (let index = 0; index < 9; index += 1) {
            const a = (fanAngle(plan, index, step / 108) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
            for (const [cx, cy] of [[-w / 2, -h / 2], [w / 2, -h / 2], [-w / 2, h / 2], [w / 2, h / 2]] as const) {
              const lx = cx, ly = cy - plan.radius;
              const x = plan.hingeX + lx * c - ly * s, y = plan.hingeY + lx * s + ly * c;
              const label = `${size.width}x${size.height} ${JSON.stringify(input)} step ${step} copy ${index}`;
              expect(x, label).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
              expect(x, label).toBeLessThanOrEqual(safe.x1 + 1e-6);
              expect(y, label).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
              expect(y, label).toBeLessThanOrEqual(safe.y1 + 1e-6);
            }
          }
        }
      }
    }
  });

  it("colours alternate cream and violet with a backdrop keyline; ink and the deep shade on the accent card", () => {
    const palette = item.defaultParams.palette;
    expect(fanPlan(params(), PORTRAIT).colors).toEqual([palette.paper, palette.accent]);
    expect(fanPlan(params({ plate: "accent" }), PORTRAIT).colors).toEqual([palette.ink, palette.accent2]);
    expect(fanPlan(params({ plate: "accent" }), PORTRAIT).keylineColor).toBe(palette.accent);
    const fills = [...frameText(0.8, PORTRAIT).matchAll(/fill="(#[0-9A-F]{6})"/g)].map(match => match[1]);
    expect(fills).toEqual(Array.from({ length: 9 }, (_, index) => (index % 2 ? palette.accent : palette.paper)));
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
