import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { frameUnit, titleSafeBox } from "../shared";
import { T44_BLUR, T44_IN_SCALE, T44_OUT_SCALE, T44_PUNCH, explodePlan, explodePose, explodeTimes } from "./T44_explodeOut";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T44";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: flying in with ghosts (0.08, 0.2), the hold (0.7), blowing apart (1.2, 1.38). */
const TIMES = [0.08, 0.2, 0.7, 1.2, 1.38] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "3869bc2cd18eba70be2b908f90f50f963393fd4f1a240d52793d4b062f5ba292",
    "8d5719b4dc89a28984f42792516a9594db31eac1bf4a818d23861fc644e56cda",
    "98a12a4b3f3796d67e3c513e98f7602e500a15e4dd106c8cb454e5150f41caf5",
    "a8d2faf3694421104165750db8cb52d18a08566ded03bf6e1ab314b096020108",
    "63fb61ee16b259313d2f86f6c56386c0226fbd92897f4a7ec5f61a5afdb6bd7e",
  ],
  landscape: [
    "7f6b20003697e8f66dc0fdf6d5822f747baa59ce665a4b43a31f0352c8853018",
    "9149c377b7afd0c85067cc6e328eca5f53598656575aaeb8b74745f5512c230d",
    "15db2f606a98657e5bc91f381e7d7f740641392462df7addf7bf35ef6a6e9e45",
    "141fd33a1e01561015b3efd1615cc90c58c1943e74ec4d20052a7728c0f9cfd2",
    "a29d1205aecdce811e433b7fc6b146c06f80f6a9b02bdfbfa5f5eaac7dbdc95a",
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
const empty = (size: MotionFrameSize) => `${header(size)}</svg>`;

describe("T44 Explode Out", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.5, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * 2, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(1.2, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(1.2, PORTRAIT)).toBe(first);
  });

  it("flies in (0–0.3 s, 1.6× → 1, two ghosts), holds 0.3–1.1 s with a 1.03 punch, blows apart 1.1–1.45 s, then nothing", () => {
    const times = explodeTimes(params());
    expect([times.inEnd, times.outStart, times.outEnd]).toEqual([0.3, 1.1, 1.45].map(value => expect.closeTo(value, 9)));
    const plan = explodePlan(params(), LANDSCAPE), unit = frameUnit(LANDSCAPE);
    expect(plan.glyphs).toHaveLength(4);
    for (const glyph of plan.glyphs) {
      // In: from the exploded pose (scale 1.6, spun, transparent) to home.
      expect(glyph.in.scale).toBe(T44_IN_SCALE);
      const start = explodePose(glyph, times, 0, unit)!;
      expect(start.opacity).toBe(0);
      expect(start.scale).toBeCloseTo(T44_IN_SCALE, 9);
      // Hold: home, opaque, sharp.
      expect(explodePose(glyph, times, 0.7, unit)).toEqual({ dx: 0, dy: 0, rotation: 0, scale: 1, opacity: 1, blur: 0 });
      // Out: away along the line from the word centre through the character (±25°), 0.6–0.9 frame widths, spinning 90–200°.
      const away = (Math.atan2(glyph.cy - plan.centerY, glyph.cx - plan.centerX) * 180) / Math.PI;
      const delta = ((glyph.out.directionDegrees - away + 540) % 360) - 180;
      expect(Math.abs(delta)).toBeLessThanOrEqual(25 + 1e-6);
      const travel = Math.hypot(glyph.out.dx, glyph.out.dy) / LANDSCAPE.width;
      expect(travel).toBeGreaterThanOrEqual(0.6 - 1e-9);
      expect(travel).toBeLessThanOrEqual(0.9 + 1e-9);
      expect(Math.abs(glyph.out.rotation)).toBeGreaterThanOrEqual(90);
      expect(Math.abs(glyph.out.rotation)).toBeLessThanOrEqual(200);
      expect(glyph.out.scale).toBe(T44_OUT_SCALE);
      const late = explodePose(glyph, times, 1.44, unit)!;
      expect(late.blur).toBeLessThanOrEqual(T44_BLUR * unit + 1e-9);
      expect(late.opacity).toBeLessThan(0.1);
      expect(explodePose(glyph, times, 1.46, unit)).toBeNull();
    }
    // The blur exists only in the out phase (≤ 6 px at 1080), one filter per character.
    expect(frameText(0.1, PORTRAIT)).not.toContain("<filter");
    expect(frameText(0.7, PORTRAIT)).not.toContain("<filter");
    const out = frameText(1.3, PORTRAIT);
    expect(out.match(/<filter /g)?.length).toBe(4);
    for (const match of out.matchAll(/stdDeviation="([\d.]+)"/g)) expect(Number(match[1])).toBeLessThanOrEqual(T44_BLUR + 1e-9);
    // Two ghosts trail each character while it flies in.
    expect(frameText(0.08, PORTRAIT).match(/opacity="0\.[0-9]+"/g)!.length).toBeGreaterThanOrEqual(8);
    // Empty after the out phase; the clip is 2 s.
    expect(item.defaultDurationSeconds).toBe(2);
    expect(frameText(1.5, PORTRAIT)).toBe(empty(PORTRAIT));
    expect(frameText(1.97, LANDSCAPE)).toBe(empty(LANDSCAPE));
    // A longer clip holds longer; the out phase stays at the end.
    expect(explodeTimes(params({ durationSeconds: 4 })).outStart).toBeCloseTo(3.1, 9);
  });

  it("keeps the word inside the 5% title-safe box at the hold (punch included), at least 9% of the short side tall", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { lines: ["炸"] }, { lines: ["炸裂", "四散"] }]) {
        const plan = explodePlan(params(input), size), safe = titleSafeBox(size), short = Math.min(size.width, size.height);
        const cx = plan.centerX, cy = plan.centerY, k = 1 + T44_PUNCH;
        const label = `${size.width}x${size.height} ${JSON.stringify(input)}`;
        expect(cx + (plan.box.x0 - cx) * k, label).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
        expect(cx + (plan.box.x1 - cx) * k, label).toBeLessThanOrEqual(safe.x1 + 1e-6);
        expect(cy + (plan.box.y0 - cy) * k, label).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
        expect(cy + (plan.box.y1 - cy) * k, label).toBeLessThanOrEqual(safe.y1 + 1e-6);
        expect(plan.glyphHeight, label).toBeGreaterThanOrEqual(0.09 * short);
        if (input === undefined) expect((plan.box.x1 - plan.box.x0) / safe.width, label).toBeGreaterThanOrEqual(0.8);
      }
    }
  });

  it("colours alternate cream and lime on the dark card; ink and the deep shade on the accent card", () => {
    const palette = item.defaultParams.palette;
    expect(explodePlan(params(), PORTRAIT).glyphs.map(glyph => glyph.color)).toEqual([palette.paper, palette.accent, palette.paper, palette.accent]);
    expect(explodePlan(params({ plate: "accent" }), PORTRAIT).glyphs.map(glyph => glyph.color)).toEqual([palette.ink, palette.accent2, palette.ink, palette.accent2]);
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
