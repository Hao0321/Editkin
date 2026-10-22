import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateTransitionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { MOTION_ENERGIES, type MotionFrameSize, type TransitionFrame, type TransitionMotionItem } from "../../types";
import { curtainReach } from "./X08_curtainSlide";

const ID = "X08";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const DURATIONS = [0.2, 0.5, 1, 2];

/** Golden SVG SHA-256 (matte + overlay) at 5 fixed times × 2 formats, default params. Regenerate only for a reviewed art change and bump the revision. */
const TIMES = [0, 0.125, 0.25, 0.375, 0.5];
const GOLDEN: Record<"portrait" | "landscape", readonly string[]> = {
  portrait: [
    "4ee83d3d13afcff4bcf85a9a5c8b25d04cb7dc50723fcdb0d8574dbd4660a8fd",
    "9a690c116c33e7170ee4cbf70a826142715a6c39b68861fdd3f14698b5288028",
    "84a52ed5a61dafe954e88b7de33eb798c85e3f3124088a39003dafe167423ce7",
    "13a6c007a6f5b7ad230636dc74e5cd37e0f6048fce1dc5c9fdf10708eeeeb11c",
    "b7f18d04a593679d1eb2977d387af3b1c1dd31e2ca79f2240408625b2a215f7e",
  ],
  landscape: [
    "3eaa09242ada92cc8c34abd73e2167add7ae8bb1f5d89cc1d51f3c764840e37a",
    "3fb89a63ffaa65c60e8b2cc37d3953c33c713449ec163a63b5fe1436412b81af",
    "57d89a78d11426ccbc481532831af70807efb1ea9a4bc2b56740ec13dabc6377",
    "d69f528873bb46985cd5d19c97dffb8e844128b4ecd98e71ecd4de64a789b8ee",
    "6f39a25128cdf1861a213a57b8b3e7d9f711059518cdd30caaac7d2e618b4b9a",
  ],
};

const item = () => getMotionLibraryItem(ID) as TransitionMotionItem;
/** The item's default palette, so colour assertions follow the catalog's default theme. */
const palette = () => item().defaultParams.palette;
function frame(t: number, input?: unknown, size: MotionFrameSize = LANDSCAPE): TransitionFrame {
  return generateTransitionFrame(item(), resolveMotionLibraryParams(item(), input), t, size);
}
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const head = (size: MotionFrameSize) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}">`;
const full = (size: MotionFrameSize, fill: string) => `<rect x="0" y="0" width="${size.width}" height="${size.height}" fill="${fill}"/>`;
const ALL_A = (size: MotionFrameSize) => `${head(size)}${full(size, "#000000")}</svg>`;
const ALL_B = (size: MotionFrameSize) => `${head(size)}${full(size, "#000000")}${full(size, "#FFFFFF")}</svg>`;
const EMPTY = (size: MotionFrameSize) => `${head(size)}</svg>`;

/** The two curtain rects of an overlay, in drawing order (back, then front). */
function panels(svg: string): Array<{ x: number; width: number; height: number; fill: string }> {
  return [...svg.matchAll(/<rect x="([\d.-]+)" y="0" width="([\d.]+)" height="([\d.]+)" fill="(#[0-9A-F]{6})"\/>/g)]
    .map(([, x, width, height, fill]) => ({ x: Number(x), width: Number(width), height: Number(height), fill }));
}
/** Uncovered gap between the panels (0 when they touch or overlap). */
function gap(svg: string, size = LANDSCAPE): number {
  const found = panels(svg);
  if (found.length < 2) return size.width - found.reduce((sum, panel) => sum + panel.width, 0);
  const [back, front] = found;
  return Math.max(0, back.x - (front.x + front.width));
}

