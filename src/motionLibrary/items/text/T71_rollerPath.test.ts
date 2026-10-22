import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import {
  carPose, headDistance, rollerPlan, T71_DOT_OPACITY, T71_DOT_PITCH, T71_DOT_RADIUS, T71_GLYPH, T71_ROUNDNESS, T71_SPEED_SWING, T71_TRACK_FILL,
} from "./T71_rollerPath";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T71";
const LOOP = 3;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.4, 0.75, 1.5, 2.6] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "f72af02df98809d22420cb838ad456132fafacb554c64862bc6b32d1fb2739e1",
    "0eac1e88bd4781d8a4111413960b995e0e8675bd10c25388066770c5609dc9f0",
    "edc14f731ea7d2fcd18a95a359c84b73cb640b9b959774faa151952005e66f18",
    "800d1e929f6fe5716c0ffe020ae8cb48ba0d623e050a16961446095f615eafd1",
    "3b2239977f774065bba230e6496f1fd2cd6b7648623796316872b6e0f197969d",
  ],
  landscape: [
    "719ded516902c10244c6078bd1def0061ebbd843ad50169d4425f6baafcecd94",
    "0228ae5f40706991564e7dbb2c581f7b4939c0e6458e99feb97b0ae5e466f9a1",
    "4dae486f97c1cc02863bf1f1532b145cbb770c749313bf64c3c58a7353c3350c",
    "5d269107fec9137c9e9b1f55e2de43bb9a1c8de46a5b50656a230f59ccaa9976",
    "550f33e79669c4b51ae001d7dea8729611309989a3fbf9836f9443c8e5bf701f",
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
const PALETTE_A = { bg: "#101820", ink: "#0A0A0A", paper: "#FAFAF0", accent: "#E0A030", accent2: "#704010" };
const PALETTE_B = { bg: "#203040", ink: "#000814", paper: "#F0F8FF", accent: "#30C0E0", accent2: "#105070" };

describe("T71 Roller Path", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: one lap per loop, the frame at loopSeconds equals frame 0", () => {
    expect(item.loopSeconds).toBe(LOOP);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { plate: item.showcasePlate }, { lines: ["繞圈圈繞圈圈"] }]) {
        const start = frameText(0, size, input);
        expect(frameText(LOOP, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2 * LOOP, size, input)).toBe(start);
        expect(frameText(LOOP * 0.37, size, input)).not.toBe(start);
      }
    }
    expect(frameText(90 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.5, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * LOOP, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.75, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.75, PORTRAIT)).toBe(first);
  });

  it("the train rides the ∞ coupled at a fixed gap, fastest through the crossing and slowest at the tips", () => {
    expect([T71_SPEED_SWING, T71_DOT_PITCH, T71_DOT_RADIUS, T71_DOT_OPACITY]).toEqual([0.5, 0.45, 0.06, 0.75]);
    const plan = rollerPlan(params(), LANDSCAPE), length = plan.track.totalLength;
    // A bold dotted track: a dot every 0.45 glyph heights, 12% of the glyph height across.
    expect(plan.dots).toHaveLength(Math.round(length / (0.45 * plan.glyphHeight)));
    expect(plan.dotRadius).toBeCloseTo(0.06 * plan.glyphHeight, 9);
    expect(headDistance(plan, 0)).toBe(0);
    expect(headDistance(plan, 1)).toBeCloseTo(length, 6);
    // Speed L·(1 − k·cos 4πu): slowest at the tips (u = 0, ½), fastest at the crossings (u = ¼, ¾ ↔ s = L/4, 3L/4).
    const speed = (u: number) => (headDistance(plan, u + 1e-5) - headDistance(plan, u - 1e-5)) / 2e-5;
    expect(speed(0)).toBeCloseTo(length * 0.5, 0);
    expect(speed(0.25)).toBeCloseTo(length * 1.5, 0);
    expect(headDistance(plan, 0.25)).toBeCloseTo(length / 4, 6);
    expect(speed(0.5)).toBeLessThan(speed(0.75));
    // The crossing is the track's centre.
    const crossing = plan.track(length / 4);
    expect(Math.hypot(crossing.x - 960, crossing.y - 540)).toBeLessThan(2);
    // Cars are a fixed arc length apart and turned to the tangent.
    for (const u of [0.1, 0.6]) {
      for (const car of plan.cars) {
        const pose = carPose(plan, car.index, u), at = plan.track((((headDistance(plan, u) - car.index * plan.gap) % length) + length) % length);
        expect([pose.x, pose.y, pose.angle]).toEqual([at.x, at.y, at.angle]);
      }
    }
  });

  it("r2: the ∞ spans about 85% of the safe width with round loops, glyphs are 16% of the short side, and every car stays inside the safe box", () => {
    expect([T71_TRACK_FILL, T71_GLYPH, T71_ROUNDNESS]).toEqual([0.85, 0.16, 0.5]);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { lines: ["繞"] }, { lines: ["繞圈圈繞圈圈"] }, { energy: "hype" }]) {
        const plan = rollerPlan(params(input), size), safe = titleSafeBox(size), short = Math.min(size.width, size.height);
        expect(plan.glyphHeight, JSON.stringify(input)).toBeGreaterThanOrEqual(0.12 * short);
        expect(plan.glyphHeight).toBeCloseTo(0.16 * short, 0);
        // Every car, turned to the tangent, at every phase: its ink box corners stay inside the safe box.
        const outside: string[] = [];
        for (let step = 0; step < 240; step += 1) {
          for (const car of plan.cars) {
            const pose = carPose(plan, car.index, step / 240), radians = (pose.angle * Math.PI) / 180, c = Math.cos(radians), s = Math.sin(radians);
            for (const [bx, by] of [[car.box.x0, car.box.y0], [car.box.x1, car.box.y0], [car.box.x0, car.box.y1], [car.box.x1, car.box.y1]]) {
              const x = pose.x + (bx - car.cx) * c - (by - car.cy) * s, y = pose.y + (bx - car.cx) * s + (by - car.cy) * c;
              if (x < safe.x0 - 0.5 || x > safe.x1 + 0.5 || y < safe.y0 - 0.5 || y > safe.y1 + 0.5) outside.push(`${car.char} u=${step / 240} (${x.toFixed(1)}, ${y.toFixed(1)})`);
            }
          }
        }
        expect(outside.slice(0, 3), `${size.width}x${size.height} ${JSON.stringify(input)}`).toEqual([]);
      }
      const plan = rollerPlan(params(), size), safe = titleSafeBox(size);
      const xs = plan.dots.map(dot => dot.x), ys = plan.dots.map(dot => dot.y);
      const spanX = Math.max(...xs) - Math.min(...xs), spanY = Math.max(...ys) - Math.min(...ys);
      // Horizontal ∞ in landscape and square, upright in portrait; it spans 78–85% of the safe width (85% where nothing binds).
      expect(spanX > spanY).toBe(size !== PORTRAIT);
      expect(spanX / safe.width).toBeGreaterThanOrEqual(0.78);
      expect(spanX / safe.width).toBeLessThanOrEqual(0.851);
      if (size === LANDSCAPE) expect(spanX / safe.width).toBeGreaterThan(0.84);
      // Round loops: the half-width across the ∞ is half its half-length along it.
      expect((size === PORTRAIT ? spanX : spanY) / (size === PORTRAIT ? spanY : spanX)).toBeCloseTo(T71_ROUNDNESS, 1);
    }
  });

  it("colours: ink and deep teal cars on the cream card (teal is 1.6:1 there), cream and teal on the dark card; the track in the deep shade at 75%", () => {
    const palette = item.defaultParams.palette;
    expect(item.showcasePlate).toBe("paper");
    const onPaper = rollerPlan(params({ plate: "paper" }), LANDSCAPE);
    expect(onPaper.cars.map(car => car.color)).toEqual([palette.ink, palette.accent2, palette.ink]);
    expect(onPaper.dotColor).toBe(palette.accent2);
    expect(rollerPlan(params(), LANDSCAPE).dotColor).toBe(palette.accent);
    expect(rollerPlan(params(), LANDSCAPE).cars.map(car => car.color)).toEqual([palette.paper, palette.accent, palette.paper]);
    expect(frameText(0, LANDSCAPE)).toContain(`fill-opacity="0.75"`);
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
