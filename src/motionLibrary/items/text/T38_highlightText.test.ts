import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { tint } from "../../svg/color";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { boxOpening, highlightPlan, markerProgress, T38_TINT } from "./T38_highlightText";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T38";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: unfolding, marker mid-swipe, marker done, hold, folding away. */
const TIMES = [0.1, 0.5, 0.7, 1.5, 2.35] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "d8631053f8fea35e9c1dc378a0a3a40a5a1f80492966b2a04d99206124ce7c7b",
    "62137a1b03a584a1ae1b5d52e920c62cb5b32136c26c01d126c81ddc2930a55b",
    "91bc3ba624248263d0369ec3070952b77e18fb6ea14fe08ffb66bd7e26255ee4",
    "444b4c6df979269baaf75e66df02e6a0c23d3ffde37335e99524ae5640a87f8c",
    "20ba7569ab3e92a90d940985278ec5cfdabf9fea223dabda2db937a1f0e4822c",
  ],
  landscape: [
    "a62cf1269fe7e441219d509b9df9ed1bf78a438a982491a966fa4533a0d609e8",
    "5c9147ee63a832d167cdb47a8e24721a53169355411f3c9944f4fc59eee9aa65",
    "4372901b73bcd9f35af718944a80da35ce8ebfd9471f16ed5ab79d82d49fa266",
    "8355babc78bf60424b152a5c517dbcbe5d37ad36792b4740cf2120e47c0ea041",
    "d9a2ff496bc16da52633b355ad87a9ef15f4ffb1756f9ee0a2696b36e4b8b0ac",
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

describe("T38 Highlight Text", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(1, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * 2.5, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.5, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.5, PORTRAIT)).toBe(first);
  });

  it("mincho type in a cream box; a rounded marker band in a tint of the accent wipes left to right behind it in 0.4 s", () => {
    expect(item.defaultParams.font).toBe("serif");
    const plan = highlightPlan(params(), PORTRAIT);
    expect(markerProgress(plan, 0, 0.38)).toBe(0);
    expect(markerProgress(plan, 0, 0.5)).toBeGreaterThan(0.5); // quartOut: fast attack
    expect(markerProgress(plan, 0, 0.78)).toBe(1);
    const palette = item.defaultParams.palette;
    const band = tint(palette.accent, T38_TINT, palette.paper);
    const done = frameText(1.5, PORTRAIT);
    // Box, then the band behind the type, then the type: draw order matters.
    const boxAt = done.indexOf(`fill="${palette.paper}"`), bandAt = done.indexOf(`fill="${band}"`), textAt = done.indexOf(`fill="${palette.ink}"`);
    expect(boxAt).toBeGreaterThan(-1);
    expect(bandAt).toBeGreaterThan(boxAt);
    expect(textAt).toBeGreaterThan(bandAt);
    // Rounded ends: rx = ry = half the band height.
    const match = new RegExp(`<rect x="[\\d.]+" y="[\\d.]+" width="([\\d.]+)" height="([\\d.]+)" rx="([\\d.]+)" ry="([\\d.]+)" fill="${band}"/>`).exec(done)!;
    expect(Number(match[3])).toBeCloseTo(Number(match[2]) / 2, 2);
    // The band grows: mid-swipe it is shorter than at rest.
    const mid = new RegExp(`width="([\\d.]+)" height="[\\d.]+" rx="[\\d.]+" ry="[\\d.]+" fill="${band}"`).exec(frameText(0.45, PORTRAIT))!;
    expect(Number(mid[1])).toBeLessThan(Number(match[1]));
    expect(frameText(0.3, PORTRAIT)).not.toContain(`fill="${band}"`);
    // In / out: the box unfolds from its middle line and folds back; the clip is empty at both ends.
    expect(boxOpening(plan, 0, 2.5)).toBe(0);
    expect(boxOpening(plan, 1, 2.5)).toBe(1);
    expect(frameText(0, PORTRAIT)).not.toContain("<path");
    expect(frameText(2.4999, PORTRAIT)).not.toContain("<path");
  });

  it("the text fills 84% of the safe width at least 9% tall, and the whole box stays inside the 5% title-safe box", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { lines: ["力量"] }, { lines: ["文字的力量", "改變世界"] }, { energy: "hype" }]) {
        const plan = highlightPlan(params(input), size), safe = titleSafeBox(size);
        expect(plan.card.x0).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
        expect(plan.card.x1).toBeLessThanOrEqual(safe.x1 + 1e-6);
        expect(plan.card.y0).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
        expect(plan.card.y1).toBeLessThanOrEqual(safe.y1 + 1e-6);
        for (const line of plan.lines) expect(line.glyphHeight).toBeGreaterThanOrEqual(0.09 * Math.min(size.width, size.height));
        if (input === undefined) expect((plan.ink.x1 - plan.ink.x0) / safe.width).toBeCloseTo(0.84, 2);
      }
    }
    // Several lines swipe one after another.
    const two = highlightPlan(params({ lines: ["文字的力量", "改變世界"] }), PORTRAIT);
    expect(markerProgress(two, 1, 0.45)).toBeLessThan(markerProgress(two, 0, 0.45));
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
        expect(none.includes(plateRect(size, palette.bg))).toBe(false);
        expect(frameText(t, size, { plate: "none" })).toBe(none);
        expect(frameText(t, size, { plate: "bg" }).replace(plateRect(size, palette.bg), "")).toBe(none);
        // The box is the text's own backdrop: on the accent plate only the plate is new.
        expect(frameText(t, size, { plate: "accent" }).replace(plateRect(size, palette.accent), "")).toBe(none);
        expect(maskColors(frameText(t, size, { plate: "paper" }).replace(plateRect(size, palette.paper), ""))).toBe(maskColors(none));
      }
    }
  });
});
