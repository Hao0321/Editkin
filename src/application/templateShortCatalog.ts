import type { EditorialProfileId } from "../domain/types";
import { REFERENCE_MOTION_DESIGN_THEMES, REFERENCE_MOTION_VIDEO_TYPES, designThemeDefaultStyle,
  type ReferenceMotionDesignSystem, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { TEMPLATE_SHORT_CERTIFICATIONS, findTemplateShortCertification, type TemplateShortCertification } from "../motion/templateFamilyCertification";
import { TemplateShortBlockError, assertCopySlots, type TemplateShortCopy, type TemplateShortFamily, type TemplateShortGenre } from "./templateShortBrief";

/** Genre → the create_project editorial profile (travel→travel, food→food, game→gaming, otherwise auto) and the theme:
 * the first style of that video type. Family is chosen by copy shape, never by the video type's scene list, which for
 * travel does not even contain strike_reframe (design §0.3 item 3). */
export const TEMPLATE_SHORT_GENRES = Object.fromEntries(Object.entries(REFERENCE_MOTION_VIDEO_TYPES).map(([genre, type]) => [genre, {
  name: type.name,
  profile: (genre === "travel" ? "travel" : genre === "food" ? "food" : genre === "game" ? "gaming" : "auto") as EditorialProfileId,
  designSystem: type.styles[0] as ReferenceMotionDesignSystem,
}])) as Record<TemplateShortGenre, { name: string; profile: EditorialProfileId; designSystem: ReferenceMotionDesignSystem }>;

export interface TemplateShortSelection {
  family: TemplateShortFamily;
  designSystem: ReferenceMotionDesignSystem;
  certification?: TemplateShortCertification;
  /** READY needs a certified family × theme; anything else is REVIEW_REQUIRED at best, with a full art review. */
  statusCeiling: "READY" | "REVIEW_REQUIRED";
}
/** Explicit family first, then copy shape: a hook selects strike_reframe, otherwise 2–4 points select context_stack. */
export function selectTemplateShortFamily(brief: { copy: TemplateShortCopy; family?: TemplateShortFamily }, genre: TemplateShortGenre,
  certifications: readonly TemplateShortCertification[] = TEMPLATE_SHORT_CERTIFICATIONS): TemplateShortSelection {
  const family = brief.family ?? (brief.copy.hook !== undefined ? "strike_reframe" : brief.copy.points !== undefined ? "context_stack" : undefined);
  if (!family) throw new TemplateShortBlockError("BLOCK_BRIEF", "v1 需要『原本以為→其實是』或 2–4 個重點", "copy");
  assertCopySlots(family, brief.copy);
  const designSystem = TEMPLATE_SHORT_GENRES[genre].designSystem, certification = findTemplateShortCertification(family, designSystem, certifications);
  return { family, designSystem, ...(certification ? { certification } : {}), statusCeiling: certification ? "READY" : "REVIEW_REQUIRED" };
}

export interface TemplateShortInputContext {
  clipId: string;
  durationFrames: number;
  designSystem: ReferenceMotionDesignSystem;
  shortId: string;
  /** `material:<id>:semantic:<sha>` of the recorded semantics for this window. */
  semanticRef: string;
  factRefs?: readonly string[];
  /** From the workspace defaults file, never from the brief. */
  brandMark?: string;
  focus?: { x: number; y: number; w: number; h: number };
}
/** Slot table (§3.4) → the reference-motion template input. No viewed-frame ref and no textRegion: design themes reject it. */
export function toTemplateInput(family: TemplateShortFamily, copy: TemplateShortCopy, context: TemplateShortInputContext): ReferenceMotionTemplateInput {
  assertCopySlots(family, copy);
  const theme = REFERENCE_MOTION_DESIGN_THEMES[context.designSystem];
  return {
    templateId: family, clipId: context.clipId, startFrame: 0, durationFrames: context.durationFrames,
    designSystem: context.designSystem, style: designThemeDefaultStyle(context.designSystem), graphicCadence: "kinetic", intent: "shortform",
    title: copy.payoff,
    ...(copy.accent !== undefined ? { accentText: copy.accent } : {}),
    ...(copy.hook !== undefined ? { previousText: copy.hook } : {}),
    ...(copy.proof !== undefined ? { subtitle: copy.proof } : {}),
    ...(copy.place !== undefined ? { kicker: copy.place } : {}),
    ...(copy.tag !== undefined ? { tag: copy.tag } : {}),
    ...(copy.points !== undefined ? { items: copy.points.map(point => ({ label: point.label, ...(point.detail !== undefined ? { detail: point.detail } : {}) })) } : {}),
    ...(context.brandMark !== undefined ? { brandMark: context.brandMark } : {}),
    ...(context.focus ? { focusRegion: { x: context.focus.x, y: context.focus.y, width: context.focus.w, height: context.focus.h } } : {}),
    purpose: `${theme.name}：${copy.hook !== undefined ? `${copy.hook}→` : ""}${copy.payoff}`,
    evidenceRefs: [context.semanticRef, ...(context.factRefs ?? []), `creator:template-short-brief#${context.shortId}`],
  };
}
