import * as z from "zod/v4";
import { motionTreatmentSchema } from "./motionTreatment";
import { motionPresetVariantSchema } from "../domain/schema";

const boundedText = (max: number) => z.string().trim().min(1).max(max);
const evidenceRefSchema = boundedText(160);
const idSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/i);
// Creative-library IDs carry a namespace (music:<digest>, broll:<digest>, ...).
// These are opaque candidate identities, never file paths or URI capabilities.
// Keep beat/graphic IDs on the stricter schema above and do not trim/alias IDs.
const assetCandidateIdSchema = z.string().max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)?$/i);

/**
 * Lower-third identity claims must point into a material receipt carried by the
 * enclosing v4 plan.  The compact spelling keeps the ref below the general
 * 160-character evidence-ref limit:
 *
 *   mi:<material sha256>:<semantic receipt sha256>:cue:<zero-based index>
 *
 * A later audit/apply check resolves the cue against the immutable material
 * packet and semantic receipt.  A free-form label such as
 * `transcript:introduction` is deliberately not an identity authority.
 */
const lowerThirdEvidenceRefPattern = /^mi:([a-f0-9]{64}):([a-f0-9]{64}):cue:(0|[1-9]\d{0,3})$/;

export interface LowerThirdEvidenceReference {
  materialId: string;
  semanticReceiptSha256: string;
  transcriptCueIndex: number;
}

export function parseLowerThirdEvidenceReference(reference: string): LowerThirdEvidenceReference | undefined {
  const match = lowerThirdEvidenceRefPattern.exec(reference);
  if (!match) return undefined;
  return {
    materialId: match[1],
    semanticReceiptSha256: match[2],
    transcriptCueIndex: Number(match[3]),
  };
}

export const frameRangeSchema = z.strictObject({
  startFrame: z.number().int().nonnegative(),
  endFrame: z.number().int().positive(),
}).refine((range) => range.endFrame > range.startFrame, "endFrame 必須大於 startFrame");

export const editorialBeatSchema = z.strictObject({
  id: idSchema,
  range: frameRangeSchema,
  role: z.enum(["promise", "locate", "setup", "build", "breath", "proof", "state_change", "reveal", "payoff", "cta"]),
  summary: boundedText(240),
  energy: z.number().min(0).max(1),
  primaryFocus: boundedText(120),
  evidenceRefs: z.array(evidenceRefSchema).min(1).max(8),
});

const graphicEventSchema = z.strictObject({
  id: idSchema,
  presetId: idSchema,
  presetVariant: motionPresetVariantSchema.optional(),
  range: frameRangeSchema,
  kind: z.enum([
    "title_card", "context_card", "tracked_value_label", "challenge_ledger", "telemetry_callout",
    "subject_sheen", "money_burst", "proof_freeze", "scale_ladder", "map", "diagram",
    "lower_third_name", "lower_third_affiliation",
  ]),
  purpose: z.enum(["context", "stakes", "proof", "state_change", "identity", "payoff"]),
  message: boundedText(180),
  evidenceRefs: z.array(evidenceRefSchema).min(1).max(8),
  trackingId: idSchema.optional(),
  matteId: idSchema.optional(),
}).superRefine((event, context) => {
  if (event.kind === "tracked_value_label" && !event.trackingId) {
    context.addIssue({ code: "custom", path: ["trackingId"], message: "tracked_value_label 必須指定 trackingId" });
  }
  if (event.kind === "subject_sheen" && !event.matteId) {
    context.addIssue({ code: "custom", path: ["matteId"], message: "subject_sheen 必須指定 matteId" });
  }
  if ((event.kind === "lower_third_name" || event.kind === "lower_third_affiliation") && event.purpose !== "identity") {
    context.addIssue({ code: "custom", path: ["purpose"], message: "人物字幕條只能用於 evidence-bound identity" });
  }
});

