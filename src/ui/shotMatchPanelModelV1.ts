import { canonicalJson } from "../shared/canonicalJson";
import { DEFAULT_COLOR_MANAGEMENT } from "../domain/types";
import type { EditProject, TimelineClip } from "../domain/types";
import type { ShotGradeFrameV1, ShotGradeRegionV1 } from "../color/shotGradeStatisticsV1";
import type { ShotGradeLocalRequestV1 } from "../application/shotGradeLocalContractV1";
import type { PreparedShotGradeLocalV1 } from "../application/shotGradeLocalV1";

export type ShotMatchModeV1 = "shot_match" | "auto_balance";
export interface ShotMatchFramesV1 { clipId: string; assetId: string; sourceSha256: string; opaque: true; frames: ShotGradeFrameV1[]; }
export interface ShotMatchRuntimeV1 { signal: AbortSignal; isCurrent(): boolean; }
export interface ShotMatchReviewV1 {
  proposal: PreparedShotGradeLocalV1; before: ShotMatchFramesV1; after: ShotMatchFramesV1;
  /** Same backend/session closure; the displayed JSON proposal is never apply authority. */
  apply(runtime: ShotMatchRuntimeV1): Promise<{ status: "applied" | "unchanged"; undoSteps: 0 | 1; clipId: string }>;
  discard(): void;
}
export interface ShotMatchHostV1 {
  projectOwner: object; contentOwner: object; sessionId: number; projectPath?: string;
  project: EditProject; targetClipId: string; editable: boolean; readOnlyReason?: string;
  readFrames(clipId: string, runtime: ShotMatchRuntimeV1): Promise<ShotMatchFramesV1>;
  prepare(request: ShotGradeLocalRequestV1, runtime: ShotMatchRuntimeV1): Promise<ShotMatchReviewV1>;
}
export interface ShotMatchDraftV1 {
  referenceClipId?: string; targetRegions: ShotGradeRegionV1[]; referenceRegions: ShotGradeRegionV1[];
  destination: { kind: "append"; label: string } | { kind: "replace"; nodeId: string; label: string };
}
export type ShotMatchHoldV1 = "unavailable" | "locked" | "aces" | "stale" | "frames" | "reference" | "destination" | "timeout";
export class ShotMatchPanelRefusalV1 extends Error {
  constructor(readonly code: ShotMatchHoldV1) { super(`SHOT_MATCH_PANEL_${code.toUpperCase()}`); }
}
export function refuseShotMatchPanelV1(code: ShotMatchHoldV1): never { throw new ShotMatchPanelRefusalV1(code); }
export function targetShotMatchClipV1(host: ShotMatchHostV1): TimelineClip {
  if (!host || !host.projectOwner || typeof host.projectOwner !== "object" || !host.contentOwner || typeof host.contentOwner !== "object" || !Number.isSafeInteger(host.sessionId) || host.sessionId < 0
    || typeof host.readFrames !== "function" || typeof host.prepare !== "function") refuseShotMatchPanelV1("unavailable");
  const track = host.project.tracks.find(t => t.clips.some(c => c.id === host.targetClipId)), clip = track?.clips.find(c => c.id === host.targetClipId);
  if (!clip) refuseShotMatchPanelV1("unavailable");
  if (host.editable !== true || track?.locked || host.readOnlyReason) refuseShotMatchPanelV1("locked");
  const management = host.project.colorManagement ?? DEFAULT_COLOR_MANAGEMENT;
  if (management.mode !== "rec709" || management.outputTransform !== "rec709_sdr") refuseShotMatchPanelV1("aces");
  return clip;
}
/** One existing track's authored clip strip; no silent fallback to a later shot. */
export function shotMatchReferenceStripV1(host: ShotMatchHostV1) {
  const target = targetShotMatchClipV1(host), track = host.project.tracks.find(t => t.id === target.trackId)!;
  const referenced = new Set(track.clips.map(c => c.assetId));
  const assets = new Map<string, { name: string; video: boolean }>();
  // Per-call, referenced IDs only. Preserve first name and any-video admission.
  for (const asset of host.project.assets) {
    const id = asset.id;
    if (!referenced.has(id)) continue;
    const existing = assets.get(id);
    if (existing) existing.video ||= asset.kind === "video";
    else assets.set(id, { name: asset.name, video: asset.kind === "video" });
  }
  const strip = track.clips.filter(c => assets.get(c.assetId)?.video)
    .map((clip, index) => ({ clip, index })).sort((a, b) => a.clip.timelineStart - b.clip.timelineStart || a.index - b.index).map(r => r.clip);
  const index = strip.findIndex(c => c.id === target.id);
  return { previousClipId: index > 0 ? strip[index - 1].id : undefined,
    clips: strip.filter(c => c.id !== target.id).map(c => ({ id: c.id, name: assets.get(c.assetId)?.name ?? c.id })) };
}
export function shotMatchHostStampV1(host: ShotMatchHostV1) {
  return canonicalJson({ project: host.project, clipId: host.targetClipId, path: host.projectPath, editable: host.editable, readOnlyReason: host.readOnlyReason });
}
export function validateShotMatchFramesV1(input: ShotMatchFramesV1, project: EditProject, clipId: string): ShotMatchFramesV1 {
  const clip = project.tracks.flatMap(t => t.clips).find(c => c.id === clipId);
  if (!clip || !input || input.clipId !== clipId || input.assetId !== clip.assetId || !/^[a-f0-9]{64}$/.test(input.sourceSha256)
    || input.opaque !== true || !Array.isArray(input.frames) || input.frames.length < 1 || input.frames.length > 4) refuseShotMatchPanelV1("frames");
  const ids = new Set<string>();
  for (const [index, frame] of input.frames.entries()) {
    if (!frame || !/^[A-Za-z0-9_.:-]{1,128}$/.test(frame.sampleId) || ids.has(frame.sampleId)
      || !Number.isFinite(frame.timeSeconds) || frame.timeSeconds < 0 || frame.timeSeconds >= clip.duration
      || (index > 0 && frame.timeSeconds <= input.frames[index - 1].timeSeconds)
      || ![frame.width, frame.height].every(v => Number.isSafeInteger(v) && v >= 1 && v <= 256)
      || frame.format !== "rgb8" || frame.workingSpace !== "rec709_display" || frame.stage !== "clip_working_post_v2"
      || !(frame.pixels instanceof Uint8Array) || frame.pixels.length !== frame.width * frame.height * 3
      || (typeof SharedArrayBuffer !== "undefined" && frame.pixels.buffer instanceof SharedArrayBuffer)
      || (frame.pixels.buffer as ArrayBuffer & { resizable?: boolean }).resizable) refuseShotMatchPanelV1("frames");
    ids.add(frame.sampleId);
  }
  return structuredClone(input);
}
export function regionFromShotMatchPixelsV1(frame: ShotGradeFrameV1, role: "neutral" | "skin", start: { x: number; y: number }, end = start): ShotGradeRegionV1 {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(frame.sampleId) || ![frame.width, frame.height].every(v => Number.isSafeInteger(v) && v > 0 && v <= 256)
    || ![start.x, start.y, end.x, end.y].every(Number.isSafeInteger) || !["neutral", "skin"].includes(role)
    || [start.x, end.x].some(v => v < 0 || v >= frame.width) || [start.y, end.y].some(v => v < 0 || v >= frame.height)) refuseShotMatchPanelV1("frames");
  return { sampleId: frame.sampleId, role, x: Math.min(start.x, end.x) / frame.width, y: Math.min(start.y, end.y) / frame.height,
    width: Math.min(1 - Math.min(start.x, end.x) / frame.width, (Math.abs(end.x - start.x) + 1) / frame.width),
    height: Math.min(1 - Math.min(start.y, end.y) / frame.height, (Math.abs(end.y - start.y) + 1) / frame.height) };
}
export function replaceShotMatchMarkV1(regions: readonly ShotGradeRegionV1[], region: ShotGradeRegionV1) {
  return [...regions.filter(r => r.sampleId !== region.sampleId || r.role !== region.role), { ...region }];
}
function sourceRequest(frames: ShotMatchFramesV1, regions: ShotGradeRegionV1[]) {
  if (regions.length > 32 || regions.some(r => !frames.frames.some(f => f.sampleId === r.sampleId)
    || ![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.x < 0 || r.y < 0 || r.width <= 0 || r.height <= 0 || r.x + r.width > 1 || r.y + r.height > 1)) refuseShotMatchPanelV1("frames");
  return { clipId: frames.clipId, samples: frames.frames.map(f => ({ id: f.sampleId, time: f.timeSeconds })), regions: structuredClone(regions) };
}
export function shotMatchPanelRequestV1(host: ShotMatchHostV1, draft: ShotMatchDraftV1, target: ShotMatchFramesV1, reference: ShotMatchFramesV1 | undefined, mode: ShotMatchModeV1): ShotGradeLocalRequestV1 {
  const clip = targetShotMatchClipV1(host), destination = structuredClone(draft.destination);
  if (!["append", "replace"].includes(destination.kind) || !destination.label.trim() || destination.label.trim().length > 120 || (destination.kind === "replace" && clip.gradeV2?.nodes?.at(-1)?.id !== destination.nodeId)) refuseShotMatchPanelV1("destination");
  const common = { schema: "editkin.shot-grade-local-request/v1" as const, expectedRevision: host.project.revision,
    target: sourceRequest(validateShotMatchFramesV1(target, host.project, clip.id), draft.targetRegions), destination,
    roiBasis: "local-layer-raster-normalized" as const, reason: "Explicit user-declared local-stage regions; no automatic neutral or skin classification", highBitDepth: false, maximumTimeMs: 20000 };
  if (mode === "auto_balance") return { ...common, mode };
  if (!reference || !draft.referenceClipId || reference.clipId !== draft.referenceClipId || reference.clipId === clip.id
    || !shotMatchReferenceStripV1(host).clips.some(c => c.id === reference.clipId)) refuseShotMatchPanelV1("reference");
  return { ...common, mode, reference: sourceRequest(validateShotMatchFramesV1(reference, host.project, reference.clipId), draft.referenceRegions) };
}
