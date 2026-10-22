import type { TemplatePlacement } from "../modules/templateCatalog";
import { IMPACT_HEADLINE_MODULE_ID_V1 } from "./impactHeadlineHookV1";

/** Semantic slots, not scene counts. No timings, copy, fills, artwork or defaults. */
function slot(id: string, placement: TemplatePlacement, min: number, max: number, executorHook: typeof IMPACT_HEADLINE_MODULE_ID_V1 | null = null) {
  return Object.freeze({ id, placement, min, max, executorHook });
}

/** W4-8: deliberately not a CompositionTemplate or an executable VA recipe. */
export const SHORTS_HYPE_V2_SLOT_SKELETON = Object.freeze({
  schema: "editkin.shorts-hype-slots/v2" as const,
  templateId: "shorts.hype" as const,
  version: "2.0.0" as const,
  state: "skeleton" as const,
  artStatus: "pending" as const,
  defaultEligible: false as const,
  vaDefaultEligible: false as const,
  executor: null,
  slots: Object.freeze([
    slot("hook", "opening", 1, 1, IMPACT_HEADLINE_MODULE_ID_V1),
    slot("impact", "keyword", 0, 4),
    slot("question", "keyword", 0, 2),
    slot("reaction", "keyword", 0, 3),
    slot("payoff", "closing", 0, 1, IMPACT_HEADLINE_MODULE_ID_V1),
  ]),
});
