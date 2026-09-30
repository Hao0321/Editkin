import type { EditorCommand } from "../domain/commandTypes";
import type { EditProject, MotionGraphic } from "../domain/types";
import { applyCommand } from "../domain/commands";
import { projectDuration } from "../domain/editGraph";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { createMotionGraphic } from "../motion/composition";
import { motionGraphicV2LayoutReceipt } from "../motion/compositionV2";
import { floatingFrameSceneCommands, type FloatingFrameSceneBindings } from "../motion/floatingFrameScenes";
import type { MotionPresetVariant } from "../domain/schema";
import { validateMotionSceneStyle, type MotionSceneStyle } from "../domain/motionSceneStyle";

export interface NativeReelSceneInput {
  templateId: "editorial_steps" | "spatial_gallery";
  startFrame: number;
  durationFrames: number;
  title: string;
  body?: string;
  progress?: { steps: number; activeStep: number };
  clipId?: string;
  sources?: FloatingFrameSceneBindings;
  evidenceRefs: string[];
  style?: MotionSceneStyle;
}

/** Pure scene geometry shared by the desktop and backend; no Node or file access. */
export function buildNativeReelSceneCommands(project: EditProject, input: NativeReelSceneInput, idFactory: (prefix: string) => string) {
  if (Math.min(project.width, project.height) < 256) throw new Error("此場景需要短邊至少 256 的畫布");
  const portrait = project.height > project.width;
  const style = input.style ? validateMotionSceneStyle(input.style) : undefined;
  if (!Number.isSafeInteger(input.startFrame) || input.startFrame < 0 || !Number.isSafeInteger(input.durationFrames) || input.durationFrames < 30
    || input.startFrame + input.durationFrames > Math.round(projectDuration(project) * project.fps)) throw new Error("場景影格範圍需要至少 30 格且必須位於專案內");
  if (!input.title.trim() || input.title.length > 48 || (input.body?.length ?? 0) > 64) throw new Error("場景需要核對過的短標題／內文，不可用空文字或過長文案");
  if (!input.evidenceRefs.length || input.evidenceRefs.some(ref => !ref.trim() || ref.length > 160)) throw new Error("場景需要素材或已核對 brief 證據引用");
  const commands: EditorCommand[] = [];
  const bindings: Array<{ graphic: MotionGraphic; presetId: string; overrides: MotionPresetVariant["overrides"]; offsetFrames: number }> = [];
  const layouts: Array<{ id: string; presetId: string; receiptId: string; box: { x: number; y: number; width: number; height: number } }> = [];
  function add(presetId: string, text: string, overrides: MotionPresetVariant["overrides"] = {}, offsetFrames = 0) {
    const preset = findMotionGraphicPreset(presetId);
    const fontSize = Math.max(8, overrides.fontSize ?? preset.seed.fontSize ?? 48);
    overrides = { ...overrides,
      ...(overrides.fontSize !== undefined ? { fontSize } : {}),
      ...(overrides.layoutV2 ? { layoutV2: { ...overrides.layoutV2, minFontSize: Math.max(8, Math.min(fontSize, overrides.layoutV2.minFontSize)) } } : {}),
    };
    if (style) {
      const vector = overrides.vectorV2 ?? preset.seed.vectorV2;
      if (vector?.kind === "panel") overrides.backgroundColor = style.palette.surface;
      else if (vector?.kind === "dot_grid") overrides.accentColor = `${style.palette.muted}24`;
      else if (vector) overrides.accentColor = style.palette.accent;
      else overrides = { ...overrides, fontFamily: input.body?.trim() === text.trim() ? style.typography.bodyFamily : style.typography.headingFamily,
        textColor: ["章節序號", "章節眉題"].includes(overrides.name ?? "") ? style.palette.muted : style.palette.text };
      const motion = structuredClone(overrides.motionV2 ?? preset.seed.motionV2);
      if (motion) {
        for (const phase of [motion.entrance, motion.exit]) phase.durationFrames = Math.max(1, Math.round(phase.durationFrames / style.animationSpeed));
        motion.sequence.staggerFrames = Math.round(motion.sequence.staggerFrames / style.animationSpeed);
        overrides.motionV2 = motion;
      }
      if (vector) overrides.vectorV2 = { ...vector, revealFrames: Math.max(1, Math.round(vector.revealFrames / style.animationSpeed)) };
    }
    const graphic: MotionGraphic = {
      ...createMotionGraphic(idFactory("reel"), preset.seed.kind ?? "card", text, (input.startFrame + offsetFrames) / project.fps,
        (input.durationFrames - offsetFrames) / project.fps, undefined, preset.seed), ...structuredClone(overrides),
    };
    const layout = motionGraphicV2LayoutReceipt(project, graphic);
    layouts.push({ id: graphic.id, presetId, receiptId: layout.receiptId, box: layout.box });
    commands.push({ type: "add_motion_graphic", graphic });
    bindings.push({ graphic, presetId, overrides, offsetFrames });
  }
  const unit = Math.min(project.width, project.height) / 1080;
  if (input.templateId === "editorial_steps") {
    if (!portrait) {
      throw new Error("長片只提取局部文字與焦點元素；請用 prepare_native_motion_sequence，不套整套章節底板或縮小原片");
    }
    if (!input.progress || !Number.isInteger(input.progress.steps) || input.progress.steps < 1 || input.progress.steps > 12
      || !Number.isInteger(input.progress.activeStep) || input.progress.activeStep < 0 || input.progress.activeStep > input.progress.steps) throw new Error("章節場景需要有效的總步數與目前章節");
    const base = findMotionGraphicPreset("reel_step_progress").seed.vectorV2!;
    const paper = { x: 0, width: portrait ? 1 : .38, outlineWidth: 0, cornerRadius: 0, backgroundColor: "#F8F3EA",
      layoutV2: { ...findMotionGraphicPreset("reel_native_panel").seed.layoutV2!, safeArea: { top: 0, right: 0, bottom: 0, left: 0 } },
      motionV2: { sequence: { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0 },
        entrance: { durationFrames: 1, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 1, easing: { type: "linear" } },
        exit: { durationFrames: 1, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 1, easing: { type: "linear" } } } } satisfies MotionPresetVariant["overrides"];
    // Keep the real source visible between the information bands.
    add("reel_native_panel", "", { ...paper, y: 0, vectorV2: { schema: "editkin.motion-vector/v1", kind: "panel", heightPixels: project.height * (portrait ? .35 : 1), revealFrames: 1 } });
    add("reel_native_panel", "", { ...paper, x: portrait ? 0 : .38, width: portrait ? 1 : Math.max(16 / project.width, .003), backgroundColor: portrait ? paper.backgroundColor : "#E4D8C7", y: portrait ? .79 : 0, vectorV2: { schema: "editkin.motion-vector/v1", kind: "panel", heightPixels: project.height * (portrait ? .21 : 1), revealFrames: 1 } });
    add("reel_dot_grid", "", { x: portrait ? .08 : .04, y: .03, width: portrait ? .84 : .3, accentColor: "#74695724", layoutV2: { ...findMotionGraphicPreset("reel_dot_grid").seed.layoutV2!, safeArea: { top: .03, right: .03, bottom: .03, left: .03 } }, vectorV2: { schema: "editkin.motion-vector/v1", kind: "dot_grid", heightPixels: project.height * (portrait ? .32 : .92), revealFrames: 1, spacingPixels: 52 * unit, dotRadiusPixels: 1.2 * unit } });
    add("reel_step_progress", "", { x: portrait ? .08 : .05, y: portrait ? .082 : .1, width: portrait ? .55 : .28, vectorV2: { ...base, kind: "step_progress", heightPixels: 10 * unit,
      revealFrames: Math.min(18, input.durationFrames - 6), steps: input.progress.steps, activeStep: input.progress.activeStep, gapPixels: 12 * unit } });
    add("reel_rule_reveal", "", { x: portrait ? .08 : .05, y: portrait ? .32 : .7, width: portrait ? .84 : .28, accentColor: "#BF684870", vectorV2: { schema: "editkin.motion-vector/v1", kind: "rule", heightPixels: 4 * unit, revealFrames: 14 } });
    const textLayout = { ...findMotionGraphicPreset("reel_editorial_step").seed.layoutV2!, safeArea: { top: .03, right: .03, bottom: .06, left: .03 }, maxLines: portrait ? 2 : 3, minFontSize: Math.max(8, (portrait ? 36 : 24) * unit) };
    add("reel_editorial_step", input.title.trim(), { x: portrait ? .08 : .05, y: portrait ? .145 : .28, width: portrait ? .65 : .29, fontSize: (portrait ? 96 : 60) * unit, backgroundColor: "#00000000", shadowDepth: 0, layoutV2: textLayout,
      motionV2: { ...findMotionGraphicPreset("reel_editorial_step").seed.motionV2!, sequence: { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0 } } });
    add("reel_editorial_step", `STEP ${String(input.progress.activeStep).padStart(2, "0")} / ${String(input.progress.steps).padStart(2, "0")}`, {
      name: "章節眉題", x: portrait ? .08 : .05, y: .042, width: portrait ? .55 : .28, fontSize: (portrait ? 24 : 18) * unit, fontWeight: 650, letterSpacing: unit,
      textColor: "#766E63", backgroundColor: "#00000000", shadowDepth: 0,
      layoutV2: { ...textLayout, minFontSize: 20 * unit, maxLines: 1 },
      motionV2: { ...findMotionGraphicPreset("reel_editorial_step").seed.motionV2!, sequence: { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0 } },
    });
    add("reel_editorial_step", String(input.progress.activeStep).padStart(2, "0"), {
      name: "章節序號", x: portrait ? .76 : .28, y: portrait ? .14 : .16, width: portrait ? .16 : .07, fontSize: (portrait ? 132 : 64) * unit, fontWeight: 400,
      textColor: "#C9BCAC", backgroundColor: "#00000000", shadowDepth: 0,
      layoutV2: { ...textLayout, minFontSize: (portrait ? 60 : 28) * unit, maxLines: 1 },
      motionV2: { ...findMotionGraphicPreset("reel_editorial_step").seed.motionV2!, sequence: { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0 } },
    });
    if (input.body?.trim()) add("reel_editorial_step", input.body.trim(), { name: "章節重點",
      x: portrait ? .08 : .05, y: portrait ? .825 : .76, width: portrait ? .84 : .29, fontSize: (portrait ? 42 : 26) * unit, textColor: "#5B5047", backgroundColor: "#00000000", shadowDepth: 0,
      layoutV2: { ...textLayout, minFontSize: (portrait ? 36 : 16) * unit }, motionV2: { ...findMotionGraphicPreset("reel_editorial_step").seed.motionV2!, sequence: { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0 } } }, 12);
  } else if (input.templateId === "spatial_gallery") {
    if (!input.clipId || !input.sources) throw new Error("空間展廊需要三個獨立素材槽及原片 clipId");
    const clip = project.tracks.flatMap(track => track.clips).find(item => item.id === input.clipId);
    if (!clip || Math.round(clip.timelineStart * project.fps) !== input.startFrame || Math.round(clip.duration * project.fps) !== input.durationFrames) throw new Error("空間場景範圍必須精確對應原片；請先以既有剪裁命令準備片段");
    commands.push(...floatingFrameSceneCommands(project, input.clipId, "portrait_stack", input.sources));
    add("reel_spatial_headline", input.title.trim(), { x: portrait ? .08 : .05, y: portrait ? .085 : .18, width: portrait ? .84 : .3, fontSize: (portrait ? 76 : 66) * unit, shadowDepth: 0, backgroundColor: "#00000000", accentColor: "#00000000",
      layoutV2: { ...findMotionGraphicPreset("reel_spatial_headline").seed.layoutV2!, safeArea: { top: .03, right: .03, bottom: .06, left: .03 }, maxLines: portrait ? 2 : 3, minFontSize: Math.max(8, (portrait ? 34 : 28) * unit) },
      motionV2: { ...findMotionGraphicPreset("reel_spatial_headline").seed.motionV2!, sequence: { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0 },
        entrance: { durationFrames: 12, offsetXPixels: 0, offsetYPixels: 16, scale: 1, opacity: 0, easing: { type: "ease_out" } } } });
  } else throw new Error("未知自研直式場景");
  applyCommand(project, { type: "batch", commands });
  return { status: "REVIEW_REQUIRED", templateId: input.templateId, format: portrait ? "9:16" : "16:9", projectRevision: project.revision, commands, bindings,
    layouts, readOnly: true, renderer: "Editkin original integer-frame geometry and video planes",
    evidenceState: "caller_declared_requires_v4_material_receipts", next: "Bind scene evidence and motionTreatment into the existing v4 plan; audit/apply/render. Verify the installed runtime exposes editkin.motion-vector/v1 before execution." };
}
