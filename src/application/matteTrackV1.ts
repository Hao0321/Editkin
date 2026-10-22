import * as z from "zod/v4";
import type { EditorCommand } from "../domain/commandTypes";
import { applyCommand } from "../domain/commands";
import { validateProject } from "../domain/editGraph";
import type { EditProject, MotionTrack, NormalizedRect } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";

const unit = z.number().finite().min(0).max(1);
const rect = z.strictObject({ x: unit, y: unit, width: unit.positive(), height: unit.positive() })
  .refine(r => r.x + r.width <= 1 + 1e-10 && r.y + r.height <= 1 + 1e-10);
const point = z.strictObject({ x: unit, y: unit });
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().min(1).max(160).refine(s => s.trim() === s);
const optionsSchema = z.strictObject({ clipId: identifier, newTrackId: identifier,
  name: z.string().trim().min(1).max(160), createdAt: z.string().min(1).max(64).refine(s => Number.isFinite(Date.parse(s))),
  minimumAlpha: unit.positive(), referenceFrame: z.number().int().min(0).max(1439) });
export type MatteTrackOptionsV1 = z.infer<typeof optionsSchema>;
export const matteTrackMeasurementSchemaV1 = z.strictObject({ schema: z.literal("editkin.matte-track-measurement/v1"),
  sourceSha256: digest, alphaSha256: digest, analysisSha256: digest, subjectConfirmationSha256: digest,
  width: z.number().int().min(16).max(8192), height: z.number().int().min(16).max(8192), alphaBits: z.union([z.literal(8), z.literal(16)]),
  fps: z.number().finite().min(1).max(60), frameCount: z.number().int().min(1).max(1440), sourceStart: z.number().finite().min(0).max(604800),
  minimumAlpha: unit.positive(), frames: z.array(z.strictObject({ frame: z.number().int().nonnegative(), time: z.number().finite().nonnegative(),
    confidence: unit, foregroundPixels: z.number().int().min(0).max(2073600), alphaMass: z.number().finite().min(0).max(2073600),
    bbox: rect.optional(), centroid: point.optional() })).min(1).max(1440) });
export type MatteTrackMeasurementV1 = z.infer<typeof matteTrackMeasurementSchemaV1>;

/** True inclusive bounds and alpha-weighted pixel centres; alpha precision is never reduced.
 * The source supplies one frame only. Zero foreground is absence, never a fabricated rectangle. */
