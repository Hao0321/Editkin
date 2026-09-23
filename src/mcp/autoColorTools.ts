import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { resolve } from "node:path";
import { findAsset } from "../domain/editGraph";
import type { EditProject } from "../domain/types";
import { autoColorGoalSchema, referenceWhiteBalanceGoalSchema } from "../application/autoColorDecision";
import { proposeAutoColorExposure, proposeReferenceWhiteBalance } from "../application/autoColorEvidence";
import { creativeAssetIdFromUri, resolveCreativeLibraryAsset } from "../application/creativeLibrary";
import { creativePackRoot, personalMusicRoot, personalVisualRoot, textResult, errorResult } from "./toolRuntime";
import { readProject, resolveWorkspaceMediaPath } from "./storage";

export function autoColorRuntime(project: EditProject) {
  const modelRoot = process.env.EDITKIN_MODEL_ROOT ?? resolve(process.cwd(), ".editkin-models");
  return { ffmpegPath: process.env.HAO_FFMPEG_PATH ?? "ffmpeg", ffprobePath: process.env.HAO_FFPROBE_PATH,
    cacheRoot: process.env.EDITKIN_CACHE_ROOT ?? resolve(modelRoot, "../media-cache"),
    resolveSource: async (assetId: string) => {
      const asset = findAsset(project, assetId), id = creativeAssetIdFromUri(asset.uri);
      return id ? (await resolveCreativeLibraryAsset(creativePackRoot(), id, personalMusicRoot(), personalVisualRoot())).absolutePath : resolveWorkspaceMediaPath(asset.uri);
    } };
}
export function registerAutoColorTools(server: McpServer) {
  server.registerTool("propose_reference_white_balance", {
    description: "依呼叫者明確指定為中性的首尾影格ROI，從原始來源的FLOAT線性Rec709量測三通道白平衡增益，先於tone/look。maxGainStops為相對baseline的log2幅度；回傳whiteBalanceRed/Green/Blue是絕對stops，不覆蓋創意temperature/tint。ROI使用未裁切upright來源影格的0..1座標。此功能不會自行辨識白點，也不認證膚色/美感。只有applicable=true可將command與autoColor[{mode:reference_white_balance,decisionSha256,commandIndex,clipId}]放入v4再audit/apply；不直接改專案。reference_unusable/target_unreachable會阻擋套用。",
    inputSchema: z.object({ projectPath: z.string(), materialId: z.string().regex(/^[a-f0-9]{64}$/),
      semanticReceiptSha256: z.string().regex(/^[a-f0-9]{64}$/), goal: referenceWhiteBalanceGoalSchema }),
  }, async ({ projectPath, ...request }) => {
    try { const project = await readProject(projectPath); return textResult(await proposeReferenceWhiteBalance(project, request, autoColorRuntime(project))); }
    catch (error) { return errorResult(error); }
  });
  server.registerTool("propose_auto_color_exposure", {
    description: "素材語意完成後，依明確創作亮度目標實測最多9組曝光候選，回傳可編輯絕對曝光命令與不可變決策ID。不修改專案、不猜白平衡、不認證美感。將command與autoColor[{decisionSha256,commandIndex,clipId}]一起放入v4，仍須audit/apply及人審；target_unreachable不是成功調色。",
    inputSchema: z.object({ projectPath: z.string(), materialId: z.string().regex(/^[a-f0-9]{64}$/),
      semanticReceiptSha256: z.string().regex(/^[a-f0-9]{64}$/), goal: autoColorGoalSchema }),
  }, async ({ projectPath, ...request }) => {
    try { const project = await readProject(projectPath); return textResult(await proposeAutoColorExposure(project, request, autoColorRuntime(project))); }
    catch (error) { return errorResult(error); }
  });
}
