import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { EditProject } from "../domain/types";
import { clipTimeRemapMuteReasonV1, hasAuthoredClipTimeRemapV1, type ClipTimeRemapMuteReasonV1 } from "../domain/clipTimeRemapV1";
import { clipTimeRemapRenderBlockersV1 } from "../domain/clipTimeRemapCommandsV1";
import { materializeTimeRemapClipsV1 } from "./materializeTimeRemapClipsV1";
import { TIME_REMAP_CACHE_POLICY_V1 } from "./timeRemapCacheContractV1";
import { TIME_REMAP_CACHE_EVICTION_POLICY_V1 } from "./timeRemapCacheCapacityV1";
import { timeRemapSha256V1 } from "./timeRemapCacheIdentityV1";
import { resolveMediaPath } from "./mediaProcess";
import { withHelperTemporaryRootV1 } from "./helperProcessEnvironmentV1";
import { renderProgressTimeReporter, reportRenderPart, reportRenderStage } from "./renderProgress";
import type { RenderOptions, RenderResult } from "./ffmpegTypes";

/** What the export did with each authored speed or speed curve. */
export interface TimeRemapExportReceiptV1 {
  schema: "editkin.time-remap-export/v1";
  /** Each clip is baked from its source through the shared source clock, then rendered like any other clip. */
  route: "source_clock_cache_bake";
  clips: Array<{
    clipId: string; speed: number | null; curve: boolean; frames: number; cacheHit: boolean;
    /** pitch_preserved = the sound follows the constant speed with its pitch kept (shared-phase vocoder). */
    audio: "pitch_preserved" | "muted" | "absent";
    audioEngine?: "shared_bin_phase_vocoder_v1" | "atempo_chain";
    muteReason?: ClipTimeRemapMuteReasonV1;
  }>;
}

const authoredClips = (project: EditProject) => project.tracks.flatMap(track => track.clips).filter(hasAuthoredClipTimeRemapV1);

export function projectHasAuthoredTimeRemapV1(project: EditProject): boolean {
  return [project.tracks, ...project.compositions.map(composition => composition.tracks)]
    .some(tracks => tracks.some(track => track.clips.some(hasAuthoredClipTimeRemapV1)));
}

/**
 * Every export entry (desktop service, MCP sync/async render, autopilot, batch) goes through renderProject, which calls
 * this first. A project without an authored speed is passed through untouched (the exact previous path). Otherwise each
 * speed/curve clip is baked through the existing source-clock cache (materializeTimeRemapClipsV1), the ordinary render
 * runs on that clone, and the cache leases are released afterwards. Anything the export cannot render is refused with its
 * named reason first (the same admission as set_clip_speed and validate_project); there is no 1x fallback.
 *
 * The cache lives on the output's volume (<output folder>/.editkin/time-remap-v1, reused across exports); its helper
 * processes get a declared TEMP/TMP beside it, so the host's own TEMP (often the system drive) is never used for it.
 */
export async function withTimeRemapExportV1(project: EditProject, outputPath: string, options: RenderOptions,
  render: (project: EditProject) => Promise<RenderResult>): Promise<RenderResult> {
  if (!projectHasAuthoredTimeRemapV1(project)) return render(project);
  const blockers = clipTimeRemapRenderBlockersV1(project);
  if (blockers.length) {
    throw new Error(`變速片段無法輸出（${blockers.slice(0, 3).map(row => `${row.clipId}：${row.code}`).join("；")}${blockers.length > 3 ? "…" : ""}）：${blockers[0].message}`);
  }
  options.signal?.throwIfAborted();
  const clips = authoredClips(project);
  const projectRoot = dirname(resolve(outputPath)), helperTemporaryRoot = join(projectRoot, ".editkin", "time-remap-helper-temp");
  await mkdir(helperTemporaryRoot, { recursive: true });
  const sourceSha256ByAssetId: Record<string, string> = {};
  for (const assetId of new Set(clips.map(clip => clip.assetId))) {
    const asset = project.assets.find(item => item.id === assetId)!;
    const recorded = asset.derivatives?.sourceSha256;
    sourceSha256ByAssetId[assetId] = recorded && /^[a-f0-9]{64}$/.test(recorded) ? recorded
      : await timeRemapSha256V1(resolveMediaPath(asset.uri, options.assetBase), options.signal);
  }
  let active: string | undefined;
  reportRenderStage("precompose");
  const materialized = await withHelperTemporaryRootV1(helperTemporaryRoot, () => materializeTimeRemapClipsV1(project,
    { projectRoot, assetBase: options.assetBase, sourceSha256ByAssetId },
    { policy: TIME_REMAP_CACHE_POLICY_V1, ffmpegPath: options.ffmpegPath ?? "ffmpeg", ffprobePath: options.ffprobePath ?? "ffprobe",
      helperTemporaryRoot, signal: options.signal, cacheEvictionPolicy: TIME_REMAP_CACHE_EVICTION_POLICY_V1,
      onFrame: ({ clipId, index }) => {
        if (clipId !== active) {
          active = clipId;
          const at = clips.findIndex(clip => clip.id === clipId);
          reportRenderStage("precompose", clips[at]?.duration);
          reportRenderPart(at + 1, clips.length);
        }
        renderProgressTimeReporter()?.((index + 1) / project.fps);
      } }));
  reportRenderPart();
  const receipt: TimeRemapExportReceiptV1 = { schema: "editkin.time-remap-export/v1", route: "source_clock_cache_bake",
    clips: clips.map((clip, index) => {
      const cached = materialized.artifacts[index].receipt, muteReason = clipTimeRemapMuteReasonV1(clip);
      const audio = cached.audio === "absent" ? "absent" as const : cached.audio === "explicitly_muted" ? "muted" as const : "pitch_preserved" as const;
      return { clipId: clip.id, speed: clip.speed ?? null, curve: clip.timeRemap !== undefined, frames: cached.frames, cacheHit: materialized.artifacts[index].cacheHit, audio,
        ...(audio === "pitch_preserved" ? { audioEngine: cached.audio === "shared_phase_constant_pcm_f32_candidate" ? "shared_bin_phase_vocoder_v1" as const : "atempo_chain" as const } : {}),
        ...(audio === "muted" && muteReason ? { muteReason } : {}) };
    }) };
  try {
    const result = await render(materialized.project);
    return { ...result, timeRemap: receipt };
  } finally {
    await materialized.release();
  }
}
