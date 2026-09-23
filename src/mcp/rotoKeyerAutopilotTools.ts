import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { resolve } from "node:path";
import { creativeAssetIdFromUri, resolveCreativeLibraryAsset } from "../application/creativeLibrary";
import {
  buildRotoKeyerDecision,
  defaultRotoKeyerRuntimePaths,
  inspectRotoKeyerCapabilities,
  inspectRotoKeyerMaterialEvidence,
  prepareAutopilotAutoRoto,
  recordRotoKeyerEvidence,
  rotoKeyerEvidenceInputSchema,
  verifyRotoKeyerEvidence,
  verifyRotoKeyerSourceFile,
} from "../application/rotoKeyerAutopilot";
import { autopilotPlanSourceFromIdentity, readLiveAutopilotIdentity } from "../application/autopilotInvocationIdentity";
import type { ChromaKeySettings } from "../domain/types";
import { editorCommandSchema } from "../domain/schema";
import { findAsset } from "../domain/editGraph";
import { creativePackRoot, errorResult, personalMusicRoot, personalVisualRoot, textResult } from "./toolRuntime";
import { readProject, resolveWorkspaceMediaPath } from "./storage";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

async function resolveAssetSource(uri: string): Promise<string> {
  const creativeId = creativeAssetIdFromUri(uri);
  if (creativeId) return (await resolveCreativeLibraryAsset(creativePackRoot(), creativeId, personalMusicRoot(), personalVisualRoot())).absolutePath;
  return resolveWorkspaceMediaPath(uri);
}

function runtime() {
  const paths = defaultRotoKeyerRuntimePaths();
  return {
    ...paths,
    ffmpegPath: process.env.HAO_FFMPEG_PATH ?? resolve(process.cwd(), "vendor/ffmpeg/win32-x64/ffmpeg.exe"),
    nativeCorePath: process.env.HAO_NATIVE_CORE_PATH ?? resolve(process.cwd(), "native/bin/win32-x64/hao-core.exe"),
  };
}

export const ROTO_KEYER_AUTOPILOT_TOOL_IDS = [
  "inspect_roto_keyer_capabilities",
  "record_roto_keyer_evidence",
  "build_autopilot_roto_keyer_decision",
  "prepare_autopilot_auto_roto",
] as const;

