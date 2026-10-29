import * as z from "zod/v4";
import { resolveMotionLibraryCacheRootV1 } from "../application/motionLibraryClipsV1";
import { creativeAssetIdFromUri, resolveCreativeLibraryAsset } from "../application/creativeLibrary";
import { applyCommand } from "../domain/commands";
import type { EditorCommand } from "../domain/commandTypes";
import { generatedRemovalCommandsV1 } from "../application/generatedRenderAssetsV1";
import { motionLibraryClipSecondsV1, motionLibraryFrameRateV1 } from "../domain/motionLibraryV1";
import { styleImageSlotValueV1Schema, STYLE_JOB_PALETTE_ROLES_V1, type StyleSlotValuesV1 } from "../domain/styleJobFieldsV1";
import type { EditProject, MediaAsset, TimelineClip } from "../domain/types";
import { readProject, resolveProjectPath, resolveWorkspaceMediaPath, workspaceRoot } from "../mcp/storage";
import { creativePackRoot, personalMusicRoot, personalVisualRoot } from "../mcp/toolRuntime";
import { StyleTemplateClipRefusalV1, styleTemplateFormatOf } from "../styleTemplates/slots/compileClip";
import {
  assertStyleTemplateProjectFilesV1, renderStyleTemplateClipV1, styleTemplateAddClipCommandV1, styleTemplateUpdateClipCommandV1, type StyleTemplateClipRenderResultV1,
} from "../styleTemplates/slots/renderTemplateClip";
import { styleSlotTemplatesV1, type StyleSlotTemplateV1 } from "../styleTemplates/slots/slotCatalog";
import type { ModuleCall, ModuleRuntimeAdapterV2 } from "./moduleTypes";

/**
 * graphic.style_template (Hao 2026-10-23: 「這幾種都做成 Editkin 的模板，讓 VA 也可以直接調用！！要都能改字改色改圖！！！」):
 * a style template placed as one editable clip whose slots — text, palette colours, pictures — VA fills and later changes.
 *
 * prepare renders the clip inside prepare (progress and cancel through the request), verifies the rendered file, applies
 * the command to an in-memory copy (the same domain validation apply runs) and returns flat commands. It never mutates
 * the project. With `updateClipId` it re-renders an existing template clip with changed slots (update_style_template_clip,
 * one Undo).
 *
 * Variant choice: without variantId the module auto-picks, and auto-pick only ever takes a template whose art Claude has
 * certified and whose components render today: S4 and S7 (mesh3d engine passes composited with SVG type) and S5 (a
 * composited SVG collage), certified by Hao on 2026-10-29. A pending template (S1) can be used only by naming it (the
 * result says "uncertified"). A stub (slots declared ahead of the art) is refused with STYLE_TEMPLATE_NOT_IMPLEMENTED.
 *
 * M10 (never invent text): every text slot VA fills comes from the material and names its evidence (`textEvidence`); a
 * call without text is refused with STYLE_TEMPLATE_TEXT_SLOTS_REQUIRED before anything is read or rendered, a text slot
 * without evidence with STYLE_TEMPLATE_TEXT_EVIDENCE_REQUIRED. There is no sample-text fallback. The carrier lists every
 * shown string with its evidence for the seal gate.
 */

export const STYLE_TEMPLATE_MODULE_ID_V1 = "graphic.style_template" as const;

export class StyleTemplateModuleRefusalV1 extends Error {
  constructor(readonly code: "STYLE_TEMPLATE_TEXT_SLOTS_REQUIRED" | "STYLE_TEMPLATE_TEXT_EVIDENCE_REQUIRED" | "STYLE_TEMPLATE_NO_CERTIFIED_VARIANT" | "STYLE_TEMPLATE_NOT_IMPLEMENTED"
    | "STYLE_TEMPLATE_PLACEMENT_INVALID" | "STYLE_TEMPLATE_UPDATE_TARGET_INVALID",
    detail: string) { super(`${code}: ${detail}`); this.name = "StyleTemplateModuleRefusalV1"; }
}

