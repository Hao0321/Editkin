import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { jitterEnvelope, jitterPlan, jitterPose, jitterPoseIndex, T74_OFFSET, T74_POSES_PER_SECOND, T74_ROTATION, T74_SHAKE, T74_TAU } from "./T74_jitterSettle";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T74";
const LOOP = 1.6;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.1, 0.35, 0.7, 1.3] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "da54ad646b85e6535e8535b572f29f1011a35f7198fee74f52080bce8323e777",
    "b04cac181a03ce46d1925892062832fa1ad38c2e694e806dc15e7ef30248a2f7",
    "6197b18e303ac5a0c6037481e0a882b267e97772f7311d6d7cabfadace01347a",
    "b9df649c1a743eea593283492a6e5b75eb489a1c96ecc0831593a8dacd3dd0f1",
    "a1bd2259a0c6b2f8057a2db184febba950ed51d3a8fe7d3fa689906abc3addbb",
  ],
  landscape: [
    "af0aa8210935c814d64167326bf6ec73cb65cc45c365f3caea63e313f6171282",
    "004bd2cd83661f04e3add205aed5e136f0372a9d2e0ff52e4898259a4efaa8cb",
    "b8504dce72cf062b32619fde876b03876f99a665dcaa4826677c99549ed19a30",
    "c88660624d12d1cbdfa2fbe45a7e0d4ef6ded6513af3e13d479c81d09cffbaa2",
    "af6d322593eb8f7ff5cf97131a98cadd0aca204173268bb8c2171db3243c8493",
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

describe("T74 Jitter Settle", () => {
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
    expect(frameText(48 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
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

  it("a new seeded pose every 2 frames (±6%, ±10°), decaying exponentially (τ 0.25 s) to perfectly still at 1.0 s", () => {
    expect([T74_SHAKE, T74_TAU, T74_POSES_PER_SECOND, T74_OFFSET, T74_ROTATION]).toEqual([1, 0.25, 15, 0.06, 10]);
    expect(jitterEnvelope(0)).toBe(1);
    expect(jitterEnvelope(T74_SHAKE)).toBe(0);
    expect(jitterEnvelope(T74_SHAKE - 1e-9)).toBeLessThan(1e-6);
    // Exponential with τ = 0.25 s (renormalised): e^(−0.25/0.25) ≈ 0.368 → 0.356.
    expect(jitterEnvelope(0.25)).toBeCloseTo((Math.exp(-1) - Math.exp(-4)) / (1 - Math.exp(-4)), 9);
    // Pose index: frames 0 and 1 share a pose at 30 fps, frame 2 takes the next.
    expect([0, 1, 2, 3].map(frame => jitterPoseIndex(frame / 30))).toEqual([0, 0, 1, 1]);
    const plan = jitterPlan(params(), PORTRAIT);
    // The same pose (scaled by the decay) for both frames of a pair, a new one on the next pair.
    const unit = (u: number) => { const pose = jitterPose(plan, 1, 0, u), e = jitterEnvelope(u); return [pose.dx / e, pose.dy / e, pose.rotation / e]; };
    unit(1 / 30).forEach((value, index) => expect(value).toBeCloseTo(unit(0)[index], 9));
    expect(unit(2 / 30)[0]).not.toBeCloseTo(unit(0)[0], 3);
    for (let step = 0; step < 48; step += 1) {
      const u = (step / 48) * LOOP;
      for (const glyph of plan.glyphs) {
        const pose = jitterPose(plan, 1, glyph.index, u), envelope = jitterEnvelope(u);
        expect(Math.abs(pose.dx)).toBeLessThanOrEqual(T74_OFFSET * plan.glyphHeight * envelope + 1e-9);
        expect(Math.abs(pose.rotation)).toBeLessThanOrEqual(T74_ROTATION * envelope + 1e-9);
        if (u >= T74_SHAKE) expect(pose).toEqual({ dx: 0, dy: 0, rotation: 0 });
      }
    }
    // Still 1.0–1.6 s: identical frames.
    expect(frameText(1.05, PORTRAIT)).toBe(frameText(1.55, PORTRAIT));
    // The jitter stays well under 2% of the frame.
    expect(T74_OFFSET * plan.glyphHeight).toBeLessThan(0.02 * 1080);
  });

  it("the word fills 80–90% of the safe width and every pose stays inside the safe box", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { lines: ["抖"] }, { lines: ["瑟瑟", "發抖"] }]) {
        const plan = jitterPlan(params(input), size), safe = titleSafeBox(size), short = Math.min(size.width, size.height);
        expect(plan.glyphHeight, JSON.stringify(input)).toBeGreaterThanOrEqual(0.09 * short);
        if (input === undefined) {
          const fill = (plan.box.x1 - plan.box.x0) / safe.width;
          expect(fill).toBeGreaterThanOrEqual(0.8);
          expect(fill).toBeLessThanOrEqual(0.9);
        }
        for (let step = 0; step < 15; step += 1) {
          const u = step / 15;
          for (const glyph of plan.glyphs) {
            const pose = jitterPose(plan, 1, glyph.index, u), radians = (pose.rotation * Math.PI) / 180;
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

  it("colours: ink and the deep gold on the gold card (cream is 1.4:1 there); cream and gold on the dark card", () => {
    const palette = item.defaultParams.palette;
    expect(item.showcasePlate).toBe("accent");
    expect(jitterPlan(params({ plate: "accent" }), PORTRAIT).glyphs.map(glyph => glyph.color)).toEqual([palette.ink, palette.accent2, palette.ink, palette.accent2]);
    expect(jitterPlan(params(), PORTRAIT).glyphs.map(glyph => glyph.color)).toEqual([palette.paper, palette.accent, palette.paper, palette.accent]);
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
