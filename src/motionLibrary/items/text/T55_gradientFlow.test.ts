import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { mixHex } from "../../svg/color";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { T55_LEAN, T55_LIGHT, T55_LOOP_SECONDS, T55_PERIOD, flowColors, flowStops, gradientFlowLayout } from "./T55_gradientFlow";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T55";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision (r2: the specular streak and ink band, no deep shade). */
const TIMES = [0, 0.5, 1.0, 1.6, 2.1] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "1c18dbda54481c5cb2590b6271146e68ac00cfe358996060d37b2c2778365f62",
    "22e1367dcddefeafe8942f88096e2b61db8495c63ad4ff8a4668f6fafdb2707c",
    "4bf7f0c26beba651e399e03701545327ae21a0f49c136ab8402f27c435ed5e7a",
    "2fca99aeecb4e3054ccc0a33ff8d020b33a19e73ce27a1e7c1efd564f0050dd9",
    "68272824793d26f1a66d4edb58f9271033c12517f59bd22a807e6b14761ba92c",
  ],
  landscape: [
    "dd12d3b015579ea3f75097266a174fde9bc20146f593d323e043d949f37d29c0",
    "78400a6eec1e1310717297d76332dd64dd64ae5f9f9a22a14f2ba19630150cbb",
    "b4da5442db6e23c5a5c01e73cec4a6e47ab932f9211a8df2767c74862a957269",
    "43a1719f795c8792143a7f3af5cdcc208252aaa6db6ecfdb610514040b0ec1ad",
    "cc3924cee6d685fb95df25bec30c9560b936ff1650d05408f22220e3234bc08e",
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
/** The gradient's end points and its stop colours. */
function gradient(svg: string): { x1: number; y1: number; x2: number; y2: number; stops: string[]; spread: string } {
  const match = /<linearGradient id="[^"]+" x1="([-\d.]+)" y1="([-\d.]+)" x2="([-\d.]+)" y2="([-\d.]+)" gradientUnits="userSpaceOnUse" spreadMethod="(\w+)">/.exec(svg)!;
  const stops = [...svg.matchAll(/<stop offset="[\d.]+" stop-color="(#[0-9A-F]{6})"\/>/g)].map(stop => stop[1]);
  return { x1: Number(match[1]), y1: Number(match[2]), x2: Number(match[3]), y2: Number(match[4]), stops, spread: match[5] };
}