// ---------------------------------------------------------------------------
// Variants (discovery): every slot template with its slots, component and art status
// ---------------------------------------------------------------------------

export interface StyleTemplateModuleVariantV1 {
  id: string; name: string; family: string; roles: string[]; formats: Array<"portrait" | "landscape" | "square">; intensity: string; use: string;
  artStatus: "certified" | "pending"; implemented: boolean;
  slots: {
    text: Array<{ id: string; label: Record<string, string>; maxLength: number; role: string; required: boolean; consumers: string[] }>;
    color: Array<{ role: string; label: Record<string, string>; default: string | null; consumers: string[] }>;
    image: Array<{ id: string; label: Record<string, string>; aspect: Record<string, number>; fit: string; focal: number[]; placeholder: string | null; required: boolean; consumers: string[] }>;
  };
  clip: { component: string; renderer: string; parts: string[]; output: string; seconds: { default: number; min: number; max: number } };
}

const consumers = (bind: ReadonlyArray<{ component: string; target: string; as: string }>) => bind.map(entry => `${entry.component}.${entry.target}:${entry.as}`);

export function styleTemplateModuleVariantV1(template: StyleSlotTemplateV1): StyleTemplateModuleVariantV1 {
  const notes = [
    `text slots (M10: the creator's own words with evidence, never sample text): ${template.slots.text.map(slot => `${slot.id}${slot.required ? "*" : ""} ≤${slot.maxLength}`).join(", ")}`,
    `colours: ${template.slots.color.map(slot => slot.role).join(", ") || "none"}; pictures: ${template.slots.image.map(slot => `${slot.id} (${slot.fit})`).join(", ") || "none"}`,
    ...(template.stub ? [`slots declared ahead of the art (${template.art?.engine ?? template.clip.component.renderer}); not implemented yet, refused by prepare`] : []),
    ...(template.artStatus === "certified" ? [] : ["art pending Claude's certification: never auto-picked; name it to use it"]),
  ];
  return {
    id: template.id, name: template.names.zh, family: template.clip.component.renderer, roles: [...template.videoTypes], formats: [...template.clip.formats],
    intensity: "medium", use: notes.join("；"), artStatus: template.artStatus, implemented: template.implemented,
    slots: {
      text: template.slots.text.map(slot => ({ id: slot.id, label: { ...slot.label }, maxLength: slot.maxLength, role: slot.role, required: slot.required, consumers: consumers(slot.bind) })),
      color: template.slots.color.map(slot => ({ role: slot.role, label: { ...slot.label }, default: (template.palette as Record<string, string | undefined>)[slot.role] ?? null, consumers: consumers(slot.bind) })),
      image: template.slots.image.map(slot => ({ id: slot.id, label: { ...slot.label }, aspect: { ...slot.aspect }, fit: slot.fit, focal: [...slot.focal], placeholder: slot.placeholder ?? null,
        required: slot.required, consumers: consumers(slot.bind) })),
    },
    clip: { component: template.clip.component.id, renderer: template.clip.component.renderer, parts: (template.clip.parts ?? []).map(part => part.id),
      output: template.clip.output, seconds: { ...template.clip.seconds } },
  };
}

/** The variant snapshot behind the module manifest (styleTemplateModuleVariantsV1.json, pinned equal by test). */
export function styleTemplateModuleVariantSnapshotV1() {
  return { schema: "editkin.style-template-module-variants/v1" as const, variants: [...styleSlotTemplatesV1().values()].map(styleTemplateModuleVariantV1) };
}

