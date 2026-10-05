import { z } from "zod";
import { motionSceneStyleSchema } from "../domain/motionSceneStyle";
import type { MotionSceneStyle } from "../domain/motionSceneStyle";
import { GRAPHIC_CADENCE_PROFILES, GRAPHIC_CADENCE_BRISK_CONTRACT } from "./graphicCadence";

/** Editkin sky brand: verified against ui/theme.css, not reference-video colors. */
export const DEFAULT_REFERENCE_MOTION_STYLE: MotionSceneStyle = {
  palette: { surface: "#FFFFFF", text: "#172033", accent: "#175CD3", muted: "#5B6678", separator: "#D8DEE8" },
  typography: { headingFamily: "Noto Serif TC", bodyFamily: "Noto Sans TC" }, animationSpeed: 1,
};
export const DEFAULT_REFERENCE_NETWORK_COLORS: [string, string, string] = ["#175CD3", "#2E90FA", "#0B3B95"];
export const REFERENCE_MOTION_COLOR_POLICY = "Use the creator's verified brand palette or an original design; never extract or copy reference palettes, author branding or color roles as RGB values.";
/** Explicit new authoring only; historical saved recipes keep their identities. */
export const REFERENCE_MOTION_NATIVE_PAINT_PRESENTATION_CONTRACT = {
  schema: "editkin.reference-motion-native-paint/v1", families: ["level_bridge"],
  output: "aces2_rec709_sdr", physicalGlyphsRequired: true, maxProjectGraphics: 4,
  panelStrokePixels1080: 1, panelShadowPixels1080: { blur: 8, x: 0, y: 4 },
  panelStrokeAlpha: "60", panelShadowColor: "#09284930", historicalAutomaticUpgrade: false,
  sourceLeadSeconds: .6, titleSeconds: 3.4, minimumCleanTailSeconds: .6,
  portraitPanelHeights: { withSubtitle: .245, withKicker: .2, titleOnly: .145 },
} as const;
/** New display artwork has a distinct recipe identity. Never mutate the V1
 * contract above: its hash and scene interpretation belong to saved projects. */
export const REFERENCE_MOTION_DISPLAY_PAINT_PRESENTATION_CONTRACT = {
  ...REFERENCE_MOTION_NATIVE_PAINT_PRESENTATION_CONTRACT,
  schema: "editkin.reference-motion-native-paint/v2",
  paintSchema: "editkin.motion-paint/v2", trackSchema: "editkin.native-motion-paint-track/v2",
  colorIntent: "display_rec709_sdr", compositionBoundary: "after_aces2_before_output_encoding",
  compositionLayer: "foreground", outputEncodingCount: 1,
  historicalAutomaticUpgrade: false, savedUpgrade: "explicit_one_way_recompile",
} as const;
export const referenceMotionGraphicPresentations = ["native_paint_v1", "native_paint_display_v2"] as const;
export function isNativeReferenceMotionPresentation(value: unknown): boolean {
  return value === "native_paint_v1" || value === "native_paint_display_v2";
}
const authoringRequirements = {
  latestAuthoringGeneration: 2,
  typographyPrerequisite: "actual_prepared_physical_glyphs",
  sourceGeometryPrerequisite: "upright_display_aspect_ratio_or_legacy_probed_dimensions",
  acceptance: "requires_current_source_and_complete_template_review",
} as const;

/** Original editable recipes. Reference video, typography and brand assets are not bundled. */
export const REFERENCE_MOTION_TEMPLATES = [
  { ...authoringRequirements, id: "strike_reframe", name: "刪去誤解 · 揭露重點", grammar: "focus_reveal", sourceSlots: 0, maxSources: 0,
    description: "先讀原句，短線刪去誤解，再揭露新的重點。", reference: "facebook:0–4s", minSeconds: 4 },
  { ...authoringRequirements, id: "level_bridge", name: "層級切換 · 穩定主標", grammar: "chapter_progress", sourceSlots: 0, maxSources: 0,
    description: "眉題、主標分層入場；閱讀時位置固定。", reference: "instagram:33–37s", minSeconds: 3 },
  { ...authoringRequirements, id: "comparison_pair", name: "兩份證據 · 並列比較", grammar: "comparison", sourceSlots: 1, maxSources: 1,
    description: "兩份不同素材等尺度並列，保留同一個比較基準。", reference: "facebook:8–14s", minSeconds: 4 },
  { ...authoringRequirements, id: "context_stack", name: "上下文 · 逐層組裝", grammar: "context_assembly", sourceSlots: 0, maxSources: 0,
    description: "2 至 4 份短資訊依因果順序出場，最後共同停留。", reference: "facebook:23–35s", minSeconds: 4 },
  { ...authoringRequirements, id: "evidence_takeover", name: "證據接管 · 回到原畫面", grammar: "evidence_takeover", sourceSlots: 0, maxSources: 0,
    description: "同一份影片從框內放大至全畫面，觀看後回到框內；來源時間連續。", reference: "instagram:16–20s", minSeconds: 5 },
  { ...authoringRequirements, id: "focus_wall", name: "作品集合 · 選中聚焦", grammar: "focus_wall", sourceSlots: 2, maxSources: 8,
    description: "3 至 9 份不同影片先總覽，再讓選中影片放大；其餘降亮度後穩定停留。平面作品牆。", reference: "instagram:46–55s", minSeconds: 5 },
  { ...authoringRequirements, id: "brand_recap", name: "重點回顧 · 依序收束", grammar: "context_assembly", sourceSlots: 0, maxSources: 0,
    description: "真實影片持續播放，2 至 4 個短重點輪流成為主視覺；依閱讀時間安排交接。", reference: "facebook:51–59s", minSeconds: 4 },
  { ...authoringRequirements, id: "kinetic_network", name: "能力連結 · 三幕動態敘事", grammar: "context_assembly", sourceSlots: 0, maxSources: 0,
    description: "三個短語依序主導畫面；原生點群從分散、聚合到連線，每幕保留停留。抽象概念圖，不代表真實人數或平台成果。", reference: "facebook:1090924177018347:0–15s / 1083483141329004:11–17s", minSeconds: 8 },
] as const;

