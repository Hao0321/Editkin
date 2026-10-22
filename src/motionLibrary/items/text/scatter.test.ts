import { describe, expect, it } from "vitest";
import { scatterOffsets, scatterPose, springSettle, type ScatterTarget } from "./scatter";

const frame = { width: 1080, height: 1920 };
const word: ScatterTarget[] = [0, 1, 2, 3, 4].map(index => ({ x: 340 + index * 100, y: 960 + (index % 2) * 20, halfWidth: 45, halfHeight: 45 }));
const base = { itemId: "T44", seed: 7, frame } as const;
const angleBetween = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

describe("scatterOffsets", () => {
  it("radial: travels away from the word centre within the spread and the default 0.6–0.9 frame widths", () => {
    const center = { x: 540, y: 970 };
    const offsets = scatterOffsets(word, { ...base, mode: "radial", center, spreadDegrees: 25 });
    offsets.forEach((offset, index) => {
      const away = (Math.atan2(word[index].y - center.y, word[index].x - center.x) * 180) / Math.PI;
      expect(angleBetween(offset.directionDegrees, away)).toBeLessThanOrEqual(25 + 1e-9);
      const travel = Math.hypot(offset.dx, offset.dy);
      expect(travel).toBeGreaterThanOrEqual(0.6 * frame.width);
      expect(travel).toBeLessThanOrEqual(0.9 * frame.width);
    });
    // The centre target (on the centre) gets a seeded direction instead of NaN.
    const onCentre = scatterOffsets([{ x: 540, y: 970 }], { ...base, mode: "radial", center });
    expect(Number.isFinite(onCentre[0].dx) && Number.isFinite(onCentre[0].directionDegrees)).toBe(true);
  });
  it("field: lands in the disc (default radius up to half the short side)", () => {
    const offsets = scatterOffsets(word, { ...base, mode: "field" });
    for (const offset of offsets) expect(Math.hypot(offset.dx, offset.dy)).toBeLessThanOrEqual(0.5 * frame.width + 1e-9);
    const ring = scatterOffsets(word, { ...base, mode: "field", distance: [200, 300] });
    for (const offset of ring) {
      expect(Math.hypot(offset.dx, offset.dy)).toBeGreaterThanOrEqual(200 - 1e-9);
      expect(Math.hypot(offset.dx, offset.dy)).toBeLessThanOrEqual(300 + 1e-9);
    }
  });
  it("sides: the first half leaves past the left edge, the second past the right, fully off-frame", () => {
    const offsets = scatterOffsets(word, { ...base, mode: "sides", margin: 10, verticalJitter: 0.1 });
    offsets.forEach((offset, index) => {
      const target = word[index], x = target.x + offset.dx;
      // Index 2 is the middle character of five: its side is seeded.
      const left = index < 2 || (index === 2 && offset.dx < 0);
      if (left) expect(x + target.halfWidth!).toBeCloseTo(-10, 9);
      else expect(x - target.halfWidth!).toBeCloseTo(frame.width + 10, 9);
      expect(Math.abs(offset.dy)).toBeLessThanOrEqual(0.1 * frame.height);
    });
    const even = scatterOffsets(word.slice(0, 4), { ...base, mode: "sides" });
    expect(even.map(offset => Math.sign(offset.dx))).toEqual([-1, -1, 1, 1]);
  });
  it("seeds rotation and scale ranges with a random sign", () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ x: 100 + index * 80, y: 900 }));
    const offsets = scatterOffsets(many, { ...base, mode: "radial", rotation: [90, 200], scale: [1.5, 1.8] });
    for (const offset of offsets) {
      expect(Math.abs(offset.rotation)).toBeGreaterThanOrEqual(90);
      expect(Math.abs(offset.rotation)).toBeLessThanOrEqual(200);
      expect(offset.scale).toBeGreaterThanOrEqual(1.5);
      expect(offset.scale).toBeLessThanOrEqual(1.8);
    }
    expect(new Set(offsets.map(offset => Math.sign(offset.rotation))).size).toBe(2);
    expect(scatterOffsets(word, { ...base, mode: "field" }).every(offset => offset.rotation === 0 && offset.scale === 1)).toBe(true);
  });
  it("is deterministic per (item, seed, stream) and stable when characters are added", () => {
    const a = scatterOffsets(word, { ...base, mode: "field" });
    expect(scatterOffsets(word, { ...base, mode: "field" })).toEqual(a);
    expect(scatterOffsets([...word, { x: 900, y: 900 }], { ...base, mode: "field" }).slice(0, word.length)).toEqual(a);
    expect(scatterOffsets(word, { ...base, mode: "field", stream: "out" })).not.toEqual(a);
    expect(scatterOffsets(word, { ...base, mode: "field", seed: 8 })).not.toEqual(a);
    expect(Object.isFrozen(a) && Object.isFrozen(a[0])).toBe(true);
  });
  it("validates its inputs", () => {
    expect(() => scatterOffsets(word, { ...base, mode: "field", frame: { width: 0, height: 10 } })).toThrow(/frame/);
    expect(() => scatterOffsets(word, { ...base, mode: "field", distance: [5, 1] })).toThrow(/distance/);
    expect(scatterOffsets([], { ...base, mode: "radial" })).toEqual([]);
  });
});

