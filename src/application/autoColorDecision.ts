import * as z from "zod/v4";
import type { EditorCommand } from "../domain/commands";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const autoColorGoalSchema = z.strictObject({
  medianLinearY: z.number().min(.02).max(.8),
  reason: z.string().trim().min(8).max(240),
  maxExposureChange: z.number().min(.25).max(1).default(.75),
});
export type AutoColorGoal = z.infer<typeof autoColorGoalSchema>;
const referenceRoiSchema = z.strictObject({ x: z.number().min(0).max(1), y: z.number().min(0).max(1),
  width: z.number().positive().max(1), height: z.number().positive().max(1) })
  .refine(roi => roi.x + roi.width <= 1 && roi.y + roi.height <= 1, "參考區域不能超出原始影格");
export const referenceWhiteBalanceGoalSchema = z.strictObject({
  reference: z.literal("caller-declared-neutral"),
  reason: z.string().trim().min(8).max(240),
  maxGainStops: z.number().min(.05).max(1).default(1),
  samples: z.array(z.strictObject({ sampleId: z.string().regex(/^kf-\d+$/), roi: referenceRoiSchema })).min(2).max(3),
});
export type ReferenceWhiteBalanceGoal = z.infer<typeof referenceWhiteBalanceGoalSchema>;
export const autoColorBindingsSchema = z.array(z.strictObject({
  decisionSha256: sha, commandIndex: z.number().int().min(0).max(99), clipId: z.string().min(1).max(256),
  mode: z.enum(["exposure", "reference_white_balance"]).optional(),
})).min(1).max(32);
export type AutoColorBindings = z.infer<typeof autoColorBindingsSchema>;

/** No filesystem trust at the schema layer. Audit/apply separately read the producer receipt. */
export function assertAutoColorCommandBinding(bindings: AutoColorBindings | undefined, commands: EditorCommand[]): void {
  if (!bindings) return;
  if (commands.some(command => command.type === "batch")) throw new Error("自動調色決策不接受巢狀 batch");
  const indexes = new Set<number>(), clips = new Set<string>();
  for (const binding of bindings) {
    if (indexes.has(binding.commandIndex) || clips.has(binding.clipId)) throw new Error("自動調色決策不可重複疊加");
    indexes.add(binding.commandIndex); clips.add(binding.clipId);
    const command = commands[binding.commandIndex];
    if (command?.type !== "set_clip_color" || command.clipId !== binding.clipId) throw new Error("自動調色必須綁定精確的絕對調色命令");
    const keys = Object.keys(command.patch).sort();
    if ((binding.mode ?? "exposure") === "exposure") {
      if (keys.join(",") !== "exposure" || !Number.isFinite(command.patch.exposure)) throw new Error("自動調色必須綁定精確的絕對 exposure 命令");
    } else if (keys.join(",") !== "whiteBalanceBlue,whiteBalanceGreen,whiteBalanceRed"
      || ![command.patch.whiteBalanceRed, command.patch.whiteBalanceGreen, command.patch.whiteBalanceBlue].every(value => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 4)) {
      throw new Error("參考輔助白平衡必須綁定精確的三通道線性增益絕對命令");
    }
    if (commands.some((other, index) => index !== binding.commandIndex && other.type === "set_clip_color" && other.clipId === binding.clipId)) throw new Error("自動調色片段不可再疊加調色命令");
  }
}
