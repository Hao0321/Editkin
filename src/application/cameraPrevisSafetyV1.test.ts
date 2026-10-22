import { describe, expect, it } from "vitest";
import { prepareSafeCameraPrevisV1 as safe, previsLineIntersectsV1 } from "./cameraPrevisSafetyV1";
import type { Mesh3dCamera } from "../motion/mesh3dScene";
const base: Mesh3dCamera = { position: [0, 2, 5], target: [0, 2, 0], verticalFovDegrees: 45, near: .1, far: 40 };
const settings = { floorY: 0, radius: .15, obstacles: [] };
describe("continuous conservative camera clearance", () => {
  it("catches thin obstacles between sample points and touching bounds", () => {
    expect(previsLineIntersectsV1([0, 2, 5], [4, 2, 5], { min: [2.001, 1, 4.9], max: [2.002, 3, 5.1] })).toBe(true);
    expect(previsLineIntersectsV1([0, 2, 5], [4, 2, 5], { min: [2, 2, 5], max: [2, 2, 5] })).toBe(true);
  });
  it("reduces amplitude without changing move kind or falling back to a still", () => {
    const p = safe(base, { kind: "truck", distance: 4, easing: "smooth" }, 5, { ...settings, obstacles: [{ min: [2.01, 1, 4], max: [2.1, 3, 6] }] });
    expect(p.amplitudeScale).toBe(.25); expect(p.motion.kind).toBe("truck"); expect(p.sample(5).position[0]).toBe(1);
    expect(p.warnings).toEqual(["PREVIS_AMPLITUDE_REDUCED"]);
  });
  it("checks the middle of a circular path whose endpoints miss an obstacle", () => {
    const p = safe(base, { kind: "orbit", degrees: 90, easing: "linear" }, 5, { ...settings, obstacles: [{ min: [3.45, 1, 3.45], max: [3.65, 3, 3.65] }] });
    expect(p.amplitudeScale).toBeLessThan(.5); expect(p.sample(0)).toEqual(base);
  });
  it("admits an obstacle in the empty middle of an arc hull when the curve clears it", () => {
    expect(safe(base, { kind: "orbit", degrees: 90, easing: "smooth" }, 5, { ...settings, obstacles: [{ min: [1, 1, 1], max: [2, 3, 2] }] }).amplitudeScale).toBe(1);
  });
  it("refuses an unsafe starting position and floor penetration", () => {
    expect(() => safe(base, { kind: "locked" }, 5, { ...settings, floorY: 1.9 })).toThrow("NO_SAFE_PATH");
    expect(() => safe(base, { kind: "truck", distance: 1, easing: "linear" }, 5, { ...settings, obstacles: [{ min: [-1, 1, 4], max: [1, 3, 6] }] })).toThrow("NO_SAFE_PATH");
  });
  it("checks the entire follow polyline and relative subject clearance", () => {
    const motion = { kind: "follow", objectId: "hero" };
    expect(() => safe(base, motion, 5, { ...settings, followDeltas: [[0, 0, 0], [4, 0, 0]], obstacles: [{ min: [2, 1, 4], max: [2.1, 3, 6] }] })).toThrow("NO_SAFE_PATH");
    expect(() => safe(base, motion, 5, { ...settings, followDeltas: [[0, 0, 0]], relativeObstacles: [{ min: [-1, 1, 4], max: [1, 3, 6] }] })).toThrow("NO_SAFE_PATH");
    expect(safe(base, motion, 5, { ...settings, followDeltas: [[0, 0, 0], [1, 0, 0]] }).amplitudeScale).toBe(1);
  });
  it("rejects malformed safety bounds rather than skipping them", () => {
    expect(() => safe(base, { kind: "locked" }, 5, { ...settings, obstacles: [{ min: [NaN, 0, 0], max: [1, 1, 1] }] })).toThrow("SAFETY_INVALID");
  });
});
