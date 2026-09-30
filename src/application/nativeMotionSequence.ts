import * as z from "zod/v4";
import type { EditProject, MotionGraphic } from "../domain/types";
import { applyCommand } from "../domain/commands";
import type { EditorCommand } from "../domain/commandTypes";
import { projectDuration } from "../domain/editGraph";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { createMotionGraphic } from "../motion/composition";
import { motionGraphicV2LayoutReceipt } from "../motion/compositionV2";
import { motionSceneStyleSchema, validateMotionSceneStyle } from "../domain/motionSceneStyle";
import { projectSchema, type MotionPresetVariant } from "../domain/schema";
import type { EditorialPlan } from "./editorialPlan";
import { motionPresetSeedSha256 } from "./motionPresetVariant";

const region = z.strictObject({ x: z.number().finite().min(.03).max(.92), y: z.number().finite().min(.03).max(.84),
  width: z.number().finite().min(.03).max(.6), height: z.number().finite().min(.02).max(.8) });
export const nativeMotionSectionSchema = z.strictObject({
  id: z.string().trim().min(1).max(80), role: z.enum(["hook", "chapter", "proof", "comparison", "recap"]),
  treatment: z.enum(["context_label", "focus_hint"]),
  startFrame: z.number().int().nonnegative(), durationFrames: z.number().int().min(30).max(1800),
  title: z.string().trim().min(1).max(36), clipId: z.string().min(1),
  labelBox: z.strictObject({ x: z.number().finite().min(.03).max(.9), y: z.number().finite().min(.03).max(.8), width: z.number().finite().min(.08).max(.3) }),
  focusRegion: region.optional(), style: motionSceneStyleSchema.optional(),
  evidenceRefs: z.array(z.string().trim().min(1).max(160)).min(1).max(8),
}).superRefine((section, context) => {
  if (section.labelBox.x + section.labelBox.width > .97) context.addIssue({ code: "custom", message: "短文字需要位於素材中已觀察的安全空間" });
  if ((section.treatment === "focus_hint") !== Boolean(section.focusRegion)) context.addIssue({ code: "custom", message: "焦點提示需要明確觀察區域；普通文字不能夾帶未知焦點" });
  if (section.focusRegion && (section.focusRegion.x + section.focusRegion.width > .97 || section.focusRegion.y + section.focusRegion.height > .9)) context.addIssue({ code: "custom", message: "焦點區域超出畫面安全範圍" });
});
export type NativeMotionSection = z.infer<typeof nativeMotionSectionSchema>;

