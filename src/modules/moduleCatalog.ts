import * as z from "zod/v4";
import { findClip } from "../domain/editGraph";
import { EFFECT_PRESETS, LOOK_PRESETS, TEXT_STYLE_PRESETS, TRANSITION_PRESETS } from "../creative/corePack";
import { motionGraphicPresets } from "../creative/motionGraphicPresets";
import type { MotionGraphicPreset } from "../creative/motionGraphicPresetTypes";
import { ORIGINAL_ELEMENTS } from "../creative/originalElements";
import { CINEMATIC_LANGUAGE_RECIPES } from "../creative/cinematicLanguage";
import { motionGraphicCreationInputSchema } from "../application/motionGraphicCreation";
import { SHORT_FORM_TEMPLATES } from "../application/shortFormTemplates";
import { LONG_FORM_TEMPLATES } from "../application/longFormTemplates";
import { AVAILABLE_MESH_3D_TEMPLATES, MESH_3D_TEMPLATES } from "../application/mesh3dTemplates";
import { FLOATING_FRAME_SCENE_PRESETS } from "../motion/floatingFrameScenes";
import { MOTION_CLIP_PRESETS } from "../motion/motionClipPresets";
import { REFERENCE_MOTION_TEMPLATES, referenceMotionTemplateInputSchema } from "../motion/referenceMotionTemplates";
import { prepareMotionGraphicCreationFile } from "../mcp/motionGraphicCreationFile";
import { motionGraphicKitSceneSchema, originalElementRequestSchema, prepareMotionGraphicKitFile, prepareOriginalElementFile } from "../mcp/motionGraphicKitTools";
import { prepareReferenceMotionTemplateFile } from "../mcp/referenceMotionTemplateTools";
import { prepareIllustratedMusicVideoInputSchema, prepareIllustratedMusicVideoReadOnly, prepareMusicVideoDraftInputSchema, prepareMusicVideoDraftReadOnly } from "../mcp/musicVideoTools";
import { compileBeatMontageInputSchema, compileBeatMontageReadOnly } from "../mcp/montageTools";
import {
  clipMotionPresetRequestSchema, creativePresetCommands, floatingFrameSceneRequestSchema, nativeMotionSequenceRequestSchema, nativeReelSceneRequestSchema,
  prepareAutopilotTemplatePackageFile, prepareClipMotionPresetFile, prepareFloatingFrameSceneFile, prepareNativeMotionSequenceFile, prepareNativeReelSceneFile,
  templatePackageRequestSchema,
} from "../mcp/moduleCompilers";
import { readProject } from "../mcp/storage";
import type { ModuleAdapter, ModuleFormat, ModuleManifest, ModuleVariant } from "./moduleTypes";
import { COMPOSITION_TEMPLATES } from "./templateCatalog";

const BOTH: ModuleFormat[] = ["landscape", "portrait"];
const V4 = "Bind the commands (and any carriers) into the single v4 plan, then audit_autopilot_plan → apply_autopilot_plan.";

type Manifest = Omit<ModuleManifest, "schema">;
const manifest = (value: Omit<Manifest, "version" | "invoke" | "variants" | "roles" | "formats" | "requires"> & Partial<Pick<Manifest, "variants" | "roles" | "formats" | "requires">> & { invoke?: string }): Manifest => ({
  version: "1.0.0", variants: [], roles: [], formats: BOTH, requires: [],
  ...value, invoke: { tool: value.invoke ?? "prepare_editkin_module" },
});

const FORMAT_BY_RATIO: Record<string, ModuleFormat> = { "16:9": "landscape", "9:16": "portrait", "1:1": "square" };

/** Presets the creation compiler accepts: registered text v2, no vector body, no tracking or surface requirements. */
export function creatableMotionPresets(): MotionGraphicPreset[] {
  return motionGraphicPresets().filter(preset => preset.renderer === "hao-motion-composition/v2" && preset.seed.schema === "hao.motion-composition/v2"
    && preset.seed.kind !== undefined && preset.seed.vectorV2 === undefined && preset.seed.trackingMode === undefined
    && (preset.routing?.requires ?? ["none"]).every(requirement => requirement === "none"));
}

