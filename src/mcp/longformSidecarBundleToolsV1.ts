import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { resolve } from "node:path";
import { exportLongformSidecarBundleV1, prepareLongformSidecarExportV1, type LongformSidecarRuntimeV1 } from "../application/longformSidecarExportV1";
import { errorResult, textResult } from "./toolRuntime";

export const LONGFORM_SIDECAR_RESPONSE_BYTES_V1 = 256 * 1024;
export const prepareLongformSidecarBundleInputV1 = z.strictObject({ projectPath: z.string().min(1).max(1024),
  expectedProjectRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  chapterMarkerIds: z.array(z.string().min(1).max(160)).min(1).max(200),
  captionMode: z.enum(["original", "translation", "bilingual"]).default("original") });
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const exportLongformSidecarBundleInputV1 = prepareLongformSidecarBundleInputV1.extend({
  expectedProjectSha256: digest, expectedProjectFileSha256: digest, expectedBundleSha256: digest, outputDirectory: z.string().min(1).max(1024) });
type DependenciesV1 = { prepare: typeof prepareLongformSidecarExportV1; export: typeof exportLongformSidecarBundleV1 };
function boundedResult(value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > LONGFORM_SIDECAR_RESPONSE_BYTES_V1) throw Error("SIDECAR_RESPONSE_BUDGET");
  return textResult(value);
}
function boundedError(error: unknown) {
  return errorResult(Error((error instanceof Error ? error.message : String(error)).slice(0, 8192)));
}
export function registerLongformSidecarBundleToolsV1(server: McpServer, environment: NodeJS.ProcessEnv = process.env,
  dependencies: DependenciesV1 = { prepare: prepareLongformSidecarExportV1, export: exportLongformSidecarBundleV1 }) {
  const runtime: LongformSidecarRuntimeV1 = { workspaceRoot: resolve(environment.EDITKIN_WORKSPACE ?? environment.HAO_EDITOR_WORKSPACE ?? process.cwd()) };
  server.registerTool("prepare_longform_sidecar_bundle", {
    description: "唯讀準備成對的 captions.srt 和 chapters.txt。章節僅採指定的既有時間軸標記，字幕沿用既有 SRT 輸出。回同一專案版本、原始檔 SHA、內容 SHA、毫秒章節時間及有界預覽；不改專案或檔案，不判定平台可發布。",
    inputSchema: prepareLongformSidecarBundleInputV1,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async input => {
    try { return boundedResult(await dependencies.prepare(runtime, prepareLongformSidecarBundleInputV1.parse(input))); }
    catch (error) { return boundedError(error); }
  });
  server.registerTool("export_longform_sidecar_bundle", {
    description: "明確匯出已準備的 captions.srt 和 chapters.txt 到工作區內全新的資料夾。須提供準備時的專案、原始檔與 bundle SHA；既有資料夾拒絕覆蓋。兩檔寫入、讀回及原專案再核對後才回 COMPLETE；中斷的局部輸出保留並標不完整，不改專案、不渲染或發布影片。",
    inputSchema: exportLongformSidecarBundleInputV1,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async input => {
    try { return boundedResult(await dependencies.export(runtime, exportLongformSidecarBundleInputV1.parse(input))); }
    catch (error) { return boundedError(error); }
  });
}
