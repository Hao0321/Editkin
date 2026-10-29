import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import {
  dominoAngle, dominoPlan, dominoTransform, T54_DOWN, T54_FALL, T54_LOOP_SECONDS, T54_REBOUND, T54_REBOUND_TO, T54_REST, T54_STAGGER, T54_STAND,
  T54_START,
} from "./T54_dominoLetters";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T54";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: standing, the first tile falling, the chain mid-fall, lying, standing back up. */
const TIMES = [0.05, 0.3, 0.45, 0.9, 1.2] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "033adbc30f7d1e8355fa8c47b7b1054a73c8d3679c1ba9a5e3a106b12c9b4e3e",
    "524f4aaca07947c4ed929c4b8559c4988809e6002bbfee7fc42d348b4eacec3c",
    "3c3057485c8159ad0e8a6ec4086da3e73ac2550cbbf67ba27a9fa31540d99ad8",
    "110dffa3cf2964baaadcfe7e499f1a2cd268b537ef3dc6afaa65170c4bed98b6",
    "5a82f3f0838aeb9e4248a1d2962e0c27013c673d1087e2347d138fac4446a9f7",
  ],
  landscape: [
    "b1edc7c69353dcb87aa761713ac85fb354e295efa977fd86a01e9cb5ca8046a8",
    "8875e3ff34a61200ecd1c0b6509635cf917016e41b05527a9a9e09ef82ac1846",
    "d57e7e37b3b0625f7fc0394ad907a650c20483d1f1fd23b32904adb81d63794b",
    "04d2587f055dafa9f2d09b845687383ebed976928785124b81b28b3a03893c67",
    "cb7596aafa64b756e01377f07546a2be6a194680a770d8017c0d6ea89421abd4",
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

describe("T54 Domino Letters", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: the word stands still at the seam", () => {
    expect(item.loopSeconds).toBe(T54_LOOP_SECONDS);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { energy: "calm" }, { plate: "accent" }, { lines: ["一二三四五六七八九"] }]) {
        const start = frameText(0, size, input);
        expect(frameText(T54_LOOP_SECONDS, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2 * T54_LOOP_SECONDS, size, input)).toBe(start);
        expect(frameText(0.6, size, input)).not.toBe(start);
        // Nothing is tilted at the seam.
        expect(start).not.toContain("rotate(");
      }
    }
    expect(frameText(60 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.5, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * T54_LOOP_SECONDS, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.45, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.45, PORTRAIT)).toBe(first);
  });

  it("follows the catalog timing: 0.1 s apart, 0 → 88° in 0.22 s (easeIn), rebound 88 → 82 → 88°, down 0.35 s, up in 0.25 s (backOut)", () => {
    expect([T54_START, T54_STAGGER, T54_FALL, T54_REBOUND, T54_REST, T54_STAND]).toEqual([0.12, 0.1, 0.22, 0.08, 0.35, 0.25]);
    expect([T54_DOWN, T54_REBOUND_TO]).toEqual([88, 82]);
    const plan = dominoPlan(params(), PORTRAIT);
    expect(plan.stagger).toBe(0.1);
    for (let index = 0; index < plan.dominoes.length; index += 1) {
      const s = T54_START + index * 0.1;
      expect(dominoAngle(plan, index, s)).toBe(0);
      // easeIn: slow start, fast finish.
      expect(dominoAngle(plan, index, s + 0.11)).toBeLessThan(88 / 4);
      expect(dominoAngle(plan, index, s + 0.22)).toBeCloseTo(88, 6);
      expect(dominoAngle(plan, index, s + 0.30)).toBeCloseTo(82, 6);
      expect(dominoAngle(plan, index, s + 0.38)).toBeCloseTo(88, 6);
      expect(dominoAngle(plan, index, s + 0.5)).toBe(88);
      expect(dominoAngle(plan, index, s + 0.73)).toBeCloseTo(88, 6);
      // backOut: rocks a little past upright (negative), then settles at 0.
      const back = Math.min(...Array.from({ length: 50 }, (_, k) => dominoAngle(plan, index, s + 0.73 + (k / 50) * 0.25)));
      expect(back).toBeLessThan(-2);
      expect(dominoAngle(plan, index, s + 0.98)).toBeCloseTo(0, 3);
      expect(dominoAngle(plan, index, s + 1.0)).toBe(0);
    }
    // Upright tilt pivots on the bottom-right corner, a rocked-back tilt on the bottom-left: no tile dips through the floor.
    const domino = plan.dominoes[0];
    expect(dominoTransform(domino, 40)).toContain(`${domino.tile.x1.toFixed(3).replace(/\.?0+$/, "")} ${domino.tile.y1.toFixed(3).replace(/\.?0+$/, "")}`);
    expect(dominoTransform(domino, -5)).toContain(`${domino.tile.x0.toFixed(3).replace(/\.?0+$/, "")} ${domino.tile.y1.toFixed(3).replace(/\.?0+$/, "")}`);
    expect(dominoTransform(domino, 0)).toBeUndefined();
  });

  it("standing, falling and fallen, every tile stays inside the 5% title-safe box; glyphs are at least 9% of the short side", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { lines: ["骨牌"] }, { lines: ["一二三四五六七八九"] }]) {
        const plan = dominoPlan(params(input), size), safe = titleSafeBox(size);
        if (input === undefined) expect(plan.tileHeight * (1 - 0.12)).toBeGreaterThanOrEqual(0.09 * Math.min(size.width, size.height));
        for (let step = 0; step <= 100; step += 1) {
          const u = (step / 100) * T54_LOOP_SECONDS;
          for (const domino of plan.dominoes) {
            const degrees = dominoAngle(plan, domino.index, u), radians = (degrees * Math.PI) / 180;
            const px = degrees > 0 ? domino.tile.x1 : domino.tile.x0, py = domino.tile.y1;
            for (const [x, y] of [[domino.tile.x0, domino.tile.y0], [domino.tile.x1, domino.tile.y0], [domino.tile.x0, domino.tile.y1], [domino.tile.x1, domino.tile.y1]]) {
              const rx = px + (x - px) * Math.cos(radians) - (y - py) * Math.sin(radians);
              const ry = py + (x - px) * Math.sin(radians) + (y - py) * Math.cos(radians);
              expect(rx, `${JSON.stringify(input)} u=${u}`).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
              expect(rx).toBeLessThanOrEqual(safe.x1 + 1e-6);
              expect(ry).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
              expect(ry).toBeLessThanOrEqual(plan.floorY + 1e-6); // never through the floor
            }
          }
        }
      }
    }
  });

  it("colours: ink glyphs and cream tiles on every other character on the coral card; the floor line is the text colour at 30%", () => {
    const palette = item.defaultParams.palette;
    const plan = dominoPlan(params(), PORTRAIT);
    expect(plan.dominoes.map(domino => domino.tiled)).toEqual([true, false, true, false]);
    const onCoral = frameText(0.05, PORTRAIT, { plate: "accent" });
    expect(onCoral.match(new RegExp(`rx="[\\d.]+" ry="[\\d.]+" fill="${palette.paper}"`, "g"))).toHaveLength(2);
    expect(onCoral.match(new RegExp(`<path d="[^"]+" fill="${palette.ink}"`, "g"))).toHaveLength(4);
    expect(onCoral).toContain(`stroke="${palette.ink}" stroke-opacity="0.3"`);
    // Over the dark card the bare glyphs and the floor turn cream; tiled glyphs stay ink on their cream tiles.
    const onDark = frameText(0.05, PORTRAIT);
    expect(onDark.match(new RegExp(`<path d="[^"]+" fill="${palette.ink}"`, "g"))).toHaveLength(2);
    expect(onDark.match(new RegExp(`<path d="[^"]+" fill="${palette.paper}"`, "g"))).toHaveLength(2);
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
    expect(item.showcasePlate).toBe("accent");
    const palette = item.defaultParams.palette;
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const t of TIMES) {
        const none = frameText(t, size);
        expect(none.startsWith(header(size) + plateRect(size, palette.bg))).toBe(false);
        expect(frameText(t, size, { plate: "none" })).toBe(none);
        expect(frameText(t, size, { plate: "bg" }).replace(plateRect(size, palette.bg), "")).toBe(none);
        const onAccent = frameText(t, size, { plate: "accent" });
        expect(onAccent.startsWith(header(size) + plateRect(size, palette.accent))).toBe(true);
        expect(maskColors(onAccent.replace(plateRect(size, palette.accent), ""))).toBe(maskColors(none));
      }
    }
  });
});