const clipsSchema = z.array(z.string().min(1)).min(1).max(64);
const lookSchema = z.strictObject({ clipIds: clipsSchema });
const effectSchema = z.strictObject({ clipIds: clipsSchema, additionalEffectIds: z.array(z.string().min(1)).max(3).optional() });
const transitionSchema = z.strictObject({ clipIds: clipsSchema, edge: z.enum(["in", "out", "both"]).default("in") });
const textStyleSchema = z.strictObject({});
async function clipCommands(projectPath: string, clipIds: string[], build: (clipId: string) => ReturnType<typeof creativePresetCommands>) {
  if (new Set(clipIds).size !== clipIds.length) throw new Error("clipIds 不可重複");
  const project = await readProject(projectPath);
  for (const clipId of clipIds) findClip(project, clipId);
  return { status: "PREPARED", projectRevision: project.revision, commands: clipIds.flatMap(build) };
}

export function moduleCatalog(): ModuleAdapter[] {
  const presets = creatableMotionPresets();
  const presetKind = (id: string) => presets.find(preset => preset.id === id)?.seed.kind;
  const variant = (id: string, name: string, extra: Partial<ModuleVariant> = {}): ModuleVariant => ({ id, name, ...extra });

  return [
    // ---------------------------------------------------------------- graphics
    { manifest: manifest({ id: "graphic.motion_preset", kind: "graphic", name: "Motion 圖文預設", status: "available", layer: "overlay", variantField: "presetId",
      summary: "已註冊的 Motion v2 文字圖卡（kinetic 七式、lower third、studio、reel 等），用實體字型與逐格安全區準備，片尾不足會拒絕。",
      variants: presets.map(preset => variant(preset.id, preset.name, { family: preset.family, roles: preset.routing?.semanticRoles,
        formats: preset.routing?.formats.map(ratio => FORMAT_BY_RATIO[ratio]).filter(Boolean), intensity: preset.routing?.intensity })),
      roles: [...new Set(presets.flatMap(preset => preset.routing?.semanticRoles ?? []))].sort(), formats: ["landscape", "portrait", "square"],
      output: { commandTypes: ["add_motion_graphic"], carriers: [] }, requires: ["expectedRevision", "exact startFrame window", "0.8s reading hold"],
      legacy: { tools: ["prepare_motion_graphic_creation", "apply_creative_preset"] },
      autopilot: { use: "Plain text beats: titles, lower thirds, tags, counters. Pick the variant by semantic role and energy.", avoid: "Designed concept moments — prefer graphic.original_element." } }),
      inputSchema: motionGraphicCreationInputSchema,
      prepare: async ({ projectPath, variantId, inputs, environment, signal }) =>
        prepareMotionGraphicCreationFile(projectPath, motionGraphicCreationInputSchema.parse({ kind: presetKind(variantId ?? ""), ...inputs, presetId: variantId }), environment, signal) },

    { manifest: manifest({ id: "graphic.original_element", kind: "graphic", name: "原創元素 Collection 01", status: "available", layer: "scene", variantField: "elementId",
      summary: "八種原創元素（重點字貼、對話泡泡、手記、章節票卡、操作框選、反應貼紙、步驟連線、重點回顧），分段建構＋Studio 細節層；scene 整幕或 overlay 疊實拍。",
      variants: ORIGINAL_ELEMENTS.map(element => variant(element.id, element.name, { use: element.use, roles: [element.intent] })),
      roles: ORIGINAL_ELEMENTS.map(element => element.intent),
      output: { commandTypes: ["add_motion_graphic"], carriers: ["timeline"] }, requires: ["startFrame", "durationFrames 30–600", "focus-bracket needs an observed target + sourceId"],
      legacy: { tools: ["prepare_original_element"] },
      autopilot: { use: "Designed moments: emphasis, question, observation, chapter, UI focus, reaction, process, recap. Size the slot as timeline.buildSeconds + reading hold.", avoid: "Overlay mode on busy footage without checking subtitle clearance." } }),
      inputSchema: originalElementRequestSchema,
      prepare: async ({ projectPath, variantId, inputs }) => prepareOriginalElementFile(projectPath, originalElementRequestSchema.parse({ ...inputs, elementId: variantId })) },

    { manifest: manifest({ id: "graphic.motion_kit", kind: "graphic", name: "Motion Graphic Kit", status: "available", layer: "scene",
      summary: "藍白網格底板、眉題、逐字主標、說明、泡泡、膠囊、卡片、點擊波紋，自由組成概念整幕。",
      roles: ["concept", "explainer", "dialogue"], output: { commandTypes: ["add_motion_graphic"], carriers: [] },
      requires: ["elements with at (seconds)", "board covers the frame — omit it over footage"], legacy: { tools: ["prepare_motion_graphic_kit"] },
      autopilot: { use: "Custom concept scenes the original elements do not cover." } }),
      inputSchema: motionGraphicKitSceneSchema,
      prepare: async ({ projectPath, inputs }) => prepareMotionGraphicKitFile(projectPath, motionGraphicKitSceneSchema.parse(inputs)) },

    // ---------------------------------------------------------------- clip motion
    { manifest: manifest({ id: "clip_motion.camera", kind: "clip_motion", name: "片段運鏡", status: "available", layer: "clip", variantField: "presetId",
      summary: "Motion Language 運鏡（punch_in、snap_zoom、push_settle、whip_in、impact_shake、drift_push）與舊版浮動；烘成逐格關鍵幀。",
      variants: MOTION_CLIP_PRESETS.map(preset => variant(preset.id, preset.name, { use: preset.description })),
      roles: ["emphasis", "impact", "reveal", "continuity"], output: { commandTypes: ["add_keyframe"], carriers: [] },
      requires: ["clip without keyframes", "≥12 frames", "real footage only (never generated stills)"], legacy: { tools: ["prepare_clip_motion_preset"] },
      autopilot: { use: "Camera emphasis on filmed clips at the narration's key word.", avoid: "Generated images and cards (anti-pattern 18)." } }),
      inputSchema: clipMotionPresetRequestSchema,
      prepare: async ({ projectPath, variantId, inputs }) => prepareClipMotionPresetFile(clipMotionPresetRequestSchema.parse({ ...inputs, projectPath, presetId: variantId })) },

    // ---------------------------------------------------------------- scenes
    { manifest: manifest({ id: "scene.floating_frame", kind: "scene", name: "浮空影片框場景", status: "available", layer: "scene", variantField: "presetId",
      summary: "直式三素材 2.5D 浮空影片框（原比例完整嵌入、逐格進退場）。",
      variants: FLOATING_FRAME_SCENE_PRESETS.map(preset => variant(preset.id, preset.name, { use: preset.description, formats: ["portrait"] })),
      roles: ["showcase", "comparison"], formats: ["portrait"], output: { commandTypes: ["set_clip_floating_frame", "add_clip"], carriers: ["sources"] },
      requires: ["portrait project", "rear-right and front source clips", "≥13 frames"], legacy: { tools: ["prepare_floating_frame_scene"] },
      autopilot: { use: "Showing several of the creator's own clips at once in Shorts." } }),
      inputSchema: floatingFrameSceneRequestSchema,
      prepare: async ({ projectPath, variantId, inputs }) => prepareFloatingFrameSceneFile(floatingFrameSceneRequestSchema.parse({ ...inputs, projectPath, presetId: variantId })) },

    { manifest: manifest({ id: "scene.native_reel", kind: "scene", name: "直式章節場景", status: "available", layer: "scene", variantField: "templateId",
      summary: "9:16 章節資訊（進度、短線、點陣、字）或三素材空間展廊。",
      variants: [variant("editorial_steps", "章節步驟", { formats: ["portrait"] }), variant("spatial_gallery", "空間展廊", { formats: ["portrait"] })],
      roles: ["chapter", "process"], formats: ["portrait"], output: { commandTypes: ["add_motion_graphic"], carriers: ["editorialGraphics"] },
      requires: ["evidenceRefs", "title ≤48", "valid range"], legacy: { tools: ["prepare_native_reel_scene"] },
      autopilot: { use: "Shorts chapter beats.", avoid: "Longform — use overlay.native_motion_sequence." } }),
      inputSchema: nativeReelSceneRequestSchema,
      prepare: async ({ projectPath, variantId, inputs }) => prepareNativeReelSceneFile(nativeReelSceneRequestSchema.parse({ ...inputs, projectPath, templateId: variantId })) },

    { manifest: manifest({ id: "overlay.native_motion_sequence", kind: "overlay", name: "長片局部提示", status: "available", layer: "overlay",
      summary: "長片只加短文字與局部焦點線，保留原素材尺寸、剪點與旁白；每次最多四秒。",
      roles: ["focus", "keyword"], formats: ["landscape"], output: { commandTypes: ["add_motion_graphic"], carriers: ["editorialGraphics"] },
      requires: ["observed text space per section"], legacy: { tools: ["prepare_native_motion_sequence"] },
      autopilot: { use: "Teaching longform: light cues over real UI footage." } }),
      inputSchema: nativeMotionSequenceRequestSchema,
      prepare: async ({ projectPath, inputs }) => prepareNativeMotionSequenceFile(nativeMotionSequenceRequestSchema.parse({ ...inputs, projectPath })) },

    { manifest: manifest({ id: "scene.reference_motion", kind: "scene", name: "自研 Motion 場景模板", status: "available", layer: "scene", variantField: "templateId",
      summary: "八種自研場景（刪去重點、層級切換、比較、連線…），實體字型排版，kinetic 節奏預設；回傳 planDeclaration 供 v4 綁定。",
      variants: REFERENCE_MOTION_TEMPLATES.map(template => variant(template.id, template.name, { use: template.description, family: template.grammar })),
      roles: [...new Set(REFERENCE_MOTION_TEMPLATES.map(template => template.grammar))],
      output: { commandTypes: ["add_motion_graphic", "add_clip", "update_motion_graphic"], carriers: ["editorialGraphics", "planDeclaration"] },
      requires: ["exact clip range", "verified short copy", "purpose and evidence"], legacy: { tools: ["prepare_reference_motion_template"] },
      autopilot: { use: "Narrative concept scenes with saved, revisable instances; shift planDeclaration indexes to the plan offset." } }),
      inputSchema: referenceMotionTemplateInputSchema,
      prepare: async ({ projectPath, variantId, inputs, environment }) =>
        prepareReferenceMotionTemplateFile(projectPath, referenceMotionTemplateInputSchema.parse({ ...inputs, templateId: variantId }), environment) },

    // ---------------------------------------------------------------- creative presets (read-only; the old tool applied directly)
    { manifest: manifest({ id: "look.color", kind: "look", name: "調色 Look", status: "available", layer: "clip", variantField: "lookPresetId",
      summary: "原生調色 Look，回傳 set_clip_creative 命令（進 v4 plan，不直接改專案）。",
      variants: LOOK_PRESETS.map(preset => variant(preset.id, preset.name)), output: { commandTypes: ["set_clip_creative"], carriers: [] },
      requires: ["clipIds"], legacy: { tools: ["apply_creative_preset"] }, autopilot: { use: "Grade per template or material evidence." } }),
      inputSchema: lookSchema,
      prepare: async ({ projectPath, variantId, inputs }) => {
        const { clipIds } = lookSchema.parse(inputs);
        return clipCommands(projectPath, clipIds, clipId => creativePresetCommands({ clipId, lookPresetId: variantId }));
      } },
    { manifest: manifest({ id: "effect.clip", kind: "effect", name: "片段特效", status: "available", layer: "clip", variantField: "effectPresetIds",
      summary: "片段特效（最多 4 個疊加），回傳 set_clip_creative。",
      variants: EFFECT_PRESETS.map(preset => variant(preset.id, preset.name)), output: { commandTypes: ["set_clip_creative"], carriers: [] },
      requires: ["clipIds", "motivated by material evidence"], legacy: { tools: ["apply_creative_preset"] }, autopilot: { use: "Only with a material reason; never decorative by default." } }),
      inputSchema: effectSchema,
      prepare: async ({ projectPath, variantId, inputs }) => {
        const { clipIds, additionalEffectIds } = effectSchema.parse(inputs);
        return clipCommands(projectPath, clipIds, clipId => creativePresetCommands({ clipId, effectPresetIds: [variantId ?? "", ...(additionalEffectIds ?? [])] }));
      } },
    { manifest: manifest({ id: "transition.clip", kind: "transition", name: "片段轉場", status: "available", layer: "clip", variantField: "transitionPresetId",
      summary: "片段入場／出場轉場，回傳 set_clip_creative。",
      variants: TRANSITION_PRESETS.map(preset => variant(preset.id, preset.name)), output: { commandTypes: ["set_clip_creative"], carriers: [] },
      requires: ["clipIds", "edge in/out/both"], legacy: { tools: ["apply_creative_preset"] }, autopilot: { use: "Transitions with a narrative reason at the cut." } }),
      inputSchema: transitionSchema,
      prepare: async ({ projectPath, variantId, inputs }) => {
        const { clipIds, edge } = transitionSchema.parse(inputs);
        return clipCommands(projectPath, clipIds, clipId => creativePresetCommands({ clipId,
          ...(edge !== "out" ? { transitionInPresetId: variantId } : {}), ...(edge !== "in" ? { transitionOutPresetId: variantId } : {}) }));
      } },
    { manifest: manifest({ id: "text_style.caption", kind: "text_style", name: "字幕樣式", status: "available", layer: "project", variantField: "textStylePresetId",
      summary: "字幕文字樣式，回傳 set_caption_style。",
      variants: TEXT_STYLE_PRESETS.map(preset => variant(preset.id, preset.name)), output: { commandTypes: ["set_caption_style"], carriers: [] },
      legacy: { tools: ["apply_creative_preset"] }, autopilot: { use: "Caption look; longform stays white-first." } }),
      inputSchema: textStyleSchema,
      prepare: async ({ projectPath, variantId, inputs }) => {
        textStyleSchema.parse(inputs);
        const project = await readProject(projectPath);
        return { status: "PREPARED", projectRevision: project.revision, commands: creativePresetCommands({ textStylePresetId: variantId }) };
      } },

    // ---------------------------------------------------------------- music video, recipes, templates
    { manifest: manifest({ id: "music_video.illustrated", kind: "music_video", name: "插畫動畫 MV", status: "available", layer: "timeline",
      summary: "有權利的原創／授權插畫背景與透明角色圖層＋歌曲，編成分層 2D 鏡頭推移、角色進場、節拍動態與歌詞。",
      roles: ["music_video"], output: { commandTypes: ["add_clip", "add_motion_graphic", "add_keyframe"], carriers: [] },
      requires: ["licensed illustration layers", "song", "verified lyrics"], legacy: { tools: ["prepare_illustrated_music_video_draft"] },
      autopilot: { use: "Animated MV requests.", avoid: "Never fake it with live-action lyric cards." } }),
      inputSchema: prepareIllustratedMusicVideoInputSchema,
      prepare: async ({ projectPath, inputs }) => prepareIllustratedMusicVideoReadOnly(prepareIllustratedMusicVideoInputSchema.parse({ ...inputs, projectPath })) },
    { manifest: manifest({ id: "music_video.footage", kind: "music_video", name: "實拍蒙太奇 MV", status: "available", layer: "timeline",
      summary: "歌曲聲軌＋實拍鏡頭＋樂句切點（可選歌詞）的可編輯草稿。",
      roles: ["music_video", "montage"], output: { commandTypes: ["add_clip", "add_motion_graphic"], carriers: [] },
      requires: ["explicit request for a live-action montage"], legacy: { tools: ["prepare_music_video_draft"] },
      autopilot: { use: "Only when a live-action montage MV is explicitly asked for." } }),
      inputSchema: prepareMusicVideoDraftInputSchema,
      prepare: async ({ projectPath, inputs }) => prepareMusicVideoDraftReadOnly(prepareMusicVideoDraftInputSchema.parse({ ...inputs, projectPath })) },
    { manifest: manifest({ id: "edit_recipe.beat_montage", kind: "edit_recipe", name: "節拍蒙太奇", status: "available", layer: "timeline",
      summary: "依節拍點、鏡頭顯著度與故事順序編出節拍對齊的蒙太奇剪輯命令。",
      roles: ["montage", "rhythm"], output: { commandTypes: ["batch"], carriers: ["selections", "guarantees"] },
      requires: ["beatTimes", "candidate shots with evidence"], legacy: { tools: ["compile_beat_montage"] },
      autopilot: { use: "Montage beats synced to music." } }),
      inputSchema: compileBeatMontageInputSchema,
      prepare: async ({ projectPath, inputs }) => compileBeatMontageReadOnly(compileBeatMontageInputSchema.parse({ ...inputs, projectPath })) },
    ...(["short", "long"] as const).map((format): ModuleAdapter => ({
      manifest: manifest({ id: `template.${format}_form`, kind: "template", name: format === "short" ? "短片視覺模板" : "長片視覺模板", status: "available",
        layer: "project", variantField: "templateId",
        summary: format === "short" ? "短片模板的原生 Look（其餘轉場／特效／圖卡為建議，依素材證據逐項加）。" : "長片模板的原生 Look＋白字半透明黑底字幕。",
        variants: (format === "short" ? SHORT_FORM_TEMPLATES : LONG_FORM_TEMPLATES).map(template => variant(template.id, template.name,
          { use: template.bestFor, family: template.category, formats: format === "short" ? ["portrait"] : ["landscape"] })),
        formats: format === "short" ? ["portrait"] : ["landscape"], output: { commandTypes: ["set_clip_creative", "set_caption_style"], carriers: ["suggestions"] },
        requires: ["video clipIds"], legacy: { tools: ["prepare_autopilot_template_package"] },
        autopilot: { use: "Starting visual package; add motion modules from the returned suggestions with evidence." } }),
      inputSchema: templatePackageRequestSchema,
      prepare: async ({ projectPath, variantId, inputs }) => prepareAutopilotTemplatePackageFile(templatePackageRequestSchema.parse({ ...inputs, projectPath, format, templateId: variantId })),
    })),

    // ---------------------------------------------------------------- dedicated-tool, planning-only and withdrawn modules
    { manifest: manifest({ id: "template.composition", kind: "template", name: "組合模板", status: "dedicated_tool", invoke: "prepare_editkin_template", layer: "timeline",
      summary: "把多個模組排成具名配方（Shorts 教學／高能／Vlog、教學長片、插畫 MV）：每個 slot 限定可用模組與 variant，一次編譯成同一份命令並檢查組合與節奏。",
      variants: COMPOSITION_TEMPLATES.map(template => variant(template.id, template.name, { use: template.bestFor, formats: template.formats })),
      roles: ["template"], output: { commandTypes: ["add_motion_graphic", "add_keyframe", "set_clip_creative", "set_caption_style", "add_clip"], carriers: ["planDeclaration", "editorialGraphics", "motionCoverage"] },
      requires: ["fills with slotId, beatId and module inputs"], legacy: { tools: ["list_editkin_templates", "prepare_editkin_template"] },
      autopilot: { use: "Start a whole film from a named recipe; fill slots from material evidence, never from the template's example copy." } }) },
    { manifest: manifest({ id: "scene.original_2d", kind: "scene", name: "原創 2D 場景", status: "dedicated_tool", invoke: "prepare_original_motion_scene_2d", layer: "scene",
      summary: "可編輯原創 2D 場景＋鏡頭，綁 originalMotionEvidence 與 v4 originalSourceExecution。", output: { commandTypes: ["add_motion_graphic", "set_motion_scene"], carriers: ["originalMotionEvidence"] },
      legacy: { tools: ["prepare_original_motion_scene_2d", "prepare_original_scene_graphic_revision"] }, autopilot: { use: "Original standalone/hybrid scenes under the v4 original-source contract." } }) },
    { manifest: manifest({ id: "scene.original_source", kind: "scene", name: "原創場景原稿", status: "dedicated_tool", invoke: "prepare_original_motion_source", layer: "scene",
      summary: "從 .editkin/original-sources 原稿編譯可編輯場景（權利、風格、cue、實體字型）。", output: { commandTypes: ["add_motion_graphic", "set_motion_scene"], carriers: ["originalMotionEvidence"] },
      legacy: { tools: ["prepare_original_motion_source", "prepare_original_motion_source_revision"] }, autopilot: { use: "Authored-source scenes; keep commandIndexOffset bound to the plan." } }) },
    { manifest: manifest({ id: "graphic.motion_revision", kind: "graphic", name: "Motion 局部修訂", status: "dedicated_tool", invoke: "prepare_native_motion_revision", layer: "overlay",
      summary: "精確修訂既有 Motion v2 元素的入退場與節奏（不改內容與終點）。", output: { commandTypes: ["update_motion_graphic"], carriers: [] },
      legacy: { tools: ["prepare_native_motion_revision"] }, autopilot: { use: "Director revisions of existing graphics." } }) },
    { manifest: manifest({ id: "scene.reference_motion_revision", kind: "scene", name: "場景模板修訂／重用", status: "dedicated_tool", invoke: "prepare_reference_motion_template_revision", layer: "scene",
      summary: "修改或重用已保存的自研場景實例。", output: { commandTypes: ["update_motion_graphic", "add_motion_graphic"], carriers: ["planDeclaration"] },
      legacy: { tools: ["prepare_reference_motion_template_revision", "prepare_reference_motion_template_reuse", "inspect_reference_motion_instances"] }, autopilot: { use: "Revising saved scene instances." } }) },
    { manifest: manifest({ id: "overlay.tracked_label", kind: "overlay", name: "追蹤標籤", status: "dedicated_tool", invoke: "prepare_autopilot_motion_track", layer: "overlay",
      summary: "原生 Rust 追蹤＋跟隨標籤。", output: { commandTypes: ["add_motion_track"], carriers: [] }, requires: ["video clip", "initial rect"],
      legacy: { tools: ["prepare_autopilot_motion_track"] }, autopilot: { use: "Labels that follow a moving subject." } }) },
    { manifest: manifest({ id: "scene.geometry_motion", kind: "scene", name: "幾何動態", status: "dedicated_tool", invoke: "prepare_native_geometry_motion", layer: "scene",
      summary: "原生幾何動態場景。", output: { commandTypes: ["add_motion_graphic"], carriers: [] }, legacy: { tools: ["prepare_native_geometry_motion"] },
      autopilot: { use: "Geometric motion beats." } }) },
    { manifest: manifest({ id: "asset.creative_library", kind: "asset", name: "Hao 素材庫", status: "dedicated_tool", invoke: "list_creative_assets", layer: "timeline",
      summary: "授權素材庫（模板、動態、B-roll…），以 creative:// URI 匯入。", output: { commandTypes: ["import_asset", "add_clip"], carriers: [] },
      legacy: { tools: ["list_creative_assets", "add_creative_asset_to_timeline"] }, autopilot: { use: "Licensed library media when the material lacks a shot." } }) },
    { manifest: manifest({ id: "audio.background_music", kind: "audio", name: "自動配樂", status: "dedicated_tool", invoke: "auto_add_music", layer: "timeline",
      summary: "依主題、長度與 BPM 選授權配樂，鋪滿全片、crossfade、自動 ducking。", output: { commandTypes: ["import_asset", "add_track", "add_clip"], carriers: [] },
      legacy: { tools: ["auto_add_music"] }, autopilot: { use: "Background music." } }) },
    { manifest: manifest({ id: "plugin.installed", kind: "plugin", name: "已安裝外掛能力", status: "dedicated_tool", invoke: "list_installed_plugins", layer: "timeline",
      summary: "已安裝外掛的能力（host 在 audit 重新編譯）。", output: { commandTypes: ["plugin_application"], carriers: ["pluginApplications"] },
      legacy: { tools: ["list_installed_plugins", "get_plugin_capability", "compile_plugin_application"] }, autopilot: { use: "Plugin capabilities matching the semantic role, via pluginApplications." } }) },
    { manifest: manifest({ id: "edit_recipe.cinematic", kind: "edit_recipe", name: "鏡頭語言配方", status: "planning_only", invoke: "resolve_cinematic_recipe", layer: "timeline",
      summary: "鏡頭語言規劃（連續、對話、揭曉、教學、蒙太奇…），只回 planning draft。",
      variants: CINEMATIC_LANGUAGE_RECIPES.map(recipe => variant(recipe.id, recipe.name, { family: recipe.family, roles: recipe.beatRoles })),
      output: { commandTypes: [], carriers: ["plan"] }, legacy: { tools: ["resolve_cinematic_recipe", "rank_style_shots"] }, autopilot: { use: "Cut planning before compiling." } }) },
    { manifest: manifest({ id: "scene.mesh_3d", kind: "scene", name: "3D 網格場景", status: AVAILABLE_MESH_3D_TEMPLATES.length ? "dedicated_tool" : "withdrawn", invoke: "prepare_mesh_3d_template", layer: "scene",
      summary: "3D 網格模板（目前沒有開放的模板）。", variants: MESH_3D_TEMPLATES.map(template => variant(template.id, template.name, { use: template.purpose })),
      output: { commandTypes: ["set_mesh_3d_scene"], carriers: [] }, legacy: { tools: ["list_mesh_3d_templates", "prepare_mesh_3d_template"] }, autopilot: { use: "Not available until a template is released." } }) },
  ];
}
