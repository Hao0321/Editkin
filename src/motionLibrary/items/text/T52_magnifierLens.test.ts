import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { lensCenter, magnifierPlan, magnifierTransform, T52_DIM_OPACITY, T52_LOOP_SECONDS, T52_MAGNIFICATION } from "./T52_magnifierLens";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T52";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.3, 0.9, 1.5, 2.1] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "224980dd638cec5d6a6577e62fdc22b209b93ecbc6f863eec945d1c9be44e0a1",
    "751a2e8281e0e68d3a06fd8965ad2cd4c13a87f1e811a7fd528056e75d4e3c66",
    "86abedf0e18145224a4e360981b8ff4555b95e5004ca99ce0568109f9fdbd654",
    "eaf3b9d3cb0d9d0a7c61a78399623c06ea1f48ae6c908e0c8735f11ee40eca26",
    "1da25919c4402f48fc67d43e6ddca885c0389e15f0c40e2bd2ab69c4c07daca5",
  ],
  landscape: [
    "423f7de7d82a545a86b95a56f326bbfa27a2a995ce15e95c9dadd013d0138e1c",
    "0d1753b1531f9fd8de9826191c68a793a8cbc3832e3af42da6a677b2855051e5",
    "9f584261d2a86064ffd71755e6c116085f847c2ce390f961c1e5e2951803e4e8",
    "a475d1407d8c02ef71840a2d398eb5b64017b27e8229a1d3c61e0efc2c0776bf",
    "eff463082f4469ff4b3346626c2a7e93673959808b3ab6b1840d035c6660128c",
  ],
};

