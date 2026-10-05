import { describe, expect, it } from "vitest";
import { sampleSpringGeometryTrack, type SpringGeometryTrack } from "./springGeometryTrack";
import type { SpringTargetTrack } from "./springTargetTrack";

const property = (initialPosition: number, target = initialPosition, frame = 15): SpringTargetTrack => ({
  fps: 30, initialPosition, initialVelocity: 0, initialTarget: initialPosition,
  spring: { stiffness: 100, damping: 20, mass: 1 }, events: target === initialPosition ? [] : [{ frame, target }],
});
const morph = (): SpringGeometryTrack => ({
  localId: "original-circle-to-card",
  envelope: { x: 0, y: 0, width: 400, height: 400 },
  left: property(80, 20), right: { ...property(140, 300, 18), spring: { stiffness: 120, damping: 12, mass: 1 } },
  top: property(90, 100), bottom: property(150, 260), cornerRadius: property(30, 8),
});

describe("bounded rounded rectangle spring geometry", () => {
  it("morphs a circle into a card using one contour and unchanged property tracks", () => {
    const value = morph(), authored = JSON.stringify(value);
    expect(sampleSpringGeometryTrack(value, 0).geometry).toEqual({ x: 80, y: 90, width: 60, height: 60, cornerRadius: 30 });
    const middle = sampleSpringGeometryTrack(value, 24).geometry;
    expect(middle.width).toBeGreaterThan(60);
    expect(middle.height).toBeGreaterThan(60);
    expect(middle.cornerRadius).toBeLessThan(30);
    const settled = sampleSpringGeometryTrack(value, 180).geometry;
    expect(settled.x).toBeCloseTo(20, 3);
    expect(settled.y).toBeCloseTo(100, 3);
    expect(settled.width).toBeCloseTo(280, 3);
    expect(settled.height).toBeCloseTo(160, 3);
    expect(settled.cornerRadius).toBeCloseTo(8, 3);
    expect(JSON.stringify(value)).toBe(authored);
    for (const frame of [0, 15, 24, 180]) {
      const sample = sampleSpringGeometryTrack(value, frame);
      expect(sample.localId).toBe(value.localId);
      expect(sample.envelope).toEqual(value.envelope);
      expect(sample.envelope).not.toBe(value.envelope);
    }
  });

  it("allows a leading edge to move before its trailing edge starts", () => {
    const sample = sampleSpringGeometryTrack(morph(), 17);
    expect(sample.geometry.x).toBeLessThan(80);
    expect(sample.geometry.x + sample.geometry.width).toBe(140);
    expect(sample.velocity.x).toBeLessThan(0);
    expect(sample.velocity.x + sample.velocity.width).toBe(0);
  });

  it("is seek-order independent and preserves geometry and derivative continuity", () => {
    const value = morph(), frames = [0, 15, 17, 18, 24, 45, 180];
    const samples = new Map(frames.map(frame => [frame, sampleSpringGeometryTrack(value, frame)]));
    for (const frame of [45, 15, 0, 180, 17, 24, 18]) expect(sampleSpringGeometryTrack(value, frame)).toEqual(samples.get(frame));
    for (const frame of [15, 18]) {
      const before = sampleSpringGeometryTrack(value, frame - 30 * 1e-7), beforeFar = sampleSpringGeometryTrack(value, frame - 30 * 2e-7);
      const after = sampleSpringGeometryTrack(value, frame + 30 * 1e-7), afterFar = sampleSpringGeometryTrack(value, frame + 30 * 2e-7);
      for (const field of ["geometry", "velocity"] as const) for (const key of ["x", "y", "width", "height", "cornerRadius"] as const) {
        // Fixed 1e-7-second one-sided limit probes remove real local slopes.
        const a = 2 * before[field][key] - beforeFar[field][key], b = 2 * after[field][key] - afterFar[field][key];
        expect(Math.abs(a - b) / Math.max(1, Math.abs(a), Math.abs(b))).toBeLessThan(1e-5);
      }
      const prefix = { ...value };
      for (const key of ["left", "top", "right", "bottom", "cornerRadius"] as const) {
        prefix[key] = { ...value[key], events: value[key].events.filter(event => event.frame < frame) };
      }
      expect(sampleSpringGeometryTrack(value, frame)).toEqual(sampleSpringGeometryTrack(prefix, frame));
    }
  });

  it("fails closed when a physically overshooting edge leaves the fixed envelope", () => {
    const value = morph();
    value.envelope.width = 300;
    value.left = property(30);
    value.right = { ...property(100, 240, 0), spring: { stiffness: 100, damping: 0, mass: 1 } };
    value.cornerRadius = property(8);
    // A zero-damping step reaches twice its target displacement after half a period.
    expect(() => sampleSpringGeometryTrack(value, 30 * Math.PI / 10)).toThrow(/envelope/);
  });

  it("refuses collapsed/inverted edges and illegal radius instead of clamping", () => {
    expect(() => sampleSpringGeometryTrack({ ...morph(), left: property(140) }, 0)).toThrow(/collapsed/);
    expect(() => sampleSpringGeometryTrack({ ...morph(), left: property(150) }, 0)).toThrow(/inverted/);
    expect(() => sampleSpringGeometryTrack({ ...morph(), cornerRadius: property(31) }, 0)).toThrow(/radius/);
    expect(() => sampleSpringGeometryTrack({ ...morph(), cornerRadius: property(-1) }, 0)).toThrow(/radius/);
  });

  it("rejects invalid envelopes and mixed frame rates", () => {
    const value = morph();
    for (const width of [0, -1, Infinity, NaN]) expect(() => sampleSpringGeometryTrack({ ...value, envelope: { ...value.envelope, width } }, 0)).toThrow(/envelope/);
    expect(() => sampleSpringGeometryTrack({ ...value, right: { ...value.right, fps: 24 } }, 0)).toThrow(/same fps/);
    expect(() => sampleSpringGeometryTrack({ ...value, localId: " " }, 0)).toThrow(/localId/);
    expect(() => sampleSpringGeometryTrack({ ...value, localId: "a".repeat(81) }, 0)).toThrow(/localId/);
  });

  it("rejects finite authored velocities whose combined width derivative overflows", () => {
    const value = morph();
    value.left = { ...value.left, initialVelocity: -Number.MAX_VALUE };
    value.right = { ...value.right, initialVelocity: Number.MAX_VALUE };
    expect(() => sampleSpringGeometryTrack(value, 0)).toThrow(/numeric range/);
  });
});
