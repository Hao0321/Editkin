import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { ballPose, karaokeBallPlan, landingTime, T65_APEX, T65_BALL, T65_GREY, T65_LEAD, T65_REST, wipeProgress } from "./T65_karaokeBall";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T65";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: the drop-in, the first landing, a wipe mid-line, a later wipe, the held line. */
const TIMES = [0.1, 0.3, 0.6, 1.3, 2.3] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "8f44d459335c9aba924df36ac17a427e6e5562e5408319284e7971cffd79b23a",
    "4a947c3f9b3dd944d5740f16f70204bee9a26634760c6f8c3ab3eff46a5920db",
    "164ce5f3d174edc6ee15d360fc8a5db1a5cee1c6c10f8fa23d04b46d8be592c7",
    "2e0ac521ebba3c2bbd27b1b731365144a8aab40d9191396e934c46bcbaf5aa18",
    "e48c99dfea428dbeb618f88f03706b38915e7a7ab0925e1ef3b71d375388d045",
  ],
  landscape: [
    "ca93d26b0679a15b037a6cdeac160563e0b9c679f30b7c1aa9cc04dc22fe41d3",
    "9dc773ecf0f5bcbb0e0dbcaa5d13f968d164b4df0b124a7ac954305713e7fbe4",
    "9a155a460408ef03928c1795078b0f649f2d3ed2fc8b34628ec80ec4f35e2aa5",
    "7d1e644f76fb5e7e63db6933cd54f15218f64e15f05e11afcae36eb1d1d7ed51",
    "03e8eb20c3afd46576a87f47040b464620e53694cdac244040faa27c15b3f3c2",
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

describe("T65 Karaoke Ball", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.5, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * 2.4, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.6, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.6, PORTRAIT)).toBe(first);
  });

  it("the beat is (duration − 0.6 s) ÷ characters: a landing on each character at exactly 0.3 + i·c, a linear wipe across it", () => {
    expect([T65_LEAD, T65_REST, T65_BALL, T65_APEX, T65_GREY]).toEqual([0.3, 0.3, 0.22, 0.4, 0.4]);
    for (const duration of [2.4, 3, 6]) {
      const plan = karaokeBallPlan(params({ durationSeconds: duration }), PORTRAIT);
      expect(plan.beats).toBe(5);
      expect(plan.beatSeconds).toBeCloseTo((duration - 0.6) / 5, 12);
      for (let beat = 0; beat < plan.beats; beat += 1) {
        const at = landingTime(plan, beat), spot = plan.spots[beat];
        const pose = ballPose(plan, at);
        expect(pose.x).toBeCloseTo(spot[0], 6);
        expect(pose.y).toBeCloseTo(spot[1], 6);
        expect(wipeProgress(plan, beat, at)).toBe(0);
        expect(wipeProgress(plan, beat, at + plan.beatSeconds / 2)).toBeCloseTo(0.5, 9);
        expect(wipeProgress(plan, beat, at + plan.beatSeconds)).toBeCloseTo(1, 9);
      }
      // The final in-place bounce lands 0.3 s before the end, and the ball rests there.
      const last = plan.spots[plan.beats - 1];
      expect(landingTime(plan, plan.beats)).toBeCloseTo(duration - 0.3, 12);
      for (const t of [duration - 0.2, duration - 0.01]) expect([ballPose(plan, t).x, ballPose(plan, t).y]).toEqual([last[0], last[1]]);
    }
  });

  it("the ball is 22% of the glyph height across, lands on each character's top centre and peaks 40% above the cap line", () => {
    const plan = karaokeBallPlan(params(), PORTRAIT);
    expect(plan.radius * 2).toBeCloseTo(0.22 * plan.glyphHeight, 9);
    for (let beat = 0; beat < plan.beats; beat += 1) {
      const glyph = plan.glyphs.find(entry => entry.beat === beat)!;
      expect(plan.spots[beat][0]).toBeCloseTo(glyph.cx, 9);
      expect(plan.spots[beat][1] + plan.radius).toBeLessThanOrEqual(glyph.box.y0);
    }
    // Apex of a hop: the ball centre reaches about apexY (ball bottom 40% of the glyph height above the cap line).
    const apex = ballPose(plan, landingTime(plan, 1) + plan.beatSeconds / 2);
    expect(apex.y).toBeCloseTo(plan.apexY, -1);
    // Constant gravity: the height is a parabola in time.
    const y = (p: number) => ballPose(plan, landingTime(plan, 1) + p * plan.beatSeconds).y;
    expect(y(0.1) - 2 * y(0.2) + y(0.3)).toBeCloseTo(y(0.6) - 2 * y(0.7) + y(0.8), 6);
    // It squashes on landing (about the ball's bottom) and pops in at the start.
    expect(ballPose(plan, landingTime(plan, 2) + 0.04).scaleY).toBeLessThan(0.8);
    expect(ballPose(plan, 0).scale).toBeCloseTo(0, 9);
    expect(ballPose(plan, 0.2).scale).toBe(1);
  });

  it("the line and the whole bounce stay inside the safe box; the line fills 80–90% of the safe width", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { lines: ["唱"] }, { lines: ["跟著節奏", "一起唱"] }, { lines: ["跟著節奏一起唱"] }, { durationSeconds: 5 }]) {
        const plan = karaokeBallPlan(params(input), size), safe = titleSafeBox(size), short = Math.min(size.width, size.height);
        const duration = params(input).durationSeconds;
        expect(plan.glyphHeight, JSON.stringify(input)).toBeGreaterThanOrEqual(0.09 * short);
        if (input === undefined) {
          const fill = (plan.box.x1 - plan.box.x0) / safe.width;
          expect(fill).toBeGreaterThanOrEqual(0.8);
          expect(fill).toBeLessThanOrEqual(0.9);
        }
        for (const box of [plan.box]) {
          expect(box.x0).toBeGreaterThanOrEqual(safe.x0);
          expect(box.x1).toBeLessThanOrEqual(safe.x1);
          expect(box.y1).toBeLessThanOrEqual(safe.y1);
        }
        for (let step = 0; step <= 120; step += 1) {
          const pose = ballPose(plan, (step / 120) * duration);
          const rx = plan.radius * pose.scaleX * Math.max(1, pose.scale), ry = 2 * plan.radius * pose.scaleY * Math.max(1, pose.scale);
          const bottom = pose.y + plan.radius;
          expect(pose.x - rx, `${size.width}x${size.height} ${JSON.stringify(input)}`).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
          expect(pose.x + rx).toBeLessThanOrEqual(safe.x1 + 1e-6);
          expect(bottom - ry).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
        }
      }
    }
  });

  it("colours: grey is the text colour at 40%; the fill and the ball are teal on the dark card, deep teal on the teal card", () => {
    const palette = item.defaultParams.palette;
    expect(item.showcasePlate).toBe("bg");
    const plan = karaokeBallPlan(params(), PORTRAIT);
    expect([plan.greyColor, plan.fillColor]).toEqual([palette.paper, palette.accent]);
    expect(frameText(0.1, PORTRAIT)).toContain(`fill="${palette.paper}" opacity="0.4"`);
    const onAccent = karaokeBallPlan(params({ plate: "accent" }), PORTRAIT);
    expect([onAccent.greyColor, onAccent.fillColor]).toEqual([palette.ink, palette.accent2]);
  });

  it("separators share their neighbour's beat and the ball skips them", () => {
    const plan = karaokeBallPlan(params({ lines: ["跟・唱"] }), PORTRAIT);
    expect(plan.glyphs.map(glyph => glyph.beat)).toEqual([0, 0, 1]);
    expect(plan.beats).toBe(2);
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
