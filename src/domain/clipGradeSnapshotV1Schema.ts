import * as z from "zod/v4";
import type { ColorAdjustments, ColorGradeV2 } from "./visualTypes";
import { colorGradeV2Schema } from "./colorGradeV2Schema";
export interface ClipGradeSnapshotV1 { schema: "editkin.clip-grade-snapshot/v1"; color: ColorAdjustments; gradeV2?: ColorGradeV2 }
const number = () => z.number().finite();
export const clipGradeSnapshotV1Schema: z.ZodType<ClipGradeSnapshotV1> = z.strictObject({
  schema: z.literal("editkin.clip-grade-snapshot/v1"),
  color: z.strictObject({ brightness: number(), contrast: number(), saturation: number(), hue: number(), exposure: number(), temperature: number(), tint: number(),
    whiteBalanceRed: number().min(-4).max(4), whiteBalanceGreen: number().min(-4).max(4), whiteBalanceBlue: number().min(-4).max(4),
    pivot: number(), shadows: number(), highlights: number(), blacks: number(), whites: number() }),
  gradeV2: colorGradeV2Schema.optional(),
});
