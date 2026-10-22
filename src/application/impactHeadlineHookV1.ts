import { z } from "zod";
import { getMotionLibraryItem } from "../motionLibrary/catalog";
import { resolveMotionLibraryParams } from "../motionLibrary/params";
import { MOTION_LIBRARY_ENGINE_VERSION, MOTION_TEXT_PLATES, resolveMotionItemRevision, textMotionParamsSchema } from "../motionLibrary/types";

/** W4-1: data only. The existing Motion Library owns every generator and cache. */
export const IMPACT_HEADLINE_MODULE_ID_V1 = "graphic.impact_headline" as const;
export const IMPACT_HEADLINE_ITEM_IDS_V1 = Object.freeze(["T01", "T02", "T03", "T04", "T05", "T06", "T07", "T08", "T24"] as const);

export const impactHeadlineHookRequestV1Schema = z.strictObject({
  schema: z.literal("editkin.impact-headline-request/v1"),
  itemId: z.enum(IMPACT_HEADLINE_ITEM_IDS_V1),
  // Unlike the library's convenience input, every value is explicit here, including plate.
  params: textMotionParamsSchema.extend({ plate: z.enum(MOTION_TEXT_PLATES) }),
});
export type ImpactHeadlineHookRequestV1 = z.input<typeof impactHeadlineHookRequestV1Schema>;

/**
 * Returns an immutable, unbound manual hook; never an apply packet or project command.
 * The host still needs the Motion Library clip commands and Claude's art review.
 */
export function prepareImpactHeadlineHookV1(input: unknown) {
  const request = impactHeadlineHookRequestV1Schema.parse(input);
  const item = getMotionLibraryItem(request.itemId);
  if (item.kind !== "text" || !item.implemented || (item.id !== "T24" && item.category !== "impact")) {
    throw new Error("IMPACT_HEADLINE_ITEM_UNAVAILABLE");
  }
  if (item.id === "T24" && (!item.tags.includes("thin_depth") || !item.tags.includes("no_va_default"))) {
    throw new Error("IMPACT_HEADLINE_THIN_VARIANT_REQUIRED");
  }
  const params = resolveMotionLibraryParams(item, request.params);
  return Object.freeze({
    schema: "editkin.impact-headline-hook/v1" as const,
    moduleId: IMPACT_HEADLINE_MODULE_ID_V1,
    artStatus: "pending" as const,
    manualOnly: true as const,
    defaultEligible: false as const,
    vaDefaultEligible: false as const,
    executionState: "waiting_motion_library_clip_commands" as const,
    executor: null,
    motionLibrary: Object.freeze({
      itemId: request.itemId,
      itemRevision: resolveMotionItemRevision(item.revision),
      engineVersion: MOTION_LIBRARY_ENGINE_VERSION,
      params,
    }),
  });
}
export type PreparedImpactHeadlineHookV1 = ReturnType<typeof prepareImpactHeadlineHookV1>;
