import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { frameUnit, titleSafeBox } from "../shared";
import { blurTrailPlan, dashBlur, dashX, T69_BLUR_MAX, T69_ECHOES, T69_IN, T69_OUT, T69_TAIL, trailEchoes } from "./T69_blurTrail";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T69";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: dashing in, braking, the crisp hold, dashing out, the empty tail. */
const TIMES = [0.05, 0.2, 1, 1.55, 1.9] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "bf908bbeb8cc81f4d90fc325963d93ca0dda66218fd33a55bfdd37acaeff3b42",
    "ca8ee67983d34b3f67c85fe025da08844dac6f81bf5a9e0b4ca7fe6b8d686f15",
    "ca4f0d5940a835ae5abe89804339c45dbc9652e42211013c38125ca83af4ff58",
    "4842b8151ce84750652ba711e3838f18ebc7530f3ba0f9b67cffde8edd9693c7",
    "6dd797c940e8a36b0204c4ed319a6dab5061438bad86ebadb1f923876da86852",
  ],
  landscape: [
    "38002e0c7609e0145d5775165ebdc0e153dcbbeac1ccc629c1f3a12695827147",
    "6d356ec5d86a0a9c52670fdc5f4a38afaf9b699ed5983dddbf6d66cd7a255103",
    "6ff49d4e8e33ed783e1663432ec43771df68fc890fdae22f22b26f8114464980",
    "2750096384e01bc91eef5d7327e1d3ddb819bb515d9736caba797d74adb8efe2",
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
/** The drawn content after the root tag and the <defs> (clip paths, filters): a plate must come first in it. */
const body = (svg: string) => svg.replace(/^<svg[^>]*>(<defs>.*?<\/defs>)?/, "");
const colours = (svg: string) => new Set(svg.match(/#[0-9A-F]{6}/g) ?? []);
const PALETTE_A = { bg: "#101820", ink: "#0A0A0A", paper: "#FAFAF0", accent: "#E0A030", accent2: "#704010" };
const PALETTE_B = { bg: "#203040", ink: "#000814", paper: "#F0F8FF", accent: "#30C0E0", accent2: "#105070" };

describe("T69 Blur Trail", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.1, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * 2, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.1, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.1, PORTRAIT)).toBe(first);
  });

  it("dashes in from beyond the left edge by 0.35 s (expoOut), holds crisp to 1.4 s, dashes off right by 1.7 s (expoIn), empty after", () => {
    expect([T69_IN, T69_OUT, T69_TAIL]).toEqual([0.35, 0.3, 0.3]);
    for (const size of [PORTRAIT, LANDSCAPE]) {
      const plan = blurTrailPlan(params(), size);
      expect([plan.inEnd, plan.outStart, plan.outEnd]).toEqual([0.35, 1.4, 1.7].map(value => expect.closeTo(value, 9)));
      // Fully off-frame at both ends, centred at the hold.
      expect(dashX(plan, 0)! + plan.halfWidth).toBeLessThan(0);
      expect(dashX(plan, plan.outEnd)! - plan.halfWidth).toBeGreaterThan(size.width);
      expect(dashX(plan, 0.35)).toBe(plan.cx);
      expect(dashX(plan, 1.39)).toBe(plan.cx);
      // expoOut in: half the distance within the first tenth of the dash; expoIn out: still near the centre at mid-dash.
      const travelIn = plan.cx - plan.startX;
      expect(dashX(plan, 0.035)! - plan.startX).toBeCloseTo(travelIn * 0.5, 0);
      expect(dashX(plan, 1.55)! - plan.cx).toBeLessThan(0.05 * (plan.endX - plan.cx));
      expect(dashX(plan, 1.8)).toBeUndefined();
    }
    // The empty tail draws nothing.
    expect(frameText(1.9, PORTRAIT)).not.toContain("<path");
  });

  it("six accent echoes at 50/38/28/18/10/5% trail the word while it moves; the hold is crisp, unfiltered and echo-free", () => {
    expect(T69_ECHOES).toEqual([0.5, 0.38, 0.28, 0.18, 0.1, 0.05]);
    const plan = blurTrailPlan(params(), PORTRAIT);
    const moving = trailEchoes(plan, 0.12);
    expect(moving.length).toBe(6);
    moving.forEach((echo, index) => {
      expect(echo.opacity).toBeLessThanOrEqual(T69_ECHOES[index] + 1e-9);
      expect(echo.x).toBeLessThan(dashX(plan, 0.12)!);
    });
    for (const t of [0.35, 0.6, 1.0, 1.39]) {
      expect(trailEchoes(plan, t), `t=${t}`).toEqual([]);
      expect(dashBlur(plan, t)).toBe(0);
      const svg = frameText(t, PORTRAIT);
      expect(svg).not.toContain("filter");
      expect((svg.match(/<path /g) ?? []).length).toBe(1);
    }
    // Leaving, the trail is behind (left of) the word.
    for (const echo of trailEchoes(plan, 1.6)) expect(echo.x).toBeLessThan(dashX(plan, 1.6)!);
  });

  it("the horizontal blur follows speed and never exceeds 12 px at 1080 units", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      const plan = blurTrailPlan(params(), size);
      let peak = 0;
      for (let step = 0; step <= 200; step += 1) peak = Math.max(peak, dashBlur(plan, (step / 200) * 2));
      expect(peak).toBeCloseTo(T69_BLUR_MAX * frameUnit(size), 6);
      // Faster means blurrier while braking.
      expect(dashBlur(plan, 0.1)).toBeGreaterThan(dashBlur(plan, 0.25));
      expect(frameText(0.1, size)).toContain(`stdDeviation="${Number(dashBlur(plan, 0.1).toFixed(3))} 0"`);
    }
  });

  it("the held word fills 80–90% of the safe width inside the safe box", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { lines: ["疾"] }, { lines: ["疾馳", "而過"] }]) {
        const plan = blurTrailPlan(params(input), size), safe = titleSafeBox(size), short = Math.min(size.width, size.height);
        expect(plan.glyphHeight, JSON.stringify(input)).toBeGreaterThanOrEqual(0.09 * short);
        expect(plan.box.x0).toBeGreaterThanOrEqual(safe.x0);
        expect(plan.box.x1).toBeLessThanOrEqual(safe.x1);
        expect(plan.box.y0).toBeGreaterThanOrEqual(safe.y0);
        expect(plan.box.y1).toBeLessThanOrEqual(safe.y1);
        // 「疾馳」 is two characters: in landscape the height cap binds (heroTextBox), elsewhere the width does.
        if (input === undefined && size !== LANDSCAPE) {
          const fill = (plan.box.x1 - plan.box.x0) / safe.width;
          expect(fill).toBeGreaterThanOrEqual(0.8);
          expect(fill).toBeLessThanOrEqual(0.9);
        }
      }
    }
  });

  it("energy scales the timing; short clips squeeze it and keep the tail", () => {
    const hype = blurTrailPlan(params({ energy: "hype" }), PORTRAIT);
    expect(hype.inEnd).toBeCloseTo(0.35 * 0.85, 9);
    const short = blurTrailPlan(params({ durationSeconds: 0.8 }), PORTRAIT);
    expect(short.inEnd).toBeLessThan(0.35);
    expect(short.outEnd).toBeLessThan(0.8);
    expect(short.inEnd).toBeLessThan(short.outStart);
  });

  it("colours: a cream word with a teal trail on the dark card; ink with deep teal on the teal card", () => {
    const palette = item.defaultParams.palette;
    expect(item.showcasePlate).toBe("bg");
    const plan = blurTrailPlan(params(), PORTRAIT);
    expect([plan.color, plan.echoColor]).toEqual([palette.paper, palette.accent]);
    const onAccent = blurTrailPlan(params({ plate: "accent" }), PORTRAIT);
    expect([onAccent.color, onAccent.echoColor]).toEqual([palette.ink, palette.accent2]);
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
