import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { EditProject } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import { renderTimeRemapSourceProjectV1, SOURCE_CLOCK_RENDER_POLICY_V1, SOURCE_CLOCK_PCM_CONSTANT_POLICY_V2, SOURCE_CLOCK_SHARED_PHASE_PCM_POLICY_V3 } from "../render/timeRemapSourceRenderV1";
import { errorResult, textResult } from "./toolRuntime";

const projectHash = (project: EditProject) => createHash("sha256").update(canonicalJson(project)).digest("hex");
export const timeRemapRenderInputSchemaV1 = z.strictObject({
  projectPath: z.string().trim().min(1).max(1024), outputPath: z.string().trim().min(1).max(1024).regex(/\.mkv$/i),
  policy: z.enum([SOURCE_CLOCK_RENDER_POLICY_V1, SOURCE_CLOCK_PCM_CONSTANT_POLICY_V2, SOURCE_CLOCK_SHARED_PHASE_PCM_POLICY_V3]), expectedSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  expectedProjectSha256: z.string().regex(/^[a-f0-9]{64}$/), maximumOutputBytes: z.number().int().min(1024).max(1024 ** 4),
});
export interface TimeRemapRenderDependenciesV1 {
  readProject(path: string): Promise<EditProject>; resolveProjectPath(path: string): Promise<string>;
  resolveRenderPath(path: string): Promise<string>; workspaceRoot(): string;
  acquireProjectLock(path: string): Promise<() => Promise<void>>; render: typeof renderTimeRemapSourceProjectV1;
}
async function defaultDependencies(): Promise<TimeRemapRenderDependenciesV1> {
  const { readProject, resolveProjectPath, resolveWorkspaceMediaPath, workspaceRoot } = await import("./storage");
  const { acquireProjectLock } = await import("../application/projectFiles");
  return { readProject, resolveProjectPath, resolveRenderPath: resolveWorkspaceMediaPath, workspaceRoot, acquireProjectLock, render: renderTimeRemapSourceProjectV1 };
}
/** Explicit candidate source exporter. General renderer, installed desktop and VA admission stay separate. */
export async function renderTimeRemapToolV1(value: unknown, signal?: AbortSignal, supplied?: TimeRemapRenderDependenciesV1) {
  const input = timeRemapRenderInputSchemaV1.parse(value); signal?.throwIfAborted();
  const dependencies = supplied ?? await defaultDependencies(), path = await dependencies.resolveProjectPath(input.projectPath);
  const stored = await dependencies.readProject(input.projectPath), projectSha256 = projectHash(stored); signal?.throwIfAborted();
  if (projectSha256 !== input.expectedProjectSha256) throw Error("CURVE_RENDER_PROJECT_BINDING_CHANGED");
  // Read exactly the media that was checked (renderMediaBinding.ts): granted outside files by canonical path, nothing unchecked.
  const { bindProjectMediaForRender } = await import("./renderMediaBinding");
  const project = await bindProjectMediaForRender(stored); signal?.throwIfAborted();
  const output = await dependencies.resolveRenderPath(input.outputPath), app = resolve(import.meta.dirname, "../..");
  const result = await dependencies.render(project, output, { assetBase: dependencies.workspaceRoot(),
    ffmpegPath: process.env.HAO_FFMPEG_PATH ?? resolve(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe"),
    ffprobePath: process.env.HAO_FFPROBE_PATH ?? resolve(app, "vendor/ffmpeg/win32-x64/ffprobe.exe"),
    policy: input.policy, expectedSourceSha256: input.expectedSourceSha256, maximumOutputBytes: input.maximumOutputBytes, signal,
    withPublicationGuard: async operation => {
      const release = await dependencies.acquireProjectLock(path);
      try {
        signal?.throwIfAborted();
        if (projectHash(await dependencies.readProject(input.projectPath)) !== projectSha256) throw Error("CURVE_RENDER_SAVED_PROJECT_CHANGED");
        return await operation();
      } finally { await release(); }
    },
  });
  return { ...result, projectBinding: { path, projectId: project.id, revision: project.revision, projectSha256 },
    mutationPerformed: false, certificationPerformed: false };
}
export function registerTimeRemapRenderToolsV1(server: McpServer) {
  server.registerTool("render_source_clock_project_v1", {
    description: "明示 diagnostic_lossless_source_clock_rgba8_v1 與專案/來源SHA、容量上限：單一中性8bit片段的恒速、Bezier變速、倒放、定格，從真實decoded PTS取樣，有界RGBA cache串流FFV1 MKV，逐像素核對後僅新增輸出。原政策有聲須靜音；diagnostic_lossless_source_clock_rgba8_pcm_constant_v2是未認證音訊候選：1倍速原窗PCM已驗，其他恒速須經處理/來源峰值與sample窗完整核對，反相或峰值異常拒絕，完整output PCM對reference一致才發布。新增明示diagnostic_lossless_source_clock_rgba8_shared_phase_pcm_v3：有界共同frequency-bin相位PCM，FD3與video雙pipe，不存raw電影；恒速0.5/2/4的音高/正反相核心短測已過，完整聲音/極短/曲線/倒放、HDR/scene-linear、一般預覽與10小時速度仍未完成。輸出前重新鎖定並核對已儲存專案，不覆寫、不改來源、不認證或安裝。",
    inputSchema: timeRemapRenderInputSchemaV1,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input, extra) => {
    try { return textResult(await renderTimeRemapToolV1(input, extra.mcpReq.signal)); } catch (error) { return errorResult(error); }
  });
}
