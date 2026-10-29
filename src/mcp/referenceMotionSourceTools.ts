import type { McpServer } from "@modelcontextprotocol/server";
import { randomUUID } from "node:crypto";
import * as z from "zod/v4";
import { referenceMotionSourceReplacementRequestSchema, referenceMotionSourceSlots, SOURCE_REPLACEMENT_MESSAGES } from "../application/referenceMotionSourceReplacement";
import { prepareReferenceMotionTemplateSourceReplacement } from "../application/referenceMotionSourceTransaction";
import { inspectMedia } from "../application/inspectMedia";
import type { MediaFrameRate } from "../domain/mediaFrameRate";
import { canonicalJson } from "../shared/canonicalJson";
import { readProject, resolveWorkspaceMediaPath } from "./storage";
import { withReferenceMotionPhysicalFonts } from "./referenceMotionPhysicalFonts";
import { errorResult, textResult } from "./toolRuntime";

export function registerReferenceMotionSourceTools(server: McpServer, environment: NodeJS.ProcessEnv = process.env,
  probe = inspectMedia) {
  server.registerTool("prepare_reference_motion_template_source_replacement", {
    description: "唯讀：更換 CURRENT 保存模板同一實例的主影片／額外影片與整數影格時間窗；保留原文案、字型、配色、角色 IDs 與節奏，副來源固定靜音。換檔須新 evidenceRefs、明確 focusRegion/textRegion 值或 null、已換副來源的新 label；舊 QA／美術／權利證據不沿用。新檔須先匯入，並用 staging clip 的新時間窗取得 prepare_ai_material 與實際 keyframes／semantic 證明。回傳 optional editkin.reference-motion-plan/v2 replace_source 意圖；canonical v4 audit/apply 各自用真字型重新編譯，並要求同 asset 的已驗證素材時間窗完整覆蓋新窗口。準備結果不是執行授權、已安裝能力或驗收；須另行 apply、save/reopen、render 與 Claude 美術驗收。",
    inputSchema: referenceMotionSourceReplacementRequestSchema.safeExtend({ projectPath: z.string().trim().min(1).max(1024) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ projectPath, ...request }) => {
    try {
      const project = await readProject(projectPath), signature = canonicalJson(project);
      const owner = project.referenceMotionInstances?.find(instance => instance.id === request.instanceId);
      if (!owner) throw new Error(SOURCE_REPLACEMENT_MESSAGES.edited);
      const rates: Record<string, MediaFrameRate> = {};
      const checked = new Set<string>();
      for (const slot of referenceMotionSourceSlots(project, owner)) {
        const target = slot.slot === 0 ? request.primary : request.sources?.[slot.slot - 1];
        const assetId = target?.assetId ?? slot.assetId;
        if (checked.has(assetId)) continue;
        checked.add(assetId);
        const asset = project.assets.find(candidate => candidate.id === assetId);
        if (!asset || asset.kind !== "video") throw new Error(SOURCE_REPLACEMENT_MESSAGES.videoOnly);
        const measured = await probe(await resolveWorkspaceMediaPath(asset.uri), environment.HAO_FFPROBE_PATH);
        if (!measured.hasVideo || measured.imageSequence || measured.width !== asset.width || measured.height !== asset.height
          || !Number.isFinite(measured.duration) || Math.abs(measured.duration - asset.duration) > 1 / project.fps
          || asset.displayAspectRatio !== undefined && (measured.displayAspectRatio === undefined || Math.abs(measured.displayAspectRatio - asset.displayAspectRatio) > 1e-6)
          || [[asset.color?.primaries, measured.colorPrimaries], [asset.color?.transfer, measured.colorTransfer], [asset.color?.matrix, measured.colorMatrix]]
            .some(([saved, current]) => saved !== undefined && saved !== current)) throw new Error(SOURCE_REPLACEMENT_MESSAGES.changedFile);
        if (measured.frameRate) rates[assetId] = measured.frameRate;
      }
      if (canonicalJson(await readProject(projectPath)) !== signature) throw new Error("Source replacement project changed during its live probe");
      const prepared = await withReferenceMotionPhysicalFonts(dependencies => prepareReferenceMotionTemplateSourceReplacement(project, request,
        prefix => `${prefix}-${randomUUID()}`, { ...dependencies, sourceFrameRates: rates }), environment);
      if (canonicalJson(await readProject(projectPath)) !== signature) throw new Error("Source replacement project changed during physical preparation");
      if (prepared.status === "UNCHANGED") return textResult({ ...prepared, editorialGraphics: [] });
      const executed = new Set(prepared.commands.flatMap(command => command.type === "add_motion_graphic" ? [command.graphic.id]
        : command.type === "update_motion_graphic" ? [command.graphicId] : []));
      const { instanceId, expectedInstanceRevision, expectedProjectRevision: _projectRevision, ...replacement } = request;
      return textResult({ ...prepared, editorialGraphics: prepared.editorialGraphics.filter(graphic => executed.has(graphic.id)),
        planDeclaration: { schema: "editkin.reference-motion-plan/v2", instances: [{ instanceId, mode: "replace_source", expectedInstanceRevision,
          replacement, commandIndexes: prepared.commands.map((_, index) => index) }] },
        declarationIndexes: "Relative flat indexes; shift by final v4 offset. Stage fresh material analysis before replacement and remove its staging clip in that same plan. Audit/apply independently verify the complete compiler group and new material windows." });
    } catch (error) { return errorResult(error); }
  });
}
