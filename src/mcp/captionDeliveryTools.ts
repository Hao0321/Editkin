import type { McpServer } from "@modelcontextprotocol/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { inspectCaptionDelivery, prepareCaptionOverlapRepair, exportCaptionDelivery } from "../domain/captionDelivery";
import { sha256Canonical } from "../application/autopilotInvocationIdentity";
import { readProject } from "./storage";
import { textResult, errorResult } from "./toolRuntime";

const projectInput = z.strictObject({ projectPath: z.string().min(1).max(1024), expectedProjectRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });
export const inspectCaptionDeliveryInput = projectInput;
export const prepareCaptionRepairInput = projectInput.extend({ captionIds: z.array(z.string().min(1).max(160)).min(1).max(100) });
export const prepareCaptionSidecarInput = projectInput.extend({ format: z.enum(["srt", "vtt"]), mode: z.enum(["original", "translation", "bilingual"]) });
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
type Dependencies = { readProject: typeof readProject };
export function registerCaptionDeliveryTools(server: McpServer, dependencies: Dependencies = { readProject }) {
  async function project(input: z.output<typeof projectInput>) {
    const current = await dependencies.readProject(input.projectPath);
    if (current.revision !== input.expectedProjectRevision) throw Error("字幕準備版本已過期，請重新讀取專案");
    return { current, binding: { projectId: current.id, projectRevision: current.revision, projectSha256: sha256Canonical(current) } };
  }
  server.registerTool("inspect_caption_delivery", {
    description: "唯讀檢查整份字幕的時間重疊、過短及閱讀速度；不聲稱語音辨識或字型排版正確。", inputSchema: inspectCaptionDeliveryInput, annotations: readOnly,
  }, async input => {
    try { const { current, binding } = await project(inspectCaptionDeliveryInput.parse(input)); return textResult({ binding, report: inspectCaptionDelivery(current) }); }
    catch (error) { return errorResult(error); }
  });
  server.registerTool("prepare_caption_overlap_repair", {
    description: "唯讀預覽指定前句的 1–4 格句尾重疊修正，保留全部文字。回 ordinary update_caption 草稿，仍需同一正常 v4 audit/apply；不是直接套用或授權。", inputSchema: prepareCaptionRepairInput, annotations: readOnly,
  }, async input => {
    try { const request = prepareCaptionRepairInput.parse(input), { current, binding } = await project(request);
      return textResult({ binding, ...prepareCaptionOverlapRepair(current, request.captionIds) }); }
    catch (error) { return errorResult(error); }
  });
  server.registerTool("prepare_caption_sidecar", {
    description: "唯讀產生原文／翻譯／雙語 UTF-8 SRT 或 WebVTT 內容供交付；不寫檔、不輸出影片、不改字幕樣式或繞过 formal render。結構錯誤與重疊須先修正。", inputSchema: prepareCaptionSidecarInput, annotations: readOnly,
  }, async input => {
    try { const request = prepareCaptionSidecarInput.parse(input), { current, binding } = await project(request);
      const delivery = exportCaptionDelivery(current, request.format, request.mode);
      return textResult({ binding, ...delivery, contentSha256: createHash("sha256").update(delivery.text, "utf8").digest("hex"), boundary: "sidecar_only_not_video_or_v4_apply" }); }
    catch (error) { return errorResult(error); }
  });
}