const transitionSchema = z.strictObject({
  id: idSchema,
  atFrame: z.number().int().nonnegative(),
  kind: z.enum(["clean_cut", "j_cut", "l_cut", "cut_on_action", "match_cut", "foreground_wipe", "whip_pan", "speed_ramp", "short_dissolve"]),
  motivation: z.enum(["continuity", "audio", "action", "shape", "motion", "scene_change", "time_passage", "emotion"]),
  evidenceRefs: z.array(evidenceRefSchema).min(1).max(8),
}).superRefine((transition, context) => {
  const needsTwoSides = new Set(["cut_on_action", "match_cut", "foreground_wipe", "whip_pan", "speed_ramp"]);
  if (needsTwoSides.has(transition.kind) && transition.evidenceRefs.length < 2) {
    context.addIssue({ code: "custom", path: ["evidenceRefs"], message: `${transition.kind} 必須提供切點兩側證據` });
  }
  if ((transition.kind === "j_cut" || transition.kind === "l_cut") && transition.motivation !== "audio") {
    context.addIssue({ code: "custom", path: ["motivation"], message: `${transition.kind} 必須由 audio 證據驅動` });
  }
});

const audioLayerSchema = z.strictObject({
  id: idSchema,
  role: z.enum(["dialogue", "production_sound", "room_tone", "music", "foley", "sfx"]),
  purpose: boundedText(160),
  evidenceRefs: z.array(evidenceRefSchema).min(1).max(8),
});

const packagingHypothesisSchema = z.strictObject({
  id: idSchema,
  title: boundedText(120),
  thumbnailPromise: boundedText(180),
  openingFulfillment: boundedText(180),
  distinctFromIds: z.array(idSchema).max(2),
});

