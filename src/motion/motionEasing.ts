import type { MotionGraphicV2Easing } from "../domain/types";

/**
 * Pure motionV2 easing kernel. Every v2 consumer (layout evaluator, Motion
 * Language, baked clip recipes) samples curves here so one formula exists.
 */

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

function cubicBezier(progress: number, easing: Extract<MotionGraphicV2Easing, { type: "cubic_bezier" }>): number {
  const sample = (time: number, p1: number, p2: number) => {
    const inverse = 1 - time;
    return 3 * inverse * inverse * time * p1 + 3 * inverse * time * time * p2 + time ** 3;
  };
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 16; iteration += 1) {
    const midpoint = (low + high) / 2;
    if (sample(midpoint, easing.x1, easing.x2) < progress) low = midpoint; else high = midpoint;
  }
  return sample((low + high) / 2, easing.y1, easing.y2);
}

function spring(progress: number, easing: Extract<MotionGraphicV2Easing, { type: "spring" }>): number {
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;
  const omega0 = Math.sqrt(easing.stiffness / easing.mass);
  const zeta = easing.damping / (2 * Math.sqrt(easing.stiffness * easing.mass));
  const initialDisplacement = -1;
  if (zeta < 1 - 1e-6) {
    const omegaD = omega0 * Math.sqrt(1 - zeta * zeta);
    const coefficient = (easing.initialVelocity + zeta * omega0 * initialDisplacement) / omegaD;
    const displacement = Math.exp(-zeta * omega0 * progress) * (initialDisplacement * Math.cos(omegaD * progress) + coefficient * Math.sin(omegaD * progress));
    return 1 + displacement;
  }
  if (Math.abs(zeta - 1) <= 1e-6) {
    const coefficient = easing.initialVelocity + omega0 * initialDisplacement;
    return 1 + (initialDisplacement + coefficient * progress) * Math.exp(-omega0 * progress);
  }
  const root = Math.sqrt(zeta * zeta - 1);
  const first = -omega0 * (zeta - root);
  const second = -omega0 * (zeta + root);
  const a = (easing.initialVelocity - second * initialDisplacement) / (first - second);
  const b = initialDisplacement - a;
  return 1 + a * Math.exp(first * progress) + b * Math.exp(second * progress);
}

export function evaluateMotionGraphicV2Easing(progress: number, easing: MotionGraphicV2Easing): number {
  const value = clamp(progress, 0, 1);
  if (easing.type === "linear") return value;
  if (easing.type === "ease_in") return value ** 3;
  if (easing.type === "ease_out") return 1 - (1 - value) ** 3;
  if (easing.type === "ease_in_out") return value < .5 ? 4 * value ** 3 : 1 - ((-2 * value + 2) ** 3) / 2;
  if (easing.type === "cubic_bezier") return cubicBezier(value, easing);
  return spring(value, easing);
}
