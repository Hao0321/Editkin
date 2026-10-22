import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { cellState, pixelDissolvePlan, pixelPhase, T67_BREAK, T67_CELLS_PER_GLYPH, T67_GONE, T67_RETURN, T67_SPARKLE, T67_WHOLE } from "./T67_pixelDissolve";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T67";
const LOOP = 1.8;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: the crisp word, the break-up starting, mid break-up, mid return, nearly whole. */
const TIMES = [0.1, 0.35, 0.6, 1, 1.25] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "8b21b6c02e2fb35603cc00126c75c5d6a7c56b03fd45f840d315c20fe1db296c",
    "7df9a70a6d79cec946d36f1e079b03c1720ccdf9b1050eb0e7c37aec625de1f4",
    "4acc42682920a7c08eb1fd2c0f46d5e67a1bc4e0463b5d011941a8178fd32c82",
    "b8c9ddda00241c1cdf846204414a0cda51e4d5cfcdd215ab006ad0f5ee632f61",
    "5b9616625508d45f9c1cd89f1fe83076422e9f7a2b4769d07753ab76f1605482",
  ],
  landscape: [
    "57322b8c2a5ba18c89beaffeb4eb067b5af88a95aaa9231dcdb75730b6910860",
    "74984d0bafd2501272724a651fd000c9dac6ab3f2a6826ec3b699d56bec231a3",
    "1a2a7c32b9b929badb2fd76826e8a515292b6e71185ea9b940a884e758c06a31",
    "de197defcd83cd46f06e84169bc539ceacbe5ccea90a3578c9e010f864de2a26",
    "0f464b26e1745399f95ebb9ad4fc705480a2f0347fcd784a74d23e63f88861a9",
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

describe("T67 Pixel Dissolve", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: the frame at loopSeconds equals frame 0, and the hold is the crisp vector word", () => {
    expect(item.loopSeconds).toBe(LOOP);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { plate: item.showcasePlate }, { seed: 9 }]) {
        const start = frameText(0, size, input);
        expect(frameText(LOOP, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2 * LOOP, size, input)).toBe(start);
        expect(frameText(LOOP * 0.37, size, input)).not.toBe(start);
        // The crisp word from 1.3 s is exactly the word at 0 s.
        expect(frameText(T67_WHOLE, size, input)).toBe(start);
        expect(frameText(1.6, size, input)).toBe(start);
      }
    }
    expect(frameText(54 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
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

  it("samples our own outlines into cells 1/9 of the glyph height and drops them one by one 0.3–0.75 s, back 0.85–1.3 s in another order", () => {
    expect([T67_BREAK, T67_GONE, T67_RETURN, T67_WHOLE, T67_CELLS_PER_GLYPH]).toEqual([0.3, 0.75, 0.85, 1.3, 9]);
    const plan = pixelDissolvePlan(params(), PORTRAIT);
    expect(plan.cellSize).toBeCloseTo(plan.glyphHeight / 9, 9);
    expect(plan.cells.length).toBeGreaterThan(60);
    expect(pixelPhase(0.29)).toBe("word");
    expect(pixelPhase(0.3)).toBe("cells");
    expect(pixelPhase(1.29)).toBe("cells");
    expect(pixelPhase(1.3)).toBe("word");
    const n = plan.cells.length;
    // Vanish and appear times are evenly spaced, one cell per step, all distinct, in two different seeded orders.
    const vanish = [...plan.vanishAt].sort((a, b) => a - b), appear = [...plan.appearAt].sort((a, b) => a - b);
    expect(vanish[n - 1]).toBeCloseTo(T67_GONE, 12);
    expect(appear[0]).toBeCloseTo(T67_RETURN, 12);
    for (let index = 1; index < n; index += 1) {
      expect(vanish[index] - vanish[index - 1]).toBeCloseTo((T67_GONE - T67_BREAK) / n, 9);
      expect(appear[index] - appear[index - 1]).toBeCloseTo((T67_WHOLE - T67_RETURN) / n, 9);
    }
    const order = (times: readonly number[]) => times.map((time, index) => [time, index] as const).sort((a, b) => a[0] - b[0]).map(entry => entry[1]);
    expect(order(plan.vanishAt)).not.toEqual(order(plan.appearAt));
    // At 0.3 s every cell shows; between 0.75 and 0.85 s none.
    expect(plan.cells.every((_, index) => cellState(plan, index, 0.3) !== "hidden")).toBe(true);
    expect(plan.cells.every((_, index) => cellState(plan, index, 0.8) === "hidden")).toBe(true);
    expect(plan.cells.every((_, index) => cellState(plan, index, 1.299) !== "hidden")).toBe(true);
    // Each cell sparkles for exactly one frame (1/30 s) as it goes and as it comes back.
    for (const index of [0, Math.floor(n / 2), n - 1]) {
      const v = plan.vanishAt[index], a = plan.appearAt[index];
      expect(cellState(plan, index, v - T67_SPARKLE - 1e-6)).toBe("ink");
      expect(cellState(plan, index, v - T67_SPARKLE / 2)).toBe("sparkle");
      expect(cellState(plan, index, v)).toBe("hidden");
      expect(cellState(plan, index, a - 1e-6)).toBe("hidden");
      expect(cellState(plan, index, a + T67_SPARKLE / 2)).toBe("sparkle");
      expect(cellState(plan, index, a + T67_SPARKLE + 1e-6)).toBe("ink");
    }
    // A different seed reorders the cells.
    expect(order(pixelDissolvePlan(params({ seed: 9 }), PORTRAIT).vanishAt)).not.toEqual(order(plan.vanishAt));
  });

  it("the word fills 80–90% of the safe width and every cell stays inside the safe box", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { lines: ["像"] }, { lines: ["像素", "溶解"] }]) {
        const plan = pixelDissolvePlan(params(input), size), safe = titleSafeBox(size), short = Math.min(size.width, size.height);
        expect(plan.glyphHeight, JSON.stringify(input)).toBeGreaterThanOrEqual(0.09 * short);
        if (input === undefined) {
          const fill = (plan.box.x1 - plan.box.x0) / safe.width;
          expect(fill).toBeGreaterThanOrEqual(0.8);
          expect(fill).toBeLessThanOrEqual(0.9);
        }
        for (const cell of plan.cells) {
          expect(cell.x).toBeGreaterThanOrEqual(safe.x0);
          expect(cell.x + cell.size).toBeLessThanOrEqual(safe.x1);
          expect(cell.y).toBeGreaterThanOrEqual(safe.y0);
          expect(cell.y + cell.size).toBeLessThanOrEqual(safe.y1);
        }
      }
    }
  });

  it("colours: ink on the cream card with a teal sparkle; cream on the dark card", () => {
    const palette = item.defaultParams.palette;
    expect(item.showcasePlate).toBe("paper");
    const onPaper = pixelDissolvePlan(params({ plate: "paper" }), PORTRAIT);
    expect([onPaper.color, onPaper.sparkleColor]).toEqual([palette.ink, palette.accent]);
    const onDark = pixelDissolvePlan(params(), PORTRAIT);
    expect([onDark.color, onDark.sparkleColor]).toEqual([palette.paper, palette.accent]);
    expect(pixelDissolvePlan(params({ plate: "accent" }), PORTRAIT).sparkleColor).toBe(palette.accent2);
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
