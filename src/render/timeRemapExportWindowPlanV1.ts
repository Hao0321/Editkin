import { createHash } from "node:crypto";
import type { EditProject } from "../domain/types";
import { validateProject } from "../domain/editGraph";
import { hasAuthoredClipTimeRemapV1, clipTimeRemapAudioPlanV1 } from "../domain/clipTimeRemapV1";
import { canonicalJson } from "../shared/canonicalJson";
import { renderReviewContentJson } from "../shared/renderReviewContent";
import { admitTimeRemapCacheClipV1, TIME_REMAP_CACHE_MAX_BYTES_V1 } from "./timeRemapCacheContractV1";
import { resolveTimeRemapFrameWindowV1 } from "./timeRemapFrameWindowV1";
import { resolveMediaPath } from "./mediaProcess";
import { createTimeRemapSourceStageV1 } from "./timeRemapSourceStageV1";

const MIB = 1024 ** 2, HEADER_BYTES = 2 * MIB;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export interface TimeRemapExportWindowLimitsV1 {
  /** Media artifact cap, not the index/decoder/encoder/RAM budget. The actual writer must enforce it. */
  maximumWindowMediaBytes?: number;
  maximumWindowSeconds?: number;
  maximumPlanningMetadataBytes?: number;
}

/** H8 preparation only: no file I/O, per-frame table, normalized curve slice, render default or
 * audio fallback. The host still owns original-source verification, V4 live sessions, the space
 * guard, composition, a single global audio pass and final publication. */
