import { describe, expect, it } from "vitest";
import { MOTION_CURVES as LANGUAGE_CURVES, MOTION_ENERGY_PROFILES as LANGUAGE_PROFILES } from "../../motion/motionLanguage";
import {
  MOTION_CURVES, MOTION_ENERGY_PROFILES, animate, backOut, clamp, cubicInOut, curve, elasticOut, energyProfile, expoInOut, expoOut,
  impulse, lerp, loopPhase, pingPong, pulse, quartIn, quartInOut, quartOut, smoothstep, spring, wrap,
} from "./easing";

describe("motion library easing", () => {
  it("re-exports the Motion Language v1 vocabulary unchanged", () => {
    expect(MOTION_CURVES).toBe(LANGUAGE_CURVES);
    expect(MOTION_ENERGY_PROFILES).toBe(LANGUAGE_PROFILES);
    expect(energyProfile("hype")).toEqual({ tier: 3, amplitude: 1.7, scaleDepth: 1.6, time: 0.85 });
    expect(curve("expoOut", 0)).toBeCloseTo(0, 3); // Motion Language bezier: 16-step bisection, not exactly 0
    expect(curve("expoOut", 1)).toBeCloseTo(1, 6);
    expect(curve("backOut", 0.5)).toBeGreaterThan(1);
  });
  it("curves start at 0 and end at 1", () => {
    for (const fn of [cubicInOut, quartInOut, expoOut, expoInOut, (p: number) => backOut(p), (p: number) => elasticOut(p)]) {
      expect(fn(0)).toBeCloseTo(0, 9);
      expect(fn(1)).toBeCloseTo(1, 9);
    }
    expect(Math.max(...Array.from({ length: 101 }, (_, index) => backOut(index / 100)))).toBeGreaterThan(1.05);
    expect(quartInOut(0.5)).toBeCloseTo(0.5, 9);
  });
  it("spring settles at 1 and overshoots when underdamped", () => {
    expect(spring(0)).toBe(0);
    expect(spring(-1)).toBe(0);
    expect(spring(3, 170, 26)).toBeCloseTo(1, 4);
    const samples = Array.from({ length: 200 }, (_, index) => spring(index / 100, 300, 10));
    expect(Math.max(...samples)).toBeGreaterThan(1.1);
    expect(spring(5, 100, 20)).toBeCloseTo(1, 4); // critically damped
    expect(spring(8, 100, 40)).toBeCloseTo(1, 3); // overdamped
    expect(() => spring(1, 0, 1)).toThrow();
  });
  it("helpers", () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(lerp(10, 20, 0.25)).toBe(12.5);
    expect(smoothstep(0, 1, 0.5)).toBe(0.5);
    expect(wrap(-1, 4)).toBe(3);
    expect(loopPhase(8, 4)).toBe(0);
    expect(pingPong(0.5, 2)).toBe(0.5);
    expect(pulse(1, 1, 0.5)).toBe(1);
    expect(pulse(2, 1, 0.5)).toBe(0);
    expect(impulse(1, 1, 0.1, 0.2)).toBe(0);
    expect(impulse(1.1, 1, 0.1, 0.2)).toBeCloseTo(1, 9);
    expect(impulse(1.3, 1, 0.1, 0.2)).toBeCloseTo(0, 9);
    const keys = [{ t: 0, v: 0 }, { t: 1, v: 10 }, { t: 2, v: 10 }, { t: 3, v: 0, ease: cubicInOut }];
    expect(animate(-1, keys)).toBe(0);
    expect(animate(0.5, keys)).toBe(5);
    expect(animate(1.5, keys)).toBe(10);
    expect(animate(2.5, keys)).toBe(5);
    expect(animate(9, keys)).toBe(0);
  });
});

describe("quartIn", () => {
  it("is p⁴ on [0, 1], clamped, and mirrors quartOut", () => {
    expect([quartIn(0), quartIn(0.5), quartIn(1)]).toEqual([0, 0.0625, 1]);
    expect([quartIn(-1), quartIn(2)]).toEqual([0, 1]);
    for (const p of [0.1, 0.3, 0.7]) expect(quartIn(p)).toBeCloseTo(1 - quartOut(1 - p), 12);
  });
});
