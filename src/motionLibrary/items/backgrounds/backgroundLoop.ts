/**
 * Background loop timing (DESIGN §8): every background loops seamlessly at every
 * speed, with no rounding of the speed.
 *
 * A background is authored as `baseCycles` whole motion cycles (waves, pulses,
 * band passes, arm steps…) per `baseLoopSeconds` at speed 1. At speed s the motion
 * runs baseCycles · s cycles per base loop; to keep a whole number of cycles in the
 * clip, the loop stretches by the smallest m in {1, 2, 4} that makes
 * baseCycles · s · m an integer. Speeds are quarter steps (the parameter schema
 * quantizes them), so m = 4 always suffices:
 *   - 0.5× with baseCycles 1: m = 2, one cycle over twice the period (half as fast);
 *   - 0.75×: m = 4, three cycles over four periods;
 *   - 1.5×: m = 2, three cycles over two periods;
 *   - 2×: m = 1, two cycles per period.
 * Default params (speed 1) give m = 1 and cycles = baseCycles, so the default output
 * is unchanged.
 *
 * Generators call backgroundLoop once per frame, take the loop phase from loopSeconds
 * and drive their motion by `cycles`. The catalog exposes the same period through
 * motionBackgroundLoopSeconds(item, params), so a renderer or VA can pick a seamless
 * clip length. Pure and browser-safe.
 */

export interface BackgroundLoop {
  /** The seamless period in seconds: the base loop stretched by `stretch`. */
  readonly loopSeconds: number;
  /** Whole motion cycles in that period: baseCycles · speed · stretch, an integer ≥ 1. */
  readonly cycles: number;
  /** The smallest m in {1, 2, 4} that makes the cycle count whole. */
  readonly stretch: 1 | 2 | 4;
}

/** Speed in quarter steps (the schema quantizes speed; this guards direct generator calls). */
export function backgroundSpeedQuarters(speed: number): number {
  if (!Number.isFinite(speed) || speed <= 0) throw new Error(`Background speed must be a positive number (got ${String(speed)})`);
  return Math.max(1, Math.round(speed * 4));
}

/**
 * Loop period and whole cycle count for an item authored as baseCycles cycles per
 * baseLoopSeconds at speed 1 (see the file comment).
 */
export function backgroundLoop(baseLoopSeconds: number, baseCycles: number, speed: number): BackgroundLoop {
  if (!Number.isFinite(baseLoopSeconds) || baseLoopSeconds <= 0) throw new Error("backgroundLoop needs a positive base loop in seconds");
  if (!Number.isInteger(baseCycles) || baseCycles < 1) throw new Error("backgroundLoop needs a whole number of base cycles (≥ 1)");
  // baseCycles · speed · m = baseCycles · quarters · m / 4 must be a whole number.
  const quarterCycles = baseCycles * backgroundSpeedQuarters(speed);
  const stretch: 1 | 2 | 4 = quarterCycles % 4 === 0 ? 1 : quarterCycles % 2 === 0 ? 2 : 4;
  return Object.freeze({ loopSeconds: baseLoopSeconds * stretch, cycles: (quarterCycles * stretch) / 4, stretch });
}
