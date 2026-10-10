import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { buildProjectMediaSearchIndex, searchProjectMedia, PROJECT_MEDIA_SEARCH_LIMITS } from "../domain/projectMediaSearch";
import { sha256Canonical } from "../application/autopilotInvocationIdentity";
import { readProject } from "./storage";
import { textResult, errorResult } from "./toolRuntime";

export const searchProjectMediaInput = z.strictObject({
  projectPath: z.string().min(1).max(1024), expectedProjectRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  expectedProjectSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  query: z.string().max(PROJECT_MEDIA_SEARCH_LIMITS.queryCharacters).default(""), kind: z.enum(["all", "video", "audio", "image"]).default("all"),
  sort: z.enum(["imported", "name", "duration"]).default("imported"), offset: z.number().int().min(0).max(PROJECT_MEDIA_SEARCH_LIMITS.assets).default(0), limit: z.number().int().min(1).max(100).default(30),
});
export function registerProjectMediaSearchTools(server: McpServer, dependencies: { readProject: typeof readProject } = { readProject }) {
  server.registerTool("search_project_media", {
    description: "唯讀搜尋專案內已匯入素材的名稱、來源路徑、角色與類型，與 MediaBin 同一規則；回精簡 ID/名稱/時長，最多100筆。是文字索引，非視覺語意或權利驗證；不掃硬碟、不預覽/分析/套用/輸出影片。後續頁需帶第一頁的專案 SHA。", inputSchema: searchProjectMediaInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async input => {
    try {
      const request = searchProjectMediaInput.parse(input);
      if (request.offset > 0 && !request.expectedProjectSha256) throw Error("後續頁需要第一頁的專案 SHA，請重新搜尋");
      const project = await dependencies.readProject(request.projectPath), hash = sha256Canonical(project);
      if (project.revision !== request.expectedProjectRevision || (request.expectedProjectSha256 && request.expectedProjectSha256 !== hash)) throw Error("素材搜尋專案已變更，請重新搜尋");
      const assets = project.assets.filter(asset => asset.id !== "asset-demo"), rows = searchProjectMedia(buildProjectMediaSearchIndex(assets), request);
      const page = rows.slice(request.offset, request.offset+request.limit);
      return textResult({ schema: "editkin.project-media-search/v1", binding: { projectId: project.id, projectRevision: project.revision, projectSha256: hash },
        filter: { query: request.query, kind: request.kind, sort: request.sort }, totalImported: assets.length, totalMatches: rows.length, offset: request.offset,
        nextOffset: request.offset+page.length < rows.length ? request.offset+page.length : null,
        assets: page.map(({ id, name, kind, duration, width, height, role }) => ({ id, name, kind, duration, width, height, role })),
        mutationPerformed: false, boundary: "metadata_search_only_no_visual_or_rights_verification" });
    } catch (error) { return errorResult(error); }
  });
}
