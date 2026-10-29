import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { findClip, findAsset } from "../domain/editGraph";
import { canonicalJson } from "../shared/canonicalJson";
import { autoReframeInputSchemaV1 } from "./autoReframeToolsV1";
import { prepareAutoReframeSparseSourceV2 } from "../application/autoReframeSparseSourceV2";
import { textResult, errorResult } from "./toolRuntime";
export const autoReframeSparseInputSchemaV2 = autoReframeInputSchemaV1.extend({ maximumPositionErrorPixels: z.number().min(.01).max(.25).default(.25) });
export async function prepareAutoReframeSparseToolV2(value: unknown, signal?: AbortSignal) {
  const parsed = autoReframeSparseInputSchemaV2.parse(value), { projectPath, expectedProjectSha256, ...input } = parsed, storage = await import("./storage");
  const project = await storage.readProject(projectPath), before = createHash("sha256").update(canonicalJson(project)).digest("hex");
  if (before !== expectedProjectSha256) throw Error("REFRAME_PROJECT_BINDING_CHANGED");
  const clip = findClip(project, input.clipId), asset = findAsset(project, clip.assetId), app = resolve(import.meta.dirname, "../.."), sourcePath = await storage.resolveWorkspaceMediaPath(asset.uri);
  const cacheRoot = process.env.EDITKIN_CACHE_ROOT ?? resolve(storage.workspaceRoot(), ".editkin-cache"); await mkdir(cacheRoot, { recursive: true });
  const result = await prepareAutoReframeSparseSourceV2(project, input, { sourcePath, cacheRoot, productCacheRoot: cacheRoot, signal,
    ffmpegPath: process.env.HAO_FFMPEG_PATH ?? resolve(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobePath: process.env.HAO_FFPROBE_PATH ?? resolve(app, "vendor/ffmpeg/win32-x64/ffprobe.exe") });
  if (createHash("sha256").update(canonicalJson(await storage.readProject(projectPath))).digest("hex") !== before) throw Error("REFRAME_SAVED_PROJECT_CHANGED");
  return result;
}
export function registerAutoReframeSparseToolsV2(server: McpServer) {
  server.registerTool("prepare_auto_reframe_v2", { description: "只讀、明示稀疏重構圖：逐格真source PTS/RGBA或既有診斷matte觀察，bounded camera以feasible-slope區間壓縮成既有linear keyframes，各軸畫布座標誤差不超過指定上限（最多0.25px），剪點保留hold與重置，pan cap與crop邊界保留。最多4096commands與8診斷rows，不累積整片observations、不因frameCount大直接拒絕；若複雜鏡頭耗盡command budget則明示拒絕，不偷降品質。來源/已存project SHA校驗，不改project，不啟用模型/VA/GUI/安裝/認證。真正10h速度、RAM、輸出品質與真人holdout仍待大型驗證。", inputSchema: autoReframeSparseInputSchemaV2,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async (input, extra) => {
      try { return textResult(await prepareAutoReframeSparseToolV2(input, extra.mcpReq.signal)); } catch (error) { return errorResult(error); }
    });
}
