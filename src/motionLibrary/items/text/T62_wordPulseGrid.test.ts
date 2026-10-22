import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import {
  cellSwell, pulseFront, pulseGridDimensions, pulseGridPlan, swellColorMix, T62_BUMP_WIDTH, T62_PEAK_FILL, T62_SWELL, T62_TRAVEL,
} from "./T62_wordPulseGrid";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T62";
const LOOP = 2.1;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: rest, the centre swelling, the ring mid-grid, the edge, rest. */
const TIMES = [0, 0.3, 0.7, 1.2, 1.9] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "930008277621399e6b050a45794cd646429a1b77277a1ffa1025ee6ed78d4b45",
    "1a84d3517c7ad6e43944c8a55a94ca77af62bdcf4bc76a730bfed9d00bcd9e24",
    "23fb6b54521e5099c859956e028a7125d21198a1c786d64115bbc07fea29d12f",
    "81c39ffa338d593e62247069692519a9a605f0423bc08b0e039e329a7b52bf4c",
    "930008277621399e6b050a45794cd646429a1b77277a1ffa1025ee6ed78d4b45",
  ],
  landscape: [
    "c689e5355567b5f0fe28b68f2139a99c374d192f40b81ddcc112a322f6e8198a",
    "3309802e2564d19ad5dc58bdfc59e26dd5d94a12a3fa7f857176bac7486b9ce9",
    "e0bd9496091c111ba46e3e31f890fcfbe75d101af608a7fbbab5074f5f70c92a",
    "ca7f8e9f23c9c907348b3b88f40810850fb30ed20f2a3ff0f897545db9eced0c",
    "c689e5355567b5f0fe28b68f2139a99c374d192f40b81ddcc112a322f6e8198a",
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

describe("T62 Word Pulse Grid", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: the frame at loopSeconds equals frame 0, with every cell at rest on the seam", () => {
    expect(item.loopSeconds).toBe(LOOP);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { energy: "calm" }, { plate: item.showcasePlate }, { lines: ["響應"] }]) {
        const start = frameText(0, size, input);
        expect(frameText(LOOP, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2 * LOOP, size, input)).toBe(start);
        expect(frameText(LOOP * 0.37, size, input)).not.toBe(start);
        const plan = pulseGridPlan(params(input), size);
        for (const cell of plan.cells) {
          expect(cellSwell(plan, cell, 0)).toBe(0);
          expect(cellSwell(plan, cell, T62_TRAVEL)).toBe(0);
        }
      }
    }
    expect(frameText(63 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.5, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * LOOP, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.7, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.7, PORTRAIT)).toBe(first);
  });

  it("lays near-square cells, 4 along the short side (7 × 4 landscape, 4 × 7 portrait, 4 × 4 square), inside the title-safe box", () => {
    expect(pulseGridDimensions(LANDSCAPE)).toEqual({ columns: 7, rows: 4 });
    expect(pulseGridDimensions(PORTRAIT)).toEqual({ columns: 4, rows: 7 });
    expect(pulseGridDimensions(SQUARE)).toEqual({ columns: 4, rows: 4 });
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { lines: ["響應"] }, { lines: ["W"] }]) {
        const plan = pulseGridPlan(params(input), size), safe = titleSafeBox(size), short = Math.min(size.width, size.height);
        expect(plan.cells).toHaveLength(plan.columns * plan.rows);
        expect(plan.glyphHeight, JSON.stringify(input)).toBeGreaterThanOrEqual(0.09 * short);
        expect(plan.cellWidth / plan.cellHeight).toBeGreaterThan(0.8);
        expect(plan.cellWidth / plan.cellHeight).toBeLessThan(1.25);
        for (const cell of plan.cells) {
          expect(cell.cx - cell.halfWidth).toBeGreaterThanOrEqual(safe.x0);
          expect(cell.cx + cell.halfWidth).toBeLessThanOrEqual(safe.x1);
          expect(cell.cy - cell.halfHeight).toBeGreaterThanOrEqual(safe.y0);
          expect(cell.cy + cell.halfHeight).toBeLessThanOrEqual(safe.y1);
        }
      }
    }
    // Several characters cycle through the cells in reading order.
    expect(pulseGridPlan(params({ lines: ["響應"] }), LANDSCAPE).cells.slice(0, 4).map(cell => cell.char)).toEqual(["響", "應", "響", "應"]);
  });

  it("a swollen copy never overlaps a neighbour's ink, at any phase and energy (r2: Claude's p2j review)", () => {
    expect(T62_PEAK_FILL).toBe(0.95);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { energy: "punchy" }, { lines: ["響應"] }, { lines: ["W"] }]) {
        const plan = pulseGridPlan(params(input), size);
        // At the full swell a copy fills at most 95% of its cell on both axes.
        for (const cell of plan.cells) {
          expect(2 * cell.halfWidth * (1 + plan.swell)).toBeLessThanOrEqual(0.95 * plan.cellWidth + 1e-6);
          expect(2 * cell.halfHeight * (1 + plan.swell)).toBeLessThanOrEqual(0.95 * plan.cellHeight + 1e-6);
        }
        const collisions: string[] = [];
        for (let step = 0; step < 63; step += 1) {
          const u = (step / 63) * LOOP;
          const boxes = plan.cells.map(cell => {
            const scale = 1 + plan.swell * cellSwell(plan, cell, u);
            return { cell, x0: cell.cx - cell.halfWidth * scale, x1: cell.cx + cell.halfWidth * scale, y0: cell.cy - cell.halfHeight * scale, y1: cell.cy + cell.halfHeight * scale };
          });
          for (const a of boxes) {
            for (const b of boxes) {
              if (b.cell.index > a.cell.index && !(a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0)) collisions.push(`u=${u} ${a.cell.index}/${b.cell.index}`);
            }
          }
        }
        expect(collisions, `${size.width}x${size.height} ${JSON.stringify(input)}`).toEqual([]);
      }
    }
    // Standard energy keeps the spec's ×2.3 peak; hype saturates at the cell's room instead of colliding.
    expect(pulseGridPlan(params(), LANDSCAPE).swell).toBeCloseTo(1.3, 9);
    expect(pulseGridPlan(params({ energy: "hype" }), LANDSCAPE).swell).toBeLessThan(1.3 * 1.5);
  });

  it("a radial pulse travels out at constant speed: scale = 1 + 1.3·bump(distance − front), a cosine window 1.5 cells wide", () => {
    expect([T62_SWELL, T62_BUMP_WIDTH]).toEqual([1.3, 1.5]);
    const plan = pulseGridPlan(params(), LANDSCAPE);
    // Constant speed from half a bump inside the nearest cell to half a bump past the farthest, by 1.6 s.
    expect(pulseFront(plan, 0)).toBeCloseTo(plan.minDistance - 0.75, 9);
    expect(pulseFront(plan, T62_TRAVEL)).toBeCloseTo(plan.maxDistance + 0.75, 9);
    expect(pulseFront(plan, 0.8) - pulseFront(plan, 0.4)).toBeCloseTo(pulseFront(plan, 1.2) - pulseFront(plan, 0.8), 9);
    for (const cell of plan.cells) {
      // The cell peaks when the front reaches it, and is still more than 0.75 cells away.
      const u = ((cell.distance - pulseFront(plan, 0)) / (pulseFront(plan, T62_TRAVEL) - pulseFront(plan, 0))) * T62_TRAVEL;
      expect(cellSwell(plan, cell, u)).toBeCloseTo(1, 6);
      const away = (0.76 / (pulseFront(plan, T62_TRAVEL) - pulseFront(plan, 0))) * T62_TRAVEL;
      expect(cellSwell(plan, cell, Math.max(0, u - away))).toBe(0);
    }
    // The centre swells first, the corners last.
    const nearest = plan.cells.reduce((a, b) => (a.distance <= b.distance ? a : b)), farthest = plan.cells.reduce((a, b) => (a.distance >= b.distance ? a : b));
    expect(cellSwell(plan, nearest, 0.15)).toBeGreaterThan(0);
    expect(cellSwell(plan, farthest, 0.15)).toBe(0);
    expect(plan.swell).toBeCloseTo(1.3, 9);
  });

  it("colours: ink copies turn cream as they swell past 35% on the violet card (a step, never a grey blend); cream → violet on the dark card", () => {
    const palette = item.defaultParams.palette;
    expect(item.showcasePlate).toBe("accent");
    const onAccent = pulseGridPlan(params({ plate: "accent" }), LANDSCAPE);
    expect([onAccent.restColor, onAccent.swellColor]).toEqual([palette.ink, palette.paper]);
    const onDark = pulseGridPlan(params(), LANDSCAPE);
    expect([onDark.restColor, onDark.swellColor]).toEqual([palette.paper, palette.accent]);
    expect([0, 0.2, 0.349].map(swellColorMix)).toEqual([0, 0, 0]);
    expect([0.35, 0.5, 1].map(swellColorMix)).toEqual([1, 1, 1]);
    // Only the two roles ever appear: no blended grey at any time.
    for (let step = 0; step < 63; step += 1) {
      const fills = new Set(frameText(step / 30, LANDSCAPE, { plate: "accent" }).match(/fill="#[0-9A-F]{6}"/g));
      for (const fill of fills) expect([palette.accent, palette.ink, palette.paper].map(color => `fill="${color}"`)).toContain(fill);
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