describe("T55 Gradient Flow", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: one gradient period per loop, so the frame at loopSeconds equals frame 0", () => {
    expect(item.loopSeconds).toBe(T55_LOOP_SECONDS);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { energy: "calm" }, { plate: "paper" }, { lines: ["流光", "溢彩"] }]) {
        const start = frameText(0, size, input);
        expect(frameText(T55_LOOP_SECONDS, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2 * T55_LOOP_SECONDS, size, input)).toBe(start);
        expect(frameText(T55_LOOP_SECONDS * 0.37, size, input)).not.toBe(start);
      }
    }
    expect(frameText(72 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.3, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * T55_LOOP_SECONDS, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.5, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.5, PORTRAIT)).toBe(first);
  });

  it("fills the coral word with a firm ink band and a soft cream specular streak over a 1.2 × width period, leaning / and scrolling left to right", () => {
    const palette = item.defaultParams.palette;
    // Paper showcase: coral word, ink band, streak core = coral lifted toward paper; the gradient wraps back to coral.
    const paperColors = flowColors(palette, palette.paper);
    expect(paperColors).toEqual({ base: palette.accent, band: palette.ink, light: mixHex(palette.accent, palette.paper, T55_LIGHT) });
    const onPaper = gradient(frameText(0.5, PORTRAIT, { plate: "paper" }));
    expect(onPaper.spread).toBe("repeat");
    expect(onPaper.stops).toEqual(flowStops(paperColors).map(stop => stop.color));
    expect(onPaper.stops[0]).toBe(palette.accent);
    expect(onPaper.stops.at(-1)).toBe(palette.accent);
    expect(onPaper.stops).toContain(palette.ink);
    expect(onPaper.stops).toContain(paperColors.light);
    // The streak is soft: its stops climb from coral to the core and fall back symmetrically (a palindrome), with in-between tones.
    const stops = flowStops(paperColors), streakStart = stops.findIndex(stop => stop.offset > 0.5);
    const streak = stops.slice(streakStart, -1).map(stop => stop.color);
    expect(streak).toEqual([...streak].reverse());
    expect(new Set(streak).size).toBeGreaterThanOrEqual(4);
    for (let index = 1; index < stops.length; index += 1) expect(stops[index].offset).toBeGreaterThan(stops[index - 1].offset);
    // Period 1.2 × the ink width along an axis leaning T55_LEAN degrees; it moves one period along that axis per loop.
    const layout = gradientFlowLayout(params(), PORTRAIT);
    expect(layout.period).toBeCloseTo(T55_PERIOD * (layout.x1 - layout.x0), 9);
    expect(Math.hypot(onPaper.x2 - onPaper.x1, onPaper.y2 - onPaper.y1)).toBeCloseTo(layout.period, 1);
    expect((Math.atan2(onPaper.y2 - onPaper.y1, onPaper.x2 - onPaper.x1) * 180) / Math.PI).toBeCloseTo(T55_LEAN, 1);
    const a = gradient(frameText(0.5, PORTRAIT)), b = gradient(frameText(1.0, PORTRAIT));
    const step = (0.5 * layout.period) / T55_LOOP_SECONDS, lean = (T55_LEAN * Math.PI) / 180;
    expect(b.x1 - a.x1).toBeCloseTo(step * Math.cos(lean), 1);
    expect(b.y1 - a.y1).toBeCloseTo(step * Math.sin(lean), 1);
    // Dark card: coral word, paper band. Coral card: the word turns ink (never accent on accent), the band paper.
    expect(flowColors(palette, palette.bg)).toEqual({ base: palette.accent, band: palette.paper, light: mixHex(palette.accent, palette.paper, T55_LIGHT) });
    expect(flowColors(palette, palette.accent)).toEqual({ base: palette.ink, band: palette.paper, light: mixHex(palette.ink, palette.paper, T55_LIGHT) });
  });

  it("never draws the deep shade (no brown band) on any plate", () => {
    const palette = item.defaultParams.palette;
    for (const plate of ["none", "bg", "paper", "accent"] as const) {
      for (const t of TIMES) expect(frameText(t, PORTRAIT, { plate }), `${plate} t=${t}`).not.toContain(palette.accent2);
    }
  });

  it("keeps the static word inside the 5% title-safe box at hero size (≥ 9% of the short side)", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { lines: ["流光", "溢彩"] }]) {
        const layout = gradientFlowLayout(params(input), size), safe = titleSafeBox(size);
        expect(layout.x0).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
        expect(layout.x1).toBeLessThanOrEqual(safe.x1 + 1e-6);
        expect(layout.y0).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
        expect(layout.y1).toBeLessThanOrEqual(safe.y1 + 1e-6);
        expect(layout.y1 - layout.y0).toBeGreaterThanOrEqual(0.09 * Math.min(size.width, size.height));
      }
    }
    const hero = gradientFlowLayout(params(), PORTRAIT);
    expect((hero.x1 - hero.x0) / titleSafeBox(PORTRAIT).width).toBeGreaterThan(0.8);
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
    expect(item.showcasePlate).toBe("paper");
    const palette = item.defaultParams.palette;
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const t of TIMES) {
        const none = frameText(t, size);
        expect(none).not.toContain("<rect");
        expect(frameText(t, size, { plate: "none" })).toBe(none);
        const onBg = frameText(t, size, { plate: "bg" });
        expect(onBg.startsWith(header(size))).toBe(true);
        expect(onBg.replace(plateRect(size, palette.bg), "")).toBe(none);
        for (const plate of ["paper", "accent"] as const) {
          const plated = frameText(t, size, { plate });
          expect(plated.includes(plateRect(size, palette[plate]))).toBe(true);
          expect(maskColors(plated.replace(plateRect(size, palette[plate]), ""))).toBe(maskColors(none));
        }
      }
    }
  });
});
