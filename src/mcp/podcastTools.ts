import type { McpServer } from "@modelcontextprotocol/server";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import * as z from "zod/v4";
import { transcribeAutomaticCaptions } from "../application/automaticCaptions";
import { creativeAssetIdFromUri, resolveCreativeLibraryAsset } from "../application/creativeLibrary";
import { analyzeMotionTrack } from "../application/motionTracking";
import { buildPodcastDirectorCommand } from "../application/podcastDirector";
import { resolveAestheticSystem } from "../application/editkinAesthetic";
import { findAsset, findClip, summarizeProject } from "../domain/editGraph";
import { applyProjectCommands, readProject, resolveWorkspaceMediaPath, workspaceRoot } from "./storage";
import { creativePackRoot, errorResult, personalMusicRoot, personalVisualRoot, textResult } from "./toolRuntime";

export function registerPodcastTools(server: McpServer): void {
  server.registerTool("direct_podcast_speakers", {
    description: "以使用者框選的主持人與來賓臉部，並行執行 Rust 追蹤、局部說話動態估計與本機 Whisper 語音區間，再建立 active-speaker／上下雙格可編輯 Timeline。信心不足會保留雙人畫面，不把 visual activity 冒充聲紋 diarization。",
    inputSchema: z.object({
      projectPath: z.string(), clipId: z.string(), initialTime: z.number().nonnegative().default(0),
      hostRect: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(0.02).max(1), height: z.number().min(0.02).max(1) }),
      guestRect: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(0.02).max(1), height: z.number().min(0.02).max(1) }),
      language: z.string().regex(/^(?:auto|[a-z]{2,3}(?:-[a-z0-9]{2,8})?)$/i).default("auto"),
    }),
  }, async ({ projectPath, clipId, initialTime, hostRect, guestRect, language }) => {
    try {
      for (const rect of [hostRect, guestRect]) if (rect.x + rect.width > 1 || rect.y + rect.height > 1) throw new Error("人物框超出畫面");
      const project = await readProject(projectPath);
      const clip = findClip(project, clipId);
      const asset = findAsset(project, clip.assetId);
      if (asset.kind !== "video") throw new Error("雙人物導播只支援影片片段");
      const creativeId = creativeAssetIdFromUri(asset.uri);
      const sourcePath = creativeId ? (await resolveCreativeLibraryAsset(creativePackRoot(), creativeId, personalMusicRoot(), personalVisualRoot())).absolutePath : await resolveWorkspaceMediaPath(asset.uri);
      const ffmpegPath = process.env.HAO_FFMPEG_PATH ?? (process.platform === "win32" ? resolve(import.meta.dirname, "../../vendor/ffmpeg/win32-x64/ffmpeg.exe") : "ffmpeg");
      const nativeCorePath = process.env.HAO_NATIVE_CORE_PATH ?? (process.platform === "win32" ? resolve(import.meta.dirname, "../../native/bin/win32-x64/hao-core.exe") : "hao-core");
      const modelRoot = process.env.EDITKIN_MODEL_ROOT ?? resolve(workspaceRoot(), ".editkin-models");
      const requestBase = { sourcePath, sourceStart: clip.sourceStart, duration: clip.duration, fps: project.fps, sourceWidth: asset.width ?? project.width, sourceHeight: asset.height ?? project.height, initialTime, sourceSha256: asset.derivatives?.sourceSha256 };
      const [hostResult, guestResult, transcript] = await Promise.all([
        analyzeMotionTrack({ ...requestBase, initialRect: hostRect }, { ffmpegPath, nativeCorePath, cacheRoot: process.env.EDITKIN_CACHE_ROOT }),
        analyzeMotionTrack({ ...requestBase, initialRect: guestRect }, { ffmpegPath, nativeCorePath, cacheRoot: process.env.EDITKIN_CACHE_ROOT }),
        transcribeAutomaticCaptions({ sourcePath, sourceStart: clip.sourceStart, duration: clip.duration, sourceSha256: asset.derivatives?.sourceSha256, language }, { ffmpegPath, modelRoot, modelPath: process.env.EDITKIN_WHISPER_MODEL_PATH, cacheRoot: process.env.EDITKIN_CACHE_ROOT ?? resolve(modelRoot, "../media-cache") }),
      ]);
      const now = new Date().toISOString();
      const host = { id: `motion-host-${randomUUID()}`, clipId, name: "主持人", role: "host" as const, engine: hostResult.engine, analysisFps: hostResult.analysisFps, initialRect: hostRect, points: hostResult.points, lostRatio: hostResult.lostRatio, createdAt: now };
      const guest = { id: `motion-guest-${randomUUID()}`, clipId, name: "來賓", role: "guest" as const, engine: guestResult.engine, analysisFps: guestResult.analysisFps, initialRect: guestRect, points: guestResult.points, lostRatio: guestResult.lostRatio, createdAt: now };
      const built = buildPodcastDirectorCommand({ project, clip, host, guest, cues: transcript.cues, idFactory: (kind, index) => `${kind}-${index}-${randomUUID()}` });
      if (built.command.type !== "batch") throw new Error("雙人物導播命令格式錯誤");
      const updated = await applyProjectCommands(projectPath, [{ type: "batch", commands: [
        { type: "set_editorial_profile", profile: "podcast_on_camera" },
        { type: "set_aesthetic_system", aestheticSystem: resolveAestheticSystem("podcast_on_camera", project.width > project.height ? "longform" : "shorts") },
        { type: "add_motion_track", track: host }, { type: "add_motion_track", track: guest },
        { type: "set_caption_style", patch: { presetId: "clean_caption", backgroundColor: "#00000099", color: "#FFFFFF" } },
        ...built.command.commands,
      ] }]);
      return textResult({ status: "GREEN", heuristic: "visual-activity+speech-window+hysteresis", diarizationClaimed: false, shots: built.shots.length, uncertainSplitShots: built.uncertainShots, hostValidPercent: Math.round((1 - hostResult.lostRatio) * 100), guestValidPercent: Math.round((1 - guestResult.lostRatio) * 100), summary: summarizeProject(updated) });
    } catch (error) { return errorResult(error); }
  });
}