/** Auto-pick: certified art, implemented components, offered in the frame format; filtered by video type. */
export function styleTemplateAutoPickCandidatesV1(filter: { videoType?: string; format?: string } = {}): StyleSlotTemplateV1[] {
  return [...styleSlotTemplatesV1().values()].filter(template => template.artStatus === "certified" && template.implemented && !template.stub
    && (filter.videoType === undefined || template.videoTypes.includes(filter.videoType))
    && (filter.format === undefined || (template.clip.formats as readonly string[]).includes(filter.format)));
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const id = z.string().min(1).max(160).refine(value => value.trim() === value && !/[\u0000\r\n]/.test(value));
const slotKey = z.string().regex(/^[a-z][a-zA-Z0-9]{0,31}$/);

export const styleTemplateModuleInputSchemaV1 = z.strictObject({
  /** Where the clip starts (frames). Required unless updateClipId re-renders an existing clip. */
  startFrame: z.number().int().min(0).optional(),
  /** Default: the template clip's default length (update: the clip's current length). */
  durationFrames: z.number().int().min(1).optional(),
  trackId: id.optional(), clipId: id.optional(),
  /** Re-render this existing template clip with changed slots (one Undo). Slots not passed keep their current values. */
  updateClipId: id.optional(),
  /** Remove this template clip, and its render when nothing else uses it (delete_clip + delete_asset, one Undo). Takes no other input. */
  removeClipId: id.optional(),
  /** Required to add or update (M10): the words to show, per text slot id, from the material. */
  text: z.record(slotKey, z.string().max(400)).optional(),
  /** Required for every text slot passed: where the words come from (transcript cue, on-screen text, the creator's script). */
  textEvidence: z.record(slotKey, z.string().min(1).max(200)).optional(),
  /** Palette-role overrides (#RRGGBB); derived colours follow. */
  colors: z.partialRecord(z.enum(STYLE_JOB_PALETTE_ROLES_V1), hex).optional(),
  /** Pictures per image slot: a project image, or a still of a project video at a source time; fit and focal point optional. */
  images: z.record(slotKey, styleImageSlotValueV1Schema).optional(),
  /** Auto-pick filter (ignored when variantId names the template). */
  videoType: z.string().min(1).max(60).optional(),
});
export type StyleTemplateModuleInputV1 = z.infer<typeof styleTemplateModuleInputSchemaV1>;

// ---------------------------------------------------------------------------
// Prepare
// ---------------------------------------------------------------------------

function choose(variantId: string | undefined, filter: { videoType?: string; format: string }) {
  const templates = styleSlotTemplatesV1();
  if (variantId !== undefined) {
    const template = templates.get(variantId);
    if (!template) throw new StyleTemplateClipRefusalV1("STYLE_TEMPLATE_UNKNOWN", variantId);
    if (!template.implemented) throw new StyleTemplateModuleRefusalV1("STYLE_TEMPLATE_NOT_IMPLEMENTED", `${variantId}: ${template.clip.component.id} (${template.clip.component.renderer}) is not built yet`);
    return { template, autoPicked: false, candidates: [] as string[] };
  }
  const candidates = styleTemplateAutoPickCandidatesV1(filter);
  if (!candidates.length) throw new StyleTemplateModuleRefusalV1("STYLE_TEMPLATE_NO_CERTIFIED_VARIANT", `no certified, implemented template matches ${JSON.stringify(filter)}; name one with variantId`);
  return { template: candidates[0], autoPicked: true, candidates: candidates.slice(0, 12).map(template => template.id) };
}

async function sourcePath(asset: MediaAsset): Promise<string> {
  const creative = creativeAssetIdFromUri(asset.uri);
  return creative ? (await resolveCreativeLibraryAsset(creativePackRoot(), creative, personalMusicRoot(), personalVisualRoot())).absolutePath : resolveWorkspaceMediaPath(asset.uri);
}

const uniqueClipId = (project: EditProject, base: string) => {
  const stem = base.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 120);
  const taken = (candidate: string) => project.tracks.some(track => track.clips.some(clip => clip.id === candidate));
  for (let index = 0; ; index += 1) { const candidate = index ? `${stem}-${index + 1}` : stem; if (!taken(candidate)) return candidate; }
};

