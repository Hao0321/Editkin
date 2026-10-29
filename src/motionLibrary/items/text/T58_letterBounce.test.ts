import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import {
  bouncePose, letterBouncePlan, T58_FLIGHT, T58_HOP_HEIGHT, T58_HOP_TOTAL, T58_LOOP_SECONDS, T58_MIN_REST, T58_SPACING, T58_SQUASH_SECONDS,
  T58_SQUASH_X, T58_SQUASH_Y, T58_START, T58_STRETCH_Y,
} from "./T58_letterBounce";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T58";
const LOOP = 1.6;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: rest, the first crouch, two characters in the air, mid ripple, the last hop. */
const TIMES = [0, 0.1, 0.25, 0.5, 0.75] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "7e7d3bbdcabcfcb7e8fa9052d2d52d6b1f8bc320c3e70a5a6686abdddd9ac47a",
    "6bbf966bf71162b2778109d5c08809f08bb6b270a189654b5879ebd0d7100cd3",
    "4abba9a6804d5f2fcb7e7be27ff5cfe620090fad1443c84f685d28f2fea22360",
    "6a1cb55a9bb15d6d8eddf05f69cdeb9764c1014f856d59a70d4fee7d2a01e7e9",
    "df332a6c5674bea1f5ffcc84c0290a515fb1f01e1a65e7b99939deabaeb0b3d1",
  ],
  landscape: [
    "e468d76d310034375a996612b6b64a53025cfbca6d01f49e7ef78afcc6b7fac1",
    "916d4a84b2411bc86d4dc09d1d06bf4c7ffe7f4825cd548b2f000569436ba365",
    "12ad8c269ba3e8628789e2d98283e8ebc118782b3fa27054137f509f523340e1",
    "e52db1fae547c03da0a3362b29dcb955c00acba683a2c5799c350488a12d2d1e",
    "c19c5a755a82b304c825d513f941f337290899f97dc947620d3ee5fead6bf963",
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

describe("T58 Letter Bounce", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: the frame at loopSeconds equals frame 0 (every format, energy and plate)", () => {
    expect(item.loopSeconds).toBe(LOOP);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { energy: "calm" }, { plate: item.showcasePlate }, { lines: ["跳・跳・跳"] }]) {
        const start = frameText(0, size, input);
        expect(frameText(LOOP, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2 * LOOP, size, input)).toBe(start);
        expect(frameText(LOOP * 0.37, size, input)).not.toBe(start);
      }
    }
    // The renderer samples t = i / fps: frame 48 at 30 fps is frame 0 again.
    expect(frameText(48 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.5, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * LOOP, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.25, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.25, PORTRAIT)).toBe(first);
  });

  it("hops one character at a time: crouch, a 0.32 s gravity parabola 45% of the glyph high with a 1.05 stretch at the top, landing squash", () => {
    expect([T58_HOP_HEIGHT, T58_FLIGHT, T58_SPACING, T58_SQUASH_X, T58_SQUASH_Y, T58_STRETCH_Y]).toEqual([0.45, 0.32, 0.16, 1.08, 0.9, 1.05]);
    const plan = letterBouncePlan(params(), PORTRAIT);
    expect(plan.spacing).toBe(0.16);
    expect(plan.hopHeight).toBeCloseTo(0.45 * plan.glyphHeight, 9);
    const liftOff = T58_START + T58_SQUASH_SECONDS;
    // Crouch: squash peaks mid-window at scaleX 1.08 / scaleY 0.9 and the glyph stays on the line.
    const crouch = bouncePose(plan, 0, T58_START + T58_SQUASH_SECONDS / 2);
    expect(crouch.lift).toBe(0);
    expect(crouch.scaleX).toBeCloseTo(1.08, 9);
    expect(crouch.scaleY).toBeCloseTo(0.9, 9);
    // Apex at mid-flight: 45% of the glyph height, stretched to 1.05.
    const apex = bouncePose(plan, 0, liftOff + T58_FLIGHT / 2);
    expect(apex.lift).toBeCloseTo(plan.hopHeight, 9);
    expect(apex.scaleY).toBeCloseTo(1.05, 9);
    // Constant gravity: the lift is a parabola in time (equal rise and fall at mirrored times; the second difference is constant).
    const at = (p: number) => bouncePose(plan, 0, liftOff + p * T58_FLIGHT).lift;
    expect(at(0.2)).toBeCloseTo(at(0.8), 6);
    expect(at(0.1) - 2 * at(0.2) + at(0.3)).toBeCloseTo(at(0.6) - 2 * at(0.7) + at(0.8), 6);
    // Two characters are in the air at once (0.16 s spacing, 0.32 s flight) and each hop ends in a landing squash.
    const u = liftOff + 0.2;
    expect(bouncePose(plan, 0, u).lift).toBeGreaterThan(0);
    expect(bouncePose(plan, 1, u).lift).toBeGreaterThan(0);
    const land = bouncePose(plan, 0, liftOff + T58_FLIGHT + T58_SQUASH_SECONDS / 2);
    expect(land.lift).toBe(0);
    expect(land.scaleY).toBeCloseTo(0.9, 9);
    // The last landing leaves at least 0.3 s of rest before the loop closes; every character is still at 0.
    const hops = plan.glyphs.filter(glyph => glyph.hop >= 0).length;
    expect(T58_START + (hops - 1) * plan.spacing + T58_HOP_TOTAL).toBeLessThanOrEqual(LOOP - T58_MIN_REST + 1e-9);
    for (const glyph of plan.glyphs) expect(bouncePose(plan, glyph.hop, 0)).toEqual({ lift: 0, scaleX: 1, scaleY: 1 });
    // Long lines tighten the spacing so the loop still closes.
    const long = letterBouncePlan(params({ lines: ["跳動的字跳動的字跳動的字"] }), PORTRAIT);
    expect(long.spacing).toBeLessThan(0.16);
    expect(T58_START + 11 * long.spacing + T58_HOP_TOTAL).toBeLessThanOrEqual(LOOP - T58_MIN_REST + 1e-9);
  });

  it("separators stay still and are skipped in the hop order", () => {
    const plan = letterBouncePlan(params({ lines: ["跳・跳"] }), PORTRAIT);
    expect(plan.glyphs.map(glyph => glyph.hop)).toEqual([0, -1, 1]);
    for (let step = 0; step < 32; step += 1) expect(bouncePose(plan, -1, (step / 32) * LOOP)).toEqual({ lift: 0, scaleX: 1, scaleY: 1 });
  });

  it("the word fills 80–90% of the title-safe width and every pose stays inside the safe box", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { lines: ["跳"] }, { lines: ["跳動", "的字"] }, { lines: ["跳動的字跳動的"] }]) {
        const plan = letterBouncePlan(params(input), size), safe = titleSafeBox(size), short = Math.min(size.width, size.height);
        expect(plan.glyphHeight, JSON.stringify(input)).toBeGreaterThanOrEqual(0.09 * short);
        if (input === undefined) {
          const fill = (plan.box.x1 - plan.box.x0) / safe.width;
          expect(fill).toBeGreaterThanOrEqual(0.8);
          expect(fill).toBeLessThanOrEqual(0.9);
        }
        for (let step = 0; step < 96; step += 1) {
          const u = (step / 96) * LOOP;
          for (const glyph of plan.glyphs) {
            const pose = bouncePose(plan, glyph.hop, u), footX = glyph.cx, footY = glyph.box.y1;
            const xs = [glyph.box.x0, glyph.box.x1].map(x => footX + (x - footX) * pose.scaleX);
            const ys = [glyph.box.y0, glyph.box.y1].map(y => footY - pose.lift + (y - footY) * pose.scaleY);
            for (const x of xs) {
              expect(x, `${size.width}x${size.height} ${JSON.stringify(input)}`).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
              expect(x).toBeLessThanOrEqual(safe.x1 + 1e-6);
            }
            for (const y of ys) {
              expect(y, `${size.width}x${size.height} ${JSON.stringify(input)} u=${u}`).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
              expect(y).toBeLessThanOrEqual(safe.y1 + 1e-6);
            }
          }
        }
      }
    }
  });

  it("colours: ink and cream alternate on the violet card (the reference); cream and violet on the dark card (§0)", () => {
    const palette = item.defaultParams.palette;
    expect(item.showcasePlate).toBe("accent");
    expect(letterBouncePlan(params({ plate: "accent" }), PORTRAIT).glyphs.map(glyph => glyph.color)).toEqual([palette.ink, palette.paper, palette.ink, palette.paper]);
    expect(letterBouncePlan(params(), PORTRAIT).glyphs.map(glyph => glyph.color)).toEqual([palette.paper, palette.accent, palette.paper, palette.accent]);
    expect(letterBouncePlan(params({ plate: "paper" }), PORTRAIT).glyphs.map(glyph => glyph.color)).toEqual([palette.ink, palette.accent2, palette.ink, palette.accent2]);
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
