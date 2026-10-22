import type { McpServer } from "@modelcontextprotocol/server";
import { discoverWorkspaceMedia, mediaDiscoveryInputSchema, type MediaDiscoveryInput } from "../application/mediaDiscovery";
import { workspaceRoot } from "./storage";
import { errorResult, textResult } from "./toolRuntime";

export interface MediaDiscoveryToolDependencies { workspaceRoot(): string }

export async function discoverWorkspaceMediaReadOnly(input: MediaDiscoveryInput,
  dependencies: MediaDiscoveryToolDependencies = { workspaceRoot }, signal?: AbortSignal) {
  return discoverWorkspaceMedia(input, { workspaceRoot: dependencies.workspaceRoot(), signal });
}

export function registerMediaDiscoveryTools(server: McpServer,
  dependencies: MediaDiscoveryToolDependencies = { workspaceRoot }): void {
  server.registerTool("discover_workspace_media", {
    description: "唯讀：盤點指定工作區資料夾內尚未匯入或已匯入的本機影片、音軌、圖片。依正規化檔名／相對路徑搜尋，支援類型提示、有限深度和分頁；單次最多20000個目錄項目、100筆回傳、10秒。跳過symlink/junction與列出的快取／依賴目錄，略過更深目錄會明確回報；超出項目或時間上限即停止。游標綁定盤點metadata，來源或查詢改變需重新開始。sourcePath可交既有prepare_media_bootstrap。副檔名僅提示，不是實際codec／畫面語意；statFingerprint不是素材SHA或匯入lease。工具不寫專案、不probe或解碼、不修改素材，不代替V4剪輯和成片美術驗收。",
    inputSchema: mediaDiscoveryInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input, context) => {
    try { return textResult(await discoverWorkspaceMediaReadOnly(input, dependencies, context.mcpReq.signal)); }
    catch (error) { return errorResult(error); }
  });
}
