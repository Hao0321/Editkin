import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { contrastRatio } from "../../svg/color";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { checkerDimensions, checkerPlan, shownKind, T70_COLUMN_DELAY, T70_FLIP, T70_ROW_DELAY, tileAngle } from "./T70_checkerWords";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T70";
const LOOP = 2;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: rest, the wave starting, mid-wave, the last tiles turning, rest. */
const TIMES = [0, 0.2, 0.45, 0.75, 1.5] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "f3cc2731ecd34a40069ce232e08fc86ab673f8fd3a272d8d0aa28548f7770644",
    "410050185ebf21bfe1c1d069ed963984b1b991a44e5fd00dd6a341d1fb767b85",
    "d38d87a4b882238cf2efb80aca455d5fc382701c8ed7d493802eaf81d4da65ea",
    "640c589c5771381e2de092a6a2326fffdf53fbdac361892743a562d59f0d6307",
    "f3cc2731ecd34a40069ce232e08fc86ab673f8fd3a272d8d0aa28548f7770644",
  ],
  landscape: [
    "276bae30c3901d6219fcd189b21f019e75a1fd634dae9bd1beedf0251e514bb4",
    "56403ccba4b2edd38088e0958c18301638f39b02b5d23fc3c2f537f225be2d9e",
    "4fa2d22651a5fe47f3a6e7ff103528f0b6aa8057dc2337ef438f10d63c53651e",
    "5d1b033956d64f679922fe1c92ec1048c34c170b6ac48848490d824dbf55e1dd",
    "276bae30c3901d6219fcd189b21f019e75a1fd634dae9bd1beedf0251e514bb4",
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

describe("T70 Checker Words", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: the frame at loopSeconds equals frame 0, and every tile is at rest on the seam", () => {
    expect(item.loopSeconds).toBe(LOOP);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { plate: item.showcasePlate }, { lines: ["格子"] }]) {
        const start = frameText(0, size, input);
        expect(frameText(LOOP, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2 * LOOP, size, input)).toBe(start);
        expect(frameText(LOOP * 0.25, size, input)).not.toBe(start);
        expect(frameText(LOOP - 0.05, size, input)).toBe(start);
      }
    }
    expect(frameText(60 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.5, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * LOOP, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.45, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.45, PORTRAIT)).toBe(first);
  });

  it("a checkerboard of A and B tiles fills the safe box: 7 × 4 landscape, 4 × 7 portrait, 4 × 4 square", () => {
    expect(checkerDimensions(LANDSCAPE)).toEqual({ columns: 7, rows: 4 });
    expect(checkerDimensions(PORTRAIT)).toEqual({ columns: 4, rows: 7 });
    expect(checkerDimensions(SQUARE)).toEqual({ columns: 4, rows: 4 });
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      const plan = checkerPlan(params(), size), safe = titleSafeBox(size), short = Math.min(size.width, size.height);
      expect(plan.glyphHeight).toBeGreaterThanOrEqual(0.09 * short);
      for (const tile of plan.tiles) {
        expect(tile.kind).toBe((tile.column + tile.row) % 2 === 0 ? "A" : "B");
        expect(tile.cx - plan.tileWidth / 2).toBeGreaterThanOrEqual(safe.x0);
        expect(tile.cx + plan.tileWidth / 2).toBeLessThanOrEqual(safe.x1);
        expect(tile.cy - plan.tileHeight / 2).toBeGreaterThanOrEqual(safe.y0);
        expect(tile.cy + plan.tileHeight / 2).toBeLessThanOrEqual(safe.y1);
      }
    }
  });

  it("a diagonal wave flips each tile once around (0 → 360°), 0.05 s per column and 0.03 s per row; faces swap edge-on", () => {
    expect([T70_FLIP, T70_COLUMN_DELAY, T70_ROW_DELAY]).toEqual([0.6, 0.05, 0.03]);
    const plan = checkerPlan(params(), LANDSCAPE);
    for (const tile of plan.tiles) {
      const start = tile.column * 0.05 + tile.row * 0.03;
      expect(tileAngle(tile, start)).toBe(0);
      expect(tileAngle(tile, start + T70_FLIP / 2)).toBeCloseTo(180, 6);
      expect(tileAngle(tile, start + T70_FLIP + 1e-9)).toBe(0);
      // The back face shows the other kind in the middle of the turn, the own kind at either end.
      expect(shownKind(tile, 0)).toBe(tile.kind);
      expect(shownKind(tile, 180)).toBe(tile.kind === "A" ? "B" : "A");
      expect(shownKind(tile, 359)).toBe(tile.kind);
    }
    const first = plan.tiles[0], last = plan.tiles[plan.tiles.length - 1];
    expect(tileAngle(first, 0.3)).toBeGreaterThan(0);
    expect(tileAngle(last, 0.3)).toBe(0);
  });

  it("colours: ink on teal tiles and teal on deep-teal tiles, both readable at 3:1 (ART_DIRECTION §0)", () => {
    const palette = item.defaultParams.palette;
    expect(item.showcasePlate).toBe("accent");
    const plan = checkerPlan(params({ plate: "accent" }), LANDSCAPE);
    expect(plan.faceA).toEqual({ tile: palette.accent, glyph: palette.ink });
    expect(plan.faceB).toEqual({ tile: palette.accent2, glyph: palette.accent });
    expect(contrastRatio(plan.faceB.glyph, plan.faceB.tile)).toBeGreaterThanOrEqual(3);
    // The tiles carry their own colours, so the item reads the same over footage.
    expect(checkerPlan(params(), LANDSCAPE).faceA).toEqual(plan.faceA);
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
