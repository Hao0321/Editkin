import type { NativeMotionTrackPlan } from "../render/nativeCore";

export const MOTION_TRACK_RAW_BUDGET_V2 = 512 * 1024 * 1024;
export function motionTrackingSamplingV2(input: { duration: number; fps: number; sourceWidth: number; sourceHeight: number }, budget = MOTION_TRACK_RAW_BUDGET_V2) {
  if (!Number.isFinite(input.duration) || input.duration <= 0 || input.duration > 4 * 3600
    || !Number.isFinite(input.fps) || input.fps <= 0 || input.fps > 240
    || ![input.sourceWidth, input.sourceHeight].every(n => Number.isSafeInteger(n) && n >= 16 && n <= 65536)
    || !Number.isSafeInteger(budget) || budget < 1 || budget > MOTION_TRACK_RAW_BUDGET_V2) throw new Error("TRACK_SAMPLING_INPUT_INVALID");
  const analysisFps = Math.min(15, input.fps), scale = Math.min(1, 640 / Math.max(input.sourceWidth, input.sourceHeight));
  const width = Math.floor(input.sourceWidth * scale / 2) * 2, height = Math.floor(input.sourceHeight * scale / 2) * 2;
  const maxFrames = Math.max(1, Math.ceil(input.duration * analysisFps)), minFrames = Math.max(1, Math.floor(input.duration * analysisFps));
  const rawBytes = width * height * maxFrames;
  if (width < 16 || height < 16 || maxFrames > 100000 || !Number.isSafeInteger(rawBytes) || rawBytes > budget) throw new Error("TRACK_RAW_BUDGET_EXCEEDED: 請縮短追蹤範圍，避免原始取樣耗盡磁碟");
  return { analysisFps, width, height, maxFrames, minFrames, rawBytes };
}
export type MotionTrackingSamplingV2 = ReturnType<typeof motionTrackingSamplingV2>;
export function assertMotionTrackStorageV2(availableBytes: number, sampling: MotionTrackingSamplingV2): void {
  const cacheBytes = Math.min(64 * 1024 * 1024, sampling.maxFrames * 1200 + 16384);
  const required = sampling.rawBytes + cacheBytes + 64 * 1024 * 1024;
  if (!Number.isFinite(availableBytes) || availableBytes < required) throw new Error("TRACK_WORKSPACE_SPACE_INSUFFICIENT: 取樣與快取需要額外磁碟餘裕");
}
const unit = (n: number) => Number.isFinite(n) && n >= 0 && n <= 1;

/** Cache and native output obey the same exact clock, geometry and engine contract. */
export function validMotionTrackPlanV2(value: unknown, sampling: MotionTrackingSamplingV2): value is NativeMotionTrackPlan {
  if (!value || typeof value !== "object") return false;
  const p = value as NativeMotionTrackPlan;
  if (!["hao-core-rust-motion-track-0.4-planar", "hao-core-rust-motion-track-0.4-region-fallback"].includes(p.engine)
    || p.analysisFps !== sampling.analysisFps || p.width !== sampling.width || p.height !== sampling.height
    || !unit(p.lostRatio) || !Array.isArray(p.points) || p.points.length < sampling.minFrames || p.points.length > sampling.maxFrames) return false;
  let lost = 0;
  for (let i = 0; i < p.points.length; i++) {
    const point = p.points[i], r = point?.rect, q = point?.quad;
    if (!point || point.frame !== i || !Number.isFinite(point.time) || Math.abs(point.time - i / sampling.analysisFps) > 1e-7
      || !["manual", "tracked", "held", "lost"].includes(point.status) || !unit(point.confidence) || !unit(point.activity)
      || !Number.isFinite(point.rotationDegrees) || Math.abs(point.rotationDegrees) > 1e9
      || !Number.isFinite(point.scale) || point.scale <= 0 || point.scale > 1e6
      || !r || ![r.x, r.y, r.width, r.height].every(unit) || r.width <= 0 || r.height <= 0
      || r.x + r.width > 1 + 1e-9 || r.y + r.height > 1 + 1e-9
      || !Array.isArray(q) || q.length !== 4 || Array.from(q).some(v => !v || !unit(v.x) || !unit(v.y))) return false;
    const cross = q.map((v, j) => { const a = q[(j + 1) % 4], b = q[(j + 2) % 4]; return (a.x - v.x) * (b.y - v.y) - (a.y - v.y) * (b.x - v.x); });
    if (!cross.every(v => Math.abs(v) > 1e-12 && Math.sign(v) === Math.sign(cross[0]))) return false;
    if (point.status === "lost") lost++;
  }
  return Math.abs(p.lostRatio - lost / p.points.length) < 1e-9;
}
