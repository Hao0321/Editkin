import type { McpServer } from "@modelcontextprotocol/server";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { clipAudioGainRequestSchema, prepareClipAudioGain, type ClipAudioGainDependencies } from "../application/clipAudioGain";
import type { EditProject } from "../domain/types";
import { readProject, resolveProjectPath, resolveWorkspaceMediaPath, workspaceRoot } from "./storage";
import { resolveMediaPath } from "../render/mediaProcess";
import { errorResult, textResult } from "./toolRuntime";

export const prepareClipAudioGainInputSchema = clipAudioGainRequestSchema.extend({ projectPath: z.string().trim().min(1).max(1024) }).strict();
export type PrepareClipAudioGainInput = z.input<typeof prepareClipAudioGainInputSchema>;
export interface ClipAudioGainToolDependencies {
  readProject(path: string): Promise<EditProject>;
  resolveProjectPath(path: string): Promise<string>;
  resolveWorkspaceMediaPath(path: string): Promise<string>;
  workspaceRoot(): string;
  ffmpegPath: string;
  ffprobePath: string;
  prepareDependencies?: ClipAudioGainDependencies;
}
function productionDependencies(): ClipAudioGainToolDependencies {
  return { readProject, resolveProjectPath, resolveWorkspaceMediaPath, workspaceRoot,
    ffmpegPath: process.env.HAO_FFMPEG_PATH ?? (process.platform === "win32" ? resolve(import.meta.dirname, "../../vendor/ffmpeg/win32-x64/ffmpeg.exe") : "ffmpeg"),
    ffprobePath: process.env.HAO_FFPROBE_PATH ?? (process.platform === "win32" ? resolve(import.meta.dirname, "../../vendor/ffmpeg/win32-x64/ffprobe.exe") : "ffprobe") };
}
export async function prepareClipAudioGainReadOnly(input: PrepareClipAudioGainInput, dependencies: ClipAudioGainToolDependencies = productionDependencies(), signal?: AbortSignal) {
  const { projectPath, ...request } = prepareClipAudioGainInputSchema.parse(input);
  signal?.throwIfAborted();
  const absoluteProjectPath = await dependencies.resolveProjectPath(projectPath), project = await dependencies.readProject(projectPath);
  const clip = project.tracks.flatMap(track => track.clips).find(candidate => candidate.id === request.clipId);
  const asset = clip && project.assets.find(candidate => candidate.id === clip.assetId);
  if (!asset) throw new Error("找不到片段的音訊來源");
  const sourcePath = await dependencies.resolveWorkspaceMediaPath(resolveMediaPath(asset.uri, dirname(absoluteProjectPath)));
  return { ...await prepareClipAudioGain(project, request, { workspaceRoot: dependencies.workspaceRoot(), sourcePath,
    ffmpegPath: dependencies.ffmpegPath, ffprobePath: dependencies.ffprobePath,
    readCurrentProject: () => dependencies.readProject(projectPath), signal }, dependencies.prepareDependencies), projectPath };
}
export function registerClipAudioGainTools(server: McpServer, dependencies: ClipAudioGainToolDependencies = productionDependencies()): void {
  server.registerTool("prepare_clip_audio_gain", {
    description: "唯讀量測 3–300 秒、最多 512 MiB 工作區內片段的真實音訊響度與 true peak，產生受峰值和 EditGraph 音量上限約束的 set_clip_volume 草稿。單／雙聲道來源先轉為與輸出相同的 48 kHz stereo。靜音、鎖軌、窗口越界、來源或專案變動即 BLOCK；不修改專案、不渲染、不簽審核。command 仍需放進同一份 Video Autopilot v4 plan，audit 後由 atomic apply 提交。只證明分析窗口，不證明混音或編碼後的响度／峰值。",
    inputSchema: prepareClipAudioGainInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input, context) => {
    try { return textResult(await prepareClipAudioGainReadOnly(input, dependencies, context.mcpReq.signal)); }
    catch (error) { return errorResult(error); }
  });
}
