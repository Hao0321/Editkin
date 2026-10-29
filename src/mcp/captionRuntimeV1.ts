import { resolve } from "node:path";
import type { AutomaticCaptionRuntime } from "../application/automaticCaptionTypes";
import { workspaceRoot } from "./storage";

export type McpCaptionRuntimeV1 = Pick<AutomaticCaptionRuntime, "ffmpegPath" | "whisperCliPath" | "modelRoot" | "modelPath" | "mediumModelPath" | "cacheRoot">;

/**
 * Transcription runtime for MCP tools, with the same bundled defaults auto_transcribe_captions and auto_edit_highlights
 * use (the desktop service passes the same paths, serviceMediaRuntimeV1.ts). The shipped FFmpeg has no whisper filter,
 * so a tool that omits the bundled whisper-cli blocks whenever the launcher's EDITKIN_WHISPER_CLI_PATH is not set
 * (direct_podcast_speakers did). Environment values, when set, win.
 */
export function mcpCaptionRuntimeV1(environment: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): McpCaptionRuntimeV1 {
  const app = resolve(import.meta.dirname, "../..");
  const modelRoot = environment.EDITKIN_MODEL_ROOT ?? resolve(workspaceRoot(), ".editkin-models");
  return {
    ffmpegPath: environment.HAO_FFMPEG_PATH ?? (platform === "win32" ? resolve(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe") : "ffmpeg"),
    whisperCliPath: environment.EDITKIN_WHISPER_CLI_PATH ?? (platform === "win32" ? resolve(app, "vendor/whisper/win32-x64/whisper-cli.exe") : "whisper-cli"),
    modelRoot,
    modelPath: environment.EDITKIN_WHISPER_MODEL_PATH,
    mediumModelPath: environment.EDITKIN_WHISPER_MEDIUM_MODEL_PATH,
    cacheRoot: environment.EDITKIN_CACHE_ROOT ?? resolve(modelRoot, "../media-cache"),
  };
}
