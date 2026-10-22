import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { glitchPlan, glitchState, T34_MIN_EVENT_GAP, T34_SPLIT_REACH, T34_STATE_SECONDS } from "./T34_glitchSlices";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T34";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: glitching in, clean hold, burst one, burst two, glitching out. */
const TIMES = [0.02, 0.4, 0.57, 1.02, 2.3] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "c05b963e945ae9e1b279beacf8bdeef250bceb8716833ad6fa81c1f92e2e82ad",
    "84d75043c39c23a82802a8e17203dde4b48c8e8301c517bec2bce59b588553d6",
    "c47d402d23941d61d5313039a7bc69fffc0d9692ff7e09f9e4865bab49697f75",
    "f312c84cb3bbced46e4b6512110cfa0f6dbab7a3f8f0fa2d61c3a7e631638a90",
    "60d48c550e0f9bf9fba169ca3a4ba4bb0f9158e7af6149bf9e431688d692bbb5",
  ],
  landscape: [
    "f4ade2245e27ac5c719a0883b76f66832e8b2ada87b07abb0b0494f8a12a6a23",
    "52a61230563294c2a6e737f049e3799ddcdce807694f314e2527f4c17f09f6c2",
    "ea57a4764e9c5b3ac321afe2488b5b0226f953a9c8128be165795daef501b0e1",
    "07b1ec4873c400de15bc90bd369910e3b43f90e3aa2b879086f9e35cf8a6b756",
    "606dcda8edfa4e0bf87267fc44f85665572fe04f11cf76a7237d3e24fda93da4",
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

/** Glitch event starts (a glitch state following a clean one, or the first frame) sampled at 600 Hz. */
function glitchEvents(input: unknown, duration: number): { starts: number[]; cleanGaps: number[] } {
  const p = params(input), plan = glitchPlan(p, PORTRAIT);
  const starts: number[] = [], cleanGaps: number[] = [];
  let previous: boolean | undefined, cleanSince = 0;
  for (let step = 0; step * (1 / 600) < duration; step += 1) {
    const t = step / 600, glitch = glitchState(plan, t, duration) !== undefined;
    if (glitch && previous !== true) {
      starts.push(t);
      if (previous === false) cleanGaps.push(t - cleanSince);
    }
    if (!glitch && previous !== false) cleanSince = t;
    previous = glitch;
  }
  return { starts, cleanGaps };
}

describe("T34 Glitch Slices", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.6, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * 2.5, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.57, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.57, PORTRAIT)).toBe(first);
  });

  it("photosensitivity: at most 3 glitch events in any second, clean frames between them, for every energy and clip length", () => {
    expect(T34_MIN_EVENT_GAP).toBeGreaterThan(1 / 3);
    for (const energy of ["calm", "standard", "punchy", "hype"] as const) {
      for (const durationSeconds of [0.5, 1, 1.6, 2.5, 4, 10]) {
        const { starts, cleanGaps } = glitchEvents({ energy, durationSeconds }, durationSeconds);
        for (let index = 0; index < starts.length; index += 1) {
          const inWindow = starts.filter(start => start >= starts[index] && start < starts[index] + 1);
          expect(inWindow.length, `${energy} ${durationSeconds}s from ${starts[index]}`).toBeLessThanOrEqual(3);
        }
        // Every pair of events is separated by at least one clean 30 fps frame.
        for (const gap of cleanGaps) expect(gap, `${energy} ${durationSeconds}s`).toBeGreaterThanOrEqual(1 / 30 - 1e-9);
      }
    }
    // The standard 2.5 s clip: glitch in, three bursts, glitch out (5 events).
    expect(glitchEvents(undefined, 2.5).starts).toHaveLength(5);
  });

  it("glitch states change every 0.05 s whatever the fps; bursts cut the word into 6–10 clipPath slices; clean frames draw one word", () => {
    expect(T34_STATE_SECONDS).toBe(0.05);
    const plan = glitchPlan(params(), PORTRAIT);
    for (const seed of [1, 2, 3, 7, 42]) {
      const slices = glitchPlan(params({ seed }), PORTRAIT).slices;
      expect(slices.length).toBeGreaterThanOrEqual(6);
      expect(slices.length).toBeLessThanOrEqual(10);
      for (let index = 1; index < slices.length; index += 1) expect(slices[index].y0).toBe(slices[index - 1].y1);
      for (const slice of slices) expect(Number.isInteger(slice.y0) && Number.isInteger(slice.y1)).toBe(true);
    }
    expect(glitchState(plan, 0.4, 2.5)).toBeUndefined();
    const clean = frameText(0.4, PORTRAIT);
    expect(clean.match(/<path /g)).toHaveLength(1);
    expect(clean).not.toContain("clip-path");
    const burst = frameText(0.57, PORTRAIT);
    expect(burst.match(/<clipPath /g)!.length).toBe(plan.slices.length);
    // Within a state the frame is identical at any sample time (fps independence).
    expect(frameText(0.551, PORTRAIT)).toBe(frameText(0.599, PORTRAIT));
    expect(frameText(0.551, PORTRAIT)).not.toBe(frameText(0.601, PORTRAIT));
    // The end of the clip is empty.
    expect(frameText(2.49, PORTRAIT)).not.toContain("<path");
  });

  it("the colour split uses the item's own tones: accent2 and cream on the accent card, accent and accent2 on the dark card", () => {
    const palette = item.defaultParams.palette;
    const onAccent = frameText(0.57, PORTRAIT, { plate: "accent" });
    expect(onAccent).toContain(`fill="${palette.ink}"`);
    expect(onAccent).toContain(`fill="${palette.accent2}"`);
    expect(onAccent).toContain(`fill="${palette.paper}"`);
    const onDark = frameText(0.57, PORTRAIT);
    expect(onDark).toContain(`fill="${palette.paper}"`);
    expect(onDark).toContain(`fill="${palette.accent}"`);
    expect(onDark).toContain(`fill="${palette.accent2}"`);
  });

  it("the word and its widest jumps stay inside the 5% title-safe box; the word is at least 9% of the short side tall", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { lines: ["系統崩壞"] }]) {
        const plan = glitchPlan(params(input), size), safe = titleSafeBox(size);
        const width = plan.box.x1 - plan.box.x0, reach = (0.1 + T34_SPLIT_REACH) * width * plan.amplitude;
        // The split really is within its reach: 2.8% of the glyph height (times the energy) never exceeds 3.5% of the word width.
        expect(0.028 * plan.glyphHeight).toBeLessThanOrEqual(T34_SPLIT_REACH * width);
        expect(plan.box.x0 - reach, JSON.stringify(input)).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
        expect(plan.box.x1 + reach).toBeLessThanOrEqual(safe.x1 + 1e-6);
        expect(plan.box.y0).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
        expect(plan.box.y1).toBeLessThanOrEqual(safe.y1 + 1e-6);
        expect(plan.glyphHeight).toBeGreaterThanOrEqual(0.09 * Math.min(size.width, size.height));
      }
    }
    // Every drawn slice offset in the burst frames stays within that reach.
    const plan = glitchPlan(params(), PORTRAIT), width = plan.box.x1 - plan.box.x0;
    for (const t of [0, 0.05, 0.1, 0.15, 0.57, 1.02, 1.67, 2.25, 2.4]) {
      for (const match of frameText(t, PORTRAIT).matchAll(/translate\(([-\d.]+) 0\)/g)) {
        expect(Math.abs(Number(match[1]))).toBeLessThanOrEqual((0.1 + T34_SPLIT_REACH) * width);
      }
    }
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
        const onAccent = frameText(t, size, { plate: "accent" });
        expect(maskColors(onAccent.replace(plateRect(size, palette.accent), ""))).toBe(maskColors(none));
      }
    }
  });
});
