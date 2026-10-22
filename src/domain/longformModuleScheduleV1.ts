import * as z from "zod/v4";

export const LONGFORM_MODULE_LIMITS_V1 = Object.freeze({ui_focus:64,concept:16,recap:3});
const frame=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identity=z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,95}$/i);
export const longformModuleScheduleRequestV1Schema=z.strictObject({
  schema:z.literal("editkin.longform-module-schedule-request/v1"),expectedRevision:frame,
  modules:z.array(z.strictObject({id:identity,kind:z.enum(["ui_focus","concept","recap"]),referenceId:identity,
    startFrame:frame,endFrame:frame,evidenceRefs:z.array(z.string().trim().min(1).max(160)).min(1).max(8),
  })).min(1).max(83),
});
export type LongformModuleScheduleRequestV1=z.infer<typeof longformModuleScheduleRequestV1Schema>;
