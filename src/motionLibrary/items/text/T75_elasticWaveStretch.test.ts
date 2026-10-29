import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { elasticDepth, elasticLayout, elasticPose, T75_PHASE_STEP, T75_STRETCH } from "./T75_elasticWaveStretch";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T75";
const LOOP = 1.4;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.25, 0.5, 0.8, 1.15] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "e389a06c411cf3c8846835f4b193520fd68b73a155ca43d676d4794d39dde296",
    "971a495a78fd257a246494a0a11c06a41e764d01ce497cfbb1eed3593116c176",
    "11dc4777d7cd22c50b3993ca345da99ea564cfa02b207cafeeabf30c15de780a",
    "644825d1023ae53f9651398c5e2419ce6312f1daa2dc8167455507f08bf0a254",
    "6bc2738e25b13393e29780a7f6c24ea97342039cfeb7177bc9ba66c6b5be665c",
  ],
  landscape: [
    "b256b9c559c30760677ea8e0dcc4783261aa28efefbf07793852f0e7bbd0ecc3",
    "6d3cea1293d8703af31e8744de187b0bf83a50dfde59e9dcb632c7cdbd7933c1",
    "b77f53bbfb760ed87f064130f6b6134fbadf38c814b8569162dbe306d8169b62",
    "1192de26318ea41d44e6a3490ffa388df2e22b1a8f589aca2c38d41c02875f04",
    "06ff4acc2666c8afeb8b166e57d5ca10e35a90bb1a5667812f50a9321195c39b",
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

describe("T75 Elastic Wave Stretch", () => {
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
    expect(frameText(42 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.5, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * LOOP, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.5, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.5, PORTRAIT)).toBe(first);
  });

  it("scaleY = 1 + 0.45·max(0, sin(2πt/1.4 − 0.8·i)) and scaleX = 1/√scaleY, anchored on the floor", () => {
    expect([T75_STRETCH, T75_PHASE_STEP]).toEqual([0.45, 0.8]);
    const depth = elasticDepth(params());
    expect(depth).toBeCloseTo(0.45, 12);
    for (const index of [0, 1, 3]) {
      for (const t of [0, 0.2, 0.55, 0.9, 1.3]) {
        const pose = elasticPose(depth, index, t / LOOP);
        expect(pose.scaleY).toBeCloseTo(1 + 0.45 * Math.max(0, Math.sin((2 * Math.PI * t) / LOOP - 0.8 * index)), 12);
        expect(pose.scaleX * Math.sqrt(pose.scaleY)).toBeCloseTo(1, 12);
      }
    }
    // Half of each period at rest: the max(0, …) clips the trough.
    expect(elasticPose(depth, 0, 0.75)).toEqual({ scaleX: 1, scaleY: 1 });
    expect(elasticDepth(params({ energy: "calm" }))).toBeLessThan(depth);
  });

  it("the word fills 80–90% of the safe width at rest and the full stretch stays inside the safe box", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { lines: ["伸"] }, { lines: ["伸縮", "自如"] }]) {
        const layout = elasticLayout(params(input), size), safe = titleSafeBox(size), depth = elasticDepth(params(input));
        const height = layout.box.y1 - layout.box.y0, short = Math.min(size.width, size.height);
        expect(height, JSON.stringify(input)).toBeGreaterThanOrEqual(0.09 * short);
        if (input === undefined && size !== LANDSCAPE) {
          const fill = (layout.box.x1 - layout.box.x0) / safe.width;
          expect(fill).toBeGreaterThanOrEqual(0.8);
          expect(fill).toBeLessThanOrEqual(0.9);
        }
        expect(layout.box.x0).toBeGreaterThanOrEqual(safe.x0);
        expect(layout.box.x1).toBeLessThanOrEqual(safe.x1);
        // Anchored on the floor: the tallest stretch reaches floor − (1 + depth) × the glyph's height above it.
        for (const glyph of layout.glyphs) expect(glyph.floorY - (1 + depth) * (glyph.floorY - layout.box.y0)).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
        expect(layout.box.y1).toBeLessThanOrEqual(safe.y1);
      }
    }
  });

  it("colours alternate ink and the deep gold on the cream card (gold is 1.4:1 there); cream and gold on the dark card", () => {
    const palette = item.defaultParams.palette;
    expect(item.showcasePlate).toBe("paper");
    expect(elasticLayout(params({ plate: "paper" }), PORTRAIT).glyphs.map(glyph => glyph.color)).toEqual([palette.ink, palette.accent2, palette.ink, palette.accent2]);
    expect(elasticLayout(params(), PORTRAIT).glyphs.map(glyph => glyph.color)).toEqual([palette.paper, palette.accent, palette.paper, palette.accent]);
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
