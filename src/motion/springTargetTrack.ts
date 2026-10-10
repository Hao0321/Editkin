/**
 * Original Editkin oscillator track. Each target change adds a step response to
 * m*x'' + damping*x' + stiffness*(x - target) = 0. Sampling never advances state.
 */
export const SPRING_TARGET_TRACK_MAX_EVENTS = 32;
import type { SpringDynamics, SpringTargetTrack, SpringTargetSample } from "../domain/motionContinuity";
export type { SpringDynamics, SpringTargetEvent, SpringTargetTrack, SpringTargetSample } from "../domain/motionContinuity";

function finite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`Spring target track ${label} must be finite`);
}

export function assertSpringTargetTrack(track: SpringTargetTrack): void {
  if (!track || !track.spring || !Array.isArray(track.events)) throw new Error("Invalid spring target track");
  finite(track.fps, "fps");
  if (track.fps < 1 || track.fps > 240) throw new Error("Spring target track fps must be between 1 and 240");
  finite(track.initialPosition, "initialPosition");
  finite(track.initialVelocity, "initialVelocity");
  finite(track.initialTarget, "initialTarget");
  finite(track.initialPosition - track.initialTarget, "initial displacement numeric range");
  const { stiffness, damping, mass } = track.spring;
  if (!Number.isFinite(stiffness) || stiffness < 1 || stiffness > 1_000
    || !Number.isFinite(damping) || damping < 0 || damping > 100
    || !Number.isFinite(mass) || mass < .05 || mass > 10) {
    throw new Error("Spring target track dynamics exceed supported bounds");
  }
  if (track.events.length > SPRING_TARGET_TRACK_MAX_EVENTS) throw new Error("Spring target track supports at most 32 target events");
  let previousFrame = -1;
  let previousTarget = track.initialTarget;
  for (const event of track.events) {
    if (!event || !Number.isSafeInteger(event.frame) || event.frame < 0 || event.frame <= previousFrame) {
      throw new Error("Spring target events require strictly ascending nonnegative integer frames");
    }
    finite(event.target, "event target");
    finite(event.target - previousTarget, "target delta numeric range");
    previousFrame = event.frame;
    previousTarget = event.target;
  }
}

interface OscillatorBasis {
  /** Unit initial displacement response, zero initial velocity. */
  displacement: number;
  displacementVelocity: number;
  /** Unit initial velocity response, zero initial displacement. */
  impulse: number;
  impulseVelocity: number;
}

function oscillatorBasis(spring: SpringDynamics, seconds: number): OscillatorBasis {
  if (seconds === 0) return { displacement: 1, displacementVelocity: 0, impulse: 0, impulseVelocity: 1 };
  const frequencySquared = spring.stiffness / spring.mass;
  const decay = spring.damping / (2 * spring.mass);
  const discriminant = decay * decay - frequencySquared;
  let displacement: number, impulse: number, impulseVelocity: number;
  // The critical limit avoids division by a vanishing modal separation.
  if (Math.abs(discriminant) <= Math.max(frequencySquared, decay * decay) * 1e-12) {
    const attenuation = Math.exp(-decay * seconds);
    impulse = seconds * attenuation;
    displacement = (1 + decay * seconds) * attenuation;
    impulseVelocity = (1 - decay * seconds) * attenuation;
  } else if (discriminant < 0) {
    const frequency = Math.sqrt(-discriminant);
    const phase = frequency * seconds;
    finite(phase, "sample time numeric range");
    const attenuation = Math.exp(-decay * seconds);
    impulse = attenuation * Math.sin(phase) / frequency;
    const cosine = attenuation * Math.cos(phase);
    displacement = cosine + decay * impulse;
    impulseVelocity = cosine - decay * impulse;
  } else {
    const separation = Math.sqrt(discriminant);
    // -decay + separation loses precision in the strongly overdamped limit.
    const slowRoot = -frequencySquared / (decay + separation);
    const fastRoot = -decay - separation;
    const slow = Math.exp(slowRoot * seconds);
    const fast = Math.exp(fastRoot * seconds);
    // expm1 retains the difference of nearby exponentials immediately after a
    // target event; exponential roots avoid exp(-a*t)*sinh(b*t) overflow.
    impulse = slow * -Math.expm1(-2 * separation * seconds) / (2 * separation);
    displacement = (slow + fast) / 2 + decay * impulse;
    impulseVelocity = fast + slowRoot * impulse;
  }
  return { displacement, displacementVelocity: -frequencySquared * impulse, impulse, impulseVelocity };
}

/**
 * Pure arbitrary-time sample, including fractional frames for future shutter
 * sampling. Retargeting preserves both position and velocity; no endpoint snap.
 */
export function sampleSpringTargetTrack(track: SpringTargetTrack, frameTime: number): SpringTargetSample {
  assertSpringTargetTrack(track);
  if (!Number.isFinite(frameTime) || frameTime < 0 || frameTime > Number.MAX_SAFE_INTEGER) {
    throw new Error("Spring target sample frameTime must be finite and nonnegative within the safe frame range");
  }
  if (frameTime === 0) return { position: track.initialPosition, velocity: track.initialVelocity };
  const basis = oscillatorBasis(track.spring, frameTime / track.fps);
  const displacement = track.initialPosition - track.initialTarget;
  let position = track.initialTarget + displacement * basis.displacement + track.initialVelocity * basis.impulse;
  let velocity = displacement * basis.displacementVelocity + track.initialVelocity * basis.impulseVelocity;
  let previousTarget = track.initialTarget;
  for (const event of track.events) {
    if (event.frame > frameTime) break;
    const response = oscillatorBasis(track.spring, (frameTime - event.frame) / track.fps);
    const delta = event.target - previousTarget;
    position += delta * (1 - response.displacement);
    velocity -= delta * response.displacementVelocity;
    previousTarget = event.target;
  }
  finite(position, "sample position numeric range");
  finite(velocity, "sample velocity numeric range");
  // A zero target delta may flip IEEE signed zero while preserving the same
  // physical state. Canonical zero keeps event identity and receipts exact.
  return { position: position === 0 ? 0 : position, velocity: velocity === 0 ? 0 : velocity };
}
