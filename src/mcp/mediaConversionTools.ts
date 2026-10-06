import type { McpServer } from "@modelcontextprotocol/server";
import { resolve } from "node:path";
import { CONVERSION_PROFILES, conversionRequestSchema, convertMediaBatch } from "../application/mediaConversion";
import { workspaceRoot } from "./storage";
import { errorResult, textResult } from "./toolRuntime";

export function registerMediaConversionTools(server: McpServer): void {
  server.registerTool("list_media_conversion_profiles", {
    description: "列出素材轉檔格式；透明 MOV 使用 qtrle，其他 MOV 為 H.264。此工具不製作專案成片。",
    inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => textResult({ profiles: CONVERSION_PROFILES, utilityOnly: true }));
  server.registerTool("convert_media_batch", {
    description: "將工作區內最多 64 個本機素材轉成 MP4/MOV/MKV/WEBM/AVI/GIF/PNG/JPEG/WEBP 或 MP3/WAV/AAC/FLAC。需要已存在的工作區輸出資料夾。無覆寫，獨立完整解碼後才發佈，支援取消與真實 maxEdge 長邊限制。透明素材轉非透明格式須明確 allowAlphaFlatten。圖片模式取第一幀、GIF 限30秒。HDR需另走明確色彩流程。此工具只准备素材，不修改專案、不接受美術、不繞過 revision6 V4 的 audit→atomic apply→正式渲染→QA。",
    inputSchema: conversionRequestSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input, context) => {
    try {
      return textResult(await convertMediaBatch(input, {
        workspaceRoot: workspaceRoot(), signal: context.mcpReq.signal,
        ffmpegPath: process.env.HAO_FFMPEG_PATH ?? (process.platform === "win32" ? resolve(import.meta.dirname, "../../vendor/ffmpeg/win32-x64/ffmpeg.exe") : "ffmpeg"),
        ffprobePath: process.env.HAO_FFPROBE_PATH ?? (process.platform === "win32" ? resolve(import.meta.dirname, "../../vendor/ffmpeg/win32-x64/ffprobe.exe") : "ffprobe"),
        timeoutMs: 3_600_000,
        onProgress: event => { if (context.mcpReq._meta?.progressToken === undefined) return; void context.mcpReq.notify({ method: "notifications/progress", params: { progressToken: context.mcpReq._meta.progressToken, progress: event.index + (event.phase === "complete" ? 1 : 0), total: event.total } }).catch(() => undefined); },
      }));
    } catch (error) { return errorResult(error); }
  });
}
