import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { mixHex } from "../../svg/color";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import {
  T40_ECHOES, T40_GAP_FIRST, T40_GAP_GROWTH, T40_LOOP_SECONDS, T40_OPACITY_FIRST, T40_OPACITY_LAST, T40_SHRINK, T40_TONE_CURVE, echoPlan, echoPositions,
} from "./T40_textEcho";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T40";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. r2 (Claude's review): growing gaps, 70% → 5% falloff, older echoes in the deep shade. */
const TIMES = [0, 0.4, 1.0, 1.7, 2.6] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "167e804e729b988d81b8da303678ef1a6a10380f97c943c7fcdba7175cce4e06",
    "d48c3cec7289fe201860572961838454d70201a4fdaa70e3293620a6ea30ae8c",
    "bdec08d9b21f739dc100bdd0783a5a2296f852331b270fe2d4b42fbc681d6c5d",
    "fde3cc1a76b785b1290cb32b31b27c5f03f3eb80527f91e50410ae805c024e01",
    "036748de87f3760c0c1dddc8fc06050881f77a76a769f9194e9f73f8867147ca",
  ],
  landscape: [
    "a99f77504896cea363da33952c71d89037d7c2ce008eda3550135e9f0f8c01c3",
    "05efb0a8e4cb1715f1834b16deb03cbec25b6b51b9730acc0c5b9296f83eeb54",
    "43eb0e626c812a8af1cc4e26c1c54f208e1f3bb0b9cb6cc28c077e678a93500a",
    "1776577d884a87fca126a1530d161d1fe311241cc2c547a3840be209d210ee24",
    "5e63cca95f839fba84534d0165d8530b12a9039e26df5b0d08e52bca3d841ff5",
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

describe("T40 Text Echo", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: the frame at loopSeconds equals frame 0 (every format, energy and plate)", () => {
    expect(item.loopSeconds).toBe(T40_LOOP_SECONDS);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { energy: "calm" }, { plate: "accent" }]) {
        const start = frameText(0, size, input);
        expect(frameText(T40_LOOP_SECONDS, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2 * T40_LOOP_SECONDS, size, input)).toBe(start);
        expect(frameText(T40_LOOP_SECONDS * 0.37, size, input)).not.toBe(start);
      }
    }
    expect(frameText(90 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.5, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * T40_LOOP_SECONDS, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(1.0, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(1.0, PORTRAIT)).toBe(first);
  });

  it("rides a figure-8 with eight echoes: opacity 70% → 5% (exponential), the newest in the accent, older ones in the deep shade, tapering", () => {
    expect([T40_ECHOES, T40_OPACITY_FIRST, T40_OPACITY_LAST, T40_TONE_CURVE]).toEqual([8, 0.7, 0.05, 2.2]);
    const palette = item.defaultParams.palette;
    const plan = echoPlan(params(), LANDSCAPE);
    expect(plan.echoes).toHaveLength(8);
    expect(plan.echoes[0]).toEqual({ color: palette.accent, opacity: 0.7, scale: 1 - T40_SHRINK });
    expect(plan.echoes[7].color).toBe(palette.accent2);
    expect(plan.echoes[7].opacity).toBeCloseTo(0.05, 9);
    for (let index = 1; index < 8; index += 1) {
      const p = index / 7;
      // Exponential: a constant ratio (about 0.686) from one echo to the next.
      expect(plan.echoes[index].opacity / plan.echoes[index - 1].opacity).toBeCloseTo((0.05 / 0.7) ** (1 / 7), 2);
      expect(plan.echoes[index].scale).toBeLessThan(plan.echoes[index - 1].scale);
      expect(plan.echoes[index].color).toBe(mixHex(palette.accent, palette.accent2, 1 - (1 - p) ** T40_TONE_CURVE));
    }
    // Older echoes are mostly the deep shade: from the third echo on, the tone is past half-way.
    for (let index = 2; index < 8; index += 1) expect(1 - (1 - index / 7) ** T40_TONE_CURVE).toBeGreaterThan(0.5);
    // The live word stays the brightest and crispest: opaque, unscaled, the text colour, drawn last.
    expect(plan.headColor).toBe(palette.paper);
    const svg = frameText(1.0, LANDSCAPE), paths = [...svg.matchAll(/<path [^>]*>/g)].map(match => match[0]);
    expect(paths).toHaveLength(9);
    expect(paths[8]).toContain(`fill="${palette.paper}"`);
    expect(paths[8]).not.toContain("opacity");
    // On the accent card the trail runs from the deep shade to ink.
    const onAccent = echoPlan(params({ plate: "accent" }), LANDSCAPE);
    expect([onAccent.headColor, onAccent.echoes[0].color, onAccent.echoes[7].color]).toEqual([palette.ink, palette.accent2, palette.ink]);
    // The path is a closed lemniscate: horizontal in landscape, vertical in portrait.
    expect(plan.track.closed).toBe(true);
    const wide = echoPositions(plan, 0), tall = echoPositions(echoPlan(params(), PORTRAIT), 0);
    expect(wide[0].x).toBeGreaterThan(LANDSCAPE.width / 2);
    expect(Math.abs(tall[0].y - PORTRAIT.height / 2)).toBeGreaterThan(Math.abs(tall[0].x - PORTRAIT.width / 2));
  });

  it("reads as ghosts, never an extrusion or a mass: growing gaps along the path, the first 0.6 glyph heights", () => {
    expect([T40_GAP_FIRST, T40_GAP_GROWTH]).toEqual([0.6, 1.12]);
    for (const size of [PORTRAIT, LANDSCAPE]) {
      const plan = echoPlan(params(), size);
      // Distances behind the word: gaps of 0.6 h × 1.12^k, so every gap is wider than the one before it.
      const gaps = plan.offsets.map((offset, index) => offset - (index ? plan.offsets[index - 1] : 0));
      expect(gaps[0]).toBeCloseTo(T40_GAP_FIRST * plan.glyphHeight, 9);
      for (let index = 1; index < gaps.length; index += 1) expect(gaps[index] / gaps[index - 1]).toBeCloseTo(T40_GAP_GROWTH, 9);
      // The whole trail stays shorter than the lap, so the word never meets its own tail.
      expect(plan.offsets[plan.offsets.length - 1]).toBeLessThan(0.75 * plan.track.totalLength);
      // Straight-line gaps between neighbours (the path curves, so chords are a little shorter than the arc).
      for (const u of [0, 0.13, 0.4, 0.77]) {
        const positions = echoPositions(plan, u);
        for (let index = 1; index < positions.length; index += 1) {
          const gap = Math.hypot(positions[index].x - positions[index - 1].x, positions[index].y - positions[index - 1].y);
          expect(gap, `${size.width}x${size.height} u=${u} echo ${index}`).toBeGreaterThanOrEqual(0.5 * plan.glyphHeight);
        }
      }
    }
    // Energy lengthens the trail (wider gaps), never the period.
    expect(echoPlan(params({ energy: "hype" }), LANDSCAPE).offsets[0]).toBeGreaterThan(echoPlan(params(), LANDSCAPE).offsets[0]);
  });

  it("keeps the word and every echo inside the 5% title-safe box, the word at least 9% of the short side tall", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { lines: ["殘"] }, { lines: ["殘像", "殘像"] }]) {
        const plan = echoPlan(params(input), size), safe = titleSafeBox(size), short = Math.min(size.width, size.height);
        const w = plan.ink.x1 - plan.ink.x0, h = plan.ink.y1 - plan.ink.y0;
        if (input === undefined) expect(plan.glyphHeight).toBeGreaterThanOrEqual(0.09 * short);
        for (let step = 0; step < 90; step += 1) {
          for (const at of echoPositions(plan, step / 90)) {
            const label = `${size.width}x${size.height} ${JSON.stringify(input)} step ${step}`;
            expect(at.x - w / 2, label).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
            expect(at.x + w / 2, label).toBeLessThanOrEqual(safe.x1 + 1e-6);
            expect(at.y - h / 2, label).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
            expect(at.y + h / 2, label).toBeLessThanOrEqual(safe.y1 + 1e-6);
          }
        }
      }
    }
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
