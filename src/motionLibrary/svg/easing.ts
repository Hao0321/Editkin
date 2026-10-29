import { evaluateMotionGraphicV2Easing } from "../../motion/motionEasing";
import { MOTION_CURVES, MOTION_ENERGY_PROFILES, type MotionCurveName, type MotionEnergy } from "../../motion/motionLanguage";

/**
 * Easing for motion library generators. Editkin's Motion Language v1 curves and
 * energy profiles are re-exported read-only (one curve vocabulary); the small
 * helpers below are pure, deterministic functions of their inputs.
 */
export { evaluateMotionGraphicV2Easing, MOTION_CURVES, MOTION_ENERGY_PROFILES };
export type { MotionCurveName, MotionEnergy };

export type EnergyProfile = (typeof MOTION_ENERGY_PROFILES)[MotionEnergy];

/** amplitude scales offsets, scaleDepth scales |scale - 1|, time scales durations (Motion Language v1). */
export function energyProfile(energy: MotionEnergy): EnergyProfile {
  const profile = MOTION_ENERGY_PROFILES[energy];
  if (!profile) throw new Error(`Unknown motion energy: ${String(energy)}`);
  return profile;
}

/** Sample a named Motion Language curve at progress p (clamped to 0..1). */
export function curve(name: MotionCurveName, p: number): number {
  return evaluateMotionGraphicV2Easing(p, MOTION_CURVES[name]);
}

export const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
export const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Inverse lerp, unclamped. */
export const invLerp = (a: number, b: number, value: number): number => (a === b ? 0 : (value - a) / (b - a));
export function remap(value: number, inMin: number, inMax: number, outMin: number, outMax: number, clamped = true): number {
  const t = invLerp(inMin, inMax, value);
  return lerp(outMin, outMax, clamped ? clamp01(t) : t);
}
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01(invLerp(edge0, edge1, x));
  return t * t * (3 - 2 * t);
}
export function smootherstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01(invLerp(edge0, edge1, x));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Progress of t through [start, start + duration], clamped to 0..1. */
export function progress(t: number, start: number, duration: number): number {
  if (duration <= 0) return t >= start ? 1 : 0;
  return clamp01((t - start) / duration);
}

/** Positive modulo: wrap(t, period) in [0, period). */
export function wrap(t: number, period: number): number {
  if (!(period > 0)) throw new Error("wrap needs a positive period");
  const value = t % period;
  return value < 0 ? value + period : value;
}
/** Fractional loop phase in [0, 1); wrap01(k) === 0 exactly for integer k. */
export function loopPhase(t: number, period: number): number {
  return wrap(t, period) / period;
}
/** Triangle wave 0 → 1 → 0 over one period. */
export function pingPong(t: number, period: number): number {
  const phase = loopPhase(t, period);
  return phase < 0.5 ? phase * 2 : 2 - phase * 2;
}

// Classic Penner-style curves on p in 0..1 (clamped).
export const quadIn = (p: number) => clamp01(p) ** 2;
export const quadOut = (p: number) => 1 - (1 - clamp01(p)) ** 2;
export const quadInOut = (p: number) => { const x = clamp01(p); return x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2; };
export const cubicIn = (p: number) => clamp01(p) ** 3;
export const cubicOut = (p: number) => 1 - (1 - clamp01(p)) ** 3;
export const cubicInOut = (p: number) => { const x = clamp01(p); return x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2; };
export const quartIn = (p: number) => clamp01(p) ** 4;
export const quartOut = (p: number) => 1 - (1 - clamp01(p)) ** 4;
export const quartInOut = (p: number) => { const x = clamp01(p); return x < 0.5 ? 8 * x ** 4 : 1 - (-2 * x + 2) ** 4 / 2; };
export const sineIn = (p: number) => 1 - Math.cos((clamp01(p) * Math.PI) / 2);
export const sineOut = (p: number) => Math.sin((clamp01(p) * Math.PI) / 2);
export const sineInOut = (p: number) => -(Math.cos(Math.PI * clamp01(p)) - 1) / 2;
export const expoIn = (p: number) => { const x = clamp01(p); return x === 0 ? 0 : 2 ** (10 * x - 10); };
export const expoOut = (p: number) => { const x = clamp01(p); return x === 1 ? 1 : 1 - 2 ** (-10 * x); };
export const expoInOut = (p: number) => {
  const x = clamp01(p);
  if (x === 0 || x === 1) return x;
  return x < 0.5 ? 2 ** (20 * x - 10) / 2 : (2 - 2 ** (-20 * x + 10)) / 2;
};
/** Overshooting ease-out; overshoot 1.70158 gives about 10% overshoot. */
export const backOut = (p: number, overshoot = 1.70158) => { const x = clamp01(p) - 1; return 1 + (overshoot + 1) * x ** 3 + overshoot * x ** 2; };
/** Ease-in with a short wind-up below 0. */
export const backIn = (p: number, overshoot = 1.70158) => { const x = clamp01(p); return (overshoot + 1) * x ** 3 - overshoot * x ** 2; };
export const backInOut = (p: number, overshoot = 1.70158) => {
  const x = clamp01(p), c = overshoot * 1.525;
  return x < 0.5 ? ((2 * x) ** 2 * ((c + 1) * 2 * x - c)) / 2 : ((2 * x - 2) ** 2 * ((c + 1) * (x * 2 - 2) + c) + 2) / 2;
};
/** Elastic ease-out ending exactly at 1. amplitude >= 1; period as a fraction of the phase. */
export function elasticOut(p: number, amplitude = 1, period = 0.3): number {
  const x = clamp01(p);
  if (x === 0 || x === 1) return x;
  const a = Math.max(1, amplitude), s = (period / (2 * Math.PI)) * Math.asin(1 / a);
  return a * 2 ** (-10 * x) * Math.sin(((x - s) * 2 * Math.PI) / period) + 1;
}