function carrier(rendered: StyleTemplateClipRenderResultV1, template: StyleSlotTemplateV1, choice: ReturnType<typeof choose>, evidence: Record<string, string>) {
  const field = rendered.field;
  return {
    schema: "editkin.style-template-invocation/v1", templateId: template.id, revision: template.revision, artStatus: template.artStatus === "certified" ? "certified" : "uncertified",
    autoPicked: choice.autoPicked, ...(choice.autoPicked ? { candidates: choice.candidates } : {}),
    component: field.component, key: field.key, slotsSha256: field.slotsSha256, cacheHit: rendered.cacheHit, frameCount: field.job.frameCount, fps: field.job.fps,
    output: rendered.path, slots: field.slots,
    // M10 seal gate: every on-screen string with its evidence.
    editorial: Object.entries(field.slots.text).map(([slot, text]) => ({ slot, text, evidence: evidence[slot] ?? "(kept from the clip)" })),
    rights: { license: rendered.asset.license ?? null, redistributable: rendered.asset.redistributable ?? null, sources: rendered.sourceAssets.map(asset => asset.id) },
  };
}

/** Removal: the clip, and its render when nothing else uses it, in one batch (one Undo). Slot images the template imported stay. */
async function removeStyleTemplateClipV1(call: ModuleCall) {
  const input = styleTemplateModuleInputSchemaV1.parse(call.inputs);
  if (Object.keys(call.inputs as object).some(key => key !== "removeClipId")) throw new StyleTemplateModuleRefusalV1("STYLE_TEMPLATE_PLACEMENT_INVALID", "removeClipId takes no other inputs");
  const project = await readProject(call.projectPath);
  const clip = project.tracks.flatMap(track => track.clips).find(candidate => candidate.id === input.removeClipId);
  if (!clip?.styleJob) throw new StyleTemplateModuleRefusalV1("STYLE_TEMPLATE_UPDATE_TARGET_INVALID", `${input.removeClipId} is not a style template clip`);
  const commands = generatedRemovalCommandsV1(project, { type: "delete_clip", clipId: clip.id }, [clip.assetId]);
  applyCommand(project, { type: "batch", commands: structuredClone(commands) });
  return { status: "PREPARED", projectRevision: project.revision, commands, styleTemplate: { schema: "editkin.style-template-invocation/v1", action: "remove",
    templateId: clip.styleJob.template.id, clipId: clip.id, removedAssets: commands.flatMap(command => command.type === "delete_asset" ? [command.assetId] : []) } };
}

