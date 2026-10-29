import { canonicalJson } from "../shared/canonicalJson";
import { findAsset, findClip } from "../domain/editGraph";
import type { EditProject, DirectorMarker } from "../domain/types";
import type { EditorCommand } from "../domain/commandTypes";
import { musicBeatsRequestSchemaV1, validateMusicBeatsReceiptV1, type MusicBeatsRequestV1 } from "./musicBeatsTypesV1";

export const BEAT_MARKER_BATCH_LIMIT_V1 = 4096;
export interface BeatMarkerJobV1 {
  readonly schema: "editkin.beat-marker-job/v1";
  readonly clipId: string;
  readonly assetId: string;
  readonly assetUri: string;
}
export interface BeatMarkerOptionsV1 {
  mode?: "downbeats" | "all";
  timelineRange?: { start: number; end: number };
  idPrefix: string;
  createdAt: string;
  labels: { beat: string; downbeat: string; candidateNote: string };
  signal?: AbortSignal;
}
export interface BeatMarkerSourceV1 {
  /** The host resolves the selected original/baked asset and verifies its current file SHA. */
  assetId: string; assetUri: string; sourceSha256: string; sourceBytes: number; ffmpegSha256: string;
}
const jobs = new WeakMap<BeatMarkerJobV1, string>();
const plans = new WeakMap<object, { job: BeatMarkerJobV1; command?: EditorCommand; signal?: AbortSignal }>();

function selection(project: EditProject, clipId: string) {
  const clip = findClip(project, clipId), asset = findAsset(project, clip.assetId);
  const track = project.tracks.find(t => t.clips.includes(clip))!;
  if (track.locked) throw Error("BEAT_MARKER_TRACK_LOCKED");
  if (!["audio", "video"].includes(asset.kind) || asset.compositionId || clip.layer?.enabled === false
    || ["controller", "adjustment"].includes(clip.layer?.role ?? "")) throw Error("BEAT_MARKER_MEDIA_CLIP_REQUIRED");
  if (clip.timeRemap || (clip.speed !== undefined && clip.speed !== 1)) throw Error("BEAT_MARKER_AUTHORED_CLOCK_UNSUPPORTED");
  if (![project.fps, clip.timelineStart, clip.sourceStart, clip.duration, asset.duration].every(Number.isFinite)
    || project.fps <= 0 || project.fps > 240 || clip.timelineStart < 0 || clip.sourceStart < 0 || clip.duration <= 0
    || !Number.isSafeInteger(Math.round((clip.timelineStart + clip.duration) * project.fps))) throw Error("BEAT_MARKER_CLOCK_INVALID");
  return { clip, asset, track };
}
function identity(project: EditProject, job: Pick<BeatMarkerJobV1, "clipId">) {
  const { clip, asset, track } = selection(project, job.clipId);
  return canonicalJson({ projectId: project.id, revision: project.revision, updatedAt: project.updatedAt,
    fps: project.fps, trackId: track.id, clip, asset, markers: project.director.markers });
}
function current(project: EditProject, job: BeatMarkerJobV1) {
  const expected = jobs.get(job);
  if (!expected || identity(project, job) !== expected) throw Error("BEAT_MARKER_JOB_STALE_OR_FOREIGN");
  return selection(project, job.clipId);
}
/** Capture before starting asynchronous analysis. A stale result never edits a later selection. */
export function beginBeatMarkerJobV1(project: EditProject, clipId: string): BeatMarkerJobV1 {
  const { asset } = selection(project, clipId);
  const job = Object.freeze({ schema: "editkin.beat-marker-job/v1" as const, clipId, assetId: asset.id, assetUri: asset.uri });
  jobs.set(job, identity(project, job)); return job;
}
/** For the package's Node analysis handler; never trust fields from a serialized job. */
export function beatMarkerJobSourceV1(project: EditProject, job: BeatMarkerJobV1, options?: BeatMarkerOptionsV1) {
  const { clip, asset } = current(project, job);
  const range = options ? optionsFor(project, job, options).range : { start: clip.timelineStart, end: clip.timelineStart + clip.duration };
  const sourceStartSeconds = clip.sourceStart + (range.start - clip.timelineStart), sourceEndSeconds = clip.sourceStart + (range.end - clip.timelineStart);
  return { assetId: asset.id, assetUri: asset.uri, sourceStartSeconds, durationSeconds: sourceEndSeconds - sourceStartSeconds };
}
function optionsFor(project: EditProject, job: BeatMarkerJobV1, options: BeatMarkerOptionsV1) {
  const { clip } = current(project, job), mode = options.mode ?? "downbeats";
  if (!["downbeats", "all"].includes(mode) || !/^[a-zA-Z0-9_-]{1,64}$/.test(options.idPrefix)
    || !Number.isFinite(Date.parse(options.createdAt)) || new Date(options.createdAt).toISOString() !== options.createdAt
    || !options.labels || Object.values(options.labels).length !== 3 || Object.values(options.labels).some(s => typeof s !== "string" || !s.trim() || s.length > 2048)
    || !options.labels.beat || !options.labels.downbeat || !options.labels.candidateNote) throw Error("BEAT_MARKER_OPTIONS_INVALID");
  const range = options.timelineRange ?? { start: clip.timelineStart, end: clip.timelineStart + clip.duration };
  if (![range.start, range.end].every(Number.isFinite) || range.start < clip.timelineStart || range.end > clip.timelineStart + clip.duration
    || range.start >= range.end) throw Error("BEAT_MARKER_RANGE_INVALID");
  return { clip, mode, range };
}
type SelectedBeat = { frame: number; time: number; sourceSeconds: number; analysisIndex: number;
  downbeat: boolean; confidence: number; downbeatConfidence: number; quantizationErrorFrames: number };
