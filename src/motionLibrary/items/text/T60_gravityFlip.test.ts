import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import {
  gravityFlipPlan, gravityPose, landingBounce, T60_DIP, T60_GONE, T60_LANDED, T60_LIFT, T60_RETURN, T60_SETTLE, T60_STAGGER, T60_TILT,
} from "./T60_gravityFlip";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T60";
const LOOP = 2.2;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: rest, falling up, leaving, dropping back, the landing bounce. */
const TIMES = [0.2, 0.62, 0.9, 1.5, 1.85] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "e63e50d86e83d7abf7ac1dfb011161066aa75b97d4f452d89fcd04da170100b7",
    "d7decd57b5abbf1a216d33c975abc6243be2e106d31c2f5eaddf67ae08a84ea5",
    "c92e50b2011b629d54149d3958cd5881eaf0e288fde883abc6f60652826d9cf2",
    "54059b12935a82f66bedd6a9190052d0452166625ef4f55998b9fe1ee750997a",
    "f296063ce14b102b93c1ac307b8dbdf9e87308eafa6442a5b1e6f11be4028bdf",
  ],
  landscape: [
    "4b3c6237a19e54b94cc76e0246d0954eee9c3618a1a4ee29f62fa1d43a113eb0",
    "2446212ddcf362ca5b411ced0dd28b57366e8f5f348f3813e985c3f81e33f493",
    "81aa2db1b8ac3b33c999a10053d3e11d3e5f05fafc4abfb569d4c94008eb6ac3",
    "79e53e7f531297dbb377159ed52fe3db5d8a299fe1e2bac56642980493f1a644",
    "8c090c5ec39b3b8dfd65cc2d5b3d11a2548b4c49cacf4ae4db47cd6a795574d9",
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
const paths = (svg: string) => (svg.match(/<path /g) ?? []).length;
const PALETTE_A = { bg: "#101820", ink: "#0A0A0A", paper: "#FAFAF0", accent: "#E0A030", accent2: "#704010" };
const PALETTE_B = { bg: "#203040", ink: "#000814", paper: "#F0F8FF", accent: "#30C0E0", accent2: "#105070" };

describe("T60 Gravity Flip", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: the frame at loopSeconds equals frame 0 (every format, energy and plate)", () => {
    expect(item.loopSeconds).toBe(LOOP);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { energy: "calm" }, { plate: item.showcasePlate }, { lines: ["重力反轉重力反轉重力"] }]) {
        const start = frameText(0, size, input);
        expect(frameText(LOOP, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2 * LOOP, size, input)).toBe(start);
        expect(frameText(LOOP * 0.37, size, input)).not.toBe(start);
        // Every character is back at rest before the seam (the last landing settles by 2.18 s).
        expect(frameText(LOOP - 0.01, size, input)).toBe(start);
      }
    }
    expect(frameText(66 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.7, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * LOOP, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.62, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.62, PORTRAIT)).toBe(first);
  });

  it("rest 0–0.5 s, falls up one by one (0.07 s apart, accelerating, tilting 10–20°) and is gone by 1.0 s; empty until 1.2 s", () => {
    const plan = gravityFlipPlan(params(), PORTRAIT);
    expect(plan.stagger).toBe(T60_STAGGER);
    for (const glyph of plan.glyphs) {
      expect(gravityPose(plan, glyph, 0.3)).toMatchObject({ dy: 0, rotation: 0, visible: true });
      expect(Math.abs(glyph.tiltOut)).toBeGreaterThanOrEqual(T60_TILT[0]);
      expect(Math.abs(glyph.tiltOut)).toBeLessThanOrEqual(T60_TILT[1]);
      const lift = T60_LIFT + glyph.index * plan.stagger;
      // Constant upward acceleration: the rise over the second half is three times the first (quadIn).
      const first = -gravityPose(plan, glyph, lift + plan.fallOut / 2).dy;
      const full = -gravityPose(plan, glyph, lift + plan.fallOut - 1e-6).dy;
      expect(full - first).toBeCloseTo(3 * first, 0);
      // Leaving: the glyph's turned extent is clear of the top edge at the end of its fall.
      expect(glyph.cy - full).toBeLessThan(-Math.hypot(glyph.box.x1 - glyph.box.x0, glyph.box.y1 - glyph.box.y0) / 2 + 1);
    }
    // The last character starts after the others, 0.07 s apart, and all are gone at 1.0 s.
    const last = plan.glyphs[plan.glyphs.length - 1];
    expect(T60_LIFT + last.index * plan.stagger + plan.fallOut).toBeCloseTo(T60_GONE, 9);
    for (const t of [1.0, 1.1, 1.19]) expect(paths(frameText(t, PORTRAIT)), `t=${t}`).toBe(0);
  });

  it("drops back from 1.2 s, rights its tilt, lands by 1.8 s and bounces (8% dip) before settling exactly", () => {
    const plan = gravityFlipPlan(params(), PORTRAIT);
    expect(plan.dip).toBeCloseTo(T60_DIP * plan.glyphHeight, 9);
    for (const glyph of plan.glyphs) {
      const contact = T60_RETURN + glyph.index * plan.stagger + plan.fallIn;
      expect(contact).toBeLessThanOrEqual(T60_LANDED + 1e-9);
      // Falling: the tilt shrinks to zero by the landing.
      const mid = gravityPose(plan, glyph, contact - plan.fallIn * 0.3);
      expect(Math.abs(mid.rotation)).toBeGreaterThan(0);
      expect(Math.abs(mid.rotation)).toBeLessThan(Math.abs(glyph.tiltIn));
      // The first dip goes 8% of the glyph height below the rest line.
      const dips = Array.from({ length: 200 }, (_, step) => gravityPose(plan, glyph, contact + (step / 200) * T60_SETTLE).dy);
      expect(Math.max(...dips)).toBeCloseTo(plan.dip, 1);
      expect(Math.min(...dips)).toBeLessThan(0);
      expect(gravityPose(plan, glyph, contact + T60_SETTLE)).toMatchObject({ dy: 0, rotation: 0, scaleX: 1, scaleY: 1 });
    }
    expect(landingBounce(0)).toBe(0);
    expect(landingBounce(T60_SETTLE)).toBe(0);
  });

  it("the word fills 80–90% of the safe width at rest and stays inside the safe box through the landing", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { lines: ["重"] }, { lines: ["重力", "反轉"] }, { lines: ["重力反轉重力反"] }]) {
        const plan = gravityFlipPlan(params(input), size), safe = titleSafeBox(size), short = Math.min(size.width, size.height);
        expect(plan.glyphHeight, JSON.stringify(input)).toBeGreaterThanOrEqual(0.09 * short);
        if (input === undefined) {
          const fill = (plan.box.x1 - plan.box.x0) / safe.width;
          expect(fill).toBeGreaterThanOrEqual(0.8);
          expect(fill).toBeLessThanOrEqual(0.9);
        }
        for (const glyph of plan.glyphs) {
          const contact = T60_RETURN + glyph.index * plan.stagger + plan.fallIn;
          for (let step = 0; step <= 40; step += 1) {
            const pose = gravityPose(plan, glyph, contact + (step / 40) * T60_SETTLE);
            const footX = glyph.cx, footY = glyph.box.y1;
            const xs = [glyph.box.x0, glyph.box.x1].map(x => footX + (x - footX) * pose.scaleX);
            const ys = [glyph.box.y0, glyph.box.y1].map(y => footY + pose.dy + (y - footY) * pose.scaleY);
            for (const x of xs) {
              expect(x, `${size.width}x${size.height} ${JSON.stringify(input)}`).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
              expect(x).toBeLessThanOrEqual(safe.x1 + 1e-6);
            }
            for (const y of ys) {
              expect(y).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
              expect(y).toBeLessThanOrEqual(safe.y1 + 1e-6);
            }
          }
        }
      }
    }
  });

  it("colours alternate cream and violet on the dark card; ink and the deep shade on the violet card", () => {
    const palette = item.defaultParams.palette;
    expect(item.showcasePlate).toBe("bg");
    expect(gravityFlipPlan(params(), PORTRAIT).glyphs.map(glyph => glyph.color)).toEqual([palette.paper, palette.accent, palette.paper, palette.accent]);
    expect(gravityFlipPlan(params({ plate: "accent" }), PORTRAIT).glyphs.map(glyph => glyph.color)).toEqual([palette.ink, palette.accent2, palette.ink, palette.accent2]);
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
