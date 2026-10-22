import type { McpServer } from "@modelcontextprotocol/server";
import { randomBytes } from "node:crypto";
import { realpath, statfs } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import * as z from "zod/v4";
import { executeAutopilotBatch } from "../application/autopilotBatchExecution";
import { readLiveAutopilotIdentity } from "../application/autopilotInvocationIdentity";
import { shortRenderWorkDirectory } from "../application/shortRenderWorkDirectory";
import { PINNED_WHISPER_MODEL, inspectWhisperModel } from "../application/automaticCaptions";
import { batchFileSha256 } from "../application/editorialBatchResume";
import { inspectMedia } from "../application/inspectMedia";
import { prepareMaterialIntelligence, readMaterialIntelligence, readMaterialKeyframe, recordMaterialSemantics } from "../application/materialIntelligence";
import { acquireProjectLock } from "../application/projectFiles";
import { inspectReferenceMotionTemplateInstance } from "../application/referenceMotionTemplateInstances";
import type { ReferenceMotionPlan } from "../application/referenceMotionPlan";
import { referenceMotionTemplateInputSchema } from "../motion/referenceMotionTemplates";
import { TEMPLATE_SHORT_ID_PATTERN, TemplateShortBlockError, templateShortBriefSchema, templateShortStartSchema } from "../application/templateShortBrief";
import { makeTemplateShort, readTemplateShortState, recordTemplateShortReview, startTemplateShort, type TemplateShortDeps,
  type TemplateShortProvider } from "../application/templateShortRun";
import { analyzeRenderedShort, templateShortQaTools } from "../application/templateShortQa";
import { readTemplateShortDefaults, readTemplateShortFactSources } from "../application/templateShortWorkspace";
import { summarizeProject } from "../domain/editGraph";
import { discoverInstalledPlugins, installedSkillPackCandidates, pluginRegistryIdentity } from "../plugins/registry";
import { resolveEditkinSkillWorkflow } from "../plugins/skillPack";
import { readHostWorkflowProfile } from "../plugins/workflowProfileFileStore";
import { createAutopilotBatchRuntime, loadAutopilotBatch } from "./autopilotBatchTools";
import { compileCurrentDesign, designIdentity } from "./autopilotDesignTools";
import { readCreatorReviewPolicy } from "./creatorReviewPolicy";
import { materialRuntime } from "./materialIntelligenceTools";
import { prepareMediaBootstrapReadOnly } from "./mediaBootstrapTools";
import { createEditorialProjectFile } from "./projectCreation";
import { prepareReferenceMotionTemplateFile } from "./referenceMotionTemplateTools";
import { applyProjectCommands, readAutopilotExecutionAttribution, readProject, resolveWorkspaceMediaPath, workspaceRoot, writeAutopilotLearningEvent } from "./storage";
import { textResult } from "./toolRuntime";

/** Hao 2026-10-09 (M174 relaxed): one Editkin tool makes a Short; Video Autopilot records the outcome only. */
export const TEMPLATE_SHORT_RULING = "Hao 2026-10-09 M174 relaxation: one Editkin tool per Short; VA records outcome only";
export const TEMPLATE_SHORT_TOOLS = ["start_template_short", "make_template_short", "get_template_short", "record_template_short_review"] as const;

