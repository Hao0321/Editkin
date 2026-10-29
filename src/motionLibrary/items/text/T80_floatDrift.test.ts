import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import {
  floatPlan, floatPose, floatTracking, T80_DRIFT_X, T80_DRIFT_Y, T80_OPACITY, T80_PERIOD_COLOR, T80_PERIOD_OPACITY, T80_PERIOD_TURN, T80_PERIOD_X, T80_PERIOD_Y, T80_TURN,
} from "./T80_floatDrift";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T80";
const LOOP = 6;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 1, 2.5, 3.7, 5.2] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "3e6e53db10e28a250f1817e0ad48743d9293b20319c102db8eaf8ac05d134d5c",
    "b3f96fa6e33b587a153b5f9aa45de679a426012d21f09a8a4126a4164fc1a793",
    "379b663dbc0e241b7e679be155416965ec50ebfd8ccfba46c5929d7404daad02",
    "5e2672bb14cf2fdddb6e92929574b8dcd36c6acd3a3d7d62a845bdd9325fecaf",
    "23041067c9444f3972bf865c5c8e2c25cfa49c0020f7f93417b10343618d861f",
  ],
  landscape: [
    "68982daad9bfa9a8ef4e8e6fc58812fadd56b16319ec59b0131d20c643c8d8ca",
    "4faa46bbc4d7432e6a17c461e1c56e60bde31b15ae2e2ce79d120a889e83dbfe",
    "bd16ed0a50e95b88f727bf5c5a72d4835b607e055c6687e45d0a3b1f45f44f4a",
    "90995da5a6a48f527b8da84ebd78a2d7fbeedaafe8fadf178e719ca1c1616dca",
    "42aa508b24024dfa45bd72d80d0342cbc1cd3fb6bc7250c11857d3a01086d96a",
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

describe("T80 Float Drift", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: every period divides 6 s; the frame at loopSeconds equals frame 0", () => {
    expect(item.loopSeconds).toBe(LOOP);
    for (const period of [T80_PERIOD_X, T80_PERIOD_Y, T80_PERIOD_TURN, T80_PERIOD_OPACITY, T80_PERIOD_COLOR]) expect((LOOP / period) % 1).toBe(0);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { energy: "calm" }, { plate: item.showcasePlate }]) {
        const start = frameText(0, size, input);
        expect(frameText(LOOP, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2 * LOOP, size, input)).toBe(start);
        expect(frameText(LOOP * 0.37, size, input)).not.toBe(start);
      }
    }
    expect(frameText(180 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.5, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * LOOP, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(2.5, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(2.5, PORTRAIT)).toBe(first);
  });

  it("each character drifts on its own Lissajous path (±2.5% / ±5%, 3 s / 2 s), turns ±4°, breathes 92–100% and cross-fades", () => {
    expect([T80_DRIFT_X, T80_DRIFT_Y, T80_PERIOD_X, T80_PERIOD_Y, T80_TURN]).toEqual([0.025, 0.05, 3, 2, 4]);
    expect(T80_OPACITY).toEqual([0.92, 1]);
    const plan = floatPlan(params(), PORTRAIT);
    expect(new Set(plan.glyphs.map(glyph => glyph.phases[0].toFixed(6))).size).toBe(plan.glyphs.length);
    for (const glyph of plan.glyphs) {
      let maxX = 0, maxY = 0, minOpacity = 1, maxOpacity = 0, minTone = 1, maxTone = 0;
      for (let step = 0; step < 600; step += 1) {
        const pose = floatPose(plan, glyph, (step / 600) * LOOP);
        maxX = Math.max(maxX, Math.abs(pose.dx)); maxY = Math.max(maxY, Math.abs(pose.dy));
        expect(Math.abs(pose.rotation)).toBeLessThanOrEqual(4 + 1e-9);
        minOpacity = Math.min(minOpacity, pose.opacity); maxOpacity = Math.max(maxOpacity, pose.opacity);
        minTone = Math.min(minTone, pose.tone); maxTone = Math.max(maxTone, pose.tone);
      }
      expect(maxX).toBeCloseTo(0.025 * plan.glyphHeight, 0);
      expect(maxY).toBeCloseTo(0.05 * plan.glyphHeight, 0);
      expect(minOpacity).toBeGreaterThanOrEqual(0.92 - 1e-9);
      expect(minOpacity).toBeLessThan(0.93);
      expect(maxOpacity).toBeLessThanOrEqual(1 + 1e-9);
      expect(minTone).toBeLessThan(0.01);
      expect(maxTone).toBeGreaterThan(0.99);
      // The x drift repeats every 3 s, the y drift every 2 s.
      expect(floatPose(plan, glyph, 0.4).dx).toBeCloseTo(floatPose(plan, glyph, 3.4).dx, 9);
      expect(floatPose(plan, glyph, 0.4).dy).toBeCloseTo(floatPose(plan, glyph, 2.4).dy, 9);
    }
  });

  it("neighbours never touch: the tracking opens exactly the room two drifting, turning characters can close", () => {
    expect(floatTracking(["輕飄飄"], 1)).toBeCloseTo(-0.04 + 0.05 + Math.sin((4 * Math.PI) / 180) + 0.01, 12);
    const collisions: string[] = [];
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { lines: ["輕飄", "飄飄"] }]) {
        const plan = floatPlan(params(input), size);
        // Conservative: each glyph's ink box, turned and drifted; adjacent boxes on a line must not overlap.
        const span = (glyph: (typeof plan.glyphs)[number], t: number) => {
          const pose = floatPose(plan, glyph, t), radians = (pose.rotation * Math.PI) / 180;
          const xs = [[glyph.box.x0, glyph.box.y0], [glyph.box.x1, glyph.box.y0], [glyph.box.x0, glyph.box.y1], [glyph.box.x1, glyph.box.y1]]
            .map(([bx, by]) => glyph.cx + pose.dx + (bx - glyph.cx) * Math.cos(radians) - (by - glyph.cy) * Math.sin(radians));
          return [Math.min(...xs), Math.max(...xs)] as const;
        };
        for (let index = 0; index + 1 < plan.glyphs.length; index += 1) {
          const a = plan.glyphs[index], b = plan.glyphs[index + 1];
          if (a.line !== b.line || a.separator || b.separator) continue;
          for (let step = 0; step < 240; step += 1) {
            const t = (step / 240) * LOOP;
            if (span(b, t)[0] < span(a, t)[1]) collisions.push(`${JSON.stringify(input)} ${size.width}x${size.height} ${a.char}${b.char} t=${t}`);
          }
        }
      }
    }
    expect(collisions.slice(0, 5)).toEqual([]);
  });

  it("the word fills 80–90% of the safe width and the drifting characters stay inside the safe box", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { lines: ["飄"] }, { lines: ["輕飄", "飄飄"] }]) {
        const plan = floatPlan(params(input), size), safe = titleSafeBox(size), short = Math.min(size.width, size.height);
        expect(plan.glyphHeight, JSON.stringify(input)).toBeGreaterThanOrEqual(0.09 * short);
        if (input === undefined && size !== LANDSCAPE) {
          const fill = (plan.box.x1 - plan.box.x0) / safe.width;
          expect(fill).toBeGreaterThanOrEqual(0.8);
          expect(fill).toBeLessThanOrEqual(0.9);
        }
        for (let step = 0; step < 60; step += 1) {
          for (const glyph of plan.glyphs) {
            const pose = floatPose(plan, glyph, (step / 60) * LOOP), radians = (pose.rotation * Math.PI) / 180;
            for (const [bx, by] of [[glyph.box.x0, glyph.box.y0], [glyph.box.x1, glyph.box.y0], [glyph.box.x0, glyph.box.y1], [glyph.box.x1, glyph.box.y1]]) {
              const x = glyph.cx + pose.dx + (bx - glyph.cx) * Math.cos(radians) - (by - glyph.cy) * Math.sin(radians);
              const y = glyph.cy + pose.dy + (bx - glyph.cx) * Math.sin(radians) + (by - glyph.cy) * Math.cos(radians);
              expect(x).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
              expect(x).toBeLessThanOrEqual(safe.x1 + 1e-6);
              expect(y).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
              expect(y).toBeLessThanOrEqual(safe.y1 + 1e-6);
            }
          }
        }
      }
    }
  });

  it("colours cross-fade between cream and gold on the dark card; ink and the deep gold on the gold card", () => {
    const palette = item.defaultParams.palette;
    expect(item.showcasePlate).toBe("bg");
    const plan = floatPlan(params(), PORTRAIT);
    expect([plan.first, plan.second]).toEqual([palette.paper, palette.accent]);
    const onAccent = floatPlan(params({ plate: "accent" }), PORTRAIT);
    expect([onAccent.first, onAccent.second]).toEqual([palette.ink, palette.accent2]);
  });

  it("r2: no grey cast: every fill lies between cream and gold, and at the 92% floor the cream keeps ≥ 90% of each channel on the dark card", () => {
    const palette = item.defaultParams.palette;
    const rgb = (hex: string) => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
    const cream = rgb(palette.paper), gold = rgb(palette.accent), card = rgb(palette.bg);
    for (let step = 0; step < 24; step += 1) {
      const fills = [...frameText((step / 24) * LOOP, PORTRAIT, { plate: "bg" }).matchAll(/<path [^>]*fill="(#[0-9A-F]{6})"/g)].map(match => match[1]);
      expect(fills.length).toBeGreaterThan(0);
      for (const fill of fills) {
        rgb(fill).forEach((value, channel) => {
          expect(value).toBeGreaterThanOrEqual(Math.min(cream[channel], gold[channel]) - 1);
          expect(value).toBeLessThanOrEqual(Math.max(cream[channel], gold[channel]) + 1);
        });
      }
    }
    cream.forEach((value, channel) => expect(T80_OPACITY[0] * value + (1 - T80_OPACITY[0]) * card[channel]).toBeGreaterThanOrEqual(0.9 * value));
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