export function registerRotoKeyerAutopilotTools(server: McpServer): void {
  server.registerTool("inspect_roto_keyer_capabilities", {
    description: "在不修改專案的情況下，核對目前 clip／asset／material／semantic receipt，並回傳 closed-world Roto／Keyer 能力快照。產品路徑只列 no-op、手動遮罩、自研 native Auto Roto、自研綠／藍幕 Keyer；外部與 research-only 引擎只列為禁止。",
    inputSchema: z.object({
      projectPath: z.string(),
      materialId: sha256Schema,
      semanticReceiptSha256: sha256Schema,
    }),
  }, async ({ projectPath, materialId, semanticReceiptSha256 }) => {
    try {
      const project = await readProject(projectPath);
      const [capability, material] = await Promise.all([
        inspectRotoKeyerCapabilities(runtime()),
        inspectRotoKeyerMaterialEvidence(project, runtime().cacheRoot, materialId, semanticReceiptSha256),
      ]);
      const sourceAsset = findAsset(project, material.packet.source.assetId);
      await verifyRotoKeyerSourceFile(await resolveAssetSource(sourceAsset.uri), material.packet.source.sourceSha256);
      return textResult({
        status: "GREEN",
        capability,
        material: {
          schema: material.packet.schema,
          materialId: material.packet.materialId,
          source: material.packet.source,
          keyframes: material.packet.keyframes.map(({ fileName: _fileName, ...frame }) => frame),
          semanticReceiptSha256,
          clipState: material.clipState,
        },
        next: "先 view_material_keyframes，再 record_roto_keyer_evidence；含糊／無色幕不可自動 Key。",
      });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("record_roto_keyer_evidence", {
    description: "把目前 Codex／Claude 已看過的 hash-bound keyframes、幕色／主體／邊緣觀察保存成不可變 evidence receipt。色幕含糊、低信心或無幕判定都會保留 uncertainty，不能被後續 plan 偷換成自動 Key。",
    inputSchema: z.object({ projectPath: z.string(), evidence: rotoKeyerEvidenceInputSchema }),
  }, async ({ projectPath, evidence }) => {
    try {
      const project = await readProject(projectPath);
      const receipt = await recordRotoKeyerEvidence(runtime().cacheRoot, evidence);
      const clip = project.tracks.flatMap((track) => track.clips).find((candidate) => candidate.id === receipt.clipId);
      const asset = project.assets.find((candidate) => candidate.id === receipt.assetId);
      if (!clip || !asset || clip.assetId !== asset.id || (asset.derivatives?.sourceSha256 && asset.derivatives.sourceSha256 !== receipt.sourceSha256)) {
        throw new Error("Roto／Keyer evidence 不是目前專案 revision 的素材");
      }
      await verifyRotoKeyerSourceFile(await resolveAssetSource(asset.uri), receipt.sourceSha256);
      return textResult({ status: "GREEN", receipt });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("build_autopilot_roto_keyer_decision", {
    description: "為 no-op、手動遮罩或自研 green／blue screen keyer 建立 exact-command、capability、evidence、Token budget 與 pending human-review 綁定。這個工具只產生 v4 plan fragment，不修改專案；Screen Keyer 在無幕、幕色不一致或 evidence 含糊時 fail closed。",
    inputSchema: z.object({
      projectPath: z.string(),
      materialId: sha256Schema,
      evidenceReceiptSha256: sha256Schema,
      route: z.enum(["no_op", "manual_mask", "self_authored_screen_keyer"]),
      decisionContextTokens: z.number().int().min(1).max(400),
      screen: z.enum(["green", "blue"]).optional(),
      settings: z.unknown().optional(),
      manualCommand: editorCommandSchema.optional(),
    }),
  }, async ({ projectPath, materialId, evidenceReceiptSha256, route, decisionContextTokens, screen, settings, manualCommand }) => {
    try {
      const [project, evidence, capability, invocation] = await Promise.all([
        readProject(projectPath),
        verifyRotoKeyerEvidence(runtime().cacheRoot, materialId, evidenceReceiptSha256),
        inspectRotoKeyerCapabilities(runtime()),
        readLiveAutopilotIdentity(),
      ]);
      const sourceAsset = findAsset(project, evidence.assetId);
      await verifyRotoKeyerSourceFile(await resolveAssetSource(sourceAsset.uri), evidence.sourceSha256);
      const built = await buildRotoKeyerDecision(project, evidence, capability, {
        route,
        decisionContextTokens,
        ...(screen ? { screen } : {}),
        ...(settings ? { settings: settings as ChromaKeySettings } : {}),
        ...(manualCommand ? { command: editorCommandSchema.parse(manualCommand) } : {}),
      });
      if (built.command) editorCommandSchema.parse(built.command);
      return textResult({
        status: "PLAN_FRAGMENT_READY",
        requiredPlanSource: autopilotPlanSourceFromIdentity(invocation),
        rotoKeyer: { schema: "hao.video-autopilot.roto-keyer-plan/v1", decisions: [built.decision] },
        commands: built.command ? [built.command] : [],
        warning: "尚未修改專案；把 fragment 合併進同一 v4 plan，維持 quality.state=review_required，再 audit_autopilot_plan。",
      });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("prepare_autopilot_auto_roto", {
    description: "以事先綁定的 duration／frame／matte-byte 預算，執行唯一允許的自研 native Auto Roto product route，凍結逐格 matte 與自研 optical-alpha receipt，再回傳 exact editable add/update mask command 與 v4 decision。外部、ONNX、SAM、research/debug route 不接受也不會 fallback。這個工具只寫內容定址 cache，不修改專案。",
    inputSchema: z.object({
      projectPath: z.string(),
      materialId: sha256Schema,
      evidenceReceiptSha256: sha256Schema,
      maskId: z.string().trim().min(1).max(128),
      initialTime: z.number().nonnegative(),
      initialRect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
      decisionContextTokens: z.number().int().min(1).max(400),
      computeBudget: z.object({
        maxSourceDurationSeconds: z.number().positive().max(14_400),
        maxAnalyzedFrames: z.number().int().positive().max(172_800),
        maxMatteBytes: z.number().int().positive().max(8 * 1024 * 1024 * 1024),
      }),
      refine: z.object({
        temporalStability: z.number().min(0).max(.9).optional(),
        feather: z.number().min(0).max(.25).optional(),
        edgeShift: z.number().min(-.25).max(.25).optional(),
        contrast: z.number().min(0).max(4).optional(),
      }).optional(),
    }),
  }, async ({ projectPath, materialId, evidenceReceiptSha256, ...input }) => {
    try {
      const paths = runtime();
      const [project, evidence, capability, invocation] = await Promise.all([
        readProject(projectPath),
        verifyRotoKeyerEvidence(paths.cacheRoot, materialId, evidenceReceiptSha256),
        inspectRotoKeyerCapabilities(paths),
        readLiveAutopilotIdentity(),
      ]);
      const asset = findAsset(project, evidence.assetId);
      const sourcePath = await resolveAssetSource(asset.uri);
      const prepared = await prepareAutopilotAutoRoto(project, sourcePath, evidence, capability, input, paths);
      return textResult({
        status: "PLAN_FRAGMENT_READY",
        requiredPlanSource: autopilotPlanSourceFromIdentity(invocation),
        rotoKeyer: { schema: "hao.video-autopilot.roto-keyer-plan/v1", decisions: [prepared.decision] },
        commands: [prepared.command],
        preparationReceiptSha256: prepared.preparationReceiptSha256,
        warning: "尚未修改專案；合併進同一 v4 plan 後仍須 audit→atomic apply→人工檢查 Preview／formal render／reopen。",
      });
    } catch (error) { return errorResult(error); }
  });
}