/** The production boundary of the one-tool Short: the same functions the individual MCP tools call, in this process. */
export function productionTemplateShortDeps(environment: NodeJS.ProcessEnv = process.env): TemplateShortDeps {
  return {
    root: workspaceRoot(),
    now: () => new Date(),
    randomHex: bytes => randomBytes(bytes).toString("hex"),
    readDefaults: () => readTemplateShortDefaults(workspaceRoot()),
    async resolveSource(path) {
      // Rights are matched on the canonical path, so a link or junction cannot borrow an owned scope.
      const lexical = await resolveWorkspaceMediaPath(path), canonical = await realpath(lexical), root = await realpath(workspaceRoot());
      const inside = relative(root, canonical);
      if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("素材不在工作資料夾內");
      return { absolute: canonical, relative: inside.replace(/\\/g, "/") };
    },
    probe: path => inspectMedia(path, environment.HAO_FFPROBE_PATH),
    readReviewPolicy: () => readCreatorReviewPolicy(),
    createProject: (projectPath, name, width, height, fps, profile) => createEditorialProjectFile(projectPath, name, width, height, fps, profile),
    prepareBootstrap: input => prepareMediaBootstrapReadOnly(input),
    applyBootstrap: (projectPath, commands, expectedRevision) => applyProjectCommands(projectPath, commands, expectedRevision),
    readProject,
    fileSha256: batchFileSha256,
    async speechModelReady() {
      // Only a model already on disk: preparing a transcript must never start the 190 MB download (ROADMAP J1).
      const runtime = materialRuntime(), path = runtime.modelPath?.trim() || join(runtime.modelRoot, PINNED_WHISPER_MODEL.fileName);
      try { return (await inspectWhisperModel(path)).valid; } catch { return false; }
    },
    prepareMaterial: request => prepareMaterialIntelligence(request, materialRuntime()),
    readMaterial: materialId => readMaterialIntelligence(materialRuntime().cacheRoot, materialId),
    readKeyframe: (materialId, frameId) => readMaterialKeyframe(materialRuntime().cacheRoot, materialId, frameId),
    recordSemantics: input => recordMaterialSemantics(materialRuntime().cacheRoot, input),
    readFactSources: facts => readTemplateShortFactSources(workspaceRoot(), facts),
    readIdentity: () => readLiveAutopilotIdentity(),
    async resolveSkill(context) {
      const [registry, host] = await Promise.all([discoverInstalledPlugins(), readHostWorkflowProfile()]);
      return resolveEditkinSkillWorkflow(installedSkillPackCandidates(registry), host.profile, context, pluginRegistryIdentity(registry).sha256);
    },
    async compileTemplate(projectPath, input) {
      // The same parse the prepare_reference_motion_template tool input gets (defaults such as sources: []).
      const packet = await prepareReferenceMotionTemplateFile(projectPath, referenceMotionTemplateInputSchema.parse(input), environment);
      if (packet.planDeclaration.schema !== "editkin.reference-motion-plan/v1") throw new Error("Unexpected reference-motion plan declaration");
      return packet as typeof packet & { planDeclaration: ReferenceMotionPlan };
    },
    compileDesign: (request, policy) => compileCurrentDesign(request, { reviewPolicy: policy }),
    designIdentity: (brief, project) => designIdentity(brief as Parameters<typeof designIdentity>[0], project),
    async prepareBatch(batchPath, options) {
      const batch = await loadAutopilotBatch(batchPath);
      return { manifest: batch.manifest, statePath: batch.statePath, runtime: createAutopilotBatchRuntime(batch, true, options) };
    },
    executeBatch: executeAutopilotBatch,
    async readback(projectPath, instanceId) {
      const project = await readProject(projectPath);
      return { instanceStatus: (await inspectReferenceMotionTemplateInstance(project, instanceId)).status, summary: summarizeProject(project) };
    },
    async freeBytes(path) {
      let target = path;
      for (;;) {
        try { const info = await statfs(target); return Number(info.bavail) * Number(info.bsize); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(target) === target) throw error;
          target = dirname(target);
        }
      }
    },
    tempDirectory: () => shortRenderWorkDirectory(workspaceRoot(), environment),
    lock: path => acquireProjectLock(path),
    writeLearningEvent: (projectPath, event) => writeAutopilotLearningEvent(projectPath, event),
    readExecutionAttribution: async (projectPath, planSha256) => ({ ...await readAutopilotExecutionAttribution(projectPath, planSha256) }),
    // Design §6.2: R1–R5 on the candidate before promotion, with the same FFmpeg the render and audit use.
    async analyzeRendered(input) {
      if (!input.expectations) return { technical: { pass: true, checks: [] }, flags: [], report: { status: "unmeasured", reason: "no sealed render expectations" } };
      const result = await analyzeRenderedShort(input.candidate, input.expectations, input.durationFrames, { ...templateShortQaTools(environment),
        candidateSha256: input.candidateSha256, requireAudio: true, sheetsDir: input.sheetsDir });
      return { technical: result.technical, flags: result.flags, sheets: result.sheets,
        report: { schema: result.schema, measured: result.measured, timingsMs: result.timingsMs } };
    },
  };
}

/** The MCP client's name → the plan's inference provider (Claude Code, Codex, or other). */
export function templateShortProvider(clientName: string | undefined): TemplateShortProvider {
  const name = (clientName ?? "").toLowerCase();
  return /claude/.test(name) ? "claude_code" : /codex/.test(name) ? "codex" : "other";
}

