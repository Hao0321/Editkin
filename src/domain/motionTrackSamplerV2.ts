import type { MotionTrack, MotionTrackPoint, NormalizedPoint } from "./types";
import type { MotionTrackPose } from "./motionTrackSampling";

export interface MotionTrackPolicyV2 {
  minConfidence: number;
  maxInterpolationGapSeconds: number;
  maxHoldSeconds: number;
  rotationInterpolation: "shortest" | "unwrapped";
  requireQuad: boolean;
}
export type MotionTrackSampleReasonV2 = "visible" | "held" | "before_range" | "expired" | "lost" | "low_confidence" | "gap" | "invalid_time" | "invalid_quad";
export interface MotionTrackSampleV2 { pose?: MotionTrackPose; reason: MotionTrackSampleReasonV2; comparisons: number; }
export interface MotionTrackSamplerV2 {
  readonly trackId: string;
  readonly clipId: string;
  readonly sampleCount: number;
  readonly snapshotBytes: number;
  sample(localSeconds: number): MotionTrackSampleV2;
}

const STRIDE = 16, MAX_SAMPLES = 600_000;
const STATUS = ["tracked", "manual", "held", "lost"] as const;
const finite = (n: number) => Number.isFinite(n);
const unit = (n: number) => finite(n) && n >= 0 && n <= 1;
const wrap = (n: number) => ((n % 360) + 360) % 360;

function policyFor(overrides: Partial<MotionTrackPolicyV2>): MotionTrackPolicyV2 {
  const policy: MotionTrackPolicyV2 = { minConfidence: .5, maxInterpolationGapSeconds: .25,
    maxHoldSeconds: .12, rotationInterpolation: "shortest", requireQuad: false, ...overrides };
  if (!unit(policy.minConfidence) || !finite(policy.maxInterpolationGapSeconds) || policy.maxInterpolationGapSeconds <= 0
    || policy.maxInterpolationGapSeconds > 2 || !finite(policy.maxHoldSeconds) || policy.maxHoldSeconds < 0
    || policy.maxHoldSeconds > .5 || !["shortest", "unwrapped"].includes(policy.rotationInterpolation)
    || typeof policy.requireQuad !== "boolean") throw new Error("TRACK_V2_POLICY_INVALID");
  return policy;
}

function convex(quad: readonly NormalizedPoint[]): boolean {
  if (!Array.isArray(quad) || quad.length !== 4 || Array.from(quad).some(p => !p || !unit(p.x) || !unit(p.y))) return false;
  const cross = quad.map((p, i) => {
    const a = quad[(i + 1) % 4], b = quad[(i + 2) % 4];
    return (a.x - p.x) * (b.y - a.y) - (a.y - p.y) * (b.x - a.x);
  });
  return cross.every(c => Math.abs(c) > 1e-12 && Math.sign(c) === Math.sign(cross[0]));
}

/** One bounded immutable numeric snapshot, rather than a second tree of track/quad objects. */
function snapshot(points: MotionTrackPoint[], policy: MotionTrackPolicyV2) {
  if (!Array.isArray(points) || !points.length || points.length > MAX_SAMPLES) throw new Error("TRACK_V2_SAMPLE_BUDGET");
  const values = new Float64Array(points.length * STRIDE), status = new Uint8Array(points.length);
  const hasQuad = new Uint8Array(points.length), reliable = new Int32Array(points.length);
  let previous = -Infinity, lastReliable = -1;
  for (let i = 0; i < points.length; i++) {
    const p = points[i], r = p.rect, s = STATUS.indexOf(p.status);
    if (!finite(p.time) || p.time < 0 || p.time <= previous || s < 0 || !Number.isSafeInteger(p.frame) || p.frame < 0
      || !r || ![r.x, r.y, r.width, r.height].every(unit) || r.width <= 0 || r.height <= 0
      || r.x + r.width > 1 + 1e-10 || r.y + r.height > 1 + 1e-10 || !unit(p.confidence)
      || !finite(p.rotationDegrees ?? 0) || Math.abs(p.rotationDegrees ?? 0) > 1e9
      || !finite(p.scale ?? 1) || (p.scale ?? 1) <= 0 || (p.scale ?? 1) > 1e6) throw new Error("TRACK_V2_SAMPLE_INVALID");
    if (p.quad && !convex(p.quad)) throw new Error("TRACK_V2_QUAD_INVALID");
    if (policy.requireQuad && p.status !== "lost" && !p.quad) throw new Error("TRACK_V2_QUAD_REQUIRED");
    const j = i * STRIDE;
    values.set([p.time, r.x, r.y, r.width, r.height, p.confidence, p.rotationDegrees ?? 0, p.scale ?? 1], j);
    if (p.quad) { hasQuad[i] = 1; values.set(p.quad.flatMap(c => [c.x, c.y]), j + 8); }
    status[i] = s;
    if (s === 3) lastReliable = -1;
    else if (s === 1 || (s === 0 && p.confidence >= policy.minConfidence)) lastReliable = i;
    reliable[i] = lastReliable;
    previous = p.time;
  }
  return { values, status, hasQuad, reliable };
}
type Snapshot = ReturnType<typeof snapshot>;

