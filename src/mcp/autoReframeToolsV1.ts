import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { findClip, findAsset } from "../domain/editGraph";
import { canonicalJson } from "../shared/canonicalJson";
import { prepareAutoReframeSourceV1 } from "../application/autoReframeSourceV1";
import { errorResult, textResult } from "./toolRuntime";
export const autoReframeInputSchemaV1 = z.strictObject({ projectPath: z.string().trim().min(1).max(1024), clipId: z.string().min(1).max(256),
  expectedProjectSha256: z.string().regex(/^[a-f0-9]{64}$/), expectedSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  outputWidth: z.number().int().min(1).max(16384), outputHeight: z.number().int().min(1).max(16384), matteMaskId: z.string().min(1).max(256).optional(),
  maximumCommands: z.number().int().min(2).max(4096).default(4096), deadZone: z.number().min(0).max(.3).default(.08), maximumPanSpeed: z.number().gt(0).max(2).default(.6), springFrequency: z.number().min(1).max(30).default(8) });
export async function prepareAutoReframeToolV1(value: unknown, signal?: AbortSignal) {
  const input = autoReframeInputSchemaV1.parse(value), storage = await import("./storage"), project = await storage.readProject(input.projectPath);
  const before = createHash("sha256").update(canonicalJson(project)).digest("hex");
  if (before !== input.expectedProjectSha256) throw Error("REFRAME_PROJECT_BINDING_CHANGED");
  const clip = findClip(project, input.clipId), asset = findAsset(project, clip.assetId), app = resolve(import.meta.dirname, "../..");
  const sourcePath = await storage.resolveWorkspaceMediaPath(asset.uri), cacheRoot = process.env.EDITKIN_CACHE_ROOT ?? resolve(storage.workspaceRoot(), ".editkin-cache");
  const { mkdir } = await import("node:fs/promises"); await mkdir(cacheRoot, { recursive: true });
  const result = await prepareAutoReframeSourceV1(project, input, { sourcePath, cacheRoot, productCacheRoot: cacheRoot, signal,
    ffmpegPath: process.env.HAO_FFMPEG_PATH ?? resolve(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobePath: process.env.HAO_FFPROBE_PATH ?? resolve(app, "vendor/ffmpeg/win32-x64/ffprobe.exe") });
  const after = await storage.readProject(input.projectPath);
  if (createHash("sha256").update(canonicalJson(after)).digest("hex") !== before) throw Error("REFRAME_SAVED_PROJECT_CHANGED");
  return result;
}
export function registerAutoReframeToolsV1(server: McpServer) {
  server.registerTool("prepare_auto_reframe", { description: "只讀準備橫片轉直式：真source decoded PTS/RGBA的有界顯著度，或明示既有非stale、已attest的診斷roto matte；critical spring、死區、平移限速、顏色histogram換場重置，回傳既有transform add_keyframe commands。單clip且無其他內容可準備改畫布；其他專案須已是目標畫布，existing camera要另合併。須先看DRAFT/未知subject/中央60%數字再套命令，不自動改專案或進VA。未認證、不啟用模型，真人holdout95%、GUI/透視/長片仍待驗。", inputSchema: autoReframeInputSchemaV1,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async (input, extra) => {
      try { return textResult(await prepareAutoReframeToolV1(input, extra.mcpReq.signal)); } catch (error) { return errorResult(error); }
    });
}
