import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { mixHex } from "../../svg/color";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { repeatingHighlight, repeatingTextPlan, repeatingTilePop } from "./T11_repeatingText";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T11";
const LOOP = 2;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.35, 0.8, 1.25, 1.7] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "9b61e67a096b6244939943a88458bc38ddf464de03d9885de4da4d710b32b570",
    "0879869136e04c3f816da1bffa0539b738ca2c2f445dadabdf3586b9e075aa15",
    "530d8ef2a863c53ef9dc718c756411ce8a843dd80b09edc283bf5ad3a87bacc6",
    "ca35f576be66b35495429903a0ac51b16a78481fff7ca68acafbca3934e5065a",
    "999075cdca83536b0be65cb55732e12a29bb2d25d4ddfd30c93496c5b149c98d",
  ],
  landscape: [
    "9989914c2b8b814a7d6f9dd6e5ed28c43d0eb78202fe90753e9460444a90fc9b",
    "230659be2aef0e0e0ff44bb055e443250659cd10379697b1f8496d0d4304242d",
    "a21d28d09b30e42299152bcf267328c797dff7212c0076f2e29488a9ee4d889c",
    "0f071de286773ff21f90310787c6f8dd603b5eb860ab95ee20cd93cd2d212d29",
    "b18040e95cb852f052027cd6f33366eb847bad9f4848177cf59151fc500e5284",
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

describe("T11 Repeating Text", () => {
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
    expect(frameText(60 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.5, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * LOOP, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.35, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.35, PORTRAIT)).toBe(first);
  });

  it("fills the title-safe box with a grid that stays inside it at full swell; every word at least 9% of the short side", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { lines: ["流行", "趨勢"] }, { lines: ["流行文化"] }]) {
        const plan = repeatingTextPlan(params(input), size), safe = titleSafeBox(size), short = Math.min(size.width, size.height);
        expect(plan.columns * plan.rows).toBe(plan.cells.length);
        expect(plan.rows).toBeGreaterThanOrEqual(2);
        for (const cell of plan.cells) {
          const cx = (cell.box.x0 + cell.box.x1) / 2, cy = (cell.box.y0 + cell.box.y1) / 2, k = 1 + plan.swell;
          expect(cx - (cx - cell.box.x0) * k, JSON.stringify(input)).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
          expect(cx + (cell.box.x1 - cx) * k).toBeLessThanOrEqual(safe.x1 + 1e-6);
          expect(cy - (cy - cell.box.y0) * k).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
          expect(cy + (cell.box.y1 - cy) * k).toBeLessThanOrEqual(safe.y1 + 1e-6);
          expect(cell.box.y1 - cell.box.y0).toBeGreaterThanOrEqual(0.09 * short);
        }
      }
    }
  });

  it("the inversion wave travels from top-left to bottom-right, one period per loop", () => {
    const plan = repeatingTextPlan(params(), PORTRAIT);
    // h(col + 1, row) at u + k/2π equals h(col, row) at u: the crest moves toward larger col + row.
    const step = plan.k / (2 * Math.PI);
    for (const u of [0, 0.13, 0.42, 0.77]) {
      expect(repeatingHighlight(plan, { column: 1, row: 2 }, u + step)).toBeCloseTo(repeatingHighlight(plan, { column: 0, row: 2 }, u), 9);
      expect(repeatingHighlight(plan, { column: 0, row: 3 }, u + step)).toBeCloseTo(repeatingHighlight(plan, { column: 0, row: 2 }, u), 9);
    }
    expect(step).toBeGreaterThan(0); // a later time shows the same highlight one diagonal further
    expect(repeatingHighlight(plan, { column: 2, row: 1 }, 0)).toBeCloseTo(repeatingHighlight(plan, { column: 2, row: 1 }, 1), 9);
  });

  it("pops whole cards: every lit word sits on its own tile (never half covered); the pop finishes within a narrow band of the wave", () => {
    const palette = item.defaultParams.palette;
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (let frame = 0; frame < 60; frame += 3) {
        const svg = frameText(frame / 30, size);
        const tiles = (svg.match(/<rect [^>]*fill="#[0-9A-F]{6}"\/>/g) ?? []).length;
        const litWords = (svg.match(new RegExp(`<path d="[^"]+" fill="${palette.ink}"`, "g")) ?? []).length;
        expect(litWords, `frame ${frame}`).toBe(tiles);
      }
    }
    expect(repeatingTilePop(0.1)).toBe(0);
    expect(repeatingTilePop(0.6)).toBe(1);
  });

  it("colours follow ART_DIRECTION §0: muted words, accent tiles with ink words over the dark card", () => {
    const palette = item.defaultParams.palette;
    const plan = repeatingTextPlan(params(), PORTRAIT);
    expect(plan.muted).toBe(mixHex(palette.bg, palette.paper, 0.26));
    expect([plan.tile, plan.tileText]).toEqual([palette.accent, palette.ink]);
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
