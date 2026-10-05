import type { McpServer } from "@modelcontextprotocol/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { REFERENCE_MOTION_COLOR_POLICY, REFERENCE_MOTION_TEMPLATES, REFERENCE_MOTION_MEDIA_PRESENTATION_CAPABILITIES,
  REFERENCE_MOTION_GRAPHIC_CADENCE_CAPABILITIES, REFERENCE_MOTION_STRIKE_PRESENTATION_CAPABILITIES,
  REFERENCE_MOTION_SOURCE_OVERLAY_CONTRACT, REFERENCE_MOTION_NATIVE_PAINT_PRESENTATION_CONTRACT, REFERENCE_MOTION_DISPLAY_PAINT_PRESENTATION_CONTRACT,
  referenceMotionTemplateInputSchema } from "../motion/referenceMotionTemplates";
import { prepareReferenceMotionTemplateInstance, prepareReferenceMotionTemplateRevision,
  inspectReferenceMotionTemplateInstance } from "../application/referenceMotionTemplateInstances";
import { referenceMotionTemplateRevisionPatchSchema } from "../domain/referenceMotionInstance";
import { readProject } from "./storage";
import { errorResult, textResult } from "./toolRuntime";
import { withReferenceMotionPhysicalFonts } from "./referenceMotionPhysicalFonts";
import { canonicalJson } from "../shared/canonicalJson";
import { prepareReferenceMotionTemplateReuse, referenceMotionTemplateReuseRequestSchema } from "../application/referenceMotionTemplateReuse";

function executedGraphics(prepared: { commands: import("../domain/commands").EditorCommand[];
  editorialGraphics: import("../application/editorialPlan").EditorialPlan["graphics"] }) {
  const ids = new Set(prepared.commands.flatMap(command => command.type === "add_motion_graphic" ? [command.graphic.id]
    : command.type === "update_motion_graphic" ? [command.graphicId] : []));
  return prepared.editorialGraphics.filter(graphic => ids.has(graphic.id));
}

