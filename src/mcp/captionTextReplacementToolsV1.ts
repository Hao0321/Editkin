import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { currentCaptionTextReplacementCommandV1, findCaptionTextV1, prepareCaptionTextReplacementV1 } from "../application/captionTextReplacementV1";
import { sha256Canonical } from "../application/autopilotInvocationIdentity";
import { CAPTION_DELIVERY_LIMITS } from "../domain/captionDelivery";
import { readProject } from "./storage";
import { errorResult, textResult } from "./toolRuntime";

export const CAPTION_TEXT_TOOLS_V1 = ["find_caption_text", "prepare_caption_text_replacement"] as const;
const base = z.strictObject({ projectPath: z.string().min(1).max(1024), expectedProjectRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  query: z.string().min(1).max(CAPTION_DELIVERY_LIMITS.textBytes),
  captionIds: z.array(z.string().min(1).max(160)).min(1).max(100).optional() });
export const findCaptionTextInputV1 = base.extend({ offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(CAPTION_DELIVERY_LIMITS.retainedIssues).default(100) });
export const prepareCaptionTextReplacementInputV1 = base.extend({ replacement: z.string().max(CAPTION_DELIVERY_LIMITS.textBytes) });
export const CAPTION_TEXT_RESPONSE_BYTES_V1 = 256 * 1024;
type Dependencies = { readProject: typeof readProject };
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
function bounded(value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > CAPTION_TEXT_RESPONSE_BYTES_V1)
    throw Error("CAPTION_TEXT_RESPONSE_BUDGET: reduce limit or select fewer captionIds");
  return textResult(value);
}
export function registerCaptionTextReplacementToolsV1(server: McpServer, dependencies: Dependencies = { readProject }) {
  async function current(input: z.output<typeof base>) {
    const project = await dependencies.readProject(input.projectPath);
    if (project.revision !== input.expectedProjectRevision) throw Error("CAPTION_TEXT_PROJECT_REVISION_CHANGED");
    return { project, binding: { projectId: project.id, projectRevision: project.revision, projectSha256: sha256Canonical(project) } };
  }
  server.registerTool("find_caption_text", {
    description: "唯讀逐句尋找原文字幕的文字。區分大小寫、按字面比對，不執行正規表示式、不跨句；回原文、時間、次數和分頁。保留翻譯與專案。",
    inputSchema: findCaptionTextInputV1, annotations,
  }, async input => {
    try { const request = findCaptionTextInputV1.parse(input), { project, binding } = await current(request);
      return bounded({ binding, ...findCaptionTextV1(project, request.query, request.offset, request.limit, request.captionIds) }); }
    catch (error) { return errorResult(error); }
  });
  server.registerTool("prepare_caption_text_replacement", {
    description: "唯讀預覽原文字幕的字面取代，只產 ordinary update_caption 草稿、保留時間與翻譯。空句、鎖軌或過期版本拒絕；仍須正常 v4 audit/apply，未直接套用。沿用100指令上限，太多時指定較少captionIds。",
    inputSchema: prepareCaptionTextReplacementInputV1, annotations,
  }, async input => {
    try { const request = prepareCaptionTextReplacementInputV1.parse(input), { project, binding } = await current(request);
      const preview = prepareCaptionTextReplacementV1(project, request.query, request.replacement, request.captionIds);
      const command = currentCaptionTextReplacementCommandV1(project, preview);
      if (command && (command.type !== "batch" || command.commands.length > 100)) throw Error("CAPTION_TEXT_EXISTING_V4_COMMAND_LIMIT");
      return bounded({ binding, ...preview, commands: command?.type === "batch" ? command.commands : [],
        boundary: "ordinary_edit_drafts_only_not_apply_or_authorization" }); }
    catch (error) { return errorResult(error); }
  });
}
