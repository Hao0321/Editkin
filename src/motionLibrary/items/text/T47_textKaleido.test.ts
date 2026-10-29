import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { T47_COPIES, T47_INNER, T47_LOOP_SECONDS, kaleidoLayout, kaleidoPose } from "./T47_textKaleido";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T47";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.6, 1.5, 2.4, 3.3] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "747d6f0148b13dc5369044b5ffb0c652efed2e7cf91bc1ac060b0cc13dfd0b5a",
    "7e5e633b201b034272490c5e7515fa02f3ed0ac63402d4f0e284b36dee28ffe4",
    "22de5d86be6410dd37a5da694ea4ff28578cdb1ddd0a1679e4c15331cb92a506",
    "ca61728b5084c7569cb1ec51bd3de0c5cff7da226db7b9b47d206e058ba31c6b",
    "418a87384370d57edc168b2bdd0f192a9b2fa0ff0429ce59917a14522c1db229",
  ],
  landscape: [
    "9fffe601ead8e0fa8685840bcba90ef3897fa4bf3c6c30775cf918fa4849bdbe",
    "399fc34a94bd8aa96b095a1a1de5ab1ea230db0a6ac76b159abf70fac79bedb5",
    "8e1e3346ba23a47db18d1125e6c8619f624402fa0c7cc1c9de1f5e26ef74b2f3",
    "df7ddd715d2efcfb7f4c225f90b0245eb834b6efe37c6bb7b26812956ec14f59",
    "753181792f0be2b5cfb9393e7def46c8b0edd0f44359293723b0c5021bf34368",
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
/** The rotate(...) angles of the eight copies, in document order. */
const angles = (svg: string) => [...svg.matchAll(/rotate\(([-\d.]+)\)/g)].map(match => Number(match[1]));

describe("T47 Text Kaleido", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly over one full turn: the frame at 4 s equals frame 0 (every format, energy and plate)", () => {
    expect(item.loopSeconds).toBe(T47_LOOP_SECONDS);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { energy: "calm" }, { plate: "paper" }, { lines: ["花"] }]) {
        const start = frameText(0, size, input);
        expect(frameText(T47_LOOP_SECONDS, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2 * T47_LOOP_SECONDS, size, input)).toBe(start);
        expect(frameText(T47_LOOP_SECONDS * 0.37, size, input)).not.toBe(start);
      }
    }
    expect(frameText(120 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.3, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * T47_LOOP_SECONDS, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.6, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.6, PORTRAIT)).toBe(first);
  });

  it("radiates 8 copies k × 45° apart around a clear centre (inner edge at 12% of the short side), turning 90°/s", () => {
    const at0 = angles(frameText(0, PORTRAIT));
    expect(at0).toHaveLength(T47_COPIES);
    // Two whorls: even copies first, odd copies over them.
    expect(at0).toEqual([0, 90, 180, 270, 45, 135, 225, 315]);
    expect(angles(frameText(1, PORTRAIT))).toEqual([90, 180, 270, 360, 135, 225, 315, 405]);
    const layout = kaleidoLayout(params(), PORTRAIT);
    const halfWidth = (layout.ink.x1 - layout.ink.x0) / 2;
    expect(layout.radius - halfWidth).toBeCloseTo(T47_INNER * 1080, 6);
    // Breathing ±8% of the copy radius with phase k × 45°, two breaths per loop.
    expect(layout.breath / layout.radius).toBeCloseTo(0.08, 9);
    expect(kaleidoPose(layout, 0, 2).radius).toBeCloseTo(layout.radius + layout.breath, 6);
    expect(kaleidoPose(layout, 0.125, 0).radius).toBeCloseTo(layout.radius + layout.breath, 6);
    expect(kaleidoPose(layout, 0, 0).radius).toBeCloseTo(layout.radius, 6);
  });

  it("alternates ink and olive on the paper plate (lime cannot be read on cream), cream and lime on the dark card", () => {
    const palette = item.defaultParams.palette;
    expect(kaleidoLayout(params({ plate: "paper" }), PORTRAIT).colors).toEqual([palette.ink, palette.accent2]);
    expect(kaleidoLayout(params(), PORTRAIT).colors).toEqual([palette.paper, palette.accent]);
    const svg = frameText(0.6, PORTRAIT, { plate: "paper" });
    expect(svg.match(new RegExp(`fill="${palette.ink}"`, "g"))).toHaveLength(4);
    expect(svg.match(new RegExp(`fill="${palette.accent2}"`, "g"))).toHaveLength(4);
  });

  it("keeps every petal inside the frame while it turns and the word at least 9% of the short side", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { lines: ["萬花筒"] }]) {
        const layout = kaleidoLayout(params(input), size), short = Math.min(size.width, size.height);
        const w = layout.ink.x1 - layout.ink.x0, h = layout.ink.y1 - layout.ink.y0;
        // Far tip corners at the widest breath stay within 45% of the short side (inside the frame at any angle).
        expect(Math.hypot(layout.radius + layout.breath + w / 2, h / 2)).toBeLessThanOrEqual(0.45 * short + 1e-6);
        expect(h).toBeGreaterThanOrEqual(0.09 * short);
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
    expect(item.showcasePlate).toBe("paper");
    const palette = item.defaultParams.palette;
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const t of TIMES) {
        const none = frameText(t, size);
        expect(none).not.toContain("<rect");
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
