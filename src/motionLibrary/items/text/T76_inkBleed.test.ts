import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { GOO_ALPHA_MATRIX } from "../../svg/document";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { crispShare, inkBleedPlan, inkState, T76_CRISP, T76_SIGMA } from "./T76_inkBleed";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T76";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: ink pools, sharpening, the crisp hold, bleeding, fading out. */
const TIMES = [0.1, 0.4, 1.0, 1.9, 2.3] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "740ea01935fdfc98dd0f468211e7448ea90631501e52b30b80ec1e288754cfc6",
    "698ad128839891b3c60c0542fe8d02d6c79480f78a19df75417d4994d8ba4a3a",
    "698ad128839891b3c60c0542fe8d02d6c79480f78a19df75417d4994d8ba4a3a",
    "5e2d169bed531465eda504369a6c5a68c22716d3b95275a64a1b17bc587eace4",
    "33cd198d460652e2dce6c36c85776b99a5ab8af6155d28cf37b682971fa10ac9",
  ],
  landscape: [
    "bd4f400e2529d585d0a738c5b9dfbbd8a52befaf746e2a566bea81961d9dd26e",
    "d7225541c2a6aa16ec14825b3f3caa1bb659f4dd993df31ec00966aeb18f0698",
    "d7225541c2a6aa16ec14825b3f3caa1bb659f4dd993df31ec00966aeb18f0698",
    "805de861135ab802d30c243f21c7ccf287229c317f7a01339a61f379b4fcf819",
    "ed91a621fdf9b8b07fcf446245c03ebb532aeccbd416e9d35aa3a126a407e3d2",
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
/** The drawn content after the root tag and the <defs> (the goo filter): a plate must come first in it. */
const body = (svg: string) => svg.replace(/^<svg[^>]*>(<defs>.*?<\/defs>)?/, "");
const PALETTE_A = { bg: "#101820", ink: "#0A0A0A", paper: "#FAFAF0", accent: "#E0A030", accent2: "#704010" };
const PALETTE_B = { bg: "#203040", ink: "#000814", paper: "#F0F8FF", accent: "#30C0E0", accent2: "#105070" };

describe("T76 Ink Bleed", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.3, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * 2.4, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.4, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.4, PORTRAIT)).toBe(first);
  });

  it("σ falls from 9% of the glyph height to 0 by 0.6 s, holds crisp, rises back 1.6–2.2 s and fades out by 2.4 s", () => {
    expect(T76_SIGMA).toBe(0.09);
    const plan = inkBleedPlan(params(), PORTRAIT), peak = 0.09 * plan.glyphHeight;
    expect([plan.formEnd, plan.fadeInEnd, plan.bleedStart, plan.bleedEnd, plan.end].map(value => Number(value.toFixed(9)))).toEqual([0.6, 0.15, 1.6, 2.2, 2.4]);
    expect(inkState(plan, 0).sigma).toBeCloseTo(peak, 9);
    expect(inkState(plan, 0).opacity).toBe(0);
    expect(inkState(plan, 0.15).opacity).toBeCloseTo(1, 9);
    expect(inkState(plan, 0.3).sigma).toBeLessThan(inkState(plan, 0.1).sigma);
    for (const t of [0.6, 1.0, 1.59]) expect(inkState(plan, t)).toEqual({ sigma: 0, opacity: 1, pool: 0 });
    expect(inkState(plan, 1.9).sigma).toBeGreaterThan(inkState(plan, 1.7).sigma);
    expect(inkState(plan, 2.2).sigma).toBeCloseTo(peak, 9);
    expect(inkState(plan, 2.4).opacity).toBeCloseTo(0, 9);
    // The crisp hold has no filter at all; the bleed uses the goo filter (blur, then alpha × 18 − 7).
    expect(frameText(1.0, PORTRAIT)).not.toContain("filter");
    const bleed = frameText(1.9, PORTRAIT);
    expect(bleed).toContain("<feGaussianBlur");
    expect(bleed).toContain(`values="${GOO_ALPHA_MATRIX.join(" ")}"`);
    expect(Number(/^<svg[^>]*>(?:<defs>.*?<\/defs>)?<g opacity="([\d.]+)"/.exec(frameText(2.39, PORTRAIT))![1])).toBeLessThan(0.2);
  });

  it("below σ ≈ 2% of the glyph height the crisp word takes over, so no aliased threshold edge shows", () => {
    expect(T76_CRISP).toEqual([0.012, 0.022]);
    const plan = inkBleedPlan(params(), PORTRAIT), h = plan.glyphHeight;
    expect(crispShare(plan, 0.005 * h)).toBe(1);
    expect(crispShare(plan, 0.03 * h)).toBe(0);
    expect(crispShare(plan, 0.017 * h)).toBeCloseTo(0.5, 6);
  });

  it("the word and every droplet stay inside the safe box; the word is at least 9% of the short side", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { lines: ["墨"] }, { lines: ["墨跡", "暈開"] }, { seed: 5 }]) {
        const plan = inkBleedPlan(params(input), size), safe = titleSafeBox(size), short = Math.min(size.width, size.height);
        expect(plan.glyphHeight, JSON.stringify(input)).toBeGreaterThanOrEqual(0.09 * short);
        expect(plan.reach.x0).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
        expect(plan.reach.x1).toBeLessThanOrEqual(safe.x1 + 1e-6);
        expect(plan.reach.y0).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
        expect(plan.reach.y1).toBeLessThanOrEqual(safe.y1 + 1e-6);
      }
    }
  });

  it("raster stays in budget: the filter region hugs the word and droplets (± 3σ)", () => {
    const plan = inkBleedPlan(params(), PORTRAIT), svg = frameText(2.2, PORTRAIT);
    const match = /<filter[^>]*x="([\d.-]+)" y="([\d.-]+)" width="([\d.]+)" height="([\d.]+)"/.exec(svg)!;
    const [x, y, width, height] = match.slice(1).map(Number), pad = 3 * 0.09 * plan.glyphHeight;
    expect(x).toBeCloseTo(plan.reach.x0 - pad, 0);
    expect(y).toBeCloseTo(plan.reach.y0 - pad, 0);
    expect(width * height).toBeLessThan(0.5 * 1080 * 1920);
  });

  it("one flat colour, as the goo needs: cream on the dark card, ink on cream or gold", () => {
    const palette = item.defaultParams.palette;
    expect(item.showcasePlate).toBe("bg");
    expect(inkBleedPlan(params(), PORTRAIT).color).toBe(palette.paper);
    expect(inkBleedPlan(params({ plate: "paper" }), PORTRAIT).color).toBe(palette.ink);
    expect(inkBleedPlan(params({ plate: "accent" }), PORTRAIT).color).toBe(palette.ink);
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
        expect(none.startsWith(header(size))).toBe(true);
        expect(body(none).startsWith(plateRect(size, palette.bg))).toBe(false);
        expect(frameText(t, size, { plate: "none" })).toBe(none);
        const onBg = frameText(t, size, { plate: "bg" });
        expect(body(onBg).startsWith(plateRect(size, palette.bg))).toBe(true);
        expect(onBg.replace(plateRect(size, palette.bg), "")).toBe(none);
        for (const plate of ["accent", "paper"] as const) {
          const onPlate = frameText(t, size, { plate });
          expect(body(onPlate).startsWith(plateRect(size, palette[plate]))).toBe(true);
          expect(maskColors(onPlate.replace(plateRect(size, palette[plate]), ""))).toBe(maskColors(none));
        }
      }
    }
  });
});
