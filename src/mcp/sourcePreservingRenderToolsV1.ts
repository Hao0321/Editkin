import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { EditProject } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import { renderSourcePreservingProjectV1 } from "../render/sourcePreservingExportV1";
import { SOURCE_PRESERVING_POLICY_V1 } from "../render/sourcePreservingAdmissionV1";
import { errorResult, textResult } from "./toolRuntime";

const sha256Canonical = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
export interface SourcePreservingToolDependenciesV1 {
  readProject: (path: string) => Promise<EditProject>;
  resolveProjectPath: (path: string) => Promise<string>;
  resolveRenderPath: (path: string) => Promise<string>;
  workspaceRoot: () => string;
  acquireProjectLock: (path: string) => Promise<() => Promise<void>>;
  render: typeof renderSourcePreservingProjectV1;
}
async function defaultDependencies(): Promise<SourcePreservingToolDependenciesV1> {
  // Registering this opt-in tool must not load project mutation/codec graphs.
  const { readProject, resolveProjectPath, resolveRenderPath, workspaceRoot } = await import("./storage");
  const { acquireProjectLock } = await import("../application/projectFiles");
  return { readProject, resolveProjectPath, resolveRenderPath, workspaceRoot, acquireProjectLock, render: renderSourcePreservingProjectV1 };
}

export const sourcePreservingRenderInputSchemaV1 = z.strictObject({
  projectPath: z.string().min(1).max(1024), outputPath: z.string().min(1).max(1024),
  policy: z.literal(SOURCE_PRESERVING_POLICY_V1),
  expectedSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export async function renderSourcePreservingToolV1(input: z.infer<typeof sourcePreservingRenderInputSchemaV1>, signal?: AbortSignal,
  supplied?: SourcePreservingToolDependenciesV1) {
  const parsed = sourcePreservingRenderInputSchemaV1.parse(input); signal?.throwIfAborted();
  const dependencies = supplied ?? await defaultDependencies();
  const path = await dependencies.resolveProjectPath(parsed.projectPath), project = await dependencies.readProject(parsed.projectPath);
  const projectSha256 = sha256Canonical(project), output = await dependencies.resolveRenderPath(parsed.outputPath);
  const app = resolve(import.meta.dirname, "../..");
  const result = await dependencies.render(project, output, { assetBase: dependencies.workspaceRoot(),
    ffmpegPath: process.env.HAO_FFMPEG_PATH ?? resolve(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe"),
    ffprobePath: process.env.HAO_FFPROBE_PATH ?? resolve(app, "vendor/ffmpeg/win32-x64/ffprobe.exe"),
    expectedSourceSha256: parsed.expectedSourceSha256, policy: parsed.policy, signal,
    withPublicationGuard: async operation => {
      const release = await dependencies.acquireProjectLock(path);
      try {
        signal?.throwIfAborted();
        if (sha256Canonical(await dependencies.readProject(parsed.projectPath)) !== projectSha256) throw Error("SOURCE_PRESERVING_PROJECT_CHANGED");
        return await operation();
      } finally { await release(); }
    } });
  return { ...result, projectBinding: { path, projectId: project.id, revision: project.revision, projectSha256 },
    mutationPerformed: false, certificationPerformed: false };
}
export function registerSourcePreservingRenderToolsV1(server: McpServer) {
  server.registerTool("render_source_preserving_project", {
    description: "明確選擇preserve_original_container，僅輸出單一完整且未修改的Rec.709 MP4來源。保留原始容器、影音碼流、聲道及PTS/FPS；不做一般輸出的音訊正規化或色彩轉換。裁切、調色、字幕、變速、混音等不符合即拒絕。核對來源SHA、複製候選與全片解碼後才建立新輸出，不覆寫既有檔；10小時速度／美術仍需另驗。",
    inputSchema: sourcePreservingRenderInputSchemaV1,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input, extra) => {
    try { return textResult(await renderSourcePreservingToolV1(input, extra.mcpReq.signal)); }
    catch (error) { return errorResult(error); }
  });
}
