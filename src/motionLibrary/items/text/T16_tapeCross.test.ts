import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { contrastRatio } from "../../svg/color";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { T16_ANGLE, T16_PORTRAIT_ANGLE, tapeCrossPlan } from "./T16_tapeCross";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T16";
const LOOP = 4;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.6, 1.5, 2.7, 3.6] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "752b1bc64d515931459da43a951746514d4a34bab9032cf0d319e171fdf64731",
    "358cd4675f70164e94ca5c5c821ac6b48fd1c235109c33946665689fcd8d5657",
    "9ccb466cbac7b97b99b3d6218cf8a28cb416ba8379852afb303f4fb13a3d9e3a",
    "dd56b9a29c6dcb854867d6cf63557a352a85cb4b9c47938d9842bc131cab5d2d",
    "bb56730a63b97ef478abb4c0abf9facef835e72fe2defe61f689f55a93b8fd97",
  ],
  landscape: [
    "d42536156e15cc3fa7e89744233332eeb7dcfc8eb3178dda5a7090b24bbf656a",
    "ef48ceabbe315578767ee8b66f46e4736a08c6d4a7d859f3f49d99aa1c7acb78",
    "e332cb0877a5e54f667740fa8f23873785c8b61ecd43825d5219b212a55300db",
    "e69048ad95860ac9f83d1078a4d9d3cb04318f57d7756b1b2f85b5940a228c48",
    "bf47185c9f17b2654bdeffce2dd1d45b4d6077dad916f5ac78c88918b720fa30",
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

describe("T16 Tape Cross", () => {
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
    const first = frameText(0.6, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.6, PORTRAIT)).toBe(first);
  });

  it("two tapes cross in an X through the centre at ±15° (±20° in tall frames), scrolling in opposite directions", () => {
    expect([T16_ANGLE, T16_PORTRAIT_ANGLE]).toEqual([15, 20]);
    for (const [size, angle] of [[LANDSCAPE, 15], [SQUARE, 15], [PORTRAIT, 20]] as const) {
      const plan = tapeCrossPlan(params(), size);
      expect(plan.tapes.map(tape => tape.angle)).toEqual([-angle, angle]);
      expect(Math.sign(plan.tapes[0].repeatsPerLoop)).toBe(-Math.sign(plan.tapes[1].repeatsPerLoop));
      for (const tape of plan.tapes) expect(Number.isInteger(tape.repeatsPerLoop) && tape.repeatsPerLoop !== 0).toBe(true);
      const svg = frameText(1, size);
      expect(svg).toContain(`translate(${size.width / 2} ${size.height / 2}) rotate(${-angle})`);
      expect(svg).toContain(`translate(${size.width / 2} ${size.height / 2}) rotate(${angle})`);
    }
  });

  it("caution tape: the text is at least 9% of the short side, repeated with bullets; the X stays inside the title-safe box vertically", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      const plan = tapeCrossPlan(params(), size), safe = titleSafeBox(size), short = Math.min(size.width, size.height);
      for (const tape of plan.tapes) {
        expect(tape.unit.ink.y1 - tape.unit.ink.y0).toBeGreaterThanOrEqual(0.09 * short);
        expect(tape.unit.text).toBe("禁止進入・KEEP OUT・");
        expect(tape.baseline + tape.unit.ink.y0).toBeGreaterThan(-plan.thickness / 2);
        expect(tape.baseline + tape.unit.ink.y1).toBeLessThan(plan.thickness / 2);
        // Where a tape crosses the frame's left and right edges, its band is still inside the safe box vertically.
        const radians = (Math.abs(tape.angle) * Math.PI) / 180;
        const reach = (size.width / 2) * Math.tan(radians) + plan.thickness / 2 / Math.cos(radians);
        expect(size.height / 2 - reach).toBeGreaterThanOrEqual(safe.y0);
        expect(size.height / 2 + reach).toBeLessThanOrEqual(safe.y1);
      }
      expect(plan.halfLength).toBeGreaterThanOrEqual(Math.hypot(size.width, size.height) / 2);
    }
  });

  it("colours follow ART_DIRECTION §0: a cream tape under an accent tape, ink text on both", () => {
    const palette = item.defaultParams.palette;
    const plan = tapeCrossPlan(params(), PORTRAIT);
    expect(plan.tapes.map(tape => tape.color)).toEqual([palette.paper, palette.accent]);
    for (const tape of plan.tapes) {
      expect(tape.textColor).toBe(palette.ink);
      expect(contrastRatio(tape.textColor, tape.color)).toBeGreaterThanOrEqual(4.5);
    }
    // The accent tape is drawn last (on top).
    const svg = frameText(1, PORTRAIT);
    expect(svg.lastIndexOf(`fill="${palette.accent}"`)).toBeGreaterThan(svg.lastIndexOf(`fill="${palette.paper}"`));
    // A second line feeds the cream tape.
    expect(tapeCrossPlan(params({ lines: ["禁止進入", "注意安全"] }), PORTRAIT).tapes.map(tape => tape.unit.text)).toEqual(["注意安全・", "禁止進入・"]);
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