function selectedBeats(project: EditProject, job: BeatMarkerJobV1, receipt: ReturnType<typeof validateMusicBeatsReceiptV1>, request: MusicBeatsRequestV1, options: BeatMarkerOptionsV1) {
  const { clip, mode, range } = optionsFor(project, job, options), analysis = receipt.analysis;
  const sourceStart = clip.sourceStart + (range.start - clip.timelineStart), sourceEnd = clip.sourceStart + (range.end - clip.timelineStart);
  // The native contract rounds the requested duration to a16kHz sample count.
  // Coverage uses that validated request, not its slightly different double reconstruction.
  if (request.sourceStartSeconds > sourceStart || request.sourceStartSeconds + request.durationSeconds < sourceEnd) throw Error("BEAT_MARKER_ANALYSIS_WINDOW_INCOMPLETE");
  const existingFrames = new Set(project.director.markers.filter(m => m.kind === "beat").map(m => Math.round(m.time * project.fps)));
  const candidates = new Map<number, SelectedBeat>(); let duplicateFrames = 0, alreadyMarkedEvents = 0, boundaryEvents = 0, eligibleEvents = 0;
  for (const [analysisIndex, beat] of analysis.beats.entries()) {
    if ((mode === "downbeats" && !beat.downbeat) || beat.timeSeconds < sourceStart || beat.timeSeconds >= sourceEnd) continue;
    eligibleEvents++;
    const timelineSeconds = clip.timelineStart + (beat.timeSeconds - clip.sourceStart), frame = Math.round(timelineSeconds * project.fps), time = frame / project.fps;
    if (time < range.start || time >= range.end) { boundaryEvents++; continue; }
    if (existingFrames.has(frame)) { alreadyMarkedEvents++; continue; }
    const next = { frame, time, sourceSeconds: beat.timeSeconds, analysisIndex, downbeat: beat.downbeat,
      confidence: beat.confidence, downbeatConfidence: beat.downbeatConfidence, quantizationErrorFrames: frame - timelineSeconds * project.fps };
    const previous = candidates.get(frame);
    if (previous) {
      duplicateFrames++;
      if (Number(next.downbeat) < Number(previous.downbeat) || next.downbeat === previous.downbeat && next.confidence <= previous.confidence) continue;
    }
    candidates.set(frame, next);
    if (candidates.size > BEAT_MARKER_BATCH_LIMIT_V1) throw Error("BEAT_MARKER_BATCH_LIMIT_SELECT_SMALLER_RANGE");
  }
  return { events: [...candidates.values()].sort((a, b) => a.frame - b.frame), mode, range,
    stats: { analysisBeats: analysis.beats.length, eligibleEvents, duplicateFrames, alreadyMarkedEvents, boundaryEvents } };
}
/** No file I/O or analysis rerun. These are candidate beats, never human-approved meter. */
export function prepareBeatMarkersV1(project: EditProject, job: BeatMarkerJobV1, input: {
  request: MusicBeatsRequestV1; source: BeatMarkerSourceV1; receipt: unknown;
}, options: BeatMarkerOptionsV1) {
  options.signal?.throwIfAborted(); const { asset } = current(project, job);
  if (input.source.assetId !== asset.id || input.source.assetUri !== asset.uri) throw Error("BEAT_MARKER_SOURCE_BINDING_MISMATCH");
  const request = musicBeatsRequestSchemaV1.parse(input.request), receipt = validateMusicBeatsReceiptV1(input.receipt, request, input.source);
  const selected = selectedBeats(project, job, receipt, request, options), ids = new Set(project.director.markers.map(m => m.id));
  const commands: EditorCommand[] = selected.events.map(event => {
    const id = `${options.idPrefix}-${event.frame}`;
    if (ids.has(id)) throw Error("BEAT_MARKER_ID_COLLISION"); ids.add(id);
    const marker: DirectorMarker = Object.freeze({ id, time: event.time, title: event.downbeat ? options.labels.downbeat : options.labels.beat,
      note: options.labels.candidateNote, kind: "beat", status: "open", createdAt: options.createdAt });
    return Object.freeze({ type: "add_director_marker" as const, marker });
  });
  options.signal?.throwIfAborted(); current(project, job);
  const command = commands.length ? Object.freeze({ type: "batch" as const, commands: Object.freeze(commands) }) as unknown as EditorCommand : undefined;
  const emptyReason = receipt.analysis.beats.length === 0 ? "no-beats" : selected.mode === "downbeats" && selected.stats.eligibleEvents === 0 ? "no-downbeats-in-range" : "no-new-markers";
  const plan = Object.freeze({ schema: "editkin.beat-marker-plan/v1" as const, state: command ? "ready" as const : "empty" as const,
    emptyReason: command ? null : emptyReason, markerCount: commands.length, command,
    events: Object.freeze(selected.events.map(e => Object.freeze(e))), mode: selected.mode, range: Object.freeze({ ...selected.range }), stats: Object.freeze(selected.stats),
    sourceSha256: receipt.sourceSha256, pcmSha256: receipt.pcmSha256, ffmpegSha256: receipt.ffmpegSha256,
    analysisWindow: Object.freeze({ sourceStartSeconds: receipt.analysis.sourceStartSeconds, durationSeconds: receipt.analysis.durationSeconds }),
    qualityState: receipt.analysis.qualityState, meterHypothesis: receipt.analysis.meterHypothesis,
    realMusicQualityCertified: false as const, ordinaryEditorIntegrated: false as const, vaDefaultEligible: false as const });
  plans.set(plan, { job, command, signal: options.signal }); return plan;
}
/** Call immediately before the existing history dispatch; no-op plans create no Undo. */
export function beatMarkerCommandForProjectV1(project: EditProject, plan: object): EditorCommand | undefined {
  const saved = plans.get(plan); if (!saved) throw Error("BEAT_MARKER_PLAN_FOREIGN");
  saved.signal?.throwIfAborted(); current(project, saved.job);
  return saved.command ? structuredClone(saved.command) : undefined;
}
