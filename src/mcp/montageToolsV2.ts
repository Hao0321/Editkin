import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { createHash } from "node:crypto";
import { canonicalJson } from "../shared/canonicalJson";
import { beatMontageRequestSchemaV2, compileBeatAlignedMontageV2 } from "../application/beatMontageCompilerV2";
import type { EditProject } from "../domain/types";
import { errorResult, textResult } from "./toolRuntime";

export const compileBeatMontageInputSchemaV2 = beatMontageRequestSchemaV2.extend({ projectPath: z.string().trim().min(1).max(1024) });
export interface CompileBeatMontageDependenciesV2 { readProject(path: string): Promise<EditProject> }
async function defaultDependencies(): Promise<CompileBeatMontageDependenciesV2> {
  const { readProject } = await import("./storage"); return { readProject };
}
export async function compileBeatMontageReadOnlyV2(input: z.infer<typeof compileBeatMontageInputSchemaV2>, signal?: AbortSignal,
  supplied?: CompileBeatMontageDependenciesV2) {
  const parsed = compileBeatMontageInputSchemaV2.parse(input); signal?.throwIfAborted();
  const dependencies = supplied ?? await defaultDependencies(), project = await dependencies.readProject(parsed.projectPath);
  signal?.throwIfAborted(); const { projectPath, ...request } = parsed, result = compileBeatAlignedMontageV2(project, request);
  signal?.throwIfAborted();
  return { ...result, status: "DRAFT_COMMAND_CANDIDATE" as const, mutationPerformed: false as const,
    projectBinding: { path: projectPath, id: project.id, revision: project.revision, sha256: createHash("sha256").update(canonicalJson(project)).digest("hex") } };
}
export function registerMontageToolsV2(server: McpServer) {
  server.registerTool("compile_beat_montage_v2", {
    description: "唯讀 V2：用 caller 宣告的 energy 門檻選兩拍/一拍/半拍，輸出最多100個平鋪剪輯指令；不重複來源區段、影片原聲靜音，需指定音樂與來源SHA/授權證據。可明示有實際handle的溶接/dip與每秒最多3個編排閃白。證據、授權與整片像素閃光仍未驗真，不能直接apply/授予ACCEPTED；仍需既有plan/audit/atomic apply。變速/音效/variants/VA 接線未完成，新增组合未認證。",
    inputSchema: compileBeatMontageInputSchemaV2,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input, extra) => { try { return textResult(await compileBeatMontageReadOnlyV2(input, extra.mcpReq.signal)); } catch (error) { return errorResult(error); } });
}
