import { canonicalJson } from "../shared/canonicalJson";
import { applyCommand } from "../domain/commands";
import { validateProject } from "../domain/editGraph";
import type { EditorCommand } from "../domain/commandTypes";
import type { EditProject, MotionTrack, MotionTrackPoint, NormalizedRect } from "../domain/types";
import type { AnalyzeMotionTrackRequest, MotionTrackAnalysisResult } from "./motionTracking";
import { motionTrackingSamplingV2, validMotionTrackPlanV2 } from "./motionTrackingPolicyV2";

export interface MotionTrackRetrackOptionsV1 {
  trackId: string; newTrackId: string; correctedTime: number; correctedRect: NormalizedRect;
  radiusSeconds: number; createdAt: string;
}
export interface MotionTrackRetrackWindowV1 {
  firstFrame: number; lastFrame: number; sampleCount: number;
  startSeconds: number; endSeconds: number; requestedCorrectionSeconds: number; effectiveCorrectionSeconds: number;
}
export interface MotionTrackRetrackJobV1 { readonly schema: "editkin.motion-track-retrack-job/v1"; readonly trackId: string; }
type JobState = { identity: string; options: MotionTrackRetrackOptionsV1; window: MotionTrackRetrackWindowV1;
  request: Omit<AnalyzeMotionTrackRequest, "sourcePath">; signal?: AbortSignal };
const jobs = new WeakMap<MotionTrackRetrackJobV1, JobState>();
const plans = new WeakMap<object, { job: MotionTrackRetrackJobV1; command: EditorCommand; signal?: AbortSignal }>();
const id = (s: string) => typeof s === "string" && s.trim().length > 0 && s.length <= 160;
const finite = (n: number) => Number.isFinite(n);

function context(project: EditProject, trackId: string, newTrackId: string) {
  const tracks = project.motionTracks.filter(t => t.id === trackId);
  if (tracks.length !== 1 || project.motionTracks.some(t => t.id === newTrackId)) throw Error("RETRACK_TRACK_MISSING_AMBIGUOUS_OR_ID_COLLISION");
  const track = tracks[0], parents = project.tracks.filter(t => t.clips.some(c => c.id === track.clipId));
  const clips = parents.flatMap(t => t.clips.filter(c => c.id === track.clipId));
  if (parents.length !== 1 || clips.length !== 1 || parents[0].kind !== "video") throw Error("RETRACK_SOURCE_CLIP_MISSING_OR_AMBIGUOUS");
  const clip = clips[0], assets = project.assets.filter(a => a.id === clip.assetId), asset = assets[0];
  if (assets.length !== 1 || asset.kind !== "video" || asset.compositionId || asset.clipRetime
    || clip.timeRemap || (clip.speed ?? 1) !== 1) throw Error("RETRACK_ORIGINAL_1X_VIDEO_REQUIRED");
  const graphics = project.motionGraphics.filter(g => g.trackId === trackId || g.vectorTrackingV1?.trackId === trackId);
  const masks = project.tracks.flatMap(parent => parent.clips.flatMap(c => (c.masks ?? [])
    .filter(m => m.trackId === trackId).map(mask => ({ parentId: parent.id, locked: parent.locked, clipId: c.id, mask }))));
  if (parents[0].locked || masks.some(m => m.locked)) throw Error("RETRACK_TRACK_LOCKED");
  const identity = canonicalJson({ projectId: project.id, revision: project.revision, updatedAt: project.updatedAt,
    fps: project.fps, parentId: parents[0].id, track, clip, asset, graphics, masks, trackIds: project.motionTracks.map(t => t.id) });
  return { track, clip, asset, graphics, masks, identity };
}
function current(project: EditProject, job: MotionTrackRetrackJobV1) {
  const state = jobs.get(job);
  if (!state) throw Error("RETRACK_JOB_FOREIGN");
  state.signal?.throwIfAborted();
  const selected = context(project, job.trackId, state.options.newTrackId);
  if (selected.identity !== state.identity) throw Error("RETRACK_JOB_STALE");
  return { ...selected, state };
}

/** Capture the selected graph before asynchronous work. Uses the existing native sample grid,
 * including the existing nearest-sample seed rule; the effective time is always reported. */
