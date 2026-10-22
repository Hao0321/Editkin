import { describe, expect, it } from "vitest";
import { assertSpringTargetTrack, sampleSpringTargetTrack, type SpringTargetTrack } from "./springTargetTrack";

const track = (changes: Partial<SpringTargetTrack> = {}): SpringTargetTrack => ({
  fps: 30, initialPosition: 12, initialVelocity: 3, initialTarget: 60,
  spring: { stiffness: 120, damping: 12, mass: 1 },
  events: [{ frame: 22, target: -20 }, { frame: 49, target: 35 }], ...changes,
});
const atSeconds = (value: SpringTargetTrack, seconds: number) => sampleSpringTargetTrack(value, seconds * value.fps);
const relativeDifference = (a: number, b: number) => Math.abs(a - b) / Math.max(1, Math.abs(a), Math.abs(b));
const extrapolatedLimit = (value: SpringTargetTrack, seconds: number, side: -1 | 1) => {
  const near = atSeconds(value, seconds + side * 1e-7), far = atSeconds(value, seconds + side * 2e-7);
  // Estimate each one-sided limit, removing physical acceleration over the
  // fixed probe interval. Comparing raw velocities would mislabel a C1 spring
  // starting at rest as a jump solely because its acceleration is nonzero.
  return { position: 2 * near.position - far.position, velocity: 2 * near.velocity - far.velocity };
};