export const referenceMotionTemplateIds = REFERENCE_MOTION_TEMPLATES.map(item => item.id) as
  [typeof REFERENCE_MOTION_TEMPLATES[number]["id"], ...typeof REFERENCE_MOTION_TEMPLATES[number]["id"][]];
export type ReferenceMotionTemplateId = typeof REFERENCE_MOTION_TEMPLATES[number]["id"];

export const referenceMotionMediaPresentations = ["legacy_layout", "source_soft_v2"] as const;
export type ReferenceMotionMediaPresentation = typeof referenceMotionMediaPresentations[number];
export const referenceMotionStrikePresentations = ["legacy_layout", "semantic_replace_v1"] as const;
export type ReferenceMotionStrikePresentation = typeof referenceMotionStrikePresentations[number];
export const referenceMotionStrikeSurfaces = ["standalone", "source_overlay"] as const;
export type ReferenceMotionStrikeSurface = typeof referenceMotionStrikeSurfaces[number];
/** Separate from immutable recipe descriptors used by saved dependency hashes. */
export const REFERENCE_MOTION_MEDIA_PRESENTATION_CAPABILITIES = {
  comparison_pair: { newAuthoringDefault: "source_soft_v2", supported: referenceMotionMediaPresentations,
    scope: "two upright-DAR contain matte windows; existing clip entrance keys; no scene camera or source replacement" },
} as const;
export const REFERENCE_MOTION_GRAPHIC_CADENCE_CAPABILITIES = {
  supported: GRAPHIC_CADENCE_PROFILES, historicalOmittedDefault: "legacy", brisk: GRAPHIC_CADENCE_BRISK_CONTRACT,
  scope: "generation2 graphic and recipe transition timing; source playback and reading minima unchanged; no native longform upgrade",
} as const;
/** Text wordmarks are caller-authored copy, not imported image Logos or verified brand ownership. */
export const REFERENCE_MOTION_STRIKE_PRESENTATION_CAPABILITIES = {
  strike_reframe: { newAuthoringDefault: "semantic_replace_v1", historicalOmittedDefault: "legacy_layout",
    supported: referenceMotionStrikePresentations, authoringGeneration: 2,
    brandMark: { kind: "editable_text", optIn: true, maximumCodepoints: 16, imageLogoSupported: false },
    scope: "same-focus old phrase, physical crossout and replacement; source/audio clocks and reading minima unchanged" },
} as const;
/** Only explicit new presentations consume this contract in their dependency identity. */
export const REFERENCE_MOTION_SEMANTIC_REPLACE_CONTRACT = {
  id: "editkin.strike-semantic-replacement/v1", focus: "same_anchor",
  oldPhrase: "exits_before_replacement", ink: "editkin.motion-vector-annotation/v1",
  persistentEyebrow: "first_and_last_frame", supportLine: "physical_title_bounds",
  brandMark: "text_wordmark_not_image_logo",
  focusAnchor: { x: .085, yPortrait: .335, yLandscape: .31, width: .83 },
  fontPixels1080: { previous: 84, headline: 132, subtitle: 40, kicker: 30, brandMark: 40 },
  fontWeights: { previous: 700, headline: 900 }, supportGapPixels1080: 28,
  struckReadSeconds: .3, annotationHeightPixels1080: 4, gridFooterY: .82,
  defaultEyebrow: "誤解 → 重點",
} as const;

