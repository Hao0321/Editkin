import { randomUUID } from "node:crypto";
import * as z from "zod/v4";
import type { EditorCommand } from "../domain/commands";
import { findClip, findTrack } from "../domain/editGraph";
import { captionStyleFromPreset, findEffectPreset, findLookPreset, findTransitionPreset } from "../creative/corePack";
import { floatingFrameSceneCommands } from "../motion/floatingFrameScenes";
import { MOTION_CLIP_PRESET_IDS, motionClipPresetCommands } from "../motion/motionClipPresets";
import { MOTION_ENERGIES } from "../motion/motionLanguage";
import { prepareNativeReelScene } from "../application/nativeReelScenes";
import { nativeMotionSectionSchema, prepareNativeMotionSequence } from "../application/nativeMotionSequence";
import { motionSceneStyleSchema } from "../domain/motionSceneStyle";
import { SHORT_FORM_TEMPLATES } from "../application/shortFormTemplates";
import { LONG_FORM_TEMPLATES, LONG_FORM_WHITE_CAPTION_STYLE } from "../application/longFormTemplates";
import { readProject } from "./storage";

/**
 * Read-only compilers shared by the dedicated MCP tools and the unified module
 * layer (src/modules). Each returns exactly what its tool returned before the
 * module layer existed, so both entry points produce identical commands.
 */

export const clipMotionPresetRequestSchema = z.object({ projectPath: z.string().min(1), clipId: z.string().min(1), presetId: z.enum(MOTION_CLIP_PRESET_IDS),
  energy: z.enum(MOTION_ENERGIES).optional(),
  focus: z.object({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1) }).strict().optional(),
  direction: z.enum(["from_right", "from_left"]).optional() });

export async function prepareClipMotionPresetFile({ projectPath, clipId, presetId, energy, focus, direction }: z.infer<typeof clipMotionPresetRequestSchema>) {
  const project = await readProject(projectPath);
  const clip = findClip(project, clipId);
  const context = { projectWidth: project.width, projectHeight: project.height, energy, focus,
    direction: direction === "from_left" ? -1 as const : direction === "from_right" ? 1 as const : undefined };
  return { status: "GREEN", clipId, projectRevision: project.revision, presetId,
    commands: motionClipPresetCommands(clip, project.fps, presetId, context), readOnly: true, next: "bind commands to v4 motionTreatment and designEvidence, then audit/apply" };
}

export const floatingFrameSceneRequestSchema = z.object({ projectPath: z.string().min(1), clipId: z.string().min(1), presetId: z.enum(["portrait_duo", "portrait_stack"]),
  sources: z.object({ rearRight: z.object({ assetId: z.string().min(1), sourceStart: z.number().finite().nonnegative() }), front: z.object({ assetId: z.string().min(1), sourceStart: z.number().finite().nonnegative() }) }) });

export async function prepareFloatingFrameSceneFile({ projectPath, clipId, presetId, sources }: z.infer<typeof floatingFrameSceneRequestSchema>) {
  const project = await readProject(projectPath);
  return { status: "GREEN", clipId, projectRevision: project.revision, presetId,
    commands: floatingFrameSceneCommands(project, clipId, presetId, sources), sources, readOnly: true,
    next: "bind commands to v4 motionTreatment and designEvidence, then audit/apply" };
}

export const nativeReelSceneRequestSchema = z.strictObject({ projectPath: z.string().min(1), templateId: z.enum(["editorial_steps", "spatial_gallery"]),
  startFrame: z.number().int().nonnegative(), durationFrames: z.number().int().min(30).max(1800), title: z.string().trim().min(1).max(48), body: z.string().trim().max(64).optional(),
  progress: z.strictObject({ steps: z.number().int().min(1).max(12), activeStep: z.number().int().min(0).max(12) }).optional(),
  clipId: z.string().min(1).optional(), sources: z.strictObject({
    rearRight: z.strictObject({ assetId: z.string().min(1), sourceStart: z.number().finite().nonnegative() }),
    front: z.strictObject({ assetId: z.string().min(1), sourceStart: z.number().finite().nonnegative() }),
  }).optional(), evidenceRefs: z.array(z.string().trim().min(1).max(160)).min(1).max(8), style: motionSceneStyleSchema.optional(),
});

export async function prepareNativeReelSceneFile({ projectPath, ...input }: z.infer<typeof nativeReelSceneRequestSchema>) {
  return prepareNativeReelScene(await readProject(projectPath), input, prefix => `${prefix}-${randomUUID()}`);
}

export const nativeMotionSequenceRequestSchema = z.strictObject({ projectPath: z.string().min(1), sections: z.array(nativeMotionSectionSchema).min(1).max(64) });

