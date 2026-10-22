import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import {
  stopMotionPlan, stopMotionPose, stopMotionPoseIndex, T50_LOOP_SECONDS, T50_OFFSET, T50_POSES_PER_SECOND, T50_ROTATION, T50_SCALE,
} from "./T50_stopMotion";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T50";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.13, 0.6, 1.1, 1.9] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "e745f5d55843e3edd2f64c3e03e35dfd51f98df232856f48b4e348312d201004",
    "1fe68d13f030e60190c0ec722ee53e0ae29e9a10bced920ce8a0e908cc842351",
    "a4a9657c9db6dd7b5cc28ca68653fa206e5b0d3274ee7e69e61b29c97f33bef7",
    "e1c943fa0d42d7912ac9d724f490ba9f25d11252013a5f482eea88fc73d51cf3",
    "829cdc206d8d70723279cda2d52b5e6c835d67595f80309e027062166932918b",
  ],
  landscape: [
    "99c4aeac73c3cd980d78ee395e163441af472467b52ddf030698a11d22341c60",
    "738c1e2589555ec0107086b98dce35a19fbc58f0e32fed9aa8f8c156d0a9d74b",
    "92a928157c4062d5d0b031531c2647b861eaaffa156e984ccbf653b82e14605a",
    "3b1c4e4ed7c4b59d356fb58cb024a60d5b0f6ccd30877dc3d5fdd22d7301e38d",
    "3fc0e9f94673e6dc127a66697c98c291f4caa25d2db1bfae13432efabb6336e2",
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

describe("T50 Stop Motion", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: 16 poses per 2 s loop, the 17th is the first again", () => {
    expect(item.loopSeconds).toBe(T50_LOOP_SECONDS);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { energy: "calm" }, { plate: "accent" }]) {
        const start = frameText(0, size, input);
        expect(frameText(T50_LOOP_SECONDS, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2 * T50_LOOP_SECONDS, size, input)).toBe(start);
        expect(frameText(0.37, size, input)).not.toBe(start);
      }
    }
    expect(frameText(60 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.5, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * T50_LOOP_SECONDS, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.6, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.6, PORTRAIT)).toBe(first);
  });

  it("the pose index is floor(t · 8): 8 poses per second with no in-betweens, whatever the project fps", () => {
    expect(T50_POSES_PER_SECOND).toBe(8);
    for (const fps of [24, 25, 30, 60, 30000 / 1001]) {
      for (let frame = 0; frame < fps * 4; frame += 1) {
        const t = frame / fps;
        expect(stopMotionPoseIndex(t), `${fps} fps frame ${frame}`).toBe(Math.floor(t * 8 + 1e-6) % 16);
      }
    }
    // Every frame inside one 1/8 s pose is the same frame.
    expect(frameText(0.126, PORTRAIT)).toBe(frameText(0.249, PORTRAIT));
    expect(frameText(0.249, PORTRAIT)).not.toBe(frameText(0.251, PORTRAIT));
    // 16 distinct poses per loop.
    expect(new Set(Array.from({ length: 16 }, (_, pose) => frameText(pose / 8 + 0.01, PORTRAIT))).size).toBe(16);
  });

  it("poses stay in range (offset ±3%, rotation ±6°, scale 0.96–1.04) and keep every glyph inside the 5% title-safe box", () => {
    expect([T50_OFFSET, T50_ROTATION, ...T50_SCALE]).toEqual([0.03, 6, 0.96, 1.04]);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { lines: ["動畫"] }, { lines: ["定格", "動畫"] }]) {
        const p = params(input), plan = stopMotionPlan(p, size), safe = titleSafeBox(size);
        expect(plan.glyphSize, JSON.stringify(input)).toBeGreaterThanOrEqual(0.09 * Math.min(size.width, size.height));
        for (let pose = 0; pose < 16; pose += 1) {
          for (const glyph of plan.glyphs) {
            const q = stopMotionPose(plan, p.seed, glyph.index, pose);
            if (input === undefined) {
              expect(Math.abs(q.dx)).toBeLessThanOrEqual(0.03 * plan.glyphSize + 1e-9);
              expect(Math.abs(q.rotation)).toBeLessThanOrEqual(6 + 1e-9);
              expect(q.scale).toBeGreaterThanOrEqual(0.96 - 1e-9);
              expect(q.scale).toBeLessThanOrEqual(1.04 + 1e-9);
            }
            const radians = (q.rotation * Math.PI) / 180;
            for (const [x, y] of [[glyph.box.x0, glyph.box.y0], [glyph.box.x1, glyph.box.y0], [glyph.box.x0, glyph.box.y1], [glyph.box.x1, glyph.box.y1]]) {
              const lx = (x - glyph.cx) * q.scale, ly = (y - glyph.cy) * q.scale;
              const px = glyph.cx + q.dx + lx * Math.cos(radians) - ly * Math.sin(radians);
              const py = glyph.cy + q.dy + lx * Math.sin(radians) + ly * Math.cos(radians);
              expect(px).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
              expect(px).toBeLessThanOrEqual(safe.x1 + 1e-6);
              expect(py).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
              expect(py).toBeLessThanOrEqual(safe.y1 + 1e-6);
            }
          }
        }
      }
    }
  });

  it("colours: ink with every other glyph cream on the coral card (the reference); cream and coral on the dark card (§0)", () => {
    const palette = item.defaultParams.palette;
    expect(stopMotionPlan(params({ plate: "accent" }), PORTRAIT).glyphs.map(glyph => glyph.color)).toEqual([palette.ink, palette.paper, palette.ink, palette.paper]);
    expect(stopMotionPlan(params(), PORTRAIT).glyphs.map(glyph => glyph.color)).toEqual([palette.paper, palette.accent, palette.paper, palette.accent]);
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