export const editorialPlanSchema = z.strictObject({
  motionTreatment: motionTreatmentSchema.optional(),
  brief: z.strictObject({
    audience: boundedText(160), premise: boundedText(240), promise: boundedText(240),
    stakes: boundedText(240), payoff: boundedText(240), firstFramePromise: boundedText(180),
  }),
  narrative: z.strictObject({
    backbone: boundedText(240),
    beats: z.array(editorialBeatSchema).min(1).max(64),
    setupPayoffs: z.array(z.strictObject({ setupBeatId: idSchema, payoffBeatId: idSchema })).max(32),
  }),
  packaging: z.strictObject({
    hypotheses: z.array(packagingHypothesisSchema).min(1).max(3),
    evaluationMetric: z.literal("watch_time_share"),
    introMustFulfillPackagingPromise: z.literal(true),
  }),
  captions: z.strictObject({
    mode: z.enum(["semantic", "verbatim", "accessibility"]),
    maxCharsPerLine: z.number().int().min(8).max(42),
    maxLines: z.union([z.literal(1), z.literal(2)]),
    minimumOnScreenFrames: z.number().int().positive().max(300),
    semanticEmphasisOnly: z.literal(true), separateFromGraphics: z.literal(true),
  }),
  graphics: z.array(graphicEventSchema).max(64),
  transitions: z.array(transitionSchema).max(128),
  audio: z.strictObject({
    dialoguePriority: z.literal(true), blanketWhooshEveryCut: z.literal(false),
    layers: z.array(audioLayerSchema).min(1).max(32),
    impactFrames: z.array(z.number().int().nonnegative()).max(64),
    breathFrames: z.array(z.number().int().nonnegative()).max(64),
  }),
  color: z.strictObject({
    primaryLookId: idSchema, onePrimaryLook: z.literal(true), shotMatchRequired: z.literal(true), graphicsAfterGrade: z.literal(true),
    exceptions: z.array(z.strictObject({ range: frameRangeSchema, reason: boundedText(160) })).max(16),
  }),
  assets: z.strictObject({
    truthSourceFirst: z.literal(true), semanticSelectionOnly: z.literal(true), candidateIds: z.array(assetCandidateIdSchema).max(64),
    resolutionOrder: z.tuple([z.literal("truth_source"), z.literal("semantic_broll"), z.literal("motion"), z.literal("card"), z.literal("clean_hold")]),
  }),
  delivery: z.strictObject({
    currentArtifactOnly: z.literal(true),
    platforms: z.array(z.enum(["youtube", "youtube_shorts", "instagram_reels", "archive"])).min(1).max(4),
    variants: z.array(z.strictObject({ id: idSchema, aspectRatio: z.enum(["16:9", "9:16", "1:1"]), purpose: boundedText(120) })).min(1).max(4),
    outcomeCheckpoints: z.tuple([z.literal("D2"), z.literal("D7"), z.literal("D28")]),
  }),
}).superRefine((plan, context) => {
  const beatIds = new Set<string>();
  let previousEnd = -1;
  for (const [index, beat] of plan.narrative.beats.entries()) {
    if (beatIds.has(beat.id)) context.addIssue({ code: "custom", path: ["narrative", "beats", index, "id"], message: "beat id 不可重複" });
    beatIds.add(beat.id);
    if (beat.range.startFrame < previousEnd) context.addIssue({ code: "custom", path: ["narrative", "beats", index, "range"], message: "敘事 beat 必須依序且不可重疊" });
    previousEnd = beat.range.endFrame;
  }
  for (const [index, pair] of plan.narrative.setupPayoffs.entries()) {
    if (!beatIds.has(pair.setupBeatId) || !beatIds.has(pair.payoffBeatId)) context.addIssue({ code: "custom", path: ["narrative", "setupPayoffs", index], message: "setup/payoff 必須引用存在的 beat" });
  }
  const hypothesisIds = new Set(plan.packaging.hypotheses.map((item) => item.id));
  for (const [index, hypothesis] of plan.packaging.hypotheses.entries()) {
    if (hypothesis.distinctFromIds.some((id) => !hypothesisIds.has(id) || id === hypothesis.id)) context.addIssue({ code: "custom", path: ["packaging", "hypotheses", index, "distinctFromIds"], message: "distinctFromIds 必須引用另一個假設" });
  }
  for (const [index, graphic] of plan.graphics.entries()) {
    if (graphic.kind !== "lower_third_name" && graphic.kind !== "lower_third_affiliation") continue;
    const counterpartKind = graphic.kind === "lower_third_name" ? "lower_third_affiliation" : "lower_third_name";
    const ownSuffix = graphic.kind === "lower_third_name" ? "_name" : "_unit";
    const counterpartSuffix = graphic.kind === "lower_third_name" ? "_unit" : "_name";
    const counterpartPresetId = graphic.presetId.endsWith(ownSuffix)
      ? `${graphic.presetId.slice(0, -ownSuffix.length)}${counterpartSuffix}`
      : "";
    const paired = plan.graphics.some((candidate) => candidate.kind === counterpartKind
      && candidate.presetId === counterpartPresetId
      && candidate.range.startFrame === graphic.range.startFrame
      && candidate.range.endFrame === graphic.range.endFrame);
    if (!paired) context.addIssue({ code: "custom", path: ["graphics", index], message: "人物字幕條的人名 BAR 與單位 BAR 必須使用同系列 preset 並成對出現" });
  }
});

export type EditorialPlan = z.infer<typeof editorialPlanSchema>;

export function assertBuildNarrative(plan: EditorialPlan): void {
  const roles = new Set(plan.narrative.beats.map((beat) => beat.role));
  if (!roles.has("promise")) throw new Error("Build plan 缺少 promise beat");
  if (!roles.has("payoff")) throw new Error("Build plan 缺少 payoff beat");
}

export function summarizeEditorialPlan(plan: EditorialPlan) {
  const energies = plan.narrative.beats.map((beat) => beat.energy);
  return {
    beatCount: plan.narrative.beats.length, graphicCount: plan.graphics.length,
    transitionCount: plan.transitions.length, audioLayerCount: plan.audio.layers.length,
    packagingHypothesisCount: plan.packaging.hypotheses.length,
    energyRange: { min: Math.min(...energies), max: Math.max(...energies) },
    platforms: plan.delivery.platforms, outcomeCheckpoints: plan.delivery.outcomeCheckpoints,
  };
}