export function beginMotionTrackRetrackV1(project: EditProject, input: MotionTrackRetrackOptionsV1, signal?: AbortSignal): MotionTrackRetrackJobV1 {
  signal?.throwIfAborted(); const options = structuredClone(input);
  if (!id(options.trackId) || !id(options.newTrackId) || options.trackId === options.newTrackId
    || !finite(options.radiusSeconds) || options.radiusSeconds <= 0 || options.radiusSeconds > 4 * 3600
    || typeof options.createdAt !== "string" || options.createdAt.length > 64 || !finite(Date.parse(options.createdAt))) throw Error("RETRACK_OPTIONS_INVALID");
  const r = options.correctedRect;
  if (!r || ![r.x, r.y, r.width, r.height].every(finite) || r.x < 0 || r.y < 0 || r.width < .02 || r.height < .02
    || r.x + r.width > 1 || r.y + r.height > 1) throw Error("RETRACK_CORRECTED_RECT_INVALID");
  validateProject(project); const selected = context(project, options.trackId, options.newTrackId), { track, clip, asset } = selected;
  const fps = track.analysisFps;
  if (fps > 15 || track.points.length < 1 || track.points.length > 600_000
    || ![clip.sourceStart, clip.duration, asset.duration, options.correctedTime].every(finite)
    || clip.sourceStart < 0 || clip.duration <= 0 || clip.sourceStart + clip.duration > asset.duration + 1e-7
    || options.correctedTime < 0 || options.correctedTime > clip.duration) throw Error("RETRACK_SOURCE_CLOCK_INVALID");
  for (const p of track.points) {
    const error = Math.abs(p.time * fps - p.frame);
    if (p.time > clip.duration + 1e-7 || error > (p.status === "manual" ? .5 + 1e-7 : 1e-7)) throw Error("RETRACK_EXISTING_SAMPLE_CLOCK_INVALID");
  }
  const maxFrame = Math.max(0, Math.ceil(clip.duration * fps - 1e-7) - 1);
  const seedFrame = Math.min(maxFrame, Math.max(0, Math.round(options.correctedTime * fps)));
  const firstFrame = Math.min(seedFrame, Math.max(0, Math.floor((options.correctedTime - options.radiusSeconds) * fps + 1e-7)));
  const lastFrame = Math.min(maxFrame, Math.ceil((options.correctedTime + options.radiusSeconds) * fps - 1e-7));
  const sampleCount = lastFrame - firstFrame + 1, startSeconds = firstFrame / fps;
  let duration = Math.min(clip.duration - startSeconds, sampleCount / fps);
  // A subtraction at a nonzero grid origin may place ceil(duration*fps) one ULP over the exact count.
  if (Math.ceil(duration * fps) > sampleCount) duration -= Number.EPSILON * Math.max(1, duration);
  const request = { sourceStart: clip.sourceStart + startSeconds, duration, fps,
    sourceWidth: asset.width ?? project.width, sourceHeight: asset.height ?? project.height,
    initialTime: (seedFrame - firstFrame) / fps, initialRect: { ...r },
    ...(asset.derivatives?.sourceSha256 ? { sourceSha256: asset.derivatives.sourceSha256 } : {}) };
  const sampling = motionTrackingSamplingV2(request);
  if (sampling.maxFrames !== sampleCount || seedFrame < firstFrame || seedFrame > lastFrame) throw Error("RETRACK_WINDOW_CLOCK_INVALID");
  const window = { firstFrame, lastFrame, sampleCount, startSeconds, endSeconds: startSeconds + duration,
    requestedCorrectionSeconds: options.correctedTime, effectiveCorrectionSeconds: seedFrame / fps };
  const job = Object.freeze({ schema: "editkin.motion-track-retrack-job/v1" as const, trackId: track.id });
  jobs.set(job, { options, request, window, identity: selected.identity, signal }); return job;
}

/** Input for the existing analysis host, never a caller-selected alternate source or proxy. */
export function motionTrackRetrackSourceV1(project: EditProject, job: MotionTrackRetrackJobV1) {
  const { asset, state } = current(project, job);
  return { assetId: asset.id, assetUri: asset.uri, request: structuredClone(state.request),
    window: { ...state.window }, signal: state.signal };
}
function pixelSeed(r: NormalizedRect, width: number, height: number) {
  const w = Math.min(width, Math.max(4, Math.round(r.width * width))), h = Math.min(height, Math.max(4, Math.round(r.height * height)));
  return { x: Math.min(width - w, Math.max(0, Math.round(r.x * width))),
    y: Math.min(height - h, Math.max(0, Math.round(r.y * height))), width: w, height: h };
}

/** A pure command preparation step. A supplied result alone is not proof of native execution.
 * The Node host below obtains it from analyzeMotionTrack; existing dispatch/storage owns apply. */