describe("original analytical spring target track", () => {
  it("keeps position and velocity continuous across every retarget, including frame zero", () => {
    const value = track({ events: [{ frame: 0, target: 80 }, { frame: 22, target: -20 }, { frame: 49, target: 35 }] });
    expect(sampleSpringTargetTrack(value, 0)).toEqual({ position: value.initialPosition, velocity: value.initialVelocity });
    for (const event of value.events.filter(event => event.frame > 0)) {
      const seconds = event.frame / value.fps;
      const before = extrapolatedLimit(value, seconds, -1);
      const after = extrapolatedLimit(value, seconds, 1);
      expect(relativeDifference(before.position, after.position)).toBeLessThan(1e-5);
      expect(relativeDifference(before.velocity, after.velocity)).toBeLessThan(1e-5);
      const prefix = { ...value, events: value.events.filter(item => item.frame < event.frame) };
      expect(sampleSpringTargetTrack(value, event.frame)).toEqual(sampleSpringTargetTrack(prefix, event.frame));
    }
  });

  it("rejects the physically wrong hard reset control at a moving retarget", () => {
    const value = track();
    const event = value.events[0];
    const prior = sampleSpringTargetTrack({ ...value, events: [] }, event.frame);
    expect(Math.abs(prior.velocity)).toBeGreaterThan(1);
    // A common reset mistake keeps the pixel position but drops its momentum.
    const hardReset = track({ initialPosition: prior.position, initialVelocity: 0, initialTarget: event.target, events: [] });
    const resetStart = extrapolatedLimit(hardReset, 0, 1);
    const candidate = extrapolatedLimit(value, event.frame / value.fps, -1);
    expect(relativeDifference(candidate.position, resetStart.position)).toBeLessThan(1e-5);
    expect(relativeDifference(candidate.velocity, resetStart.velocity)).toBeGreaterThan(.1);
    const continuation = sampleSpringTargetTrack(value, event.frame + 1);
    const resetContinuation = sampleSpringTargetTrack(hardReset, 1);
    expect(Math.abs(continuation.position - resetContinuation.position)).toBeGreaterThan(.05);
  });

  it("returns identical samples after nonmonotonic seeks without mutating authored data", () => {
    const value = track();
    Object.freeze(value.spring);
    value.events.forEach(Object.freeze);
    Object.freeze(value.events);
    Object.freeze(value);
    const frames = [0, .125, 21.7, 22, 22.25, 49, 70, 160];
    const forward = new Map(frames.map(frame => [frame, sampleSpringTargetTrack(value, frame)]));
    for (const frame of [70, 22.25, 0, 160, .125, 49, 21.7, 22, 70]) {
      expect(sampleSpringTargetTrack(value, frame)).toEqual(forward.get(frame));
    }
  });

  it.each([24, 30, 60, 24000 / 1001])("preserves physical timing and velocity at %s fps", fps => {
    const baseline = track({ fps: 30, events: [{ frame: 30, target: -20 }, { frame: 60, target: 35 }] });
    // Noninteger rates have exact integer-frame authoring, so compare a common
    // single-target span; the three integer rates also compare retarget spans.
    const value = track({ fps, events: Number.isInteger(fps) ? [{ frame: fps, target: -20 }, { frame: fps * 2, target: 35 }] : [] });
    const reference = Number.isInteger(fps) ? baseline : { ...baseline, events: [] };
    for (const seconds of [.037, .37, .83, 1, 1.31, 2, 2.45]) {
      const actual = atSeconds(value, seconds), expected = atSeconds(reference, seconds);
      expect(actual.position).toBeCloseTo(expected.position, 10);
      expect(actual.velocity).toBeCloseTo(expected.velocity, 10);
    }
  });

  it.each([0, 8, 20, 50])("satisfies the oscillator equation and finite-difference velocity with damping %s", damping => {
    const value = track({ initialPosition: -4, initialVelocity: 7, initialTarget: 20, spring: { stiffness: 100, damping, mass: 1 }, events: [] });
    const h = 1e-5;
    for (const seconds of [.07, .23, .61, 1.2]) {
      const before = atSeconds(value, seconds - h), sample = atSeconds(value, seconds), after = atSeconds(value, seconds + h);
      expect(Number.isFinite(sample.position) && Number.isFinite(sample.velocity)).toBe(true);
      expect((after.position - before.position) / (2 * h)).toBeCloseTo(sample.velocity, 4);
      const acceleration = (after.velocity - before.velocity) / (2 * h);
      const residual = value.spring.mass * acceleration + damping * sample.velocity + value.spring.stiffness * (sample.position - value.initialTarget);
      expect(Math.abs(residual)).toBeLessThan(1e-3);
    }
  });

  it("conserves mechanical energy at zero damping and loses it with positive damping", () => {
    const energy = (value: SpringTargetTrack, seconds: number) => {
      const sample = atSeconds(value, seconds);
      return .5 * value.spring.mass * sample.velocity ** 2 + .5 * value.spring.stiffness * (sample.position - value.initialTarget) ** 2;
    };
    const undamped = track({ spring: { stiffness: 100, damping: 0, mass: 1 }, events: [] });
    const initialEnergy = energy(undamped, 0);
    for (const seconds of [.01, .2, 1, 5, 20]) expect(energy(undamped, seconds)).toBeCloseTo(initialEnergy, 7);
    const damped = { ...undamped, spring: { ...undamped.spring, damping: 8 } };
    let previousEnergy = energy(damped, 0);
    for (const seconds of [.01, .2, 1, 5]) {
      const currentEnergy = energy(damped, seconds);
      expect(currentEnergy).toBeLessThan(previousEnergy);
      previousEnergy = currentEnergy;
    }
  });

  it("remains stable around critical damping and at the strongest overdamped bounds", () => {
    const critical = track({ spring: { stiffness: 100, damping: 20, mass: 1 }, events: [] });
    for (const damping of [20 - 1e-10, 20 + 1e-10]) {
      const neighbor = { ...critical, spring: { ...critical.spring, damping } };
      for (const seconds of [1e-7, .1, 1, 10]) {
        const expected = atSeconds(critical, seconds), actual = atSeconds(neighbor, seconds);
        expect(actual.position).toBeCloseTo(expected.position, 7);
        expect(actual.velocity).toBeCloseTo(expected.velocity, 7);
      }
    }
    const slow = track({ spring: { stiffness: 1, damping: 100, mass: .05 }, events: [] });
    for (const seconds of [1e-7, 1, 100, 1000]) {
      const sample = atSeconds(slow, seconds);
      expect(Number.isFinite(sample.position) && Number.isFinite(sample.velocity)).toBe(true);
    }
    expect(atSeconds(slow, 2000).position).toBeCloseTo(slow.initialTarget, 4);
    expect(atSeconds(slow, 2000).velocity).toBeCloseTo(0, 5);
  });

  it("accepts exactly 32 events and refuses a 33rd", () => {
    const events = Array.from({ length: 32 }, (_, frame) => ({ frame, target: frame % 2 ? 10 : -10 }));
    expect(() => assertSpringTargetTrack(track({ events }))).not.toThrow();
    expect(() => assertSpringTargetTrack(track({ events: [...events, { frame: 32, target: 0 }] }))).toThrow(/at most 32/);
  });

  it("rejects finite extrema when arithmetic exceeds its numeric range", () => {
    const value = track({ initialPosition: Number.MAX_VALUE, initialTarget: Number.MAX_VALUE, initialVelocity: Number.MAX_VALUE, events: [] });
    expect(sampleSpringTargetTrack(value, 0)).toEqual({ position: Number.MAX_VALUE, velocity: Number.MAX_VALUE });
    expect(() => sampleSpringTargetTrack(value, 3)).toThrow(/numeric range/);
    expect(() => sampleSpringTargetTrack(track({ initialTarget: Number.MAX_VALUE, initialPosition: Number.MAX_VALUE,
      events: [{ frame: 1, target: -Number.MAX_VALUE }] }), 3)).toThrow(/target delta numeric range/);
  });

  it.each([
    { fps: 0 }, { fps: 241 }, { fps: Infinity }, { initialPosition: NaN }, { initialVelocity: Infinity }, { initialTarget: NaN },
    { spring: { stiffness: 0, damping: 1, mass: 1 } }, { spring: { stiffness: 1001, damping: 1, mass: 1 } },
    { spring: { stiffness: 100, damping: -1, mass: 1 } }, { spring: { stiffness: 100, damping: 101, mass: 1 } },
    { spring: { stiffness: 100, damping: 1, mass: 0 } }, { spring: { stiffness: 100, damping: 1, mass: 11 } },
    { events: [{ frame: .5, target: 1 }] }, { events: [{ frame: -1, target: 1 }] },
    { events: [{ frame: 2, target: 1 }, { frame: 2, target: 3 }] },
    { events: [{ frame: 3, target: 1 }, { frame: 2, target: 3 }] }, { events: [{ frame: 2, target: Infinity }] },
    { initialPosition: Number.MAX_VALUE, initialTarget: -Number.MAX_VALUE },
  ] as Partial<SpringTargetTrack>[])("fails closed for invalid authoring %#", change => {
    expect(() => sampleSpringTargetTrack(track(change), 1)).toThrow();
  });

  it.each([-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("refuses invalid sample time %s", frame => {
    expect(() => sampleSpringTargetTrack(track(), frame)).toThrow(/frameTime/);
  });
});
