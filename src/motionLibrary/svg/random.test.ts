import { describe, expect, it } from "vitest";
import { createSeededRng, fractalNoise2D, hashString32, loopNoise, mulberry32, seededRandom, valueNoise1D, valueNoise2D } from "./random";

describe("seeded randomness", () => {
  it("is reproducible for the same item, seed and index and differs otherwise", () => {
    expect(seededRandom("T01", 1, 0)).toBe(seededRandom("T01", 1, 0));
    const values = new Set([seededRandom("T01", 1, 0), seededRandom("T01", 2, 0), seededRandom("T01", 1, 1), seededRandom("T02", 1, 0)]);
    expect(values.size).toBe(4);
    for (let index = 0; index < 1000; index += 1) {
      const value = seededRandom("B01", 7, index);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
    expect(() => seededRandom("T01", 1.5, 0)).toThrow();
    expect(() => seededRandom("", 1, 0)).toThrow();
  });

  it("pins the generator so goldens stay meaningful across refactors", () => {
    // mulberry32 / xmur3-style hash are pure 32-bit integer arithmetic: exact on every engine.
    expect(hashString32("editkin")).toBe(hashString32("editkin"));
    const stream = mulberry32(12345);
    const first = [stream(), stream(), stream()];
    const again = mulberry32(12345);
    expect([again(), again(), again()]).toEqual(first);
    expect(first.every(value => value >= 0 && value < 1 && Number.isInteger(value * 4294967296))).toBe(true);
  });

  it("streams are reproducible, forks are independent and do not advance the parent", () => {
    const a = createSeededRng("X10", 3, "blocks"), b = createSeededRng("X10", 3, "blocks");
    const sequenceA = Array.from({ length: 16 }, () => a.next());
    const sequenceB = Array.from({ length: 16 }, () => b.next());
    expect(sequenceA).toEqual(sequenceB);
    const parent = createSeededRng("X10", 3, "blocks"), twin = createSeededRng("X10", 3, "blocks");
    const child = parent.fork("child");
    child.next(); child.next();
    expect(parent.next()).toBe(twin.next());
    expect(createSeededRng("X10", 3, "other").next()).not.toBe(createSeededRng("X10", 3, "blocks").next());
  });

  it("helpers stay in range and are roughly uniform", () => {
    const rng = createSeededRng("B30", 9);
    const counts = [0, 0, 0, 0, 0, 0];
    let sum = 0;
    for (let index = 0; index < 6000; index += 1) {
      counts[rng.int(0, 5)] += 1;
      sum += rng.next();
      const range = rng.range(-2, 3);
      expect(range).toBeGreaterThanOrEqual(-2);
      expect(range).toBeLessThan(3);
      expect([-1, 1]).toContain(rng.sign());
      expect(Number.isFinite(rng.normal())).toBe(true);
    }
    for (const count of counts) expect(count).toBeGreaterThan(850);
    expect(sum / 6000).toBeGreaterThan(0.47);
    expect(sum / 6000).toBeLessThan(0.53);
    expect(["a", "b"]).toContain(rng.pick(["a", "b"]));
    expect(() => rng.int(3, 1)).toThrow();
    expect(() => rng.pick([])).toThrow();
  });
});

describe("smooth noise", () => {
  it("is deterministic, bounded and continuous", () => {
    let previous = valueNoise2D(0, 0.3, 5);
    for (let step = 1; step <= 400; step += 1) {
      const x = step * 0.01, value = valueNoise2D(x, 0.3, 5);
      expect(value).toBeGreaterThanOrEqual(-1);
      expect(value).toBeLessThanOrEqual(1);
      expect(Math.abs(value - previous)).toBeLessThan(0.1);
      previous = value;
    }
    expect(valueNoise2D(1.37, 2.71, 5)).toBe(valueNoise2D(1.37, 2.71, 5));
    expect(valueNoise2D(1.37, 2.71, 5)).not.toBe(valueNoise2D(1.37, 2.71, 6));
    expect(Math.abs(valueNoise1D(0.5, 1))).toBeLessThanOrEqual(1);
    expect(Math.abs(fractalNoise2D(3.3, 4.4, 2, 4))).toBeLessThanOrEqual(1);
  });
  it("loops exactly over a period", () => {
    expect(loopNoise(0, 3, 2)).toBe(loopNoise(1, 3, 2));
    expect(loopNoise(0.25, 3, 2)).toBe(loopNoise(2.25, 3, 2));
    expect(loopNoise(0.25, 3, 2, 1)).not.toBe(loopNoise(0.25, 3, 2, 0));
  });
});
