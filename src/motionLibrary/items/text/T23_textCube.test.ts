import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import { flattenPathD } from "../../svg/pathOps";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { T23_LOOP_SECONDS, T23_STEP_SECONDS, cubeLayout, cubeRoll } from "./T23_textCube";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T23";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: 春 held (0), mid-roll (0.45, 0.5), 夏 held (0.9), 秋 → 冬 roll (1.7). */
const TIMES = [0, 0.45, 0.5, 0.9, 1.7] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "9dc52c2a97ff7f374be11799309bb30873c15d21d6763846a1d6a06cf0750d43",
    "718966996f8779be583e7d6b49256c86feaf63fef110a1e27f5aa2517a1e2a7b",
    "8d8a1d27d168a9a35eb495ed8069f4ceca7f7db59d2ade3bb1833ea44e310cb3",
    "603a9fd0e783bf6815d994e694b2c82b683d38fcb6510a76f46d0f3aa7db2e86",
    "60b66b4d2588ba8392c528e3eb1ec104654d6e2b373d4910b0d31aac81b5cd37",
  ],
  landscape: [
    "713a01b07969fcd452b5343c982e690d92cc6dfea424b8b3a19bcff687306d05",
    "4c62f2c86f759dfd127252e46e185b540704b17f04882f19e10b97d8fbde727c",
    "5586b8ea9ffd99ac59b8b9fc60083c92848fe87578390d451ff6d56a1c502a36",
    "5dca626a7b6905c5b2f2684fe522fd8e39cbd851dd320886effe9893dabafc2e",
    "1f52aab6c4d99c58b8c5b55fd0b4785dda1f90cfd9488174eec7c9003b5bd81d",
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
const colours = (svg: string) => new Set(svg.match(/#[0-9A-F]{6}/g) ?? []);
const PALETTE_A = { bg: "#101820", ink: "#0A0A0A", paper: "#FAFAF0", accent: "#E0A030", accent2: "#704010" };
const PALETTE_B = { bg: "#203040", ink: "#000814", paper: "#F0F8FF", accent: "#30C0E0", accent2: "#105070" };

/** Absolute points (end and control points) of compact relative m/l/q/c/z path data. */
function relativePoints(d: string): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  let x = 0, y = 0, startX = 0, startY = 0;
  for (const [, command, body] of d.matchAll(/([mlqcz])([^mlqcz]*)/g)) {
    if (command === "z") { x = startX; y = startY; continue; }
    const values = (body.match(/-?(?:\d+\.?\d*|\.\d+)/g) ?? []).map(Number);
    for (let index = 0; index + 1 < values.length; index += 2) points.push([x + values[index], y + values[index + 1]]);
    x += values[values.length - 2]; y += values[values.length - 1];
    if (command === "m") { startX = x; startY = y; }
  }
  return points;
}
/** Every point a frame draws: absolute face polygons and relative glyph paths. */
function framePoints(svg: string): Array<readonly [number, number]> {
  return [...svg.matchAll(/<path d="([^"]+)"/g)].flatMap(([, d]) => (d.startsWith("M") ? flattenPathD(d).flat() : relativePoints(d)));
}

describe("T23 Text Cube", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: four 90° steps per 2.4 s, so the frame at loopSeconds equals frame 0", () => {
    expect(item.loopSeconds).toBe(T23_LOOP_SECONDS);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { energy: "calm" }, { plate: "bg" }, { lines: ["開", "箱"] }]) {
        const start = frameText(0, size, input);
        expect(frameText(T23_LOOP_SECONDS, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2 * T23_LOOP_SECONDS, size, input)).toBe(start);
        expect(frameText(0.5, size, input)).not.toBe(start);
      }
    }
    expect(frameText(72 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.3, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * T23_LOOP_SECONDS, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.45, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.45, PORTRAIT)).toBe(first);
  });

  it("rolls 90° per 0.6 s step: a 0.35 s hold, then a 0.25 s ease-in-out turn (energy shapes it, never the period)", () => {
    const layout = cubeLayout(params(), PORTRAIT);
    expect(T23_STEP_SECONDS).toBe(0.6);
    expect(layout.turnSeconds).toBeCloseTo(0.25, 9);
    expect(cubeRoll(layout, 0)).toBe(0);
    expect(cubeRoll(layout, 0.35)).toBe(0);
    expect(cubeRoll(layout, 0.475)).toBeCloseTo(45, 6); // the ease-in-out midpoint
    expect(cubeRoll(layout, 0.6)).toBeCloseTo(90, 6);
    expect(cubeRoll(layout, 0.95)).toBeCloseTo(90, 6);
    expect(cubeRoll(layout, 1.8)).toBeCloseTo(270, 6);
    // Punchy and hype overshoot a little before settling (back ease), inside the same step.
    const hype = cubeLayout(params({ energy: "hype" }), PORTRAIT);
    expect(Math.max(...Array.from({ length: 30 }, (_, index) => cubeRoll(hype, 0.4 + index * 0.0066)))).toBeGreaterThan(90);
  });

  it("draws accent faces with ink glyphs and a dark side face, one word per face in order", () => {
    const palette = item.defaultParams.palette;
    const held = frameText(0, PORTRAIT);
    expect(held).toContain(`fill="${palette.accent}"`);
    expect(held).toContain(`fill="${palette.ink}"`);
    expect(held.match(/<path d="M/g)?.length).toBe(2); // the held cube shows its front face and the dark right side face
    const layout = cubeLayout(params(), PORTRAIT);
    expect(layout.words).toHaveLength(4);
    expect(layout.colors.side).not.toBe(palette.accent);
    // Lines cycle when there are fewer than four.
    expect(cubeLayout(params({ lines: ["開", "箱"] }), PORTRAIT).words).toHaveLength(2);
    // Mid-roll two lit faces (front rolling up, the next rolling in) and the side face show.
    expect(frameText(0.475, PORTRAIT).match(/<path d="M/g)?.length).toBe(3);
  });

  it("keeps the rolling cube inside the 5% title-safe box; the held glyph is at least 9% of the short side", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      const safe = titleSafeBox(size);
      for (let t = 0; t < T23_LOOP_SECONDS; t += 0.05) {
        const points = framePoints(frameText(t, size));
        const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
        expect(Math.min(...xs), `${size.width}x${size.height} t=${t}`).toBeGreaterThanOrEqual(safe.x0 - 1);
        expect(Math.max(...xs)).toBeLessThanOrEqual(safe.x1 + 1);
        expect(Math.min(...ys)).toBeGreaterThanOrEqual(safe.y0 - 1);
        expect(Math.max(...ys)).toBeLessThanOrEqual(safe.y1 + 1);
      }
      const glyph = [...frameText(0, size).matchAll(/<path d="(m[^"]+)" fill="#121214"\/>/g)].map(([, d]) => relativePoints(d).map(point => point[1]));
      expect(glyph).toHaveLength(1);
      expect(Math.max(...glyph[0]) - Math.min(...glyph[0])).toBeGreaterThanOrEqual(0.09 * Math.min(size.width, size.height));
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
        // The cube is opaque palette colour: every plate just paints under it.
        for (const plate of ["bg", "paper", "accent"] as const) {
          const plated = frameText(t, size, { plate });
          expect(plated.startsWith(header(size) + plateRect(size, palette[plate]))).toBe(true);
          expect(plated.replace(plateRect(size, palette[plate]), "")).toBe(none);
        }
      }
    }
  });
});
