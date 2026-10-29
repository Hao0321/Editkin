import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { mixHex } from "../../svg/color";
import { clearMotionLibraryLayoutCache, resolveMotionFace } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { mosaicPlan, perimeterOrder, T78_ACTIVE_DARK, T78_FACES, T78_POP, T78_REST_DARK, T78_STEP, tileHighlight } from "./T78_textMosaic";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T78";
const LOOP = 2.4;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.1, 0.45, 1.3, 2.25] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "5f4838c4ffb05a7d989e65b8466a765ce747801755cba92c0c7d72e4c956c0a9",
    "f1f5e0b3a4ddc0259c74a5235ba56ade4d5f4891f0bef8d76b41a9de74e96a93",
    "dfcd4812cfd0e81847d290f114b25fe4cfe4701efa97b7f73ecbd9ec4b191cae",
    "6e79264cca025e5d15520b829f4af752d6720296ae355720ff3ebe3bff929e0f",
    "24b4bd787a87dd071ba67a377c03fa582e4fc74d1ddadeba1104dc4f70a34822",
  ],
  landscape: [
    "21213a9bc2de3dce13a96b0acda7af76dcb6b63d415f203e301f3e1b6fd3471c",
    "162f5bd72f7a8ae3a08e29549df8e8aea5332d973df7e4bc3d87a98b31776199",
    "730014040efa0428cb7d803e8e123f7c39661b0e233a0d331cd325a650be304e",
    "412216b46c3972a4023c3f51800d18cc73442d25eb12bf59e51cfbfc010030f8",
    "6344b6b4309df734c6f3ab1192538adf9cab4a3180c7b528a38c5db2a95c8d5d",
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

describe("T78 Text Mosaic", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: eight 0.3 s steps; the frame at loopSeconds equals frame 0", () => {
    expect(item.loopSeconds).toBe(LOOP);
    expect(8 * T78_STEP).toBeCloseTo(LOOP, 12);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { plate: item.showcasePlate }, { lines: ["春夏"] }]) {
        const start = frameText(0, size, input);
        expect(frameText(LOOP, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2 * LOOP, size, input)).toBe(start);
        expect(frameText(LOOP * 0.37, size, input)).not.toBe(start);
      }
    }
    expect(frameText(72 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    for (let index = 0; index < 8; index += 1) frameText(index * 0.3, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * LOOP, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.45, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.45, PORTRAIT)).toBe(first);
  });

  it("a 4 × 2 grid (2 × 4 in portrait) of the first eight characters, each in a different bundled face", () => {
    const faces = T78_FACES.map(face => resolveMotionFace(face).faceId);
    expect(new Set(faces).size).toBe(8);
    expect(faces).toEqual([
      "EditkinFace-noto-sans-tc-900", "EditkinFace-noto-serif-tc-900", "EditkinFace-noto-sans-tc-100", "EditkinFace-noto-serif-tc-200",
      "EditkinFace-lxgw-wenkai-tc-700", "EditkinFace-noto-sans-tc-500", "EditkinFace-noto-serif-tc-500", "EditkinFace-noto-sans-tc-300",
    ]);
    const landscape = mosaicPlan(params(), LANDSCAPE), portrait = mosaicPlan(params(), PORTRAIT);
    expect([landscape.columns, landscape.rows, portrait.columns, portrait.rows]).toEqual([4, 2, 2, 4]);
    expect(landscape.tiles.map(tile => tile.char).join("")).toBe("春夏秋冬晴雨風雪");
    // A shorter line repeats.
    expect(mosaicPlan(params({ lines: ["春夏"] }), LANDSCAPE).tiles.map(tile => tile.char).join("")).toBe("春夏春夏春夏春夏");
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      const plan = mosaicPlan(params(), size), safe = titleSafeBox(size), short = Math.min(size.width, size.height);
      for (const tile of plan.tiles) {
        expect(tile.cx - plan.side / 2).toBeGreaterThanOrEqual(safe.x0);
        expect(tile.cx + plan.side / 2).toBeLessThanOrEqual(safe.x1);
        expect(tile.cy - plan.side / 2).toBeGreaterThanOrEqual(safe.y0);
        expect(tile.cy + plan.side / 2).toBeLessThanOrEqual(safe.y1);
        if (size !== SQUARE) expect(tile.inkHeight * T78_POP).toBeGreaterThanOrEqual(0.09 * short);
      }
    }
  });

  it("the highlight steps clockwise round the grid every 0.3 s: the tile darkens to 18% ink and its character pops to 1.08", () => {
    expect(perimeterOrder(4, 2)).toEqual([0, 1, 2, 3, 7, 6, 5, 4]);
    expect(perimeterOrder(2, 4)).toEqual([0, 1, 3, 5, 7, 6, 4, 2]);
    const plan = mosaicPlan(params(), LANDSCAPE);
    for (const tile of plan.tiles) {
      const start = tile.step * T78_STEP;
      expect(tileHighlight(tile, start + 0.1).dark).toBe(1);
      expect(tileHighlight(tile, start + 0.25).scale).toBeCloseTo(T78_POP, 6);
      expect(tileHighlight(tile, ((start + 0.1 + 0.6) % LOOP))).toEqual({ dark: 0, scale: 1 });
    }
    // Exactly one tile is fully active mid-step.
    for (let step = 0; step < 8; step += 1) {
      expect(plan.tiles.filter(tile => tileHighlight(tile, step * 0.3 + 0.15).dark === 1)).toHaveLength(1);
    }
  });

  it("colours: tiles are the accent 8% toward ink (18% active), glyphs ink", () => {
    const palette = item.defaultParams.palette;
    expect([T78_REST_DARK, T78_ACTIVE_DARK]).toEqual([0.08, 0.18]);
    expect(item.showcasePlate).toBe("accent");
    const plan = mosaicPlan(params({ plate: "accent" }), LANDSCAPE);
    expect([plan.restTile, plan.activeTile, plan.glyph]).toEqual([mixHex(palette.accent, palette.ink, 0.08), mixHex(palette.accent, palette.ink, 0.18), palette.ink]);
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