export function measureMatteFrameV1(alpha: Uint8Array, width: number, height: number, bits: 8 | 16, minimumAlpha: number, check = () => {}) {
  if (![width, height].every(n => Number.isSafeInteger(n) && n >= 16 && n <= 8192) || width * height > 2073600
    || ![8, 16].includes(bits) || !Number.isFinite(minimumAlpha) || minimumAlpha <= 0 || minimumAlpha > 1
    || alpha.byteLength !== width * height * (bits / 8)) throw Error("MATTE_TRACK_ALPHA_FRAME_CONTRACT");
  const maximum = bits === 8 ? 255 : 65535, threshold = Math.ceil(minimumAlpha * maximum);
  let minX = width, minY = height, maxX = -1, maxY = -1, count = 0, mass = 0, momentX = 0, momentY = 0;
  check();
  for (let y = 0; y < height; y++) {
    if (y % 64 === 0) check();
    for (let x = 0; x < width; x++) {
      const p = y * width + x, value = bits === 8 ? alpha[p] : alpha[2 * p] + 256 * alpha[2 * p + 1];
      if (value < threshold) continue;
      count++; mass += value; momentX += value * (2 * x + 1); momentY += value * (2 * y + 1);
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  check();
  if (!count) return { foregroundPixels: 0, alphaMass: 0 };
  return { foregroundPixels: count, alphaMass: mass / maximum,
    bbox: { x: minX / width, y: minY / height, width: (maxX - minX + 1) / width, height: (maxY - minY + 1) / height },
    centroid: { x: momentX / (2 * mass * width), y: momentY / (2 * mass * height) } };
}

export interface MatteTrackJobV1 { readonly schema: "editkin.matte-track-job/v1"; readonly clipId: string; }
type JobState = { options: MatteTrackOptionsV1; identity: string; signal?: AbortSignal };
const jobs = new WeakMap<MatteTrackJobV1, JobState>();
const plans = new WeakMap<object, { job: MatteTrackJobV1; command: EditorCommand; signal?: AbortSignal }>();
function context(project: EditProject, options: MatteTrackOptionsV1) {
  const parents = project.tracks.filter(t => t.clips.some(c => c.id === options.clipId));
  const clips = parents.flatMap(t => t.clips.filter(c => c.id === options.clipId));
  const clip = clips[0], assets = project.assets.filter(a => a.id === clip?.assetId), asset = assets[0];
  if (parents.length !== 1 || clips.length !== 1 || parents[0].kind !== "video" || assets.length !== 1 || asset.kind !== "video") throw Error("MATTE_TRACK_ORIGINAL_VIDEO_REQUIRED");
  if (parents[0].locked) throw Error("MATTE_TRACK_SOURCE_LOCKED");
  if (asset.compositionId || asset.imageSequence || asset.clipRetime || clip.timeRemap || (clip.speed ?? 1) !== 1
    || clip.expressions || clip.transform3d || clip.floatingFrame || project.scene25d?.enabled) throw Error("MATTE_TRACK_ORIGINAL_1X_GEOMETRY_REQUIRED");
  if (project.motionTracks.some(t => t.id === options.newTrackId)) throw Error("MATTE_TRACK_ID_COLLISION");
  if (![clip.sourceStart, clip.duration, asset.duration].every(Number.isFinite) || clip.sourceStart < 0 || clip.duration <= 0
    || clip.duration > 120 || clip.sourceStart + clip.duration > asset.duration + 1e-7) throw Error("MATTE_TRACK_SOURCE_CLOCK_INVALID");
  if (asset.derivatives?.sourceSha256 !== undefined && !/^[a-f0-9]{64}$/.test(asset.derivatives.sourceSha256)) throw Error("MATTE_TRACK_SOURCE_DIGEST_INVALID");
  const identity = canonicalJson({ projectId: project.id, revision: project.revision, updatedAt: project.updatedAt, fps: project.fps,
    width: project.width, height: project.height, parentId: parents[0].id, asset, clip, trackIds: project.motionTracks.map(t => t.id) });
  return { clip, asset, identity };
}
function current(project: EditProject, job: MatteTrackJobV1) {
  const state = jobs.get(job); if (!state) throw Error("MATTE_TRACK_JOB_FOREIGN"); state.signal?.throwIfAborted();
  const selected = context(project, state.options);
  if (selected.identity !== state.identity) throw Error("MATTE_TRACK_JOB_STALE");
  return { ...selected, state };
}
/** Capture before asynchronous file work; the existing host retains expected-revision apply. */
export function beginMatteTrackV1(project: EditProject, input: MatteTrackOptionsV1, signal?: AbortSignal): MatteTrackJobV1 {
  signal?.throwIfAborted(); const options = optionsSchema.parse(input); validateProject(project);
  const selected = context(project, options), job = Object.freeze({ schema: "editkin.matte-track-job/v1" as const, clipId: options.clipId });
  jobs.set(job, { options, identity: selected.identity, signal }); return job;
}
export function matteTrackSourceV1(project: EditProject, job: MatteTrackJobV1) {
  const { asset, clip, state } = current(project, job);
  return { asset: structuredClone(asset), clip: structuredClone(clip), options: structuredClone(state.options), signal: state.signal };
}
/** Pure planner. Its measurements must be obtained by the Node physical/trust verifier below,
 * never accepted as client-supplied evidence by a service. It does not mint human confirmation. */
export function prepareMatteTrackV1(project: EditProject, job: MatteTrackJobV1, input: MatteTrackMeasurementV1, signal?: AbortSignal) {
  signal?.throwIfAborted(); const { clip, asset, state } = current(project, job), m = matteTrackMeasurementSchemaV1.parse(input);
  const { options } = state;
  if (m.width * m.height > 2073600 || m.frames.length !== m.frameCount || m.minimumAlpha !== options.minimumAlpha
    || Math.abs(m.sourceStart - clip.sourceStart) > 1e-7 || Math.abs(m.frameCount / m.fps - clip.duration) > 1e-7
    || (asset.derivatives?.sourceSha256 !== undefined && m.sourceSha256 !== asset.derivatives.sourceSha256)
    || options.referenceFrame >= m.frameCount) throw Error("MATTE_TRACK_MEASUREMENT_SOURCE_OR_CLOCK_CHANGED");
  for (const [i, f] of m.frames.entries()) {
    if (f.frame !== i || Math.abs(f.time - i / m.fps) > 1e-10) throw Error("MATTE_TRACK_SAMPLE_CLOCK_INVALID");
    if (!f.foregroundPixels) {
      if (f.alphaMass !== 0 || f.bbox || f.centroid || f.confidence !== 0) throw Error("MATTE_TRACK_EMPTY_OBSERVATION_INVALID");
    } else {
      const r = f.bbox, c = f.centroid;
      if (!r || !c || f.alphaMass > f.foregroundPixels + 1e-7 || f.alphaMass < f.foregroundPixels * m.minimumAlpha - 1e-7
        || [r.x * m.width, r.width * m.width, r.y * m.height, r.height * m.height].some(v => Math.abs(v - Math.round(v)) > 1e-7)
        || f.foregroundPixels > Math.round(r.width * m.width) * Math.round(r.height * m.height)
        || c.x < r.x + .5 / m.width - 1e-10 || c.x > r.x + r.width - .5 / m.width + 1e-10
        || c.y < r.y + .5 / m.height - 1e-10 || c.y > r.y + r.height - .5 / m.height + 1e-10) throw Error("MATTE_TRACK_GEOMETRY_MEASUREMENT_INVALID");
    }
  }
  const reference = m.frames[options.referenceFrame].bbox;
  if (!reference) throw Error("MATTE_TRACK_REFERENCE_EMPTY");
  const referenceArea = reference.width * reference.height;
  let last: NormalizedRect = reference, scale = 1;
  const points = m.frames.map(f => {
    if (f.bbox) { last = f.bbox; scale = Math.sqrt(last.width * last.height / referenceArea); }
    return { frame: f.frame, time: f.time, rect: { ...last }, confidence: f.confidence,
      status: f.bbox ? "tracked" as const : "lost" as const, rotationDegrees: 0, scale };
  });
  const track: MotionTrack = { id: options.newTrackId, clipId: clip.id, name: options.name, engine: "editkin-matte-bbox-track/v1",
    analysisFps: m.fps, initialRect: { ...reference }, points, lostRatio: points.filter(p => p.status === "lost").length / points.length,
    createdAt: options.createdAt, role: "subject" };
  const command: EditorCommand = { type: "add_motion_track", track: structuredClone(track) };
  applyCommand(project, command); signal?.throwIfAborted(); current(project, job);
  const plan = { schema: "editkin.matte-track-plan/v1" as const, track, measurement: m, trackAnchor: "bbox-center" as const,
    centroidUse: "measurement-only" as const, qualityState: "diagnostic" as const, benchmarkAccepted: false as const };
  plans.set(plan, { job, command, signal }); return plan;
}
export type MatteTrackPlanV1 = ReturnType<typeof prepareMatteTrackV1>;
export function matteTrackCommandV1(project: EditProject, plan: MatteTrackPlanV1): EditorCommand {
  const state = plans.get(plan); if (!state) throw Error("MATTE_TRACK_PLAN_FOREIGN");
  state.signal?.throwIfAborted(); current(project, state.job); return structuredClone(state.command);
}
