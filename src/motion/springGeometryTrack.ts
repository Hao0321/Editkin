import { assertSpringTargetTrack, sampleSpringTargetTrack } from "./springTargetTrack";
import type { SpringGeometryTrack, SpringGeometrySample } from "../domain/motionContinuity";
export type { SpringGeometryTrack, SpringRoundedRect, SpringGeometrySample } from "../domain/motionContinuity";

export function assertSpringGeometryTrack(track: SpringGeometryTrack): void {
  if (!track || !track.envelope) throw new Error("Invalid spring geometry track");
  if (typeof track.localId !== "string" || !track.localId.trim() || track.localId.length > 80) throw new Error("Spring geometry requires a stable localId of at most 80 characters");
  const envelope = track.envelope;
  if (![envelope.x, envelope.y, envelope.width, envelope.height, envelope.x + envelope.width, envelope.y + envelope.height].every(Number.isFinite)
    || envelope.width <= 0 || envelope.height <= 0) throw new Error("Spring geometry requires a finite positive envelope");
  const tracks = [track.left, track.top, track.right, track.bottom, track.cornerRadius];
  for (const property of tracks) assertSpringTargetTrack(property);
  if (tracks.some(property => property.fps !== track.left.fps)) throw new Error("Spring geometry property tracks require the same fps");
}

/** Independent edge springs can lead/follow while preserving one editable shape. */
export function sampleSpringGeometryTrack(track: SpringGeometryTrack, frameTime: number): SpringGeometrySample {
  assertSpringGeometryTrack(track);
  const left = sampleSpringTargetTrack(track.left, frameTime), top = sampleSpringTargetTrack(track.top, frameTime);
  const right = sampleSpringTargetTrack(track.right, frameTime), bottom = sampleSpringTargetTrack(track.bottom, frameTime);
  const radius = sampleSpringTargetTrack(track.cornerRadius, frameTime), envelope = track.envelope;
  if (left.position < envelope.x || right.position > envelope.x + envelope.width
    || top.position < envelope.y || bottom.position > envelope.y + envelope.height) {
    throw new Error("Spring geometry sample exceeds its fixed envelope");
  }
  const width = right.position - left.position, height = bottom.position - top.position;
  if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error("Spring geometry sample dimensions exceed their numeric range");
  if (width <= 0 || height <= 0) throw new Error("Spring geometry sample has inverted or collapsed edges");
  if (radius.position < 0 || radius.position > Math.min(width, height) / 2) {
    throw new Error("Spring geometry sample has an invalid corner radius");
  }
  const velocity = { x: left.velocity, y: top.velocity, width: right.velocity - left.velocity,
    height: bottom.velocity - top.velocity, cornerRadius: radius.velocity };
  if (!Object.values(velocity).every(Number.isFinite)) throw new Error("Spring geometry sample velocity exceeds its numeric range");
  // No independent edge/radius clamps: overshoot must remain observable to the
  // author, or fail closed if it violates the admitted shape and canvas.
  return {
    localId: track.localId, envelope: { ...envelope },
    geometry: { x: left.position, y: top.position, width, height, cornerRadius: radius.position },
    velocity,
  };
}