function blockResult(error: unknown) {
  if (error instanceof TemplateShortBlockError) {
    return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ schema: "editkin.template-short-result/v1", status: error.code,
      block: { code: error.code, detail: error.detail, ...(error.field ? { field: error.field } : {}) } }) }] };
  }
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ status: "BLOCK", error: error instanceof Error ? error.message : String(error) }) }] };
}

const reviewInputSchema = z.strictObject({
  shortId: z.string().max(64).regex(TEMPLATE_SHORT_ID_PATTERN),
  accepted: z.boolean(),
  severeError: z.boolean(),
  /** Kept to 1,000 UTF-16 units (longer notes are cut, not refused). */
  note: z.string().max(8_000),
  evidencePath: z.string().min(1).max(1_024),
});

export function registerTemplateShortTools(server: McpServer, deps: TemplateShortDeps = productionTemplateShortDeps()) {
  const provider = () => templateShortProvider((server.server as unknown as { getClientVersion(): { name?: string } | undefined }).getClientVersion()?.name);

  server.registerTool("start_template_short", {
    description: `一支工具出 Short（${TEMPLATE_SHORT_RULING}）第 1 步：source.path（工作資料夾內）＋ genre，可選 in/out 秒（5–15 秒；沒給 out 只用前 15 秒）。`
      + "Editkin 建新專案、中性匯入、準備最多 4 張關鍵畫面，在 1 MB 圖片上限內回傳畫面；還有畫面時用 {schema, shortId, framePage} 續看（不建立任何東西）。"
      + "需要 .autopilot/template-short-defaults.json（創作者一次宣告自有素材權利）。回傳 shortId、版面欄位上限與下一步。",
    inputSchema: templateShortStartSchema,
  }, async input => {
    try {
      const response = await startTemplateShort(input, deps, { mode: "mcp", provider: provider() });
      return { content: [{ type: "text" as const, text: JSON.stringify(response.text) },
        ...response.images.map(image => ({ type: "image" as const, data: image.data.toString("base64"), mimeType: image.mimeType }))] };
    } catch (error) { return blockResult(error); }
  });

  server.registerTool("make_template_short", {
    description: `一支工具出 Short 第 2 步（${TEMPLATE_SHORT_RULING}）：≤1 KB brief＝seen（每張提供的畫面各一句看到什麼）＋ copy（hook→strike_reframe，或 2–4 個 points→context_stack）。`
      + "文案、字型、數字來源（M10）與看圖（M9）先檢查，不合格立即回 BLOCK_*（不寫任何東西）；通過後回 jobId，由同一程序完成 語意→模板（含模板自帶段落）→計畫→獨立 audit→原子 apply→輸出→檢查。"
      + "技術失敗不交付；美術 FLAG 仍交付 NEEDS_FIX 並列出秒數。中斷後用 {schema, shortId, resume:true} 續跑（核對已提交的套用，不重套）。每 10 秒以內最多用 get_template_short 查一次。",
    inputSchema: templateShortBriefSchema,
  }, async input => {
    try { return textResult(await makeTemplateShort(input, deps, { mode: "mcp", provider: provider() })); }
    catch (error) { return blockResult(error); }
  });

  server.registerTool("get_template_short", {
    description: "查詢一支模板短片：進行中回 RUNNING；完成回狀態（READY／SPOT_CHECK_DUE／REVIEW_REQUIRED／NEEDS_FIX／RENDER_FAILED_PROJECT_APPLIED／INTERRUPTED／BLOCK_*）、成片、段落、檢查與收據（≤20 KB）。MCP 重啟後讀持久紀錄；中斷的工作回 INTERRUPTED。",
    inputSchema: z.strictObject({ shortId: z.string().max(64).regex(TEMPLATE_SHORT_ID_PATTERN) }),
  }, async ({ shortId }) => {
    try { return textResult(await readTemplateShortState(shortId, deps)); }
    catch (error) { return blockResult(error); }
  });

  server.registerTool("record_template_short_review", {
    description: `看過交付的成片後記錄抽查（${TEMPLATE_SHORT_RULING}）：evidencePath 必須是該短片 review/ 內的審查證據檔；以 agent 身分寫入 Video Autopilot learning event（不冒充人工審片），note 超過 1,000 字會截斷。創作者政策為人工審片時拒絕。機械檢查本身不算審查。`,
    inputSchema: reviewInputSchema,
  }, async input => {
    try { return textResult(await recordTemplateShortReview(input, deps)); }
    catch (error) { return blockResult(error); }
  });
}
