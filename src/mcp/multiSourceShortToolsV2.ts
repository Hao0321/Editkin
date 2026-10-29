import type { McpServer } from "@modelcontextprotocol/server";
import { resolve } from "node:path";
import * as z from "zod/v4";
import { productionTemplateShortDeps } from "./templateShortTools";
import { withReferenceMotionPhysicalFonts } from "./referenceMotionPhysicalFonts";
import { prepareReferenceMotionTemplateInstance } from "../application/referenceMotionTemplateInstances";
import { referenceMotionTemplateInputSchema } from "../motion/referenceMotionTemplates";
import { prepareShortCaptionTextV2, multiSourceShortStartSchema, multiSourceShortMakeSchema } from "../application/multiSourceShortRecipeV2";
import { startMultiSourceShort, makeMultiSourceShort, getMultiSourceShort, type MultiSourceShortDeps } from "../application/multiSourceShortRunV2";
import { analyzeRenderedShort, templateShortQaTools, templateShortRenderExpectations } from "../application/templateShortQa";
import { renderProject } from "../render/ffmpeg";
import { errorResult, textResult } from "./toolRuntime";
import { applyProjectCommands } from "./storage";
import { bindProjectMediaForRender, mcpMediaCacheRoot } from "./renderMediaBinding";

export const MULTI_SOURCE_SHORT_TOOLS_V2 = ["start_multi_source_short", "make_multi_source_short", "get_multi_source_short"] as const;

/** Explicit new recipe API, separate from certified one-source v1 and the unchanged VA v4 workflow. */
export function productionMultiSourceShortDeps(environment: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): MultiSourceShortDeps {
  const shared = productionTemplateShortDeps(environment);
  return {
    ...shared, signal,
    applyBootstrap: (path, commands, expectedRevision) => applyProjectCommands(path, [{ type: "batch", commands }], expectedRevision),
    async compile(project, input, identity) {
      let index = 0;
      const prepared = await withReferenceMotionPhysicalFonts(deps => prepareReferenceMotionTemplateInstance(project,
        referenceMotionTemplateInputSchema.parse(input), prefix => `${prefix}-${identity}-${++index}`, deps), environment, signal);
      return { ...prepared, planDeclaration: { schema: "editkin.reference-motion-plan/v1", instances: [{ instanceId: prepared.instance.id,
        mode: "create", commandIndexes: prepared.commands.map((_, command) => command) }] } };
    },
    prepareCaptions: (project, captions, style) => withReferenceMotionPhysicalFonts(deps =>
      prepareShortCaptionTextV2(project, captions, style, { ...deps, signal }), environment, signal),
    // The committed project is read through renderMediaBinding.ts: the render opens exactly the media that was checked.
    render: async (project, outputPath, options) => renderProject(await bindProjectMediaForRender(project, { cacheRoot: mcpMediaCacheRoot(environment) }), outputPath, { ...options, signal,
      ffmpegPath: environment.HAO_FFMPEG_PATH, ffprobePath: environment.HAO_FFPROBE_PATH,
      assetBase: shared.root, fontRoot: environment.EDITKIN_FONT_ROOT ?? resolve(import.meta.dirname, "../../public/fonts"),
      nativeCorePath: environment.HAO_NATIVE_CORE_PATH, gpuCompositorPath: environment.HAO_GPU_COMPOSITOR_PATH }),
    analyzeRendered: input => analyzeRenderedShort(input.candidate, templateShortRenderExpectations(input.packet, input.project),
      input.durationFrames, { ...templateShortQaTools(environment), candidateSha256: input.candidateSha256, requireAudio: input.requireAudio,
        sheetsDir: input.sheetsDir, qaPath: input.qaPath, signal,
        report: { schema: "editkin.multi-source-short-render/v2", artStatus: "ART_PENDING_CLAUDE" } }),
  };
}

export function registerMultiSourceShortToolsV2(server: McpServer, environment: NodeJS.ProcessEnv = process.env) {
  // New composition is unapproved and absent from the default MCP/VA generation. Engineering callers opt in explicitly.
  if (environment.EDITKIN_ENABLE_MULTI_SHORT_V2 !== "1") return;
  const deps = productionMultiSourceShortDeps(environment);
  server.registerTool("start_multi_source_short", {
    description: "新版本多段 Short：≤1 KB，指定依拍攝順序排列的 2–8 段素材、題材及可選入出點，每段 5–15 秒、合計 20–40 秒。"
      + "檢查實際來源與權利後建立新專案，回傳各段實際關鍵畫面（每次 ≤1 MB）；pending 非空時用 runId/framePage 續看。"
      + "配樂必須有該音訊檔專用的既有權利宣告。此新組裝尚待 Claude 美術驗收，不進 VA 預設。",
    inputSchema: multiSourceShortStartSchema,
  }, async input => {
    try {
      const response = await startMultiSourceShort(input, deps);
      return { content: [{ type: "text" as const, text: JSON.stringify(response.text) }, ...response.images.map(image => ({
        type: "image" as const, data: image.data.toString("base64"), mimeType: image.mimeType }))] };
    } catch (error) { return errorResult(error); }
  });
  server.registerTool("make_multi_source_short", {
    description: "多段 Short 第 2 步：≤1 KB，seen[{s,kf,note}] 覆蓋每段提供的畫面，copy 使用既有欄位。"
      + "開頭套用模板、其後依拍攝順序保留畫面，加入可編輯字幕與已選配樂。captions=transcript 用實際逐字稿，copy 用創作者提供的文案。"
      + "來源重驗、模板獨立重編譯、一次套用、一次最終渲染與完整解碼 QA；回 runId，以 get_multi_source_short 查詢。"
      + "新組裝最多 REVIEW_REQUIRED，不宣稱已認證；其他未認證題材需明確 allowUncertified:true。",
    inputSchema: multiSourceShortMakeSchema,
  }, async input => {
    try { return textResult(await makeMultiSourceShort(input, deps)); }
    catch (error) { return errorResult(error); }
  });
  server.registerTool("get_multi_source_short", {
    description: "查詢多段 Short；完成回成片、可編輯專案、接觸表與檢查（≤20 KB）。中斷時保留專案，用同一份素材和文案建立新的一支。",
    inputSchema: z.strictObject({ runId: z.string().regex(/^ms-[a-f0-9]{24}$/) }),
  }, async ({ runId }) => {
    try { return textResult(await getMultiSourceShort(runId, deps)); }
    catch (error) { return errorResult(error); }
  });
}
