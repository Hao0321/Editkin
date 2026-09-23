import * as z from "zod/v4";
import type { EditorCommand } from "../domain/commands";
import { EDITKIN_MOTION } from "../motion/identity";

export const MOTION_TREATMENT_FAMILIES = ["title", "subtitles", "cards", "hud", "motion", "tracking_masks", "vfx", "transitions_camera", "color", "sound"] as const;
export type MotionTreatmentFamily = typeof MOTION_TREATMENT_FAMILIES[number];
export const motionTreatmentSchema = z.strictObject({
  schema: z.literal("editkin.motion-treatment/v1"),
  decisions: z.array(z.strictObject({
    family: z.enum(MOTION_TREATMENT_FAMILIES), action: z.enum(["use", "omit"]),
    reason: z.string().trim().min(1).max(320),
    beatIds: z.array(z.string().min(1).max(80)).max(16),
    commandIndexes: z.array(z.number().int().nonnegative()).max(100),
  })).length(MOTION_TREATMENT_FAMILIES.length),
}).superRefine((value, context) => {
  if (new Set(value.decisions.map(row => row.family)).size !== MOTION_TREATMENT_FAMILIES.length) {
    context.addIssue({ code: "custom", message: "Motion treatment 必須逐一考慮全部十個家族，不能重複或漏項" });
  }
  value.decisions.forEach((row, index) => {
    if (new Set(row.commandIndexes).size !== row.commandIndexes.length || new Set(row.beatIds).size !== row.beatIds.length) {
      context.addIssue({ code: "custom", path: ["decisions", index], message: "Motion treatment 不可重複計算命令或節拍" });
    }
    if (row.action === "use" && (!row.commandIndexes.length || !row.beatIds.length)) {
      context.addIssue({ code: "custom", path: ["decisions", index], message: "選用效果必須連到實際命令與敘事節拍" });
    }
    if (row.action === "omit" && row.commandIndexes.length) {
      context.addIssue({ code: "custom", path: ["decisions", index], message: "不使用的家族不可暗中套用命令" });
    }
  });
});
export type MotionTreatment = z.infer<typeof motionTreatmentSchema>;

/** Command authoring coverage, not a rendered-pixel/semantic-quality assertion. */
export function motionCommandFamilies(command: EditorCommand): MotionTreatmentFamily[] {
  if (command.type === "batch") return [...new Set(command.commands.flatMap(motionCommandFamilies))];
  const families = new Set<MotionTreatmentFamily>();
  if (command.type === "add_motion_graphic") {
    const graphic = command.graphic;
    families.add(graphic.kind === "title" ? "title" : graphic.kind === "card" ? "cards" : "hud");
    if (graphic.schema === "hao.motion-composition/v2") families.add("motion");
    if (graphic.trackId) families.add("tracking_masks");
  }
  if (["add_caption", "update_caption", "set_caption_style"].includes(command.type)) families.add("subtitles");
  if (["add_motion_track", "set_motion_track_point", "add_clip_mask", "update_clip_mask", "set_clip_mask_track", "set_clip_mask_keyframe", "freeze_clip_mask_range", "set_clip_chroma_key"].includes(command.type)) families.add("tracking_masks");
  if (["configure_scene_25d", "set_scene_25d_settings", "configure_particle_simulation", "set_particle_simulation_settings", "add_native_effect", "update_native_effect"].includes(command.type)) families.add("vfx");
  if (["update_clip_transform", "update_clip_transform_3d", "add_keyframe", "update_keyframe", "set_clip_expression", "set_clip_layout"].includes(command.type)) families.add("transitions_camera");
  if (["set_clip_color", "set_asset_color_interpretation", "set_project_color_management"].includes(command.type)) families.add("color");
  if (command.type === "set_clip_volume" || (command.type === "add_track" && command.track.kind === "audio")) families.add("sound");
  if (command.type === "add_clip") {
    // Every clip carries audio gain; this does not claim the source has audible sound.
    if (command.clip.volume !== 1) families.add("sound");
  }
  if (command.type === "set_clip_creative") {
    if (command.patch.lookPresetId !== undefined) families.add("color");
    if (command.patch.effectPresetIds !== undefined) families.add("vfx");
    if (command.patch.transitionIn !== undefined || command.patch.transitionOut !== undefined) families.add("transitions_camera");
  }
  return [...families];
}

export function assertMotionTreatmentBinding(treatment: MotionTreatment | undefined, commands: readonly EditorCommand[], beatIds: readonly string[]): void {
  if (!treatment) return; // Read-compatible older v4 plans report REVIEW_REQUIRED below.
  motionTreatmentSchema.parse(treatment);
  const knownBeats = new Set(beatIds);
  const observed = commands.map(motionCommandFamilies);
  for (const row of treatment.decisions) {
    if (row.beatIds.some(id => !knownBeats.has(id))) throw new Error(`Motion treatment ${row.family} 引用不存在的敘事節拍`);
    if (row.commandIndexes.some(index => !observed[index]?.includes(row.family))) throw new Error(`Motion treatment ${row.family} 的命令綁定錯誤`);
    const actualIndexes = observed.flatMap((families, index) => families.includes(row.family) ? [index] : []);
    if (actualIndexes.some(index => !row.commandIndexes.includes(index))) throw new Error(`Motion treatment ${row.family} 有未交代用途的命令`);
  }
}

export function summarizeMotionTreatment(treatment: MotionTreatment | undefined, commands: readonly EditorCommand[]) {
  const observed = commands.map(motionCommandFamilies);
  return {
    system: EDITKIN_MOTION.id,
    state: treatment ? "DECLARED_COMMAND_COVERAGE" : "REVIEW_REQUIRED",
    families: MOTION_TREATMENT_FAMILIES.map(family => {
      const declared = treatment?.decisions.find(row => row.family === family);
      return { family, action: declared?.action ?? "unreviewed", reason: declared?.reason,
        commandIndexes: observed.flatMap((families, index) => families.includes(family) ? [index] : []) };
    }),
    boundary: "Every family is considered; effect count earns no quality points. Command coverage is not pixel execution, appropriate aesthetics, human review, or competitor parity.",
  };
}