describe("X08 Curtain Slide", () => {
  for (const [format, size] of Object.entries({ portrait: PORTRAIT, landscape: LANDSCAPE }) as Array<["portrait" | "landscape", MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => { const f = frame(t, undefined, size); return sha256(`${f.matte}\n--overlay--\n${f.overlay ?? ""}`); })).toEqual(GOLDEN[format]);
    });
  }

  it("matte is strictly all A at t = 0 and all B at t = D, overlay empty, for every energy and duration", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const energy of MOTION_ENERGIES) {
        for (const durationSeconds of DURATIONS) {
          const start = frame(0, { energy, durationSeconds }, size), end = frame(durationSeconds, { energy, durationSeconds }, size);
          expect([start.matte, start.overlay, end.matte, end.overlay]).toEqual([ALL_A(size), EMPTY(size), ALL_B(size), EMPTY(size)]);
        }
      }
    }
    expect(item().supportedDirections).toBeUndefined();
  });

  it("switches A to B at exactly 50% while the curtains are shut (every energy, duration, both formats)", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const energy of MOTION_ENERGIES) {
        for (const durationSeconds of DURATIONS) {
          const input = { energy, durationSeconds }, label = `${energy} ${durationSeconds} ${size.width}`;
          expect(frame(0.499 * durationSeconds, input, size).matte, label).toBe(ALL_A(size));
          expect(frame(0.5 * durationSeconds, input, size).matte, label).toBe(ALL_B(size));
          for (const p of [0.47, 0.49, 0.5]) {
            const shut = panels(frame(p * durationSeconds, input, size).overlay!);
            expect(shut, `${label} ${p}`).toHaveLength(2);
            // Shut: the front panel ends exactly at the centre and the back panel tucks 1.5 px (at 1080) under it, full height.
            expect(shut[1]).toMatchObject({ x: 0, width: size.width / 2, height: size.height });
            expect(shut[0].x).toBeCloseTo(size.width / 2 - 1.5, 2);
            expect(shut[0].x + shut[0].width).toBeCloseTo(size.width, 2);
          }
          expect(gap(frame(0.2 * durationSeconds, input, size).overlay!, size), label).toBeGreaterThan(0);
          expect(gap(frame(0.7 * durationSeconds, input, size).overlay!, size), label).toBeGreaterThan(0);
        }
      }
    }
  });

  it("accelerates in, overshoots once past the centre, settles, then parts with a decelerating spring", () => {
    for (const energy of MOTION_ENERGIES) {
      const samples = Array.from({ length: 101 }, (_, index) => curtainReach(index / 100, energy));
      expect(samples[0]).toBe(0);
      expect(samples[100]).toBe(0);
      const peak = Math.max(...samples);
      expect(peak, energy).toBeGreaterThan(1.015);
      expect(peak, energy).toBeLessThan(1.13);
      // Contact at 36%: accelerating before it (each step longer than the last), shut over 47–50%, open by 96%.
      for (let index = 2; index <= 35; index += 1) expect(samples[index] - samples[index - 1]).toBeGreaterThanOrEqual(samples[index - 1] - samples[index - 2] - 1e-12);
      expect(samples.slice(47, 51).every(value => value === 1)).toBe(true);
      expect(samples.slice(96).every(value => value === 0)).toBe(true);
      // Parting decelerates.
      for (let index = 52; index <= 96; index += 1) expect(samples[index - 1] - samples[index]).toBeLessThanOrEqual(samples[index - 2] - samples[index - 1] + 1e-12);
    }
    // Overshoot: the front panel pushes past the centre line at its peak (about 5% of a panel at standard energy).
    const pushed = panels(frame(0.2075).overlay!)[1];
    expect(pushed.width / 960).toBeCloseTo(1.05, 2);
  });

  it("uses accent2 and ink panels, swapped by the seed", () => {
    const fills = new Set(Array.from({ length: 8 }, (_, seed) => panels(frame(0.25, { seed }).overlay!).map(panel => panel.fill).join("/")));
    expect(fills).toEqual(new Set([`${palette().ink}/${palette().accent2}`, `${palette().accent2}/${palette().ink}`]));
    expect(frame(0.25, { palette: { accent2: "#00AA00" } }).overlay).toContain('fill="#00AA00"');
  });

  it("is deterministic and generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms)", () => {
    expect(frame(0.2, { seed: 7 }, PORTRAIT)).toEqual(frame(0.2, { seed: 7 }, PORTRAIT));
    frame(0.1, undefined, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frame((index / 29) * 0.5, undefined, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });
});