function poseAt(data: Snapshot, index: number): MotionTrackPose {
  const j = index * STRIDE, v = data.values;
  return { rect: { x: v[j + 1], y: v[j + 2], width: v[j + 3], height: v[j + 4] },
    confidence: v[j + 5], rotationDegrees: v[j + 6], scale: v[j + 7], status: STATUS[data.status[index]],
    ...(data.hasQuad[index] ? { quad: Array.from({ length: 4 }, (_, i) => ({ x: v[j + 8 + i * 2], y: v[j + 9 + i * 2] })) as MotionTrackPose["quad"] } : {}) };
}

function interpolate(data: Snapshot, a: number, b: number, ratio: number, policy: MotionTrackPolicyV2): MotionTrackPose | undefined {
  const before = poseAt(data, a), after = poseAt(data, b), mix = (x: number, y: number) => x + (y - x) * ratio;
  const quad = before.quad && after.quad ? before.quad.map((p, i) => ({ x: mix(p.x, after.quad![i].x), y: mix(p.y, after.quad![i].y) })) as MotionTrackPose["quad"] : undefined;
  if (quad && !convex(quad)) return undefined;
  const angle = policy.rotationInterpolation === "unwrapped" ? mix(before.rotationDegrees, after.rotationDegrees)
    : wrap(before.rotationDegrees + (wrap(after.rotationDegrees - before.rotationDegrees + 180) - 180) * ratio);
  return { rect: { x: mix(before.rect.x, after.rect.x), y: mix(before.rect.y, after.rect.y),
    width: mix(before.rect.width, after.rect.width), height: mix(before.rect.height, after.rect.height) },
    confidence: mix(before.confidence, after.confidence), rotationDegrees: angle, scale: mix(before.scale, after.scale),
    status: before.status === "manual" && after.status === "manual" ? "manual" : "tracked", ...(quad ? { quad } : {}) };
}

function sample(data: Snapshot, count: number, seconds: number, policy: MotionTrackPolicyV2): MotionTrackSampleV2 {
  let comparisons = 0;
  const hidden = (reason: MotionTrackSampleReasonV2): MotionTrackSampleV2 => ({ reason, comparisons });
  if (!finite(seconds)) return hidden("invalid_time");
  if (seconds < data.values[0]) return hidden("before_range");
  let low = 0, high = count;
  while (low < high) {
    const mid = (low + high) >>> 1; comparisons++;
    if (data.values[mid * STRIDE] < seconds) low = mid + 1; else high = mid;
  }
  const exact = low < count && data.values[low * STRIDE] === seconds;
  const previous = exact ? low : low - 1;
  if (previous < 0) return hidden("before_range");
  if (data.status[previous] === 3) return hidden("lost");
  const reliable = data.reliable[previous];
  if (reliable < 0) return hidden("low_confidence");
  if (exact && reliable === previous) return { pose: poseAt(data, previous), reason: "visible", comparisons };
  if (!exact && low < count && reliable === previous && data.reliable[low] === low) {
    const a = data.values[previous * STRIDE], b = data.values[low * STRIDE];
    if (b - a <= policy.maxInterpolationGapSeconds) {
      const pose = interpolate(data, previous, low, (seconds - a) / (b - a), policy);
      return pose ? { pose, reason: "visible", comparisons } : hidden("invalid_quad");
    }
  }
  // Held observations do not renew the deadline, and future reacquisition is never anticipated.
  const age = seconds - data.values[reliable * STRIDE];
  if (age > policy.maxHoldSeconds + 1e-12) return hidden(low === count ? "expired" : reliable !== previous ? "low_confidence" : "gap");
  return { pose: { ...poseAt(data, reliable), status: "held" }, reason: "held", comparisons };
}

/** Opt-in v2. Old project/export sampling remains unchanged until the consumer explicitly adopts it. */
export function createMotionTrackSamplerV2(track: Pick<MotionTrack, "id" | "clipId" | "analysisFps" | "points">,
  overrides: Partial<MotionTrackPolicyV2> = {}): MotionTrackSamplerV2 {
  if (typeof track.id !== "string" || !track.id.trim() || track.id.length > 160
    || typeof track.clipId !== "string" || !track.clipId.trim() || track.clipId.length > 160
    || !finite(track.analysisFps) || track.analysisFps <= 0 || track.analysisFps > 240) throw new Error("TRACK_V2_IDENTITY_INVALID");
  const policy = policyFor(overrides), data = snapshot(track.points, policy), count = track.points.length;
  return Object.freeze({ trackId: track.id, clipId: track.clipId, sampleCount: count,
    snapshotBytes: data.values.byteLength + data.status.byteLength + data.hasQuad.byteLength + data.reliable.byteLength,
    sample: (seconds: number) => sample(data, count, seconds, policy) });
}