describe("scatterPose", () => {
  it("interpolates from the scattered pose (p = 0) to home (p = 1) and clamps", () => {
    const offset = { index: 0, dx: 100, dy: -40, rotation: 90, scale: 2, directionDegrees: 0 };
    expect(scatterPose(offset, 0)).toEqual({ dx: 100, dy: -40, rotation: 90, scale: 2 });
    expect(scatterPose(offset, 0.25)).toEqual({ dx: 75, dy: -30, rotation: 67.5, scale: 1.75 });
    const home = scatterPose(offset, 1);
    expect([home.dx, home.dy, home.rotation, home.scale].map(value => value + 0)).toEqual([0, 0, 0, 1]);
    expect(scatterPose(offset, -1)).toEqual(scatterPose(offset, 0));
    expect(scatterPose(offset, 3)).toEqual(scatterPose(offset, 1));
  });
});

describe("springSettle", () => {
  it("starts at 0, overshoots about 16% at ζ = 0.5 and is exactly 1 from the settle time", () => {
    expect(springSettle(0)).toBe(0);
    expect(springSettle(-1)).toBe(0);
    let peak = 0;
    for (let t = 0; t <= 2; t += 0.001) peak = Math.max(peak, springSettle(t));
    expect(peak).toBeGreaterThan(1.14);
    expect(peak).toBeLessThan(1.18);
    const settle = 4.6 / (0.5 * 2 * Math.PI * 2.2);
    expect(springSettle(settle)).toBe(1);
    expect(springSettle(settle + 5)).toBe(1);
    expect(springSettle(0.3, { settleSeconds: 0.3 })).toBe(1);
  });
  it("is continuous through the blend-out and never overshoots when damping ≥ 1", () => {
    const settle = 4.6 / (0.5 * 2 * Math.PI * 2.2);
    for (let t = 0.7 * settle; t < settle; t += 0.0005) expect(Math.abs(springSettle(t + 0.0005) - springSettle(t))).toBeLessThan(0.005);
    for (const damping of [1, 1.6]) {
      let previous = 0;
      for (let t = 0; t <= 2; t += 0.01) {
        const value = springSettle(t, { damping, frequency: 3 });
        expect(value).toBeLessThanOrEqual(1);
        expect(value).toBeGreaterThanOrEqual(previous - 1e-12);
        previous = value;
      }
    }
    expect(() => springSettle(0.1, { damping: 0 })).toThrow(/damping/);
    expect(() => springSettle(0.1, { frequency: -1 })).toThrow(/frequency/);
  });
});