/** Extract brief emphasis over continuous footage. Never turn a long film into slide scenes. */
export function prepareNativeMotionSequence(project: EditProject, raw: readonly NativeMotionSection[], idFactory: (prefix: string) => string) {
  if (project.width <= project.height) throw new Error("長片動態規劃需要橫式畫布");
  const sections = z.array(nativeMotionSectionSchema).min(1).max(64).parse(raw);
  const totalFrames = Math.round(projectDuration(project) * project.fps), quietFrames = Math.ceil(project.fps * 4);
  let cursor = 0, animatedFrames = 0;
  const ids = new Set<string>();
  const holds: { startFrame: number; endFrame: number; treatment: "clean_hold" }[] = [];
  const ordered = [...sections].sort((a, b) => a.startFrame - b.startFrame);
  for (const section of ordered) {
    if (ids.has(section.id)) throw new Error("段落需要唯一 ID 與實際敘事用途");
    ids.add(section.id);
    if (section.durationFrames > Math.round(project.fps * 4)) throw new Error("長片提示最多 4 秒；完整說明留在原始畫面與旁白");
    if (section.startFrame < cursor || (cursor > 0 && section.startFrame - cursor < quietFrames)) throw new Error("提示重疊或缺少至少 4 秒安靜觀看區間");
    if (section.startFrame > cursor) holds.push({ startFrame: cursor, endFrame: section.startFrame, treatment: "clean_hold" });
    cursor = section.startFrame + section.durationFrames; animatedFrames += section.durationFrames;
  }
  if (cursor > totalFrames || animatedFrames > totalFrames * .25) throw new Error("提示超出長片範圍或超過四分之一；保留乾淨素材觀看");
  if (cursor < totalFrames) holds.push({ startFrame: cursor, endFrame: totalFrames, treatment: "clean_hold" });
  const unit = Math.min(project.width, project.height) / 1080;
  const scenes = ordered.map(section => {
    const clip = project.tracks.filter(track => track.kind === "video" && !track.locked && !track.muted).flatMap(track => track.clips).find(clip => clip.id === section.clipId);
    const endFrame = section.startFrame + section.durationFrames;
    if (!clip || Math.round(clip.timelineStart * project.fps) > section.startFrame || Math.round((clip.timelineStart + clip.duration) * project.fps) < endFrame) throw new Error(`提示 ${section.id} 需要覆蓋有效範圍的明確來源影片`);
    const style = section.style ? validateMotionSceneStyle(section.style) : undefined;
    const speed = style?.animationSpeed ?? 1;
    const fontSize = Math.max(8, 36 * unit);
    const motionV2 = { sequence: { unit: "all" as const, order: "forward" as const, exitOrder: "forward" as const, staggerFrames: 0 },
      entrance: { durationFrames: Math.max(1, Math.round(10 / speed)), offsetXPixels: 0, offsetYPixels: 6 * unit, scale: 1, opacity: 0, easing: { type: "ease_out" as const } },
      exit: { durationFrames: Math.max(1, Math.round(8 / speed)), offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 0, easing: { type: "ease_in" as const } } };
    const bindings: { graphic: MotionGraphic; presetId: string; overrides: MotionPresetVariant["overrides"] }[] = [];
    const add = (presetId: string, text: string, overrides: MotionPresetVariant["overrides"]) => {
      const preset = findMotionGraphicPreset(presetId);
      const graphic: MotionGraphic = { ...createMotionGraphic(idFactory("longform-cue"), "tag", text, section.startFrame / project.fps,
        section.durationFrames / project.fps, undefined, preset.seed), ...structuredClone(overrides) };
      bindings.push({ graphic, presetId, overrides });
      return motionGraphicV2LayoutReceipt(project, graphic);
    };
    const layoutV2 = { safeArea: { top: .03, right: .03, bottom: .1, left: .03 }, maxLines: 1,
      minFontSize: Math.max(8, 30 * unit), lineGap: 0, align: "left" as const, widthMode: "fit_content" as const };
    const textLayout = add("reel_editorial_step", section.title, { name: "長片短文字提示", ...section.labelBox,
      fontSize, fontFamily: style?.typography.bodyFamily ?? "Noto Sans TC", fontWeight: 650, letterSpacing: 0,
      textColor: style?.palette.text ?? "#F5F6F8", backgroundColor: "#00000000", accentColor: "#00000000",
      outlineWidth: 1 * unit, shadowDepth: 1 * unit, cornerRadius: 0, motionV2, layoutV2 });
    if (textLayout.box.width * textLayout.box.height > project.width * project.height * .025) throw new Error("提示文字佔用過多畫面；縮短文字，保留主要素材");
    const focus = section.focusRegion;
    if (focus) {
      const a = textLayout.box, b = { x: focus.x * project.width, y: focus.y * project.height, width: focus.width * project.width, height: focus.height * project.height };
      if (a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y) throw new Error("提示文字遮擋焦點，請依真實畫面移到留白處");
    }
    const line = focus ? { x: focus.x, y: focus.y + focus.height, width: focus.width }
      : { x: textLayout.box.x / project.width, y: (textLayout.box.y + textLayout.box.height + 6 * unit) / project.height, width: Math.min(.12, textLayout.box.width / project.width) };
    const ruleLayout = add("reel_rule_reveal", "", { name: focus ? "長片焦點短線" : "長片文字短線", ...line,
      backgroundColor: "#00000000", accentColor: style?.palette.accent ?? "#86B8F0", outlineWidth: 0,
      cornerRadius: 2 * unit, fontSize: 8, shadowDepth: 0, motionV2,
      layoutV2: { ...layoutV2, minFontSize: 8, widthMode: "fixed" },
      vectorV2: { schema: "editkin.motion-vector/v1", kind: "rule", heightPixels: Math.max(1, 2 * unit), revealFrames: Math.max(1, Math.round(10 / speed)) } });
    const commands: EditorCommand[] = bindings.map(({ graphic }) => ({ type: "add_motion_graphic", graphic }));
    const editorialGraphics: EditorialPlan["graphics"] = bindings.map(({ graphic, presetId, overrides }) => ({ id: graphic.id, presetId,
      range: { startFrame: section.startFrame, endFrame }, kind: graphic.vectorV2 ? "native_shape" : "context_card",
      purpose: "context", message: graphic.text, evidenceRefs: [...section.evidenceRefs],
      presetVariant: { schema: "editkin.motion-preset-variant/v1", basePresetSha256: motionPresetSeedSha256(findMotionGraphicPreset(presetId)),
        reason: "已觀察素材中的局部留白與焦點；只提取短文字和線動態", overrides } }));
    return { id: section.id, role: section.role, treatment: section.treatment, clipId: clip.id, commands, editorialGraphics,
      layouts: [textLayout, ruleLayout], sourceContinuity: "unchanged" as const };
  });
  const commands = scenes.flatMap(scene => scene.commands);
  const applied = applyCommand(project, { type: "batch", commands });
  if (JSON.stringify(applied.tracks) !== JSON.stringify(projectSchema.parse(project).tracks)) throw new Error("長片提示不得修改原素材、剪點、尺寸或音訊");
  return { schema: "editkin.native-motion-sequence/v2", status: "REVIEW_REQUIRED", readOnly: true, format: "16:9",
    projectRevision: project.revision, totalFrames, animatedFrames, quietFrames, scenes, holds, commands,
    editorialGraphics: scenes.flatMap(scene => scene.editorialGraphics), sourceContinuity: "unchanged",
    compositionPolicy: "Continuous full-size footage, brief text/rule emphasis, then clean viewing. No chapter panels, split layouts, clip splits, floating galleries or replacement backgrounds.",
    evidenceState: "caller_declared_requires_v4_material_receipts",
    next: "Bind semantic purpose, observed source regions and exact graphic variants into v4 audit/apply, render the complete section and compare natural continuity with the reference. Unobserved camera zooms remain separate explicit design work." };
}
