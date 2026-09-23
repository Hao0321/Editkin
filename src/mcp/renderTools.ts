import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { resolve } from "node:path";
import { exportVideo } from "../application/exportVideo";
import { materializeCreativeAssets } from "../application/creativeLibrary";
import { summarizeProject } from "../domain/editGraph";
import { creativePackRoot, errorResult, personalMusicRoot, personalVisualRoot, textResult } from "./toolRuntime";
import { readProject, resolveRenderPath, workspaceRoot } from "./storage";

export function registerRenderTools(server: McpServer): void {
  server.registerTool("render_project", {
    description: "以 Rust 排程與 FFmpeg/GPU 輸出 MP4；輸出路徑限制在 EDITKIN_WORKSPACE。",
    inputSchema: z.object({
      projectPath: z.string(),
      outputPath: z.string().describe("相對 workspace 的 .mp4 路徑"),
      preferGpu: z.boolean().default(true),
    }),
  }, async ({ projectPath, outputPath, preferGpu }) => {
    try { return await renderAutopilotProject(projectPath, outputPath, preferGpu); }
    catch (error) { return errorResult(error); }
  });
}

export async function renderAutopilotProject(projectPath: string, outputPath: string, preferGpu: boolean) {
  const storedProject = await readProject(projectPath);
  const project = await materializeCreativeAssets(storedProject, creativePackRoot(), personalMusicRoot(), personalVisualRoot());
  const output = await resolveRenderPath(outputPath);
  const result = await exportVideo({
    project,
    outputPath: output,
    options: {
      assetBase: workspaceRoot(),
      autoRotoCacheRoot: process.env.EDITKIN_CACHE_ROOT ?? resolve(process.env.EDITKIN_MODEL_ROOT ?? resolve(workspaceRoot(), ".editkin-models"), "../media-cache"),
      ffmpegPath: process.env.HAO_FFMPEG_PATH,
      ffprobePath: process.env.HAO_FFPROBE_PATH,
      nativeCorePath: process.env.HAO_NATIVE_CORE_PATH ?? resolve(import.meta.dirname, "../../native/bin/win32-x64/hao-core.exe"),
      colorRoot: process.env.EDITKIN_COLOR_ROOT ?? resolve(import.meta.dirname, "../../public/color/aces2"),
      fontRoot: process.env.EDITKIN_FONT_ROOT ?? resolve(import.meta.dirname, "../../public/fonts"),
      preferGpu,
    },
  });
  return textResult({ status: "GREEN", ...result, summary: summarizeProject(project) });
}