/** Opt-in source visibility contract; never included in historical scene fingerprints. */
export const REFERENCE_MOTION_SOURCE_OVERLAY_CONTRACT = {
  id: "editkin.strike-source-overlay/v1", supported: referenceMotionStrikeSurfaces,
  historicalOmittedDefault: "standalone", sourceGeometry: "unchanged",
  sourceClocks: "unchanged", backing: "physical_ink_and_motion_bounds",
  focusAnchor: { x: .085, yPortrait: .58, yLandscape: .46, width: .83 },
  paddingPixels1080: 16, maximumPanels: 2, maximumMainArea: .45, maximumCombinedArea: .50,
  surfaceAlphaHex: "F5", drawOrder: "backing_before_ink", imageLogoSupported: false,
} as const;

const sourceSlotSchema = z.strictObject({
  assetId: z.string().trim().min(1).max(160), sourceStart: z.number().finite().nonnegative(),
  label: z.string().trim().min(1).max(20),
});
export const referenceMotionTemplateInputSchema = z.strictObject({
  templateId: z.enum(referenceMotionTemplateIds), clipId: z.string().trim().min(1),
  startFrame: z.number().int().nonnegative(), durationFrames: z.number().int().min(30).max(1800),
  title: z.string().trim().min(1).max(32), kicker: z.string().trim().max(24).optional(),
  subtitle: z.string().trim().max(40).optional(), previousText: z.string().trim().max(24).optional(),
  items: z.array(z.strictObject({ label: z.string().trim().min(1).max(24), detail: z.string().trim().max(40).optional() })).min(2).max(4).optional(),
  sources: z.array(sourceSlotSchema).max(8).default([]),
  primaryLabel: z.string().trim().max(20).optional(),
  // Historical omitted input must retain the legacy compiler path on reopen.
  mediaPresentation: z.enum(referenceMotionMediaPresentations).optional(),
  graphicCadence: z.enum(GRAPHIC_CADENCE_PROFILES).optional(),
  graphicPresentation: z.enum(referenceMotionGraphicPresentations).describe("level_bridge: native_paint_v1 preserves scene paint; native_paint_display_v2 explicitly keeps authored Rec.709 SDR colors after the scene transform. Requires matching current native runtime.").optional(),
  strikePresentation: z.enum(referenceMotionStrikePresentations).optional(),
  strikeSurface: z.enum(referenceMotionStrikeSurfaces).optional(),
  brandMark: z.string().trim().min(1).max(32)
    .refine(value => Array.from(value).length <= 16, "文字字標最多 16 字").optional(),
  focusRegion: z.strictObject({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1),
    width: z.number().finite().positive().max(1), height: z.number().finite().positive().max(1) })
    .refine(r => r.x + r.width <= 1 + 1e-9 && r.y + r.height <= 1 + 1e-9, "主體範圍超出來源畫面").optional(),
  network: z.strictObject({ seed: z.number().int().min(0).max(0xffffffff), points: z.number().int().min(8).max(64),
    labels: z.array(z.string().trim().min(1).max(6)).length(3).optional(), hubLabel: z.string().trim().min(1).max(6).optional(),
    groupColors: z.tuple([z.string().regex(/^#[0-9a-f]{6}$/i), z.string().regex(/^#[0-9a-f]{6}$/i), z.string().regex(/^#[0-9a-f]{6}$/i)]).optional() }).optional(),
  intent: z.enum(["shortform", "standalone_showcase"]).default("shortform"),
  purpose: z.string().trim().min(1).max(160),
  evidenceRefs: z.array(z.string().trim().min(1).max(160)).min(1).max(8),
  style: motionSceneStyleSchema.optional(),
}).superRefine((input, context) => {
  if (input.graphicPresentation !== undefined && input.templateId !== "level_bridge") {
    context.addIssue({ code: "custom", path: ["graphicPresentation"], message: "Native paint presentation currently supports level_bridge only" });
  }
  if (input.strikePresentation !== undefined && input.templateId !== "strike_reframe") {
    context.addIssue({ code: "custom", path: ["strikePresentation"], message: "刪線呈現只接受 strike_reframe 模板" });
  }
  if (input.brandMark !== undefined && (input.templateId !== "strike_reframe" || input.strikePresentation !== "semantic_replace_v1")) {
    context.addIssue({ code: "custom", path: ["brandMark"], message: "文字字標只接受 semantic_replace_v1 刪線呈現" });
  }
  if (input.strikeSurface !== undefined && (input.templateId !== "strike_reframe" || input.strikePresentation !== "semantic_replace_v1")) {
    context.addIssue({ code: "custom", path: ["strikeSurface"], message: "畫面用途只接受明確 semantic_replace_v1 刪線呈現" });
  }
});
export type ReferenceMotionTemplateInput = z.input<typeof referenceMotionTemplateInputSchema>;
export type ReferenceMotionSourceSlot = z.infer<typeof sourceSlotSchema>;

export function referenceMotionTemplate(id: ReferenceMotionTemplateId) {
  return REFERENCE_MOTION_TEMPLATES.find(item => item.id === id)!;
}