const item = getMotionLibraryItem(ID) as TextMotionItem;
const params = (input?: unknown): TextMotionParams => resolveMotionLibraryParams(item, input);
function frameText(t: number, size: MotionFrameSize, input?: unknown): string {
  const frame = generateAnyMotionFrame(item, params(input), t, size);
  return "svg" in frame ? frame.svg : frame.matte;
}
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const plateRect = (size: MotionFrameSize, fill: string) => `<rect x="0" y="0" width="${size.width}" height="${size.height}" fill="${fill}"/>`;
const maskColors = (svg: string) => svg.replace(/#[0-9A-F]{6}/g, "#");
const colours = (svg: string) => new Set(svg.match(/#[0-9A-F]{6}/g) ?? []);
const PALETTE_A = { bg: "#101820", ink: "#0A0A0A", paper: "#FAFAF0", accent: "#E0A030", accent2: "#704010" };
const PALETTE_B = { bg: "#203040", ink: "#000814", paper: "#F0F8FF", accent: "#30C0E0", accent2: "#105070" };

/** Apply "translate(a b) scale(s) translate(c d)" to a point. */
function applyTransform(text: string, x: number, y: number): [number, number] {
  const match = /translate\(([-\d.]+) ([-\d.]+)\) scale\(([\d.]+)\) translate\(([-\d.]+) ([-\d.]+)\)/.exec(text)!;
  const [a, b, s, c, d] = match.slice(1).map(Number);
  return [a + s * (x + c), b + s * (y + d)];
}

describe("T52 Magnifier Lens", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: the lens glides left → right → left once per 2.4 s loop", () => {
    expect(item.loopSeconds).toBe(T52_LOOP_SECONDS);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { energy: "calm" }, { plate: "accent" }]) {
        const start = frameText(0, size, input);
        expect(frameText(T52_LOOP_SECONDS, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2 * T52_LOOP_SECONDS, size, input)).toBe(start);
        expect(frameText(T52_LOOP_SECONDS * 0.37, size, input)).not.toBe(start);
      }
    }
    expect(frameText(72 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
    const plan = magnifierPlan(params(), PORTRAIT);
    expect(lensCenter(plan, 0)[0]).toBeCloseTo(plan.fromX, 6);
    expect(lensCenter(plan, 0.5)[0]).toBeCloseTo(plan.toX, 6);
    expect(lensCenter(plan, 0.25)[0]).toBeCloseTo((plan.fromX + plan.toX) / 2, 6);
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.5, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * T52_LOOP_SECONDS, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.9, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.9, PORTRAIT)).toBe(first);
  });

  it("a true magnifier: 1.7× about the lens centre, clipped to the lens circle, so the point under the centre stays put", () => {
    expect(T52_MAGNIFICATION).toBe(1.7);
    const plan = magnifierPlan(params(), PORTRAIT);
    expect(plan.radius).toBeCloseTo(0.65 * plan.glyphHeight, 6);
    for (const t of [0, 0.4, 0.9, 1.7]) {
      const svg = frameText(t, PORTRAIT);
      const [cx, cy] = lensCenter(plan, t / T52_LOOP_SECONDS);
      const zoom = /<g clip-path="url\(#[^)]+\)"><path d="[^"]+" fill="#[0-9A-F]{6}" transform="([^"]+)"\/><\/g>/.exec(svg)![1];
      const [fx, fy] = applyTransform(zoom, cx, cy);
      expect(fx).toBeCloseTo(cx, 1);
      expect(fy).toBeCloseTo(cy, 1);
      // A point one radius away lands 1.7 radii away.
      const [ex] = applyTransform(zoom, cx + plan.radius, cy);
      expect(ex - cx).toBeCloseTo(1.7 * plan.radius, 0);
      expect(magnifierTransform(cx, cy)).toContain("scale(1.7)");
      // The lens clip is the circle of the lens's inner radius; the dimmed line is clipped to the frame minus that circle.
      expect(svg).toMatch(new RegExp(`<clipPath [^>]+><circle cx="[\\d.]+" cy="[\\d.]+" r="${Number(plan.radius.toFixed(3))}"/></clipPath>`));
      expect(svg).toMatch(/<clipPath [^>]+><path d="M[^"]+" clip-rule="evenodd"\/><\/clipPath>/);
    }
    const palette = item.defaultParams.palette;
    const svg = frameText(0.9, PORTRAIT);
    expect(svg).toContain(`fill="${palette.paper}" fill-opacity="${T52_DIM_OPACITY}"`);
    expect(svg).toContain(`fill="${palette.accent}" transform=`);
    expect(svg).toContain(`stroke="${palette.paper}"`);
  });

  it("the line fills 80–90% of the safe width inside the title-safe box, at least 9% of the short side tall", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { lines: ["細節"] }]) {
        const plan = magnifierPlan(params(input), size), safe = titleSafeBox(size);
        expect(plan.box.x0).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
        expect(plan.box.x1).toBeLessThanOrEqual(safe.x1 + 1e-6);
        expect(plan.box.y0).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
        expect(plan.box.y1).toBeLessThanOrEqual(safe.y1 + 1e-6);
        expect(plan.glyphHeight).toBeGreaterThanOrEqual(0.09 * Math.min(size.width, size.height));
        if (input === undefined) {
          const fill = (plan.box.x1 - plan.box.x0) / safe.width;
          expect(fill).toBeGreaterThanOrEqual(0.8);
          expect(fill).toBeLessThanOrEqual(0.9);
        }
        // The glass (ring and handle) never leaves the frame for the default line (a one- or two-character word grows a
        // lens big enough for its handle to run off the frame, like a hand holding it from outside).
        if (input !== undefined) continue;
        for (let step = 0; step < 48; step += 1) {
          const [cx, cy] = lensCenter(plan, step / 48), reach = plan.radius + plan.ring;
          const handleEnd = (plan.radius + plan.ring / 2 + 0.95 * plan.radius + 0.13 * plan.radius) * Math.SQRT1_2;
          expect(cx - reach).toBeGreaterThanOrEqual(0);
          expect(cy - reach).toBeGreaterThanOrEqual(0);
          expect(cx + Math.max(reach, handleEnd)).toBeLessThanOrEqual(size.width);
          expect(cy + Math.max(reach, handleEnd)).toBeLessThanOrEqual(size.height);
        }
      }
    }
  });

  it("colours follow ART_DIRECTION §0: accent2 magnified text and ink glass on the accent card", () => {
    const palette = item.defaultParams.palette;
    const onAccent = frameText(0.9, PORTRAIT, { plate: "accent" });
    expect(onAccent).toContain(`fill="${palette.accent2}" transform=`);
    expect(onAccent).toContain(`stroke="${palette.ink}"`);
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
        expect(frameText(t, size, { plate: "bg" }).replace(plateRect(size, palette.bg), "")).toBe(none);
        const onAccent = frameText(t, size, { plate: "accent" });
        expect(maskColors(onAccent.replace(plateRect(size, palette.accent), ""))).toBe(maskColors(none));
      }
    }
  });
});
