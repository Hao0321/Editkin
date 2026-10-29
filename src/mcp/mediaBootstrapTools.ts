import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { mediaBootstrapRequestSchema, prepareMediaBootstrap, type MediaBootstrapDependencies } from "../application/mediaBootstrap";
import type { EditProject } from "../domain/types";
import { readProject, resolveWorkspaceMediaPath, workspaceRoot } from "./storage";
import { errorResult, textResult } from "./toolRuntime";

export const prepareMediaBootstrapInputSchema = mediaBootstrapRequestSchema.extend({
  projectPath: z.string().min(1).max(1_024),
});
export type PrepareMediaBootstrapInput = z.input<typeof prepareMediaBootstrapInputSchema>;

export interface PrepareMediaBootstrapToolDependencies {
  readProject(projectPath: string): Promise<EditProject>;
  resolveWorkspaceMediaPath(sourcePath: string): Promise<string>;
  workspaceRoot(): string;
  ffprobePath?: string;
  // Internal dependency seam for bounded adapter tests, never part of MCP input.
  prepareDependencies?: Partial<MediaBootstrapDependencies>;
}

function productionDependencies(): PrepareMediaBootstrapToolDependencies {
  return { readProject, resolveWorkspaceMediaPath, workspaceRoot, ffprobePath: process.env.HAO_FFPROBE_PATH };
}

/** Read a current workspace project and source; prepare complete neutral commands only. */
export async function prepareMediaBootstrapReadOnly(
  input: PrepareMediaBootstrapInput,
  dependencies: PrepareMediaBootstrapToolDependencies = productionDependencies(),
  signal?: AbortSignal,
) {
  // Direct calls must obey the same strict contract as registered MCP calls.
  const { projectPath, ...request } = prepareMediaBootstrapInputSchema.parse(input);
  signal?.throwIfAborted();
  // Resolve before reading/probing source bytes. The producer independently checks
  // canonical workspace containment, regular files, byte identity and freshness.
  const sourcePath = await dependencies.resolveWorkspaceMediaPath(request.sourcePath);
  signal?.throwIfAborted();
  const project = await dependencies.readProject(projectPath);
  signal?.throwIfAborted();
  const prepared = await prepareMediaBootstrap(project, { ...request, sourcePath }, {
    workspaceRoot: dependencies.workspaceRoot(), ffprobePath: dependencies.ffprobePath,
    signal,
    readCurrentProject: () => dependencies.readProject(projectPath),
  }, dependencies.prepareDependencies);
  return {
    ...prepared, projectPath, mutationPerformed: false as const, bootstrapOnly: true as const, preparationBindingOnly: true as const,
    executionBoundary: "neutral_commands_require_atomic_bootstrap_apply_motion_requires_revision6_v4" as const,
    capabilityBoundary: "preparation-time source/project identity only; no apply-time lease, host grant, legal rights validation, artwork or output acceptance" as const,
  };
}

export function registerMediaBootstrapTools(
  server: McpServer,
  dependencies: PrepareMediaBootstrapToolDependencies = productionDependencies(),
): void {
  server.registerTool("prepare_media_bootstrap", {
    description: "唯讀：從工作區內真實本機素材與整數影格落點，使用桌面共用 planner 產生完整 neutral import/track/clip flat commands。真 byte SHA、probe、來源窗口、DAR、鎖軌／軌種與碰撞由 production 核對；準備期間來源或專案變動即停止。輸入不接受 clip、color、transform 或 Motion carriers，不寫專案、不渲染、不簽 host grant；caller 權利宣告不是權利驗證。回傳 PREPARED_NOT_APPLIED 草稿，binding 只記準備時身分，不是後續 apply lease；仍需既有原子 bootstrap 套用。所有 Motion 與成片必須走 revision6／v4 audit→atomic apply→render 和當代完整 QA／美術審查。",
    inputSchema: prepareMediaBootstrapInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input, context) => {
    try { return textResult(await prepareMediaBootstrapReadOnly(input, dependencies, context.mcpReq.signal)); }
    catch (error) { return errorResult(error); }
  });
}
