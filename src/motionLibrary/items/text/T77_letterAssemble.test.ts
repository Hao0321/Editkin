import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { assemblePlan, assemblePose, T77_DISTANCE, T77_IN_ROTATION, T77_IN_SCALE, T77_STAGGER } from "./T77_letterAssemble";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T77";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: flying in, landing, the hold, leaving, gone. */
const TIMES = [0.1, 0.35, 1.0, 1.8, 2.3] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "0e759f54b28b4d2c54664e8b60f0eaecaba8b0de41a62fe37c2dce05311d03cc",
    "78dd654a7b8b5c4fa9112ce4e1e50e54127c463630dad1a5646442af7850e653",
    "2c2e5ee869940c1fdea279afad39a69ae1fe28a32ff6cd80ab6e901e92d56a79",
    "50d61ed77408005c1bf6268f08ea26bc6cbd445b672d6e184c192a5f8ec2992b",
    "6dd797c940e8a36b0204c4ed319a6dab5061438bad86ebadb1f923876da86852",
  ],
  landscape: [
    "93761a91ac4d9e1e12bf6bc4f50212c48c2f360f88890b926466ee577d59e71f",
    "aef0a2fbe6d2f21268eb7d2970315d668f663db7dd21b363c197feab563a24be",
    "03eb77fd3f6e0463ba571533d831e8985e33273970158c195d6befd0414d7c49",
    "b94d9f013214140d74bcd415d8877c164c297ba5d0a77e57c8e04ac2b13fc6f9",
    "76ac3162fc2bc04abc5e07264a36b7ab91d8e505160b96fdf5eebc40218b9b8c",
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

describe("T77 Letter Assemble", () => {
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
    const first = frameText(0.35, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.35, PORTRAIT)).toBe(first);
  });

  it("characters fly home 0.05 s apart from field scatter positions (turned ±60°, scale 0.6–1.4, unseen), by 0.6 s", () => {
    expect([T77_STAGGER, T77_IN_ROTATION]).toEqual([0.05, 60]);
    const plan = assemblePlan(params(), PORTRAIT), short = 1080;
    expect(plan.stagger).toBeCloseTo(0.05, 12);
    for (const glyph of plan.glyphs) {
      const start = glyph.index * plan.stagger;
      expect(assemblePose(plan, glyph, start - 1e-6)).toBeNull();
      const first = assemblePose(plan, glyph, start)!;
      expect(first.opacity).toBe(0);
      const distance = Math.hypot(first.dx, first.dy);
      expect(distance).toBeGreaterThanOrEqual(T77_DISTANCE[0] * short - 1e-6);
      expect(distance).toBeLessThanOrEqual(T77_DISTANCE[1] * short + 1e-6);
      expect(Math.abs(first.rotation)).toBeLessThanOrEqual(60);
      expect(first.scale).toBeGreaterThanOrEqual(T77_IN_SCALE[0]);
      expect(first.scale).toBeLessThanOrEqual(T77_IN_SCALE[1]);
      // Home by 0.6 s: expoOut puts most of the way in the first frames.
      expect(start + plan.flightIn).toBeLessThanOrEqual(0.6 + 1e-9);
      const early = assemblePose(plan, glyph, start + 0.1 * plan.flightIn)!;
      expect(Math.hypot(early.dx, early.dy)).toBeLessThan(0.55 * distance);
      expect(assemblePose(plan, glyph, 0.6)).toMatchObject({ dx: 0, dy: 0, rotation: 0, scale: 1, opacity: 1 });
    }
  });

  it("holds 0.6–1.6 s, then scatters to new positions (expoIn), spinning and fading, gone by 2.1 s; the tail is empty", () => {
    const plan = assemblePlan(params(), PORTRAIT);
    expect(plan.outStart).toBeCloseTo(1.6, 9);
    expect(plan.outEnd).toBeCloseTo(2.1, 9);
    expect(frameText(0.8, PORTRAIT)).toBe(frameText(1.55, PORTRAIT));
    for (const glyph of plan.glyphs) {
      const leave = plan.outStart + glyph.index * plan.stagger;
      const late = assemblePose(plan, glyph, leave + 0.95 * plan.flightOut)!;
      expect(late.opacity).toBeLessThan(1);
      expect(Math.abs(late.rotation)).toBeGreaterThan(45);
      expect(assemblePose(plan, glyph, 2.15)).toBeNull();
      // The out positions differ from the in positions.
      expect([glyph.to.dx, glyph.to.dy]).not.toEqual([glyph.from.dx, glyph.from.dy]);
    }
    expect(paths(frameText(2.3, PORTRAIT))).toBe(0);
  });

  it("the held word fills 80–90% of the safe width inside the safe box (glyphs ≥ 9% of the short side)", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { lines: ["集"] }, { lines: ["集合", "出發"] }]) {
        const plan = assemblePlan(params(input), size), safe = titleSafeBox(size), short = Math.min(size.width, size.height);
        expect(plan.glyphHeight, JSON.stringify(input)).toBeGreaterThanOrEqual(0.09 * short);
        expect(plan.box.x0).toBeGreaterThanOrEqual(safe.x0);
        expect(plan.box.x1).toBeLessThanOrEqual(safe.x1);
        expect(plan.box.y0).toBeGreaterThanOrEqual(safe.y0);
        expect(plan.box.y1).toBeLessThanOrEqual(safe.y1);
        if (input === undefined && size === PORTRAIT) {
          const fill = (plan.box.x1 - plan.box.x0) / safe.width;
          expect(fill).toBeGreaterThanOrEqual(0.8);
          expect(fill).toBeLessThanOrEqual(0.9);
        }
      }
    }
  });

  it("colours alternate cream and gold on the dark card; ink and the deep gold on the gold card", () => {
    const palette = item.defaultParams.palette;
    expect(item.showcasePlate).toBe("bg");
    expect(assemblePlan(params(), PORTRAIT).glyphs.map(glyph => glyph.color)).toEqual([palette.paper, palette.accent, palette.paper]);
    expect(assemblePlan(params({ plate: "accent" }), PORTRAIT).glyphs.map(glyph => glyph.color)).toEqual([palette.ink, palette.accent2, palette.ink]);
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
