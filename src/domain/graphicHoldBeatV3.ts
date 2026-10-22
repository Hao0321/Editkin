import { z } from "zod";
import { MOTION_V2_MAX_SEGMENT_FRAMES } from "./motionCompositionV2Contract";

const fraction = z.number().finite().min(0).max(1);
const scale = z.number().finite().min(1).max(1.25);
const transform = {
  peakScale: scale,
  translateXPixels: z.number().finite(),
  translateYPixels: z.number().finite(),
};
const moving = (value: { peakScale: number; translateXPixels: number; translateYPixels: number }) =>
  value.peakScale !== 1 || value.translateXPixels !== 0 || value.translateYPixels !== 0;

/** Caller-selected motion only. The compiler supplies the existing, final readable hold clock. */
export const graphicHoldBeatV3Schema = z.strictObject({
  schema: z.literal("editkin.graphic-hold-beat/v3"),
  holdIndex: z.number().int().min(0).max(63),
  roleKeys: z.array(z.string().min(1).max(160)).min(1).max(64),
  fromFraction: fraction, peakFraction: fraction, toFraction: fraction,
  origin: z.strictObject({ x: fraction, y: fraction }),
  ...transform,
}).superRefine((value, context) => {
  if (!(value.fromFraction < value.peakFraction && value.peakFraction < value.toFraction))
    context.addIssue({ code: "custom", path: ["peakFraction"], message: "第二拍需要依序分開的開始、峰值與回位時間。" });
  if (new Set(value.roleKeys).size !== value.roleKeys.length)
    context.addIssue({ code: "custom", path: ["roleKeys"], message: "第二拍的卡片角色不可重複。" });
  if (!moving(value)) context.addIssue({ code: "custom", message: "第二拍需要明確的位移或推近。" });
});
export type GraphicHoldBeatV3 = z.infer<typeof graphicHoldBeatV3Schema>;

export const graphicHoldEnvelopeV3Schema = z.strictObject({
  schema: z.literal("editkin.graphic-hold-envelope/v3"),
  clock: z.literal("graphic_local_frames"),
  fromFrame: z.number().int().nonnegative(), peakFrame: z.number().int().nonnegative(), toFrame: z.number().int().nonnegative(),
  originXPixels: z.number().finite().nonnegative(), originYPixels: z.number().finite().nonnegative(),
  ...transform,
}).superRefine((value, context) => {
  if (!(value.fromFrame < value.peakFrame && value.peakFrame < value.toFrame) || value.toFrame - value.fromFrame > 1800)
    context.addIssue({ code: "custom", message: "第二拍的整數格範圍無效或超過 1800 格。" });
  if (!moving(value)) context.addIssue({ code: "custom", message: "第二拍不可是沒有變換的空事件。" });
});
export type GraphicHoldEnvelopeV3 = z.infer<typeof graphicHoldEnvelopeV3Schema>;

export const GRAPHIC_HOLD_BEAT_V3_CONTRACT = {
  schema: "editkin.graphic-hold-beat/v3", certification: "ART_PENDING_CLAUDE", defaultSelection: false,
  clock: "caller_fractions_in_final_authored_readable_hold", storedClock: "graphic_local_frames", envelope: "neutral_peak_neutral_linear",
  group: "one_explicit_canvas_origin", sourceAndAudioClocks: "unchanged", originalEntranceAndExit: "unchanged",
  maxFrames: 1800, maxRoleKeys: 64, maxSegmentFrames: MOTION_V2_MAX_SEGMENT_FRAMES,
  opacityBlurRotation: "unchanged", shrink: "not_allowed", clipWindows: "unchanged_and_checked",
} as const;