export function planTimeRemapExportWindowsV1(project: EditProject, input: {
  sourceSha256ByAssetId: Readonly<Record<string, string>>; assetBase?: string; limits?: TimeRemapExportWindowLimitsV1;
}) {
  const limits = {
    maximumWindowMediaBytes: input.limits?.maximumWindowMediaBytes ?? 256 * MIB,
    maximumWindowSeconds: input.limits?.maximumWindowSeconds ?? 60,
    maximumPlanningMetadataBytes: input.limits?.maximumPlanningMetadataBytes ?? 4 * MIB,
  };
  if (!Number.isSafeInteger(limits.maximumWindowMediaBytes) || limits.maximumWindowMediaBytes < MIB || limits.maximumWindowMediaBytes > TIME_REMAP_CACHE_MAX_BYTES_V1
    || !Number.isFinite(limits.maximumWindowSeconds) || limits.maximumWindowSeconds <= 0 || limits.maximumWindowSeconds > 60
    || !Number.isSafeInteger(limits.maximumPlanningMetadataBytes) || limits.maximumPlanningMetadataBytes < 1024 || limits.maximumPlanningMetadataBytes > 64 * MIB) throw Error("TIME_REMAP_EXPORT_WINDOW_LIMITS_INVALID");
  validateProject(project);
  if (project.compositions.some(c => c.tracks.some(t => t.clips.some(hasAuthoredClipTimeRemapV1)))) throw Error("TIME_REMAP_EXPORT_NESTED_CLOCK_REQUIRES_MATERIALIZATION");
  const assets = new Map(project.assets.map(a => [a.id, a]));
  const entries = new Map<string, ReturnType<typeof compile>>();
  let planningMetadataBytes = 0;
  function compile(original: EditProject["tracks"][number]["clips"][number]) {
    const source = assets.get(original.assetId);
    if (!source || !Object.hasOwn(input.sourceSha256ByAssetId, source.id) || !/^[a-f0-9]{64}$/.test(input.sourceSha256ByAssetId[source.id])) throw Error("TIME_REMAP_EXPORT_ORIGINAL_SOURCE_SHA_REQUIRED");
    const { clock, width, height } = admitTimeRemapCacheClipV1(project, original, source);
    const clip = structuredClone(original), asset = structuredClone(source), sourcePath = resolveMediaPath(source.uri, input.assetBase);
    // This conservative bound is admission, not a codec promise: the child must abort if actual
    // bytes exceed the cap. Index/session storage is separately admitted by its existing guard.
    const rawFrameBytes = width * height * 4, estimatedFrameBytes = Math.ceil(rawFrameBytes * 1.2 + 4096);
    const byBytes = Math.floor((limits.maximumWindowMediaBytes - HEADER_BYTES) / estimatedFrameBytes);
    const byTime = Math.floor(limits.maximumWindowSeconds * clock.outputRate.numerator / clock.outputRate.denominator + 1e-7);
    const maximumWindowFrames = Math.min(byBytes, byTime, clock.totalOutputFrames);
    if (!Number.isSafeInteger(maximumWindowFrames) || maximumWindowFrames < 1) throw Error("TIME_REMAP_EXPORT_ONE_FRAME_EXCEEDS_WINDOW_BUDGET");
    const clockSha256 = digest(canonicalJson(clock)), sourceSha256 = input.sourceSha256ByAssetId[source.id];
    const audio = clipTimeRemapAudioPlanV1(original);
    planningMetadataBytes += Buffer.byteLength(canonicalJson({ clip, asset, clock, sourcePath, sourceSha256 }), "utf8");
    if (!Number.isSafeInteger(planningMetadataBytes) || planningMetadataBytes > limits.maximumPlanningMetadataBytes) throw Error("TIME_REMAP_EXPORT_PLANNING_METADATA_BUDGET");
    const summary = Object.freeze({ clipId: clip.id, assetId: asset.id, sourceSha256, clockSha256,
      totalFrames: clock.totalOutputFrames, outputRate: clock.outputRate, maximumWindowFrames,
      windows: Math.ceil(clock.totalOutputFrames / maximumWindowFrames), rawFrameBytes,
      audio: Object.freeze({ mode: audio.mode, originalVolume: clip.volume, followingSourceAudioMustBeConsumedSeparately: audio.mode !== "mute" }) });
    return { clip, asset, clock, sourcePath, summary, estimatedFrameBytes };
  }
  for (const track of project.tracks) for (const clip of track.clips) if (hasAuthoredClipTimeRemapV1(clip)) entries.set(clip.id, compile(clip));
  const clips = Object.freeze([...entries.values()].map(e => e.summary));
  const projectContentSha256 = digest(renderReviewContentJson(project));
  return Object.freeze({ schema: "editkin.time-remap-export-window-plan/v1" as const, projectContentSha256,
    clips, planningMetadataBytes, limits: Object.freeze(limits), ordinaryExportIntegrated: false as const,
    /** Only this requested window is allocated. Its full clock is immutable and compiled once. */
    window(clipId: string, index: number) {
      const entry = entries.get(clipId);
      if (!entry) throw Error("TIME_REMAP_EXPORT_SELECTED_CLIP_UNKNOWN");
      if (!Number.isSafeInteger(index) || index < 0 || index >= entry.summary.windows) throw Error("TIME_REMAP_EXPORT_WINDOW_INDEX_INVALID");
      const firstFrame = index * entry.summary.maximumWindowFrames;
      const frames = Math.min(entry.summary.maximumWindowFrames, entry.clock.totalOutputFrames - firstFrame);
      const outputFrameWindow = Object.freeze({ firstFrame, frames });
      const interval = resolveTimeRemapFrameWindowV1(entry.clock, outputFrameWindow);
      const sourceStage = createTimeRemapSourceStageV1({ fps: entry.clock.outputRate.numerator / entry.clock.outputRate.denominator }, entry.clip, entry.asset, entry.sourcePath);
      return Object.freeze({ clipId, index, sourceSha256: entry.summary.sourceSha256, clockSha256: entry.summary.clockSha256,
        clock: entry.clock, sourceStage, outputFrameWindow, interval: Object.freeze(interval),
        timelineStart: entry.clip.timelineStart + interval.timelineStart,
        estimatedOutputBytes: HEADER_BYTES + frames * entry.estimatedFrameBytes,
        audio: entry.summary.audio, ordinaryExportIntegrated: false as const });
    } });
}