export async function prepareStyleTemplateModuleV1(call: ModuleCall) {
  const raw = call.inputs as { text?: unknown; textEvidence?: unknown; removeClipId?: unknown } | undefined;
  if (raw && typeof raw === "object" && raw.removeClipId !== undefined) return removeStyleTemplateClipV1(call);
  // M10: refused before anything is read or rendered; a template's sample text is never content.
  if (!raw || typeof raw !== "object" || !raw.text || typeof raw.text !== "object" || !Object.values(raw.text as object).some(value => typeof value === "string" && value.trim())) {
    throw new StyleTemplateModuleRefusalV1("STYLE_TEMPLATE_TEXT_SLOTS_REQUIRED", "pass the words to show per text slot (from the material); the template has no sample text");
  }
  const evidence = raw.textEvidence && typeof raw.textEvidence === "object" ? raw.textEvidence as Record<string, unknown> : {};
  const unproven = Object.keys(raw.text as object).filter(slot => typeof evidence[slot] !== "string" || !(evidence[slot] as string).trim());
  if (unproven.length) throw new StyleTemplateModuleRefusalV1("STYLE_TEMPLATE_TEXT_EVIDENCE_REQUIRED", `textEvidence missing for ${unproven.join(", ")}`);
  const input = styleTemplateModuleInputSchemaV1.parse(call.inputs);
  const project = await readProject(call.projectPath);
  const format = styleTemplateFormatOf(project.width, project.height);
  const target: TimelineClip | undefined = input.updateClipId === undefined ? undefined
    : project.tracks.flatMap(track => track.clips).find(clip => clip.id === input.updateClipId);
  if (input.updateClipId !== undefined && !target?.styleJob) throw new StyleTemplateModuleRefusalV1("STYLE_TEMPLATE_UPDATE_TARGET_INVALID", `${input.updateClipId} is not a style template clip`);
  if (target && call.variantId !== undefined && call.variantId !== target.styleJob!.template.id) {
    throw new StyleTemplateModuleRefusalV1("STYLE_TEMPLATE_UPDATE_TARGET_INVALID", `${target.id} is a ${target.styleJob!.template.id} clip`);
  }
  if (!target && input.startFrame === undefined) throw new StyleTemplateModuleRefusalV1("STYLE_TEMPLATE_PLACEMENT_INVALID", "startFrame is required to add a clip");
  const choice = choose(target ? target.styleJob!.template.id : call.variantId, { videoType: input.videoType, format });
  const template = choice.template;
  const base: StyleSlotValuesV1 = target ? structuredClone(target.styleJob!.slots) : { text: {}, color: {}, image: {} };
  const slots = { text: { ...base.text, ...input.text }, color: { ...base.color, ...(input.colors ?? {}) }, image: { ...base.image, ...(input.images ?? {}) } };
  const rate = motionLibraryFrameRateV1(project.fps);
  const durationSeconds = input.durationFrames !== undefined ? motionLibraryClipSecondsV1(input.durationFrames, rate)
    : target ? motionLibraryClipSecondsV1(target.styleJob!.job.frameCount, rate) : undefined;
  const cacheRoot = await resolveMotionLibraryCacheRootV1({ projectPath: await resolveProjectPath(call.projectPath), workspaceRoot: workspaceRoot() });
  const tools = { ffmpegPath: call.environment.HAO_FFMPEG_PATH || call.environment.EDITKIN_FFMPEG_PATH || undefined,
    ffprobePath: call.environment.HAO_FFPROBE_PATH || call.environment.EDITKIN_FFPROBE_PATH || undefined };
  const rendered = await renderStyleTemplateClipV1({ templateId: template.id, slots, project, durationSeconds, cacheRoot, signal: call.signal,
    resolveAssetPath: async uri => sourcePath(project.assets.find(asset => asset.uri === uri)!),
    ...(tools.ffmpegPath && tools.ffprobePath ? tools : {}),
    onProgress: progress => call.onProgress?.({ progress: Math.round(progress.fraction * 1000) / 10, total: 100, message: `${template.id} ${progress.phase}` }) });
  const commands: EditorCommand[] = target
    ? [styleTemplateUpdateClipCommandV1(project, target, rendered)]
    : [styleTemplateAddClipCommandV1(project, rendered, { clipId: input.clipId ?? uniqueClipId(project, `styletpl-${template.id}-${input.startFrame}-${rendered.field.key.slice(0, 8)}`),
      trackId: input.trackId, startFrame: input.startFrame! })];
  // The same domain validation apply runs, on an in-memory copy, plus the pre-dispatch file check.
  const candidate = applyCommand(project, { type: "batch", commands: structuredClone(commands) });
  await assertStyleTemplateProjectFilesV1(candidate, cacheRoot);
  return { status: "PREPARED", projectRevision: project.revision, commands, styleTemplate: carrier(rendered, template, choice, input.textEvidence ?? {}) };
}

export const styleTemplateModuleAdapterV1: ModuleRuntimeAdapterV2 = { inputSchema: styleTemplateModuleInputSchemaV1, prepare: prepareStyleTemplateModuleV1 };
