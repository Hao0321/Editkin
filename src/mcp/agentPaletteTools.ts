import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { listPaletteRoles, paletteRevisionHash, paletteRevisionInputSchema, preparePaletteRevision } from "../application/agentPaletteRevision";
import { readProject, resolveProjectPath } from "./storage";
import { textResult, errorResult } from "./toolRuntime";

export function registerAgentPaletteTools(server: McpServer) {
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  server.registerTool("list_editkin_palette_roles", { description: "列出七個可改色角色、透明度規則與可編輯配色例；不推定美術驗收或原生渲染。", inputSchema: z.strictObject({}), annotations }, async () => textResult(listPaletteRoles()));
  server.registerTool("prepare_editkin_palette_revision", { description: "只讀：明確指定既有 Motion graphicId 與角色色，一次準備最多32個換色 commands；保留原透明度或使用角色 alpha，檢查宣告畫布上的文字對比。拒絕 stale 及 scene/template owner；回同一 revision6/V4 audit/apply/render/review。", inputSchema: paletteRevisionInputSchema.extend({ projectPath: z.string().min(1).max(1024) }), annotations }, async ({ projectPath, ...input }, extra) => {
    try {
      const signal = extra.mcpReq.signal; signal.throwIfAborted();
      const canonicalPath = await resolveProjectPath(projectPath), before = await readProject(canonicalPath);
      const result = preparePaletteRevision(before, input, signal);
      const after = await readProject(canonicalPath); signal.throwIfAborted();
      if (paletteRevisionHash(after) !== result.projectSha256) throw new Error("Project changed during palette preparation");
      const { preparationSha256: _unbound, ...body } = result;
      const bound = { ...body, projectPath: canonicalPath };
      return textResult({ ...bound, preparationSha256: paletteRevisionHash(bound) });
    } catch (error) { return errorResult(error); }
  });
}
