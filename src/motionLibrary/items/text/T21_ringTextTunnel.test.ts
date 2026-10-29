import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { textFace } from "../shared";
import {
  RING_MIN_GAP, T21_EM_RATIO, T21_EM_RATIO_MAX, T21_LOOP_SECONDS, T21_RING_COUNT, T21_RING_RATIO, fitRing, ringGapEm, ringTunnelPlan, textRingPathD,
} from "./T21_ringTextTunnel";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T21";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.3, 0.75, 1.2, 1.7] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "00aed8a6e0806746697f427c28657e9edfd8e1267cd9357a5a83379204e0abb2",
    "9274afff0731a17ac4b09d57eeca9189a11bba972baec918b765bbddf2841d98",
    "620b3fc1bfbe3116c9686ae5fec2eafccea07f91382aee12a2fa0781a200d088",
    "c0f358166b9fd31bb8afa20c27adaea6d406c429b086fd3f817e7cdad666b2ff",
    "ad8ff2e8fb507fce0790a75ee2cf25c92b760fde685bdb742613f4b1e4f4bf86",
  ],
  landscape: [
    "354bad1b53a9addfb2040004cddd14527834f340fc723a80ecdc980868c6880b",
    "ba7e284bfcfb52d04402676d22c1b88681a048de29f8ea6d2368892cb51d5a0f",
    "f41fc9d812ba6ef8e33de70ec677928d9a8bb1aec434e3adea1a8ba61e83d47d",
    "0a37c2d20578bba65958b85a597f62cd8a544d8002e90ed6c72a6fd47d4e0723",
    "d0c4855159bd89848bcbf401b85b4e02b2cac67214cd2eb533faf05b418add01",
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
/** The plate is painted first: right after the header and the (optional) <defs>. */
function paintsFirst(svg: string, size: MotionFrameSize, fill: string): boolean {
  const at = svg.indexOf(plateRect(size, fill));
  if (at < 0) return false;
  const prefix = svg.slice(0, at);
  return prefix === header(size) || (prefix.startsWith(`${header(size)}<defs>`) && prefix.endsWith("</defs>"));
}
const maskColors = (svg: string) => svg.replace(/#[0-9A-F]{6}/g, "#");
const colours = (svg: string) => new Set(svg.match(/#[0-9A-F]{6}/g) ?? []);
const PALETTE_A = { bg: "#101820", ink: "#0A0A0A", paper: "#FAFAF0", accent: "#E0A030", accent2: "#704010" };
const PALETTE_B = { bg: "#203040", ink: "#000814", paper: "#F0F8FF", accent: "#30C0E0", accent2: "#105070" };

describe("T21 Ring Text Tunnel", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: the frame at loopSeconds equals frame 0 (every format, energy and plate)", () => {
    expect(item.loopSeconds).toBe(T21_LOOP_SECONDS);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { energy: "calm" }, { plate: item.showcasePlate }, { lines: ["光", "之環"] }]) {
        const start = frameText(0, size, input);
        expect(frameText(T21_LOOP_SECONDS, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2 * T21_LOOP_SECONDS, size, input)).toBe(start);
        expect(frameText(T21_LOOP_SECONDS * 0.37, size, input)).not.toBe(start);
      }
    }
    // The renderer samples t = i / fps: frames 60 and 120 at 30 fps are frame 0 again.
    expect(frameText(60 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
    expect(frameText(120 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.5, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * T21_LOOP_SECONDS, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.75, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.75, PORTRAIT)).toBe(first);
  });

  it("flies six rings outward: radius grows exponentially with depth, neighbours a constant ratio apart, respawning at the centre", () => {
    expect([T21_RING_COUNT, T21_RING_RATIO]).toEqual([6, 1.72]);
    for (const size of [PORTRAIT, LANDSCAPE]) {
      const halfDiagonal = Math.hypot(size.width / 2, size.height / 2);
      for (const t of [0, 0.13, 0.5, 1.21, 1.99]) {
        const plan = ringTunnelPlan(params(), size, t);
        expect(plan.rings).toHaveLength(6);
        // Paint order far → near, and every ring is minRadius · G^s.
        for (let index = 1; index < plan.rings.length; index += 1) expect(plan.rings[index].s).toBeGreaterThan(plan.rings[index - 1].s);
        for (const ring of plan.rings) {
          expect(ring.radius).toBeCloseTo(plan.minRadius * (plan.maxRadius / plan.minRadius) ** ring.s, 6);
          expect(ring.size / ring.radius).toBeGreaterThanOrEqual(0.8 * T21_EM_RATIO);
          expect(ring.size / ring.radius).toBeLessThanOrEqual(T21_EM_RATIO_MAX);
        }
        for (let index = 1; index < plan.rings.length; index += 1) {
          expect(plan.rings[index].radius / plan.rings[index - 1].radius).toBeCloseTo(T21_RING_RATIO, 6);
        }
        // A ring respawns (s → 0) only once its whole glyph band is past the frame corners.
        expect(plan.maxRadius * (1 - 0.5 * T21_EM_RATIO_MAX)).toBeGreaterThan(halfDiagonal);
        // The newest ring is fogged in from the vanishing point.
        expect(plan.rings[0].opacity).toBeLessThan(1);
        expect(plan.rings[plan.rings.length - 1].opacity).toBe(1);
      }
    }
    // Rings alternate colour (cream / aqua on the dark card) and spin direction.
    const plan = ringTunnelPlan(params(), PORTRAIT, 0);
    const palette = item.defaultParams.palette;
    const byIndex = [...plan.rings].sort((a, b) => a.index - b.index);
    expect(byIndex.map(ring => ring.color)).toEqual([palette.paper, palette.accent, palette.paper, palette.accent, palette.paper, palette.accent]);
    const later = ringTunnelPlan(params(), PORTRAIT, 0.2).rings.slice().sort((a, b) => a.index - b.index);
    for (const ring of byIndex) {
      const next = later.find(other => other.index === ring.index)!;
      if (next.s > ring.s) expect(Math.sign(next.rotation - ring.rotation)).toBe(ring.index % 2 === 0 ? 1 : -1);
    }
  });

  it("bleeds by design, but always shows big readable rings: at least two rings with em ≥ 9% of the short side cross the safe area", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      const short = Math.min(size.width, size.height), safeHalf = 0.45 * Math.min(size.width, size.height);
      for (let step = 0; step < 40; step += 1) {
        const plan = ringTunnelPlan(params(), size, (step / 40) * T21_LOOP_SECONDS);
        const big = plan.rings.filter(ring => ring.size >= 0.09 * short && ring.radius - 0.5 * ring.size < Math.hypot(safeHalf, safeHalf) && ring.opacity === 1);
        expect(big.length, `${size.width}x${size.height} step ${step}`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("closes every ring with whole repeats and no seam, widening the gap only where the curvature needs it", () => {
    const face = textFace("display", 900);
    const fit = fitRing("光之環・", face, 400, T21_EM_RATIO * 400, T21_EM_RATIO_MAX * 400);
    const ring = textRingPathD({ text: "光之環・", face, size: fit.size, radius: 400, minGap: fit.minGap });
    // The leftover arc spread between glyphs is tiny: the ring closes on the minimum gap.
    expect(ring.layout.gap / fit.size - fit.minGap).toBeLessThan(0.02);
    expect(ring.layout.gap / fit.size).toBeGreaterThanOrEqual(fit.minGap - 1e-9);
    expect(ring.layout.unit).toBe("光之環・");
    expect(ring.layout.glyphs.length % 4).toBe(0);
    // Tight rings get more centre-line space; wide rings use the minimum.
    expect(ringGapEm(10_000, 100)).toBe(RING_MIN_GAP);
    expect(ringGapEm(180, 105)).toBeGreaterThan(0.25);
    // fitRing never exceeds the max size.
    for (const radius of [50, 120, 400, 1300]) expect(fitRing("旋轉", face, radius, 0.3 * radius, 0.36 * radius).size).toBeLessThanOrEqual(0.36 * radius);
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
        expect(none.includes(plateRect(size, palette.bg))).toBe(false);
        expect(frameText(t, size, { plate: "none" })).toBe(none);
        const onBg = frameText(t, size, { plate: "bg" });
        expect(paintsFirst(onBg, size, palette.bg)).toBe(true);
        expect(onBg.replace(plateRect(size, palette.bg), "")).toBe(none);
        const onAccent = frameText(t, size, { plate: "accent" });
        expect(paintsFirst(onAccent, size, palette.accent)).toBe(true);
        expect(maskColors(onAccent.replace(plateRect(size, palette.accent), ""))).toBe(maskColors(none));
      }
    }
  });
});
