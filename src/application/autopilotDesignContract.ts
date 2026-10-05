import * as z from "zod/v4";
import type { EditorCommand } from "../domain/commands";
import { isScopedMotionRevision } from "./scopedMotionRevision";
import { isScopedPaletteRevision } from "./scopedPaletteRevision";
import { referenceMotionTemplateIds } from "../motion/referenceMotionTemplates";
import { motionSceneStyleSchema } from "../domain/motionSceneStyle";
import { canonicalJson } from "../shared/canonicalJson";
import { referenceMotionRequestedIndexes, type ReferenceMotionPlan } from "./referenceMotionPlan";

export const nativeTemplateDirectionSchema = z.strictObject({
  templateId: z.enum(referenceMotionTemplateIds), graphicCadence: z.enum(["legacy", "brisk"]),
  style: motionSceneStyleSchema,
});

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/i);
export const designRequestSchema = z.strictObject({
  format: z.enum(["longform", "shorts", "reels", "vlog", "podcast", "interview", "ai_short_drama"]),
  domain: z.string().trim().min(1).max(64),
  topic: z.string().trim().min(1).max(160),
  duration: z.number().positive().max(86400),
  styleFamily: z.string().trim().min(1).max(64).optional(),
  originalSourceScope: z.strictObject({ schema: z.literal("editkin.original-motion-design-scope/v1"), sourceSetSha256: sha, usage: z.enum(["standalone", "authored_overlay"]) }).optional(),
  beats: z.array(z.strictObject({
    id, role: z.enum(["first_frame", "chapter", "proof", "comparison", "process", "payoff", "thumbnail", "lower_third", "breath"]),
    energy: z.number().min(0).max(1), subject: z.string().trim().min(1).max(160),
    nativeTemplateDirection: nativeTemplateDirectionSchema.optional(),
  })).min(1).max(64),
}).refine(value => new Set(value.beats.map(beat => beat.id)).size === value.beats.length, "Design beat IDs must be unique")
  .refine(value => !["longform", "podcast", "interview"].includes(value.format)
    || value.beats.every(beat => beat.nativeTemplateDirection === undefined), "Longform extracts local hints; whole template direction is unsupported");

export const designEvidenceSchema = z.strictObject({
  schema: z.literal("editkin.autopilot-design-evidence/v1"),
  request: designRequestSchema,
  projectSha256: sha, sourceSha256: sha, briefSha256: sha,
  decisions: z.array(z.strictObject({
    beatId: id, recipeSha256: sha,
    application: z.string().trim().min(12).max(480),
    commandIndexes: z.array(z.number().int().nonnegative()).min(1).max(512),
  })).min(1).max(64),
});
export type DesignRequest = z.infer<typeof designRequestSchema>;
export type DesignEvidence = z.infer<typeof designEvidenceSchema>;

// Metadata alone cannot demonstrate that a design decision changes a timeline.
const visibleTypes = new Set([
  "add_motion_scene",
  "set_mesh_3d_scene",
  "add_clip", "move_clip", "trim_clip", "split_clip", "delete_clip", "apply_smart_cut",
  "add_caption", "update_caption", "set_caption_style", "add_motion_graphic",
  "update_clip_transform", "update_clip_transform_3d", "set_clip_floating_frame", "set_clip_layout", "set_clip_creative",
  "set_clip_volume", "set_clip_color", "add_native_effect", "update_native_effect",
  "add_keyframe", "update_keyframe", "add_clip_mask", "update_clip_mask", "set_clip_chroma_key",
  "add_motion_track", "set_motion_track_point", "set_clip_mask_track", "set_clip_mask_keyframe",
  "configure_scene_25d", "configure_particle_simulation", "set_asset_color_interpretation",
]);
export function assertDesignDecisionBinding(evidence: DesignEvidence, commands: readonly EditorCommand[], beatIds: readonly string[]) {
  const expected = new Set(beatIds);
  for (const ids of [evidence.request.beats.map(beat => beat.id), evidence.decisions.map(row => row.beatId)]) {
    if (new Set(ids).size !== ids.length || ids.length !== expected.size || ids.some(value => !expected.has(value))) {
      throw new Error("Design recipe must cover every narrative beat exactly once");
    }
  }
  for (const row of evidence.decisions) {
    if (new Set(row.commandIndexes).size !== row.commandIndexes.length ||
      row.commandIndexes.some(index => !commands[index] || !(visibleTypes.has(commands[index].type) || isScopedMotionRevision(commands[index]) || isScopedPaletteRevision(commands[index])))) {
      throw new Error(`Design beat ${row.beatId} must bind actual visual/audio commands, not metadata or nested batches`);
    }
  }
}

/** Called only after the same reference groups have been independently recompiled.
 * The design preference must bind an actual visible command in that one group,
 * rather than earning credit from unrelated captions or caller-written metadata. */
export function assertNativeTemplateDirectionBinding(evidence: DesignEvidence, commands: readonly EditorCommand[], declaration?: ReferenceMotionPlan) {
  const directed = evidence.request.beats.filter(beat => beat.nativeTemplateDirection !== undefined);
  if (!directed.length) return;
  referenceMotionRequestedIndexes(declaration, commands);
  const used = new Set<string>();
  for (const beat of directed) {
    const direction = nativeTemplateDirectionSchema.parse(beat.nativeTemplateDirection);
    const decision = evidence.decisions.find(row => row.beatId === beat.id);
    const groups = declaration?.instances.filter(step => decision?.commandIndexes.length
      && decision.commandIndexes.every(index => step.commandIndexes.includes(index)));
    if (!decision || groups?.length !== 1) throw new Error(`Native direction ${beat.id} must bind one authenticated template group`);
    const group = groups[0], command = commands[group.commandIndexes.at(-1)!];
    if (used.has(group.instanceId)) throw new Error("Native template group cannot earn duplicate beat direction credit");
    used.add(group.instanceId);
    if (command.type !== "upsert_reference_motion_instance" || !decision.commandIndexes.some(index =>
      commands[index]?.type === "add_motion_graphic" || commands[index]?.type === "update_motion_graphic")) {
      throw new Error(`Native direction ${beat.id} requires a visible physical graphic in its compiler group`);
    }
    const input = command.instance.input;
    const actual = { templateId: input.templateId, graphicCadence: input.graphicCadence ?? "legacy", style: input.style };
    if (canonicalJson(actual) !== canonicalJson(direction)) throw new Error(`Native template direction differs from actual authoring for ${beat.id}`);
  }
}
