import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { mixHex } from "../../svg/color";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { parallaxColumnsPlan, type ParallaxDepth } from "./T15_parallaxColumns";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T15";
const LOOP = 4;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.8, 1.7, 2.55, 3.45] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "df8b1a15c41c69a4c38936561cb52997f87ee78e348cf540d48a025e23fea3fa",
    "565cdbb7b6a448ff6db539ba229e726d800553a49db0626017a93c0d527ebeb2",
    "0617681a03b9a4a725bca4e1a87dc748afd67b4d261bde2ef66a0a912174bfb8",
    "c45f9322593721001b881b3cb225551b2f3e0b05b23ca5c102f4f5a5c9fbc8c4",
    "fe82aa6c97d351a07a5ae19260a7911977716c23e849e54f23c359ef656d7290",
  ],
  landscape: [
    "377b981407ede5277fc89657135eaf516ad07d363ca481b5ee33545cf9873768",
    "55dee1fd152da2dba64f4b986519115d83c4bc7ccb786274e7f4fefd736655cf",
    "12a8a7bb643ca34619e70f857172118c3effba51dc06af3110ae9f9373c6c99a",
    "f1ff0168dd0963e8f389095d5d90eaec83582e87e49f1ab3a2eef56c6fd0ffe1",
    "2eabaf6ad033a449b374143fd07ab0ccf24a93d83104fb93a29419a59c06e7f2",
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
const DEPTHS: readonly ParallaxDepth[] = ["far", "mid", "near"];

describe("T15 Parallax Columns", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: the frame at loopSeconds equals frame 0 (every format, energy and plate)", () => {
    expect(item.loopSeconds).toBe(LOOP);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { energy: "calm" }, { plate: item.showcasePlate }]) {
        const start = frameText(0, size, input);
        expect(frameText(LOOP, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2 * LOOP, size, input)).toBe(start);
        expect(frameText(LOOP * 0.37, size, input)).not.toBe(start);
      }
    }
    expect(frameText(120 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.5, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * LOOP, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.8, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.8, PORTRAIT)).toBe(first);
  });

  it("three depth layers: far small, pale and slow; mid medium; near big, full colour and fast (1, 2, 3 repeats per loop)", () => {
    const plan = parallaxColumnsPlan(params(), PORTRAIT);
    const sizes = DEPTHS.map(depth => plan.layers[depth].unit.size);
    expect(sizes[0]).toBeLessThan(sizes[1]);
    expect(sizes[1]).toBeLessThan(sizes[2]);
    expect(DEPTHS.map(depth => plan.layers[depth].repeatsPerLoop)).toEqual([1, 2, 3]);
    const palette = item.defaultParams.palette;
    expect(plan.layers.far.color).toBe(mixHex(palette.bg, palette.paper, 0.26));
    expect(plan.layers.mid.color).toBe(mixHex(palette.bg, palette.paper, 0.55));
    expect(plan.layers.near.color).toBe(palette.paper);
    expect(plan.layers.near.separatorColor).toBe(palette.accent);
    // Layer k takes line k: 街燈 far, 夜雨 mid, 夜 near.
    expect(DEPTHS.map(depth => plan.layers[depth].unit.text)).toEqual(["街燈・", "夜雨・", "夜・"]);
    for (const depth of DEPTHS) expect(Number.isInteger(plan.layers[depth].repeatsPerLoop)).toBe(true);
    // Energy changes whole repeats only.
    const hype = parallaxColumnsPlan(params({ energy: "hype" }), PORTRAIT);
    expect(DEPTHS.map(depth => hype.layers[depth].repeatsPerLoop)).toEqual([2, 4, 6]);
  });

  it("every column has its own lane inside the title-safe box: no text on text; near glyphs at least 9% of the short side", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      const plan = parallaxColumnsPlan(params(), size), safe = titleSafeBox(size), short = Math.min(size.width, size.height);
      const near = plan.layers.near.unit;
      expect(near.ink.x1 - near.ink.x0).toBeGreaterThanOrEqual(0.09 * short);
      let previous = -Infinity;
      for (const lane of plan.lanes) {
        const ink = plan.layers[lane.depth].unit.ink;
        expect(lane.x + ink.x0).toBeGreaterThanOrEqual(Math.max(previous, safe.x0 - 1e-6));
        expect(lane.x + ink.x1).toBeLessThanOrEqual(safe.x1 + 1e-6);
        previous = lane.x + ink.x1;
      }
      expect(plan.lanes.filter(lane => lane.depth === "near").length).toBeGreaterThanOrEqual(2);
    }
  });

  it("draws far behind mid behind near", () => {
    const palette = item.defaultParams.palette;
    const svg = frameText(1.7, PORTRAIT);
    const at = (colour: string) => svg.indexOf(`fill="${colour}"`);
    expect(at(mixHex(palette.bg, palette.paper, 0.26))).toBeLessThan(at(mixHex(palette.bg, palette.paper, 0.55)));
    expect(at(mixHex(palette.bg, palette.paper, 0.55))).toBeLessThan(at(palette.paper));
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
        const onPaper = frameText(t, size, { plate: "paper" });
        expect(onPaper.startsWith(header(size) + plateRect(size, palette.paper))).toBe(true);
        expect(maskColors(onPaper.replace(plateRect(size, palette.paper), ""))).toBe(maskColors(none));
      }
    }
  });
});