export function registerReferenceMotionTemplateTools(server: McpServer, environment: NodeJS.ProcessEnv = process.env) {
  server.registerTool("list_reference_motion_templates", {
    description: "新建 strike_reframe 明確預設 semantic_replace_v1：同一焦點讀原句、刪去、替換新句；可選保留舊版。semantic 模式可明選 strikeSurface: source_overlay，以實際字型墨跡界線製作局部圓角襯底，保留原素材畫幅；省略或 standalone 維持原創圖形場景，不自動升級舊工程。可選最多16字的用戶文字字標，不是圖片Logo。新建圖卡預設 brisk，可明確選 legacy；已保存模板可獨立修改圖卡節奏，閱讀停留與媒體時鐘不變。只讀低 Token 索引：自研 Motion 場景的敘事用途、素材槽數、閱讀時間與能力邊界。新建雙素材比較預設 floating-v2 完整原比例柔邊窗，可明確選舊版取景；已儲存模板不自動升級，來源替換未支援。研究作者影片不作模板素材。", inputSchema: z.strictObject({}),
  }, async () => textResult({ schema: "editkin.reference-motion-template-catalog/v2", generation: 2, templates: REFERENCE_MOTION_TEMPLATES,
    prepareTool: "prepare_reference_motion_template", reviseTool: "prepare_reference_motion_template_revision",
    inspectTool: "inspect_reference_motion_instances", persistentProjectSchema: 10,
    nativePaintPresentation: { ...REFERENCE_MOTION_NATIVE_PAINT_PRESENTATION_CONTRACT, input: { graphicPresentation: "native_paint_v1" },
      previousInstancesKeepTheirPresentation: true, matchingCurrentNativeRuntimeRequired: true, sourceDevelopmentOnly: true,
      fullFilmArtPerformanceAndInstallationAccepted: false },
    displayPaintPresentation: { ...REFERENCE_MOTION_DISPLAY_PAINT_PRESENTATION_CONTRACT,
      input: { graphicPresentation: "native_paint_display_v2" },
      savedUpgrade: { reviseTool: "prepare_reference_motion_template_revision", patch: { graphicPresentation: "native_paint_display_v2" },
        oneWay: true, independentlyRecompiledAtAuditAndApply: true, existingRolesAndMediaClocksPreserved: true },
      previousInstancesKeepTheirPresentation: true, matchingCurrentNativeRuntimeRequired: true, sourceDevelopmentOnly: true,
      fullFilmArtPerformanceAndInstallationAccepted: false },
    savedTemplateReuse: { prepareTool: "prepare_reference_motion_template_reuse", target: "different_existing_imported_video_clip",
      sourceMutation: false, originalInstancePreserved: true, newInstanceAndRoleIds: true, freshPurposeAndEvidenceRequired: true,
      additionalSourcesMustBeExplicit: true, oldObservedCropNotCopied: true, planMode: "create", reuseOriginVerifiedAtAuditAndApply: true,
      previousQaOrArtworkApprovalReusable: false, installedOrFullProductCertified: false },
    mediaPresentationCapabilities: { comparison_pair: {
      ...REFERENCE_MOTION_MEDIA_PRESENTATION_CAPABILITIES.comparison_pair, historicalOmittedDefault: "legacy_layout",
      source_soft_v2: { schema: "editkin.floating-video-frame/v2", aspect: "source", mediaFit: "contain", style: "matte",
        yawDegrees: 0, pitchDegrees: 0 },
      legacy_layout: { presentation: "historical clip layout and masks" },
      savedInstanceAutomaticUpgrade: false, revisionCanChangePresentation: false,
    } }, graphicCadenceCapabilities: { ...REFERENCE_MOTION_GRAPHIC_CADENCE_CAPABILITIES, newAuthoringDefault: "brisk",
      savedInstanceAutomaticUpgrade: false, revisionCanChangeCadence: true },
    sameSourcePortability: { prepareTool: "prepare_media_source_relink", applyTool: "apply_media_source_relink",
      existingSourceSha256Required: true, newPathMustBeInsideWorkspace: true, differentMediaReplacement: false,
      preservesVisualsAndSourceClocks: true, previousQaOrArtworkApprovalReusable: false },
    strikePresentationCapabilities: { ...REFERENCE_MOTION_STRIKE_PRESENTATION_CAPABILITIES,
      savedInstanceAutomaticUpgrade: false, brandOwnership: "caller_declared_not_verified" },
    strikeSurfaceCapabilities: { ...REFERENCE_MOTION_SOURCE_OVERLAY_CONTRACT, presentationRequired: "semantic_replace_v1",
      newAuthoringDefault: "standalone", savedInstanceAutomaticUpgrade: false, revisionCanChangeSurface: true,
      nativePixelsOrArtworkCertified: false }, sourceReplacement: false,
    colorPolicy: REFERENCE_MOTION_COLOR_POLICY, execution: "v4 audit/apply/render required", capabilityBoundary: "Rec.709 editable 2D compound scenes; planar focus wall, no spherical wall or 3D studio" }));
  server.registerTool("prepare_reference_motion_template", {
    description: "新建 strike_reframe 的 strikePresentation 省略時明確選 semantic_replace_v1（同焦點先刪去再替換），可明選 legacy_layout；brandMark 是最多16 Unicode字的可編輯用戶文字，只接受明確 semantic_replace_v1，不支援圖片Logo或代驗品牌權利。strikeSurface 只接受明確 semantic_replace_v1，source_overlay 用實際字型與動作界線做局部襯底、保留原畫幅和時鐘；省略或 standalone 是原創圖形場景。其他family拒絕刪線專用欄位。新建 graphicCadence 預設 brisk（俐落圖卡），明確 legacy 保留舊版節奏；animationSpeed 是獨立微調，閱讀停留、原片速度及音訊不縮短。只讀：以目前 v2 recipe 和真實核對字型 bytes／glyph 排版，將八種自研場景編譯成可編輯 Motion／影片圖層命令；與桌面共用非同步 compiler，缺字型、逾時、取消或來源改變不退回估算。新建 comparison_pair 預設 source_soft_v2：兩個實際 floating-v2 matte 窗，按 upright DAR 完整容納來源、零 yaw/pitch；明確 legacy_layout 保留舊取景，其他 family 不接受此欄。已儲存模板及歷史省略欄位不自動升級，來源替換未支援。連線是抽象概念圖，點數不是平台人數。需影片、精確片段範圍、核對短文案、用途與證據。拒絕同檔別名、短素材、無閱讀停留、重疊 Motion 及長片預設套整幕。原片音訊與媒體速度不變，副來源靜音。回傳 physical layout metadata 與 v4 graphics／variants；REVIEW_REQUIRED 及素材宣告不是驗收，仍須 audit/apply/reopen/render。",
    inputSchema: referenceMotionTemplateInputSchema.safeExtend({ projectPath: z.string().min(1) }),
  }, async ({ projectPath, ...input }) => {
    try {
      const project = await readProject(projectPath), signature = canonicalJson(project);
      const prepared = await withReferenceMotionPhysicalFonts(dependencies =>
        prepareReferenceMotionTemplateInstance(project, { ...input, graphicCadence: input.graphicCadence ?? "brisk",
          ...(input.templateId === "strike_reframe" ? { strikePresentation: input.strikePresentation ?? "semantic_replace_v1" } : {}) },
        prefix => `${prefix}-${randomUUID()}`, dependencies), environment);
      if (canonicalJson(await readProject(projectPath)) !== signature) throw new Error("Motion template project changed on disk during preparation; re-read before planning");
      return textResult({ ...prepared, editorialGraphics: executedGraphics(prepared), planDeclaration: { schema: "editkin.reference-motion-plan/v1", instances: [{
        instanceId: prepared.instance.id, mode: "create", commandIndexes: prepared.commands.map((_, index) => index),
      }] }, declarationIndexes: "Relative to these flat commands; shift all indexes by their final offset in the v4 plan. Metadata earns no design credit." });
    }
    catch (error) { return errorResult(error); }
  });
  server.registerTool("prepare_reference_motion_template_reuse", {
    description: "唯讀：把CURRENT已保存模板的文案／字型／配色／節奏與明確呈現套到另一個已匯入影片clip，新建獨立實例與全新角色IDs，原模板不動。須目前project/instance revision、不同內容的targetClipId、這段的新用途與核對依據、完整明選額外sources；不複製舊素材引用、觀察裁切、素材證據或美術核准。按新clip整數影格窗口與真DAR重新核對真字型，缺字、短素材、重疊Motion、鎖軌、漂移或取消停止。不是saved source replacement，來源搬移另走same-byte工具。回傳含strict reuseOrigin的v4 mode:create；audit/apply從當前原模板與真字型獨立重新推導全commands，須同批套用、重開、正式render及新素材與全片美術/效能證據。回傳不是已安裝能力、權利或產品驗收。",
    inputSchema: referenceMotionTemplateReuseRequestSchema.safeExtend({ projectPath: z.string().min(1).max(1024) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ projectPath, ...request }) => {
    try {
      const project = await readProject(projectPath), signature = canonicalJson(project);
      const prepared = await withReferenceMotionPhysicalFonts(dependencies => prepareReferenceMotionTemplateReuse(project, request,
        prefix => `${prefix}-${randomUUID()}`, dependencies), environment);
      if (canonicalJson(await readProject(projectPath)) !== signature) throw new Error("Saved reuse project changed on disk during preparation");
      return textResult({ ...prepared, editorialGraphics: executedGraphics(prepared),
        declarationIndexes: "Relative flat command indexes; shift by final v4 offset. Reuse origin is rechecked at audit and apply; old QA and prepare output confer no new source rights or artwork credit." });
    } catch (error) { return errorResult(error); }
  });
  server.registerTool("prepare_reference_motion_template_revision", {
    description: "只讀：semantic 刪線模板可明確修改 strikeSurface（standalone 原創圖形場景／source_overlay 原素材上的局部提示），省略保留原值，改回 legacy 自動移除 semantic 用途。重編目前已保存模板的文案、標題／內文字型、配色與明確 graphicCadence 圖卡節奏；省略節奏 patch 保留目前設定，歷史省略欄位仍為 legacy。brisk 加快圖卡入退場與交接，閱讀停留、角色身分、原片速度／入點與音訊不變。手動編輯漂移、依賴改變、缺字或停留不足即停止。命令與metadata必須同批；v4 audit/apply各自從可信專案與真字型重新核對，回傳不是授權或美術通過。來源替換未支援。",
    inputSchema: z.strictObject({ projectPath: z.string().min(1), instanceId: z.string().min(1).max(160),
      expectedInstanceRevision: z.number().int().positive(), patch: referenceMotionTemplateRevisionPatchSchema }),
  }, async ({ projectPath, instanceId, expectedInstanceRevision, patch }) => {
    try {
      const project = await readProject(projectPath), signature = canonicalJson(project);
      const prepared = await withReferenceMotionPhysicalFonts(dependencies => prepareReferenceMotionTemplateRevision(project, instanceId, patch,
        { ...dependencies, expectedInstanceRevision, idFactory: prefix => `${prefix}-${randomUUID()}` }), environment);
      if (canonicalJson(await readProject(projectPath)) !== signature) throw new Error("Reference instance changed on disk during preparation");
      if (prepared.status === "UNCHANGED") return textResult({ ...prepared, editorialGraphics: [] });
      return textResult({ ...prepared, editorialGraphics: executedGraphics(prepared), planDeclaration: { schema: "editkin.reference-motion-plan/v1", instances: [{
        instanceId, mode: "revise", expectedInstanceRevision, patch, commandIndexes: prepared.commands.map((_, index) => index),
      }] }, declarationIndexes: "Relative to these flat commands; shift by final v4 offset. Current design/material/policy receipts remain required." });
    } catch (error) { return errorResult(error); }
  });
  server.registerTool("inspect_reference_motion_instances", {
    description: "只讀保存模板、輸入和漂移狀態；CURRENT不代表美術或成片驗收。detach只移metadata並保留所有現有編輯，不能用來取得自動化視覺credit。",
    inputSchema: z.strictObject({ projectPath: z.string().min(1) }),
  }, async ({ projectPath }) => {
    try {
      const project = await readProject(projectPath), signature = canonicalJson(project);
      const instances = [];
      for (const instance of project.referenceMotionInstances ?? []) instances.push({ instance,
        inspection: await inspectReferenceMotionTemplateInstance(project, instance.id),
        detachCommand: { type: "remove_reference_motion_instance", id: instance.id, expectedInstanceRevision: instance.instanceRevision } });
      if (canonicalJson(await readProject(projectPath)) !== signature) throw new Error("Reference project changed during inspection");
      return textResult({ schema: "editkin.reference-motion-instance-inspection/v1", instances, readOnly: true, artwork: "REVIEW_REQUIRED" });
    } catch (error) { return errorResult(error); }
  });
}