/**
 * Damped spring from 0 to 1 at time tSeconds (analytic, deterministic).
 * stiffness k, damping c, mass m: underdamped when c < 2·sqrt(k·m).
 * Returns 0 for t <= 0; tends to 1.
 */
export function spring(tSeconds: number, stiffness = 170, damping = 26, mass = 1): number {
  if (!(stiffness > 0) || !(damping >= 0) || !(mass > 0)) throw new Error("spring needs stiffness > 0, damping >= 0, mass > 0");
  if (tSeconds <= 0) return 0;
  const omega = Math.sqrt(stiffness / mass), zeta = damping / (2 * Math.sqrt(stiffness * mass));
  if (zeta < 1) {
    const omegaD = omega * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * omega * tSeconds) * (Math.cos(omegaD * tSeconds) + ((zeta * omega) / omegaD) * Math.sin(omegaD * tSeconds));
  }
  if (zeta === 1) return 1 - Math.exp(-omega * tSeconds) * (1 + omega * tSeconds);
  const root = Math.sqrt(zeta * zeta - 1), r1 = -omega * (zeta - root), r2 = -omega * (zeta + root);
  const c2 = r1 / (r1 - r2), c1 = 1 - c2;
  return 1 - (c1 * Math.exp(r1 * tSeconds) + c2 * Math.exp(r2 * tSeconds));
}

/** Smooth bump: 0 outside [center - width, center + width], 1 at center (cosine window). */
export function pulse(t: number, center: number, width: number): number {
  if (!(width > 0)) return 0;
  const x = (t - center) / width;
  return Math.abs(x) >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * x);
}

/** Fast attack then exponential-ish decay: 0 before start, peak 1 at start + attack, back to 0 by start + attack + decay. */
export function impulse(t: number, start: number, attack: number, decay: number): number {
  if (t <= start) return 0;
  if (t < start + attack) return cubicOut((t - start) / attack);
  return 1 - cubicOut((t - start - attack) / Math.max(1e-9, decay));
}

export type EasingFunction = (p: number) => number;
/** A keyframe: value at time t; `ease` shapes the segment that ENDS at this key. */
export interface Keyframe { readonly t: number; readonly v: number; readonly ease?: EasingFunction }

/** Piecewise keyframe animation (holds the first/last value outside the range). Keys must be sorted by t. */
export function animate(t: number, keys: readonly Keyframe[]): number {
  if (!keys.length) throw new Error("animate needs at least one keyframe");
  if (t <= keys[0].t) return keys[0].v;
  for (let index = 1; index < keys.length; index += 1) {
    const to = keys[index];
    if (t < to.t) {
      const from = keys[index - 1];
      const p = (t - from.t) / Math.max(1e-9, to.t - from.t);
      return lerp(from.v, to.v, (to.ease ?? (x => x))(p));
    }
  }
  return keys[keys.length - 1].v;
}
