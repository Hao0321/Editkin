import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { mixHex } from "../../svg/color";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { T20_COPIES, T20_LOOP_SECONDS, vortexLayout, vortexPose } from "./T20_textVortex";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T20";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: straight (0), wound one way (0.45, 1.1), unwinding (1.6), wound the other way (2.3). */
const TIMES = [0, 0.45, 1.1, 1.6, 2.3] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "b8213a2351c7c21bf6af62ec92d6639968866e59c29a2f7237402441aba3d0fa",
    "4ef6096f8717db3d7e0d8006b47b6a0d4a151135452eef0085a4af36f79c004a",
    "679ee8925ab0cf1cfc24ae8408165ad22c679f0c2eb46d922d82566603c48921",
    "d05439f0268085027dd8eafa9a0fb829768498bd685db263fccb3abfec25e308",
    "678f97733bdc3e320258bd764adb5109d758ed398363ea5cae1127237f92f0ae",
  ],
  landscape: [
    "7ca5cb52a001a767e1d1db7d11d435c165c04d34682ebd109bcbb6e6bc793c64",
    "0275b63bb0dfb47085044cc89b8250d7479a101b63f78ff82d62a748d62c2704",
    "6676ebdb9a26e7348ad5f56ae812bb9901f9dd9149c8c18d19fef0343ee4e553",
    "3e43ee6b4161d8ffae0588814a3b89cfa6ecc2a932f54a7a0a1f2a04be432386",
    "e39ccea8a9c3b7a138fa8a590c7b151564bfd747618362d8b200d239f34fdac8",
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

/** Half-extents of a w × h box rotated by `degrees`. */
function rotatedHalf(w: number, h: number, degrees: number): [number, number] {
  const a = (Math.abs(degrees) * Math.PI) / 180;
  return [(w * Math.abs(Math.cos(a)) + h * Math.abs(Math.sin(a))) / 2, (w * Math.abs(Math.sin(a)) + h * Math.abs(Math.cos(a))) / 2];
}

describe("T20 Text Vortex", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: the frame at loopSeconds equals frame 0 (every format, energy and plate)", () => {
    expect(item.loopSeconds).toBe(T20_LOOP_SECONDS);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { energy: "calm" }, { plate: "bg" }, { lines: ["深海", "漩渦"] }]) {
        const start = frameText(0, size, input);
        expect(frameText(T20_LOOP_SECONDS, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2 * T20_LOOP_SECONDS, size, input)).toBe(start);
        expect(frameText(T20_LOOP_SECONDS * 0.37, size, input)).not.toBe(start);
      }
    }
    expect(frameText(90 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.3, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * T20_LOOP_SECONDS, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.45, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.45, PORTRAIT)).toBe(first);
  });

  it("wrings ten copies: the twist swings ±12° per copy (lingering wound), the stack rocks, and the front copy reads", () => {
    const layout = vortexLayout(params(), PORTRAIT);
    expect(layout.twist).toBe(12);
    expect(vortexPose(layout, 0).twist).toBe(0);
    expect(vortexPose(layout, 0.25).twist).toBeCloseTo(12, 9);
    expect(vortexPose(layout, 0.75).twist).toBeCloseTo(-12, 9);
    // Shaped |sin|^0.55: an eighth of the way in, the stack is already wound past 9.5°.
    expect(vortexPose(layout, 0.125).twist).toBeGreaterThan(9.5);
    expect(Math.abs(vortexPose(layout, 0.4).rock)).toBeLessThanOrEqual(4);
    expect(vortexLayout(params({ energy: "hype" }), PORTRAIT).twist).toBeGreaterThan(12);
    const palette = item.defaultParams.palette;
    const svg = frameText(0.45, PORTRAIT);
    // Ten word slices; the front one is the readable colour on top; slices behind alternate aqua and cream, fogged with depth.
    const fills = [...svg.matchAll(/<path d="[^"]+" fill="(#[0-9A-F]{6})" stroke="#15191F"/g)].map(match => match[1]);
    expect(fills).toHaveLength(T20_COPIES);
    expect(fills[fills.length - 1]).toBe(palette.paper);
    expect(fills[fills.length - 2]).toBe(mixHex(palette.accent, palette.bg, 0.06));
    expect(fills[fills.length - 3]).toBe(mixHex(palette.paper, palette.bg, 0.12));
    // Three arrowhead glints in the accent.
    expect(svg.match(/<polygon [^>]*fill="#1AD4C4"/g)).toHaveLength(3);
  });

  it("keeps the front copy inside the 5% title-safe box and every twisted copy inside the frame; the word is ≥ 9% of the short side", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { lines: ["深海", "漩渦"] }]) {
        const layout = vortexLayout(params(input), size), safe = titleSafeBox(size);
        const w = layout.inkWidth * layout.fit, h = layout.inkHeight * layout.fit;
        const [fx, fy] = rotatedHalf(w, h, 4);
        expect(layout.cx - fx).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
        expect(layout.cy - fy).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
        expect(h).toBeGreaterThanOrEqual(0.09 * Math.min(size.width, size.height));
        for (let index = 1; index < T20_COPIES; index += 1) {
          for (const turn of [0, 30, 60, 90, 120, index * layout.twist + 4]) {
            if (turn > index * layout.twist + 4) continue;
            const [hx, hy] = rotatedHalf(w * 0.92 ** index, h * 0.92 ** index, turn);
            expect(hx).toBeLessThanOrEqual(size.width / 2);
            expect(hy).toBeLessThanOrEqual(size.height / 2);
          }
        }
      }
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
        for (const plate of ["paper", "accent"] as const) {
          const plated = frameText(t, size, { plate });
          expect(plated.startsWith(header(size) + plateRect(size, palette[plate]))).toBe(true);
          expect(maskColors(plated.replace(plateRect(size, palette[plate]), ""))).toBe(maskColors(none));
        }
      }
    }
  });
});