export async function prepareNativeMotionSequenceFile({ projectPath, sections }: z.infer<typeof nativeMotionSequenceRequestSchema>) {
  return prepareNativeMotionSequence(await readProject(projectPath), sections, prefix => `${prefix}-${randomUUID()}`);
}

export interface CreativePresetSelection {
  clipId?: string; lookPresetId?: string | null; effectPresetIds?: string[];
  transitionInPresetId?: string | null; transitionOutPresetId?: string | null; textStylePresetId?: string;
}

/** The clip-creative and caption-style commands apply_creative_preset applies, built without touching the project. */
export function creativePresetCommands({ clipId, lookPresetId, effectPresetIds, transitionInPresetId, transitionOutPresetId, textStylePresetId }: CreativePresetSelection): EditorCommand[] {
  const commands: EditorCommand[] = [];
  if (lookPresetId) findLookPreset(lookPresetId);
  for (const id of effectPresetIds ?? []) findEffectPreset(id);
  const transitionIn = transitionInPresetId ? findTransitionPreset(transitionInPresetId) : undefined;
  const transitionOut = transitionOutPresetId ? findTransitionPreset(transitionOutPresetId) : undefined;
  const hasClipPatch = lookPresetId !== undefined || effectPresetIds !== undefined || transitionInPresetId !== undefined || transitionOutPresetId !== undefined;
  if (hasClipPatch) {
    if (!clipId) throw new Error("套用片段 Creative preset 時必須提供 clipId");
    commands.push({ type: "set_clip_creative", clipId, patch: {
      lookPresetId,
      effectPresetIds,
      transitionIn: transitionInPresetId === null ? null : transitionIn ? { presetId: transitionIn.id, duration: transitionIn.defaultDuration } : undefined,
      transitionOut: transitionOutPresetId === null ? null : transitionOut ? { presetId: transitionOut.id, duration: transitionOut.defaultDuration } : undefined,
    } });
  }
  if (textStylePresetId) commands.push({ type: "set_caption_style", patch: captionStyleFromPreset(textStylePresetId) });
  return commands;
}

export const templatePackageRequestSchema = z.object({ projectPath: z.string(), format: z.enum(["short", "long"]), templateId: z.string().min(1),
  clipIds: z.array(z.string().min(1)).min(1).max(64) });

export async function prepareAutopilotTemplatePackageFile({ projectPath, format, templateId, clipIds }: z.infer<typeof templatePackageRequestSchema>) {
  if (new Set(clipIds).size !== clipIds.length) throw new Error("模板 clipIds 不可重複");
  const template = format === "short"
    ? SHORT_FORM_TEMPLATES.find(item => item.id === templateId)
    : LONG_FORM_TEMPLATES.find(item => item.id === templateId);
  if (!template) throw new Error(`未知 ${format} 模板：${templateId}`);
  findLookPreset(template.lookPresetId);
  const project = await readProject(projectPath);
  for (const clipId of clipIds) {
    const clip = findClip(project, clipId);
    const track = findTrack(project, clip.trackId);
    if (track.kind !== "video") throw new Error(`模板只能用於畫面軌：${clipId}`);
  }
  const commands: EditorCommand[] = clipIds.map(clipId => ({ type: "set_clip_creative", clipId,
    patch: { lookPresetId: template.lookPresetId } }));
  if (format === "long") commands.push({ type: "set_caption_style", patch: LONG_FORM_WHITE_CAPTION_STYLE });
  return { status: "REVIEW_REQUIRED", projectId: project.id, projectRevision: project.revision,
    templateId, format, commands, suggestions: { effectPresetIds: template.effectPresetIds,
      transitionPresetId: "transitionPresetId" in template ? template.transitionPresetId : template.introTransitionPresetId,
      captionPresetId: "captionPresetId" in template ? template.captionPresetId : LONG_FORM_WHITE_CAPTION_STYLE.presetId,
      cinematicRecipeId: template.cinematicRecipeId,
      ...("motionGraphicPresetId" in template && template.motionGraphicPresetId ? { motionGraphicPresetId: template.motionGraphicPresetId } : {}),
      ...("motionClipPresetId" in template && template.motionClipPresetId ? { motionClipPresetId: template.motionClipPresetId } : {}),
      ...("floatingFrameScenePresetId" in template && template.floatingFrameScenePresetId ? { floatingFrameScenePresetId: template.floatingFrameScenePresetId } : {}) },
    instruction: "Only the Look and long-form caption style are precompiled. Add motivated effects/transitions and exact Motion v2 graphics after material and design evidence; bind every command to motionTreatment and audit/apply once." };
}
