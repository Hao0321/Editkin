import * as z from "zod/v4";
import { createHash } from "node:crypto";
import type { EditProject } from "../domain/types";
import { applyCommand } from "../domain/commands";
import { motionGraphicV2LayoutReceipt } from "../motion/compositionV2";

export const nativeMotionRevisionSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(), graphicId: z.string().min(1),
  range: z.strictObject({ startFrame: z.number().int().nonnegative(), endFrame: z.number().int().positive() }),
  phase: z.enum(["entrance", "exit"]),
  change: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("animation_speed_multiplier"), value: z.number().finite().min(.5).max(2) }),
    z.strictObject({ kind: z.literal("animation_duration_frames"), value: z.number().int().min(1).max(600) }),
    z.strictObject({ kind: z.literal("animation_start_scale"), value: z.number().finite().min(.1).max(4) }),
  ]),
  evidenceRefs: z.array(z.string().trim().min(1).max(160)).min(1).max(8),
});
export type NativeMotionRevisionInput = z.infer<typeof nativeMotionRevisionSchema>;

/** Director revision stays local to the named graphic and named motion phase. */
export function prepareNativeMotionRevision(project: EditProject, raw: NativeMotionRevisionInput) {
  const input = nativeMotionRevisionSchema.parse(raw);
  if (project.revision !== input.expectedRevision) throw new Error("導演修訂的專案版本過期，請重新讀取目前畫面");
  const graphic = project.motionGraphics.find(item => item.id === input.graphicId);
  if (!graphic?.motionV2 || graphic.schema !== "hao.motion-composition/v2") throw new Error("指定對象沒有可編輯的逐格 Motion v2 動作");
  const startFrame = Math.round(graphic.timelineStart * project.fps), endFrame = startFrame + Math.round(graphic.duration * project.fps);
  if (input.range.startFrame !== startFrame || input.range.endFrame !== endFrame) throw new Error("指定範圍必須精確對應該文字元素；部分區間需要先建立獨立元素");
  const before = structuredClone(graphic.motionV2), after = structuredClone(before);
  const phase = after[input.phase];
  if (input.change.kind === "animation_speed_multiplier") phase.durationFrames = Math.max(1, Math.round(phase.durationFrames / input.change.value));
  else if (input.change.kind === "animation_duration_frames") phase.durationFrames = input.change.value;
  else phase.scale = input.change.value;
  const count = endFrame - startFrame;
  if (after.entrance.durationFrames + after.exit.durationFrames + Math.ceil(project.fps * .8) > count) throw new Error("修訂會吃掉文字的閱讀停留，請延長這個元素或縮短入出場");
  const command = { type: "update_motion_graphic" as const, graphicId: graphic.id, patch: { motionV2: after } };
  const applied = applyCommand(project, command);
  const oldReceipt = motionGraphicV2LayoutReceipt(project, graphic), newReceipt = motionGraphicV2LayoutReceipt(applied, applied.motionGraphics.find(item => item.id === graphic.id)!);
  return { schema: "editkin.native-motion-revision/v1", status: "REVIEW_REQUIRED", readOnly: true, projectRevision: project.revision,
    graphicId: graphic.id, range: input.range, phase: input.phase, change: input.change, before, after, commands: [command],
    evidenceRefs: input.evidenceRefs, invalidates: { affectedFrameRange: input.range, oldReceiptId: oldReceipt.receiptId, newReceiptId: newReceipt.receiptId,
      oldMotionSha256: createHash("sha256").update(JSON.stringify(before)).digest("hex"), newMotionSha256: createHash("sha256").update(JSON.stringify(after)).digest("hex") },
    preserved: { text: graphic.text, x: graphic.x, y: graphic.y, mediaPlayback: "unchanged", audio: "unchanged" },
    next: "Bind the precise revision into v4 evidence, audit/apply, re-render this section and inspect the continuous movement and reading hold." };
}