export function prepareMotionTrackRetrackV1(project: EditProject, job: MotionTrackRetrackJobV1, result: MotionTrackAnalysisResult, signal?: AbortSignal) {
  const { state, track, graphics, masks } = current(project, job), { window, request, options } = state;
  if (signal && state.signal && signal !== state.signal) throw Error("RETRACK_SINGLE_OWNER_SIGNAL_REQUIRED");
  signal ??= state.signal; signal?.throwIfAborted();
  const sampling = motionTrackingSamplingV2(request);
  if (!validMotionTrackPlanV2(result, sampling) || result.points.length !== window.sampleCount
    || result.analyzedSeconds !== request.duration) throw Error("RETRACK_ANALYSIS_INCOMPLETE_OR_INVALID");
  const seed = result.points[Math.round(request.initialTime * sampling.analysisFps)];
  const before = pixelSeed(track.initialRect, result.width, result.height), corrected = pixelSeed(options.correctedRect, result.width, result.height);
  const expected = { x: corrected.x / result.width, y: corrected.y / result.height, width: corrected.width / result.width, height: corrected.height / result.height };
  const corners = [{ x: expected.x, y: expected.y }, { x: expected.x + expected.width, y: expected.y },
    { x: expected.x + expected.width, y: expected.y + expected.height }, { x: expected.x, y: expected.y + expected.height }];
  if (seed?.status !== "manual" || seed.confidence !== 1 || Math.abs(seed.rotationDegrees) > 1e-7 || Math.abs(seed.scale - 1) > 1e-7
    || Object.entries(expected).some(([key, value]) => Math.abs(seed.rect[key as keyof NormalizedRect] - value) > 1e-7)
    || seed.quad!.some((q, i) => Math.abs(q.x - corners[i].x) > 1e-7 || Math.abs(q.y - corners[i].y) > 1e-7)) throw Error("RETRACK_MANUAL_SEED_REQUIRED");
  const factor = result.engine === "hao-core-rust-motion-track-0.4-planar"
    ? Math.sqrt(corrected.width * corrected.height / (before.width * before.height)) : corrected.width / before.width;
  const replacement: MotionTrackPoint[] = result.points.map(p => ({
    frame: window.firstFrame + p.frame, time: (window.firstFrame + p.frame) / track.analysisFps,
    rect: { ...p.rect }, confidence: p.confidence, status: p.status, activity: p.activity,
    rotationDegrees: p.rotationDegrees, scale: p.scale * factor,
    quad: p.quad!.map(q => ({ ...q })) as MotionTrackPoint["quad"],
  }));
  if (replacement.some(p => !finite(p.scale!) || p.scale! <= 0 || p.scale! > 1e6)) throw Error("RETRACK_SCALE_RANGE_INVALID");
  const points = [...track.points.filter(p => p.frame < window.firstFrame).map(p => structuredClone(p)),
    ...replacement, ...track.points.filter(p => p.frame > window.lastFrame).map(p => structuredClone(p))];
  const revised: MotionTrack = { ...structuredClone(track), id: options.newTrackId, engine: "editkin-motion-local-retrack/v1",
    points, lostRatio: points.filter(p => p.status === "lost").length / points.length, createdAt: options.createdAt };
  const commands: EditorCommand[] = [{ type: "add_motion_track", track: revised }];
  for (const g of graphics) commands.push({ type: "update_motion_graphic", graphicId: g.id, patch: {
    ...(g.trackId === track.id ? { trackId: revised.id } : {}),
    ...(g.vectorTrackingV1?.trackId === track.id ? { vectorTrackingV1: { ...g.vectorTrackingV1, trackId: revised.id } } : {}),
  } });
  for (const m of masks) commands.push({ type: "set_clip_mask_track", clipId: m.clipId, maskId: m.mask.id, trackId: revised.id });
  commands.push({ type: "delete_motion_track", trackId: track.id });
  const command: EditorCommand = { type: "batch", commands }; applyCommand(project, command); current(project, job); signal?.throwIfAborted();
  const plan = Object.freeze({ schema: "editkin.motion-track-retrack-plan/v1" as const, status: "PREPARED_NOT_APPLIED" as const,
    projectId: project.id, revision: project.revision, oldTrackId: track.id, newTrackId: revised.id,
    window: Object.freeze({ ...window }), originalEngine: track.engine, analysisEngine: result.engine,
    sourceIdentityMode: request.sourceSha256 ? "sha256" as const : "metadata" as const,
    localToOriginalScaleFactor: factor, samplesReplaced: replacement.length, outsideSamplesRetained: points.length - replacement.length,
    graphicBindings: graphics.length, maskBindings: masks.length, maskDerivedCachesInvalidated: masks.length,
    realCornerQualityCertified: false as const, ordinaryEditorIntegrated: false as const, vaDefaultEligible: false as const });
  plans.set(plan, { job, command, signal }); return plan;
}

/** Call immediately before the existing canonical apply/dispatch. Serialized or stale plans cannot commit. */
export function motionTrackRetrackCommandV1(project: EditProject, plan: object): EditorCommand {
  const saved = plans.get(plan); if (!saved) throw Error("RETRACK_PLAN_FOREIGN");
  saved.signal?.throwIfAborted(); current(project, saved.job); applyCommand(project, saved.command); return structuredClone(saved.command);
}
