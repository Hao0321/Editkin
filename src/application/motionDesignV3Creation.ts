import * as z from "zod/v4";
import { MOTION_DESIGN_V3_PRESETS } from "../creative/motionDesignV3Presets";
import { assertMotionGraphicV3Contract, MOTION_DESIGN_V3_FIELDS, MOTION_DESIGN_V3_IDENTITY_TEMPLATES, MOTION_V3_MAX_LINE_CHARS } from "../domain/motionCompositionV3Contract";
import type { EditorCommand } from "../domain/commandTypes";
import type { EditProject, MotionGraphic } from "../domain/types";
import { makeId } from "../lib/format";
import { motionGraphicV3Layout } from "../motion/compositionV3";

/** One Motion Design v3 graphic placed on exact project frames. Copy is one template field per line. */
export const motionDesignV3CreationInputSchema = z.strictObject({
  startFrame: z.number().int().min(0),
  durationFrames: z.number().int().min(1).max(36_000),
  lines: z.array(z.string().max(MOTION_V3_MAX_LINE_CHARS)).min(1).max(5),
  graphicId: z.string().min(1).max(128).optional(),
});
export type MotionDesignV3CreationInput = z.infer<typeof motionDesignV3CreationInputSchema>;

/** v3 presets an autopilot may place. Name bars need evidence-bound identity pairing, so they stay editor-only. */
export function autopilotMotionDesignV3Presets() {
  return MOTION_DESIGN_V3_PRESETS.filter(preset => !MOTION_DESIGN_V3_IDENTITY_TEMPLATES.has(preset.seed.designV3!.template));
}

export function prepareMotionDesignV3Graphic(project: Pick<EditProject, "width" | "height" | "fps">, presetId: string, input: MotionDesignV3CreationInput): MotionGraphic {
  const preset = MOTION_DESIGN_V3_PRESETS.find(item => item.id === presetId);
  if (!preset?.seed.designV3) throw new Error(`未知的 Motion Design v3 預設：${presetId}`);
  if (MOTION_DESIGN_V3_IDENTITY_TEMPLATES.has(preset.seed.designV3.template)) {
    throw new Error("v3 人名條需要 transcript identity evidence 配對；自動剪輯請改用證據綁定的人物字幕條");
  }
  const graphic = {
    ...structuredClone(preset.seed), id: input.graphicId ?? makeId("motion-v3"), text: input.lines.join("\n"),
    timelineStart: input.startFrame / project.fps, duration: input.durationFrames / project.fps,
  } as MotionGraphic;
  assertMotionGraphicV3Contract(graphic);
  // Laying the copy out fails closed when it overflows the template's line budget; it is never shrunk or clipped.
  motionGraphicV3Layout(project, graphic);
  return graphic;
}

/** Module output for one v3 graphic; the caller reads the project through its own workspace boundary. */
export function prepareMotionDesignV3(project: Pick<EditProject, "width" | "height" | "fps" | "revision">, presetId: string, input: MotionDesignV3CreationInput) {
  const graphic = prepareMotionDesignV3Graphic(project, presetId, input);
  const template = graphic.designV3!.template;
  const commands: EditorCommand[] = [{ type: "add_motion_graphic", graphic }];
  return { status: "PREPARED" as const, projectRevision: project.revision, presetId, template, textFields: MOTION_DESIGN_V3_FIELDS[template], commands };
}
