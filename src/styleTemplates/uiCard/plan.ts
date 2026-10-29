import { z } from "zod";
import { styleWordSchema } from "../types";

/**
 * editkin.ui-card-plan/v1: what the agent (VA) decides for an S1 v2 tutorial short. The machine measures the rest
 * (ROI follow from frame differences, phrase breaks from the recognizer's pauses, contrast, placement).
 * All on-screen text is spoken words (wordRange) or flagged: editorial labels (chapters) and on-screen text
 * re-set exactly (prompt bubbles), each with its evidence for the seal gate (M10).
 */

export const UI_CARD_PLAN_SCHEMA_V1 = "editkin.ui-card-plan/v1" as const;

const seconds = z.number().finite().min(0).max(86_400);
const range = z.tuple([z.number().int().min(0), z.number().int().min(0)]).refine(([a, b]) => b >= a, "range end before start");
const unit = z.number().finite().min(0).max(1);
const normBox = z.tuple([unit, unit, unit, unit]).refine(([x0, y0, x1, y1]) => x1 > x0 && y1 > y0, "box needs x0 < x1 and y0 < y1");
const normPoint = z.tuple([unit, unit]);
const textRef = z.union([
  z.strictObject({ wordRange: range }),
  z.strictObject({ text: z.string().min(1).max(40), editorial: z.literal(true) }),
]);
export type UiTextRefV1 = z.infer<typeof textRef>;

export const uiCardPlanSchemaV1 = z.strictObject({
  schema: z.literal(UI_CARD_PLAN_SCHEMA_V1),
  template: z.string().regex(/^[SH][0-9]+_[a-z0-9_]+$/),
  aspect: z.enum(["9:16", "16:9"]),
  palette: z.strictObject({ accent: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(), ink: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional() }).optional(),
  words: z.array(styleWordSchema).max(20_000),
  /** The recognizer's segments (complete text with punctuation, including words it could not time): phrase captions come from these. */
  segments: z.array(z.strictObject({ start: seconds, end: seconds, text: z.string().min(1).max(400) })).max(5_000).optional(),
  /** Word corrections the recognizer got wrong (shown text), each with a reason; the seal gate confirms them. */
  corrections: z.array(z.strictObject({ word: z.number().int().min(0), text: z.string().min(1).max(64), reason: z.string().min(1).max(200) })).max(200).optional(),
  /** One entry per footage clip (by id, in timeline order): how its card frames the screen. */
  shots: z.array(z.strictObject({
    id: z.string().min(1).max(64),
    /** square: the near-square hero card that follows the action; wide: a strip card on a fixed source region. */
    card: z.enum(["square", "wide"]).default("square"),
    /** wide: the strip (source-normalized); square: an optional fixed focus instead of the measured follow. */
    region: normBox.optional(),
    follow: z.boolean().default(true),
    /** square: frame tighter than the default (1 = the content height × 0.9); for sparse pages with small UI. */
    zoom: z.number().min(1).max(2.5).optional(),
  })).min(1).max(500),
  chapters: z.array(z.strictObject({ at: seconds, number: z.string().regex(/^\d{2}$/), label: textRef })).max(50).default([]),
  /** Key beats: the phrase holding this keyword becomes a lockup (white lead over a big accent keyword) and the card punches in. */
  keys: z.array(z.strictObject({ keyword: range, punch: z.boolean().default(true) })).max(200).default([]),
  /** Tool / app names: an accent pill pinned to the card's top-left edge. */
  tags: z.array(z.strictObject({ at: seconds, until: seconds.optional(), text: textRef })).max(100).default([]),
  /** On-screen text (a prompt, a UI label) re-set as a clean bubble above a wide card: exact text only. */
  bubbles: z.array(z.strictObject({ at: seconds, until: seconds, shot: z.string().min(1).max(64), label: textRef.optional(),
    lines: z.array(z.string().min(1).max(40)).min(1).max(3), evidence: z.string().min(1).max(200) })).max(50).default([]),
  /** A click on the screen: the cursor glides to a source point (normalized) of a shot and clicks. */
  clicks: z.array(z.strictObject({ at: seconds, shot: z.string().min(1).max(64), point: normPoint, evidence: z.string().min(1).max(200) })).max(100).default([]),
  /** The VO enumerates: step chips 01/02/03… in the lower third, one per spoken item. */
  steps: z.array(z.strictObject({ items: z.array(z.strictObject({ wordRange: range })).min(2).max(5) })).max(20).default([]),
  /** A detail of the UI pops out of the card (a crop of a source region, scaled up, with its own shadow). */
  callouts: z.array(z.strictObject({ at: seconds, until: seconds, shot: z.string().min(1).max(64), region: normBox,
    scale: z.number().min(1.1).max(1.8).default(1.4) })).max(50).default([]),
});
export type UiCardPlanV1 = z.output<typeof uiCardPlanSchemaV1>;
export type UiCardPlanInputV1 = z.input<typeof uiCardPlanSchemaV1>;
