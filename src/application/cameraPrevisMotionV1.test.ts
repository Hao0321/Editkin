import { describe, expect, it } from "vitest";
import { prepareCameraPrevisMotionV1 as prepare, previsArcHullV1, type CameraPrevisMotionV1 } from "./cameraPrevisMotionV1";
import type { Mesh3dCamera } from "../motion/mesh3dScene";

const base: Mesh3dCamera = { position: [0, 2, 6], target: [0, 2, 0], verticalFovDegrees: 45, near: .1, far: 50 };
describe("continuous previs camera paths", () => {
  it.each(["dolly", "truck", "pedestal"] as const)("uses one globally eased %s move", kind => {
    const path = prepare(base, { kind, distance: 2, easing: "smooth" }, 5);
    expect(path.sample(0)).toEqual(base);
    const middle = path.sample(2.5).position;
    expect(middle).toEqual(kind === "dolly" ? [0, 2, 5] : kind === "truck" ? [1, 2, 6] : [0, 3, 6]);
    const step = (t: number) => Math.hypot(...path.sample(t + .0001).position.map((v, i) => v - path.sample(t).position[i]));
    expect(step(2.5)).toBeGreaterThan(step(.001) * 1000);
    for (const t of [1.25, 2.5, 3.75]) expect(step(t)).toBeGreaterThan(.00001);
  });
  it("orbits analytically with a constant radius and preserves offset composition", () => {
    const path = prepare({ ...base, target: [.5, 2, 0] }, { kind: "orbit", degrees: 120, pivot: [0, 2, 0], easing: "linear" }, 5);
    for (const t of [0, .17, 1, 2.5, 4.9, 5]) {
      const c = path.sample(t), a = 120 * Math.PI / 180 * t / 5;
      expect(c.position[0]).toBeCloseTo(6 * Math.sin(a), 12); expect(c.position[2]).toBeCloseTo(6 * Math.cos(a), 12);
      expect(Math.hypot(...c.position.map((n, i) => n - [0, 2, 0][i]))).toBeCloseTo(6, 12);
      expect(c.target[0]).toBeCloseTo(.5 * Math.cos(a), 12);
    }
  });
  it.each(["pan", "tilt"] as const)("keeps %s eye fixed and uses angular movement", kind => {
    const path = prepare(base, { kind, degrees: 30, easing: "linear" }, 5), c = path.sample(2.5);
    expect(c.position).toEqual(base.position); expect(Math.hypot(...c.target.map((v, i) => v - c.position[i]))).toBeCloseTo(6, 12);
    expect(c.target[kind === "pan" ? 0 : 1]).not.toBe(base.target[kind === "pan" ? 0 : 1]);
  });
  it("uses explicit actual subject displacement for follow, without a guessed speed", () => {
    const path = prepare(base, { kind: "follow", objectId: "person" }, 5);
    expect(() => path.sample(1)).toThrow("CONTEXT_REQUIRED");
    expect(path.sample(2, [1, .2, -3]).position).toEqual([1, 2.2, 3]);
    expect(path.sample(2, [1, .2, -3]).target).toEqual([1, 2.2, -3]);
  });
  it("is deterministic under seeking and caller mutation", () => {
    const b = structuredClone(base), m: CameraPrevisMotionV1 = { kind: "orbit", degrees: 90, easing: "smooth" }, path = prepare(b, m, 5);
    const saved = path.sample(2); b.position[0] = 99; m.degrees = -90; path.descriptor.base.position[0] = 99;
    path.sample(5); path.sample(0); expect(path.sample(2)).toEqual(saved);
    expect(path.sample(-1)).toEqual(base);
  });
  it("includes arc interior extrema rather than just endpoints", () => {
    const bounds = previsArcHullV1([5, 2, 5], [0, 0, 0], 0, Math.PI / 2);
    expect(bounds.max[0]).toBeCloseTo(Math.sqrt(50), 12); expect(bounds.min[2]).toBeCloseTo(-5, 12);
  });
  it.each([
    [base, { kind: "tilt", degrees: 90, easing: "linear" }, 5],
    [base, { kind: "dolly", distance: 7, easing: "smooth" }, 5],
    [{ ...base, target: [0, 3, 6] }, { kind: "locked" }, 5],
    [base, { kind: "locked", distance: 1 }, 5],
    [base, { kind: "locked" }, NaN],
  ])("rejects invalid camera/path/descriptor %j", (b, m, d) => expect(() => prepare(b, m, d as number)).toThrow());
});
