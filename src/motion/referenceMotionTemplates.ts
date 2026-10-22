import { z } from "zod";
import { motionSceneStyleSchema } from "../domain/motionSceneStyle";
import type { MotionSceneStyle } from "../domain/motionSceneStyle";
import { fixedTemplateWindowV3Schema } from "../domain/fixedTemplateWindowV3";
import { graphicCopyFitV3Schema } from "../domain/graphicCopyFitV3";
import { graphicPosterRangeV3Schema } from "../domain/graphicPosterRangeV3";
import { graphicHoldBeatV3Schema } from "../domain/graphicHoldBeatV3";
import { graphicTimingV2Schema } from "../domain/graphicTimingV2";
import { GRAPHIC_CADENCE_PROFILES, GRAPHIC_CADENCE_BRISK_CONTRACT, GRAPHIC_CADENCE_KINETIC_CONTRACT } from "./graphicCadence";

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
  // Learned from the 2026-10-07 Opus motion study (grammar only; nothing copied): count-up dashboards and statement cuts.
  { ...authoringRequirements, id: "stat_reveal", name: "數據揭示 · 計數儀表", grammar: "data_reveal", sourceSlots: 0, maxSources: 0,
    description: "第一個核對數字放大計數到位（百分比畫成環），其餘 1 至 3 個數字依序計數成列；只畫真實數字，不杜撰比例。", reference: "study:ai9-opus55 leonabboud 7–8s / twoclipping 14–16s", minSeconds: 5 },
  { ...authoringRequirements, id: "statement_cut", name: "宣言快切 · 單字主張", grammar: "statement_cut", sourceSlots: 0, maxSources: 0,
    description: "2 至 4 個短主張各佔一拍，整色底依序切換、圓形擦除交接、取景框角框住主字；抽象章節卡。", reference: "study:ai9-opus55 leonabboud 5–6s / hqmank 16–19s", minSeconds: 5 },
  // Reproduced reference scenes (Hao 2026-10-07 「把他們的東西都抄下來保留」); design themes only, every style.
  { ...authoringRequirements, id: "word_build", name: "逐字標題 · 開場鉤子", grammar: "word_build", sourceSlots: 0, maxSources: 0,
    description: "標題以空格分詞，一詞一拍置中堆疊；第二行（subtitle）接著出現，強調字由風格標記。中文詞之間的空格不顯示。", reference: "study:ai9-opus55 twoclipping 0–2s", minSeconds: 4 },
  { ...authoringRequirements, id: "stat_cycle", name: "大數字輪播 · 成果拍點", grammar: "data_reveal", sourceSlots: 0, maxSources: 0,
    description: "2 至 4 個核對過的數字輪流佔滿畫面，計數或對焦入場、下方附說明，下一個以模糊推走前一個；最後一個停留。", reference: "study:ai9-opus55 twoclipping 14.5–16s", minSeconds: 6 },
  { ...authoringRequirements, id: "word_cycle", name: "字詞輪播 · 收尾一句", grammar: "word_cycle", sourceSlots: 0, maxSources: 0,
    description: "2 至 4 個短詞在中央上下輪替（下一個在下方淡淡等候），最後一詞以強調色落定，主標作為下方標語。", reference: "study:ai9-opus55 twoclipping 16.5–18s", minSeconds: 6 },
  { ...authoringRequirements, id: "logo_end", name: "片尾 Logo · 品牌收束", grammar: "brand_end", sourceSlots: 0, maxSources: 0,
    description: "風格標記與文字字標（brandMark）由左而右成形，subtitle 為低語行，細線後以主標作字距標語，kicker 為頁尾小字。", reference: "study:ai9-opus55 twoclipping 18.5–19.5s / leonabboud 13.5–15s", minSeconds: 4 },
  { ...authoringRequirements, id: "ranked_list", name: "排行清單 · 逐列計分", grammar: "ranked_list", sourceSlots: 0, maxSources: 0,
    description: "主標之下 2 至 4 列依序出現：強調色序號、內容、右側核對過的分數計數（detail，可省略），primaryLabel 為分數說明。", reference: "study:ai9-opus55 twoclipping 6.25–8s", minSeconds: 6 },
  { ...authoringRequirements, id: "ui_demo", name: "介面示範 · 游標操作", grammar: "ui_demo", sourceSlots: 0, maxSources: 0,
    description: "浮起的設定卡（主標與 kicker），2 至 4 個設定列（detail 為值，省略則為開關），游標移動點開關、按下按鈕（primaryLabel），進度掃過後顯示完成與通知（subtitle）。示意介面，不代表真實產品畫面。", reference: "study:ai9-opus55 leonabboud 10–11.5s / twoclipping 2.5–3.5s", minSeconds: 6 },
  { ...authoringRequirements, id: "mark_open", name: "標記開場 · 一點成線", grammar: "mark_open", sourceSlots: 0, maxSources: 0,
    description: "風格標記落下並漾開，kicker 打字出現，標記拉成橫線、展開成整色底，主標滾入、subtitle 為低語行。", reference: "study:ai9-opus55 leonabboud 0–2.25s", minSeconds: 6 },
] as const;

/** Recipes that exist only as design themes (no legacy compiler); every other recipe also compiles without designSystem. */
export const REFERENCE_MOTION_DESIGN_ONLY_TEMPLATE_IDS = ["stat_reveal", "statement_cut", "word_build", "stat_cycle", "word_cycle", "logo_end", "ranked_list",
  "ui_demo", "mark_open"] as const;
export const REFERENCE_MOTION_LEGACY_TEMPLATES = REFERENCE_MOTION_TEMPLATES.filter(template =>
  !(REFERENCE_MOTION_DESIGN_ONLY_TEMPLATE_IDS as readonly string[]).includes(template.id));

export const referenceMotionTemplateIds = REFERENCE_MOTION_TEMPLATES.map(item => item.id) as
  [typeof REFERENCE_MOTION_TEMPLATES[number]["id"], ...typeof REFERENCE_MOTION_TEMPLATES[number]["id"][]];
export type ReferenceMotionTemplateId = typeof REFERENCE_MOTION_TEMPLATES[number]["id"];

export const referenceMotionMediaPresentations = ["legacy_layout", "source_soft_v2"] as const;
export type ReferenceMotionMediaPresentation = typeof referenceMotionMediaPresentations[number];
export const referenceMotionStrikePresentations = ["legacy_layout", "semantic_replace_v1"] as const;
export type ReferenceMotionStrikePresentation = typeof referenceMotionStrikePresentations[number];
export const referenceMotionStrikeSurfaces = ["standalone", "source_overlay"] as const;
/** Authoring values. The V1 `supported` list above stays part of saved source-overlay identities. */
export const referenceMotionStrikeSurfaceInputs = [...referenceMotionStrikeSurfaces, "source_overlay_v2"] as const;
export type ReferenceMotionStrikeSurface = typeof referenceMotionStrikeSurfaceInputs[number];
/** Separate from immutable recipe descriptors used by saved dependency hashes. */
export const REFERENCE_MOTION_MEDIA_PRESENTATION_CAPABILITIES = {
  comparison_pair: { newAuthoringDefault: "source_soft_v2", supported: referenceMotionMediaPresentations,
    scope: "two upright-DAR contain matte windows; existing clip entrance keys; no scene camera or source replacement" },
} as const;
export const REFERENCE_MOTION_GRAPHIC_CADENCE_CAPABILITIES = {
  supported: GRAPHIC_CADENCE_PROFILES, historicalOmittedDefault: "legacy", brisk: GRAPHIC_CADENCE_BRISK_CONTRACT, kinetic: GRAPHIC_CADENCE_KINETIC_CONTRACT,
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

export const referenceMotionOverlayPresentations = ["source_editorial_v1"] as const;
export type ReferenceMotionOverlayPresentation = typeof referenceMotionOverlayPresentations[number];
/** Explicit on-footage editorial presentation for level_bridge, context_stack and brand_recap with its own recipe
 * identity; historical scenes never upgrade. The live source stays full-bleed and unchanged. White-first type sits in a
 * caller-observed quiet region in one left ink column with a soft shadow halo, Motion Language staged entrances and a
 * clean tail. No backing cards, grids, numbered rows, counters or letterboxed windows. */
export const REFERENCE_MOTION_EDITORIAL_CONTRACT = {
  id: "editkin.reference-motion-source-editorial/v1", families: ["level_bridge", "context_stack", "brand_recap"],
  backing: "none_observed_negative_space", source: "full_bleed_unchanged",
  textRegion: { evidence: "caller_observed_quiet_region", defaultAnchor: { x: .085, yPortrait: .335, yLandscape: .3, width: .83 } },
  focusRegion: "brand_recap_subject_never_covered", ink: "lightest_palette_colour_white_first",
  shadow: { offsetPixels1080: 2, haloEm: .12, colour: "#0000008C" },
  roles: {
    kicker: { size: 32, weight: 600, voice: "body", alpha: "E6", tracking: 2 },
    title: { size: 124, weight: 900, voice: "heading", tracking: 0 },
    subtitle: { size: 44, weight: 500, voice: "body", alpha: "F0", tracking: 0 },
    stackTitle: { size: 64, weight: 900, voice: "heading", tracking: 0 },
    itemLabel: { size: 60, weight: 800, voice: "heading", tracking: 0 },
    itemDetail: { size: 36, weight: 500, voice: "body", alpha: "E6", tracking: 0 },
    recapLabel: { size: 168, weight: 900, voice: "heading", tracking: 0 },
    recapDetail: { size: 46, weight: 600, voice: "body", alpha: "F0", tracking: 0 },
    // Window families (source_backdrop_v1): one title band above the windows and quiet labels under them.
    bandTitle: { size: 92, weight: 900, voice: "heading", tracking: 0 },
    windowLabel: { size: 44, weight: 700, voice: "body", alpha: "F0", tracking: 0 },
  },
  gapEm: { kicker: .22, subtitle: .2, item: .5, detail: .2 },
  // Each line's measured first physical ink sits on its ink line; role weights resolve to the bundled physical face.
  inkPlacement: "measured_first_ink", weightResolution: "nearest_bundled_physical_face",
  motion: { kicker: "swipe", title: "rise", support: "focus", item: "swipe", recap: "slam" },
  connector: { widthPixels1080: 4, nodePixels1080: 16, indentPixels1080: 44 },
  // Text holds for its reading plus a re-read margin, then the footage plays clean (at least cleanTailSeconds).
  readingMarginSeconds: 1.5, cleanTailSeconds: 1.2, imageLogoSupported: false,
} as const;

export const referenceMotionWindowPresentations = ["source_backdrop_v1"] as const;
export type ReferenceMotionWindowPresentation = typeof referenceMotionWindowPresentations[number];
/** Explicit window-family presentation, Hao's rule for non-full-frame shots: the same image, enlarged and softly blurred,
 * fills the frame. That backdrop is the primary clip itself, so its audio and clock never change; every window is a
 * silent source clone, and copy is white-first editorial ink in a top band instead of a header box or a dark stage. */
export const REFERENCE_MOTION_SOURCE_BACKDROP_CONTRACT = {
  id: "editkin.reference-motion-source-backdrop/v1", families: ["comparison_pair", "evidence_takeover", "focus_wall"],
  backdrop: { clip: "primary_audio_and_clock_unchanged", scale: 1.12, effectPresetId: "studio_backdrop_soft" },
  windows: "silent_source_clones_rounded_feathered_source_ratio", stage: "none", header: "none_white_first_editorial_ink",
  textBand: { portrait: { x: .085, y: .07, width: .83, height: .175 }, landscape: { x: .07, y: .06, width: .86, height: .18 } },
  roles: { kicker: "kicker", title: "bandTitle", label: "windowLabel", support: "subtitle" },
} as const;

export const referenceMotionDesignSystems = ["swiss_blue_v1", "trip_pop_v1", "tech_spec_v1", "game_hud_v1",
  "reel_bold_v1", "reel_night_v1", "launch_clean_v1", "launch_dark_v1"] as const;
export type ReferenceMotionDesignSystem = typeof referenceMotionDesignSystems[number];
export const referenceMotionVerdicts = ["good", "bad"] as const;
/** Genre themes (Hao 2026-10-07: 「把每個主題做成一種模板…旅遊那些就需要很活潑的動態」). One shared family grammar
 * (eight families, measured physical type, reading holds) with a complete visual and motion language per genre. Genre is
 * not a recolour: each theme brings its own type, shapes, frames, labels, strike and motion personality. Every colour comes
 * from the editable style.palette (Hao: 「要記得做到能讓用戶自由改色」); theme defaults use Hao's verified VA colours. */
export const REFERENCE_MOTION_DESIGN_THEMES = {
  swiss_blue_v1: { name: "瑞士藍", tone: "formal", genres: ["教學", "Podcast", "訪談", "知識", "評論"],
    niches: ["teaching", "ai", "interview", "documentary", "business", "architecture"], vaStyles: ["cobalt_poetry", "cyan_lab", "ai_chalk_grid"],
    language: "Hao's poster board: one theme colour with ink and a light paper, heavy grotesk flush-left on a strict grid, small-print info and hairlines, condensed display numerals, bold bars across type, boxed labels, an arch window with a soft glow",
    motion: "decisive expo-out rises, wipes from the left, no bounce",
    defaultStyle: { palette: { surface: "#F1F1EF", text: "#0D0D10", accent: "#2026E8", muted: "#64646E", separator: "#0D0D10" },
      typography: { headingFamily: "Noto Sans TC", bodyFamily: "Noto Sans TC" }, animationSpeed: 1 },
    paletteRoles: { surface: "paper", text: "ink", accent: "theme colour (fields, bars, numerals, accent words)", muted: "secondary copy", separator: "rules and marks" },
    numeralFamily: "Bebas Neue" },
  trip_pop_v1: { name: "旅遊手帳", tone: "lively", genres: ["旅遊", "美食", "Vlog", "市集", "活動"],
    niches: ["travel", "food", "cafe", "dessert", "nature", "fashion"], vaStyles: ["travel_journal", "food_pop", "food_steam", "food_heritage", "food_editorial", "matcha_fresh", "festival_block"],
    language: "a sunny travel journal: cream paper with soft colour blooms and sparkles, handwritten Kai headlines, tilted polaroids with tape, sticker pills with outlines and hard shadows, map pins, wavy underlines and scribble strikes",
    motion: "springy character bounces, stickers slapped on with overshoot, polaroids that develop",
    defaultStyle: { palette: { surface: "#FFF4E6", text: "#2B2622", accent: "#5AB0FF", muted: "#857A70", separator: "#FF6B6B" },
      typography: { headingFamily: "LXGW WenKai TC", bodyFamily: "Noto Sans TC" }, animationSpeed: 1 },
    paletteRoles: { surface: "paper", text: "ink and outlines", accent: "main sticker and accent colour", muted: "secondary copy", separator: "second sticker colour (pins, underlines, tags)" },
    numeralFamily: "Fredoka" },
  tech_spec_v1: { name: "科技規格", tone: "sleek", genres: ["開箱", "3C", "評測", "產品"],
    niches: ["unboxing", "product", "automotive", "diy", "toy"], vaStyles: ["holo_future", "electric_lab", "shape_play"],
    language: "a product spec sheet in a dark studio: graphite page with a fine dot grid and an accent glow, crisp image blocks with viewfinder brackets, outlined spec chips, leader dots, condensed display numerals",
    motion: "precise quint-out slides, brackets and lines drawing in",
    defaultStyle: { palette: { surface: "#111317", text: "#F3F5F8", accent: "#5AB0FF", muted: "#8C93A0", separator: "#FF74A8" },
      typography: { headingFamily: "Noto Sans TC", bodyFamily: "Noto Sans TC" }, animationSpeed: 1 },
    paletteRoles: { surface: "studio page", text: "ink", accent: "spec colour (brackets, chips, numerals)", muted: "secondary copy", separator: "second spec colour (alerts, verdicts)" },
    numeralFamily: "Bebas Neue" },
  game_hud_v1: { name: "電競 HUD", tone: "energetic", genres: ["遊戲", "電競", "實況精華"],
    niches: ["game", "gaming", "music", "fitness"], vaStyles: ["night_signal", "brush_rush"],
    language: "a game HUD: near-black page with scanlines and speed stripes, chamfered frames and tags, corner brackets, colour-split heavy titles, slash strikes",
    motion: "slams with scale and blur, snappy offsets",
    defaultStyle: { palette: { surface: "#0D0C16", text: "#FFFFFF", accent: "#3FC9B0", muted: "#8F8BA8", separator: "#A66BFF" },
      typography: { headingFamily: "Noto Sans TC", bodyFamily: "Noto Sans TC" }, animationSpeed: 1 },
    paletteRoles: { surface: "dark page", text: "ink", accent: "main HUD colour", muted: "secondary copy", separator: "second HUD colour (splits, chips)" },
    numeralFamily: "Bebas Neue" },
  // Reference-study styles (Hao 2026-10-07: 「我給你的參考資料你應該把他們的東西都抄下來保留…到時候就有大量模板可以選擇套用」):
  // a studied reference's visual system (colour structure, type pairing, chrome, motion) is reproduced for every family.
  // Author names, logos, product UI, footage and fonts are not copied, every colour stays editable, and these styles are
  // private study material (not exported to the public kit).
  reel_bold_v1: { name: "作品集 Showreel", tone: "bold", origin: "reference_study", genres: ["作品集", "品牌介紹", "頻道預告", "年度回顧", "AI 教學"],
    niches: ["portfolio", "brand", "trailer", "recap", "ai", "teaching"], vaStyles: [],
    study: "ai9app Opus 5.5 list: leonabboud 15-s motion-designer showreel (0–15 s, frame-sampled at 4 fps)",
    language: "a motion designer's reel: whole fields of bone, ink and a hot signal colour; a heavy grotesk that tumbles up out of its line, a Kai whisper line, a signal dot as the recurring punctuation, HUD micro labels with viewfinder corner marks, footage in viewfinder brackets with its real frame size and source time, lines that draw with a dot tip and radial bursts",
    motion: "per-character tumble rises inside line windows, focus-pull swipes, bursts on the beat, expo-out",
    defaultStyle: { palette: { surface: "#EEECE7", text: "#0B0D14", accent: "#FF4A1C", muted: "#6B6B75", separator: "#2E3BEB" },
      typography: { headingFamily: "Noto Sans TC", bodyFamily: "LXGW WenKai TC" }, animationSpeed: 1 },
    paletteRoles: { surface: "bone page", text: "ink (type, dark fields)", accent: "signal colour (fields, the dot, accent words, bursts)", muted: "HUD labels and secondary copy", separator: "second field colour (tags, second fields)" },
    numeralFamily: "Noto Sans TC" },
  reel_night_v1: { name: "作品集 Showreel・夜", tone: "bold", origin: "reference_study", genres: ["作品集", "品牌介紹", "頻道預告", "遊戲", "科技"],
    niches: ["portfolio", "brand", "trailer", "game", "tech"], vaStyles: [],
    study: "ai9app Opus 5.5 list: leonabboud 15-s motion-designer showreel, opening and end-card ink field",
    language: "the showreel on its ink field: navy-black page with a quiet dot grid, bone type, the signal dot and signal-coloured fields, HUD micro labels, viewfinder brackets and radial bursts",
    motion: "per-character tumble rises inside line windows, focus-pull swipes, bursts on the beat, expo-out",
    defaultStyle: { palette: { surface: "#0B0D14", text: "#EEECE7", accent: "#FF4A1C", muted: "#8C8C99", separator: "#2E3BEB" },
      typography: { headingFamily: "Noto Sans TC", bodyFamily: "LXGW WenKai TC" }, animationSpeed: 1 },
    paletteRoles: { surface: "ink page", text: "bone type", accent: "signal colour (fields, the dot, accent words, bursts)", muted: "HUD labels and secondary copy", separator: "second field colour (tags, second fields)" },
    numeralFamily: "Noto Sans TC" },
  launch_clean_v1: { name: "產品發表", tone: "clean", origin: "reference_study", genres: ["產品發表", "App 介紹", "AI 工具", "開箱", "教學"],
    niches: ["product", "launch", "app", "ai", "saas", "unboxing"], vaStyles: [],
    study: "ai9app Opus 5.5 list: twoclipping 20-s beat-synced product launch (0–20 s, frame-sampled at 4 fps)",
    language: "a product launch: studio-white page with soft warm blooms, heavy grotesk set tight, words rising in with a focus pull, the accent word in the brand colour on a soft highlight, footage in app windows with window dots and soft shadows, quiet grey captions, rounded pills and a brand-coloured app mark",
    motion: "quick quint-out rises with a focus pull, small overshoot pops for pills and toggles, blur cross-fades between big numbers",
    defaultStyle: { palette: { surface: "#F5F3F0", text: "#141414", accent: "#FF5A3C", muted: "#85858B", separator: "#22C55E" },
      typography: { headingFamily: "Noto Sans TC", bodyFamily: "Noto Sans TC" }, animationSpeed: 1 },
    paletteRoles: { surface: "studio page", text: "ink", accent: "brand colour (app mark, accent words, progress, glows)", muted: "captions and secondary copy", separator: "live colour (toggles, done, good verdicts)" },
    numeralFamily: "Noto Sans TC" },
  launch_dark_v1: { name: "產品發表・暗場", tone: "clean", origin: "reference_study", genres: ["產品發表", "AI 工具", "數據成果", "開箱"],
    niches: ["product", "launch", "ai", "saas", "results"], vaStyles: [],
    study: "ai9app Opus 5.5 list: twoclipping 20-s product launch, dark stage scenes (wall, stats, logo)",
    language: "the launch on its charcoal stage: a low warm glow, white heavy grotesk and big numbers blurring in, quiet grey captions, app windows with soft shadows and window dots, rounded pills and a brand-coloured app mark",
    motion: "quick quint-out rises with a focus pull, small overshoot pops for pills and toggles, blur cross-fades between big numbers",
    defaultStyle: { palette: { surface: "#121212", text: "#F7F7F5", accent: "#FF5A3C", muted: "#8E8E95", separator: "#22C55E" },
      typography: { headingFamily: "Noto Sans TC", bodyFamily: "Noto Sans TC" }, animationSpeed: 1 },
    paletteRoles: { surface: "charcoal stage", text: "ink", accent: "brand colour (app mark, accent words, progress, glows)", muted: "captions and secondary copy", separator: "live colour (toggles, done, good verdicts)" },
    numeralFamily: "Noto Sans TC" },
} as const satisfies Record<ReferenceMotionDesignSystem, { defaultStyle: MotionSceneStyle } & Record<string, unknown>>;
/** Top layer of the template library (Hao 2026-10-07: 「影片主題種類在最上層還是模板視覺在最上層」): the video type is the
 * entry point and only ranks styles and scenes; a template is style × scene, so any style still applies to any type. */
export const REFERENCE_MOTION_VIDEO_TYPES = {
  teaching: { name: "教學", styles: ["swiss_blue_v1", "launch_clean_v1", "reel_bold_v1", "tech_spec_v1"],
    scenes: ["strike_reframe", "context_stack", "statement_cut", "stat_reveal", "comparison_pair", "evidence_takeover", "level_bridge", "brand_recap"] },
  podcast: { name: "Podcast・訪談", styles: ["swiss_blue_v1", "reel_night_v1", "reel_bold_v1"],
    scenes: ["level_bridge", "statement_cut", "strike_reframe", "stat_reveal", "kinetic_network", "brand_recap"] },
  travel: { name: "旅遊", styles: ["trip_pop_v1", "reel_bold_v1", "swiss_blue_v1"],
    scenes: ["level_bridge", "context_stack", "brand_recap", "evidence_takeover", "focus_wall", "stat_reveal", "statement_cut"] },
  food: { name: "美食", styles: ["trip_pop_v1", "launch_clean_v1", "reel_bold_v1"],
    scenes: ["evidence_takeover", "comparison_pair", "context_stack", "stat_reveal", "focus_wall", "strike_reframe"] },
  unboxing: { name: "開箱・3C", styles: ["tech_spec_v1", "launch_dark_v1", "launch_clean_v1"],
    scenes: ["level_bridge", "comparison_pair", "stat_reveal", "evidence_takeover", "context_stack", "strike_reframe"] },
  game: { name: "遊戲", styles: ["game_hud_v1", "reel_night_v1", "tech_spec_v1"],
    scenes: ["level_bridge", "statement_cut", "comparison_pair", "stat_reveal", "kinetic_network", "evidence_takeover"] },
  product: { name: "產品發表・AI 工具", styles: ["launch_clean_v1", "launch_dark_v1", "tech_spec_v1", "reel_bold_v1"],
    scenes: ["statement_cut", "context_stack", "stat_reveal", "evidence_takeover", "focus_wall", "comparison_pair"] },
  brand: { name: "品牌・作品集", styles: ["reel_bold_v1", "reel_night_v1", "launch_dark_v1", "swiss_blue_v1"],
    scenes: ["statement_cut", "focus_wall", "stat_reveal", "kinetic_network", "brand_recap", "level_bridge"] },
  knowledge: { name: "知識・歷史", styles: ["swiss_blue_v1", "reel_bold_v1", "trip_pop_v1"],
    scenes: ["brand_recap", "strike_reframe", "context_stack", "stat_reveal", "kinetic_network", "statement_cut"] },
} as const satisfies Record<string, { name: string; styles: readonly ReferenceMotionDesignSystem[]; scenes: readonly ReferenceMotionTemplateId[] }>;
export const designThemeDefaultStyle = (id: ReferenceMotionDesignSystem): MotionSceneStyle =>
  structuredClone(REFERENCE_MOTION_DESIGN_THEMES[id].defaultStyle) as MotionSceneStyle;
/** Shared design grammar for every theme: families, portrait grid (1080x1920 design pixels; positions scale with the
 * canvas, sizes with its short side), reading-safe motion and measured physical type. Shorts layout v2: every readable
 * glyph stays inside the Shorts/Reels safe area (text column x 90-930, ink y 276-1640; VA R12 x<=930, 260<=y<=1660);
 * footage may run wider (40-1040) and lower (to 1880), under the platform overlay, because the picture is the proof. */
export const REFERENCE_MOTION_DESIGN_CONTRACT = {
  id: "editkin.reference-motion-design/v1",
  families: ["strike_reframe", "level_bridge", "comparison_pair", "context_stack", "evidence_takeover", "focus_wall", "brand_recap", "kinetic_network",
    "stat_reveal", "statement_cut", "word_build", "stat_cycle", "word_cycle", "logo_end", "ranked_list", "ui_demo", "mark_open"],
  orientation: "portrait_9x16",
  grid: { margin: 90, textRight: 930, mediaMargin: 40, topInk: 276, topRule: 326, contentTop: 368, contentBottom: 1640, mediaBottom: 1880, footer: 1856 },
  image: { plateFrames: 8, fadeFrames: 7 },
  wall: { monochromeEffectPresetId: "mono_halftone", tintOpacity: .52, dimOpacity: .26 },
  tagMaxCodepoints: 8, numeralMaxPixels: 220,
  inkPlacement: "measured_first_ink", weightResolution: "nearest_bundled_physical_face",
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
/** Explicit on-footage editorial successor with its own identity; V1 above is never mutated. No backing card: the
 * reading group sits in a caller-observed quiet region of the actual footage (textRegion, evidence-gated), white-first
 * type with a subtle offset shadow. The complete claim and location are readable on the first frame; the location
 * leaves with the struck claim, the answer drops in at the same anchor, and a clean tail returns the shot to the source. */
export const REFERENCE_MOTION_SOURCE_OVERLAY_V2_CONTRACT = {
  id: "editkin.strike-source-editorial/v2", supported: referenceMotionStrikeSurfaceInputs,
  sourceGeometry: "unchanged", sourceClocks: "unchanged", backing: "none_observed_negative_space",
  textRegion: { evidence: "caller_observed_quiet_region", defaultAnchor: { x: .085, yPortrait: .335, yLandscape: .3, width: .83 } },
  firstFrame: "complete_claim_and_location", location: "claim_phase_only", ink: "lightest_palette_colour_white_first",
  fontPixels1080: { claim: 132, headline: 132, support: 44, location: 32, credit: 28 },
  fontWeights: { claim: 900, headline: 900, support: 500, location: 600, credit: 600 },
  inkAlpha: { support: "EB", location: "E0", credit: "B8" }, shadow: { offsetPixels1080: 3, haloEm: .1, colour: "#0000008C" },
  strikePixels1080: 8, gapEm: { location: .2, support: .2, credit: .55 },
  inkPlacement: "measured_first_ink", weightResolution: "nearest_bundled_physical_face",
  motion: { reveal: "drop", support: "focus", revealEnergy: "hype", supportEnergy: "standard" },
  // The answer holds for its reading plus a re-read margin, then the payoff shot plays clean (at least cleanTailSeconds).
  readingMarginSeconds: 1.5, cleanTailSeconds: 1.6, imageLogoSupported: false,
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
  graphicTimingV2: graphicTimingV2Schema.optional(),
  fixedWindowV3: fixedTemplateWindowV3Schema.optional(),
  copyFitV3: graphicCopyFitV3Schema.optional(),
  posterV3: graphicPosterRangeV3Schema.optional(),
  holdBeatV3: graphicHoldBeatV3Schema.optional(),
  graphicPresentation: z.enum(referenceMotionGraphicPresentations).describe("level_bridge: native_paint_v1 preserves scene paint; native_paint_display_v2 explicitly keeps authored Rec.709 SDR colors after the scene transform. Requires matching current native runtime.").optional(),
  strikePresentation: z.enum(referenceMotionStrikePresentations).optional(),
  strikeSurface: z.enum(referenceMotionStrikeSurfaceInputs).optional(),
  overlayPresentation: z.enum(referenceMotionOverlayPresentations)
    .describe("level_bridge, context_stack, brand_recap: source_editorial_v1 keeps the live source full-bleed and sets white-first type in textRegion without backing cards").optional(),
  designSystem: z.enum(referenceMotionDesignSystems)
    .describe("Genre theme for every family (portrait 9:16): swiss_blue_v1 formal (教學、Podcast、訪談、知識), trip_pop_v1 lively (旅遊、美食、Vlog), tech_spec_v1 sleek (開箱、3C、評測), game_hud_v1 energetic (遊戲、電競); reference-study styles reel_bold_v1 / reel_night_v1 (作品集 showreel: fields, tumble type, HUD, signal dot) and launch_clean_v1 / launch_dark_v1 (產品發表: studio page, focus-pull words, app windows). Pick by REFERENCE_MOTION_VIDEO_TYPES. Real footage plays in themed image blocks; style.palette (theme default when omitted) stays freely editable").optional(),
  accentText: z.string().trim().min(1).max(12).describe("designSystem: the one word of the title set in the accent colour; must occur in the title").optional(),
  tag: z.string().trim().min(1).max(16).refine(value => Array.from(value).length <= REFERENCE_MOTION_DESIGN_CONTRACT.tagMaxCodepoints, "標籤最多 8 字")
    .describe("designSystem strike_reframe: a short verdict label on the image block").optional(),
  verdicts: z.tuple([z.enum(referenceMotionVerdicts), z.enum(referenceMotionVerdicts)])
    .describe("designSystem comparison_pair: good/bad mark for the primary and the second source, in order").optional(),
  windowPresentation: z.enum(referenceMotionWindowPresentations)
    .describe("comparison_pair, evidence_takeover, focus_wall: source_backdrop_v1 sets sharp source windows over the same image enlarged and softly blurred, with white-first type and no dark stage or header box").optional(),
  brandMark: z.string().trim().min(1).max(32)
    .refine(value => Array.from(value).length <= 16, "文字字標最多 16 字").optional(),
  focusRegion: z.strictObject({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1),
    width: z.number().finite().positive().max(1), height: z.number().finite().positive().max(1) })
    .refine(r => r.x + r.width <= 1 + 1e-9 && r.y + r.height <= 1 + 1e-9, "主體範圍超出來源畫面").optional(),
  textRegion: z.strictObject({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1),
    width: z.number().finite().min(.2).max(1), height: z.number().finite().min(.08).max(1) })
    .refine(r => r.x + r.width <= 1 + 1e-9 && r.y + r.height <= 1 + 1e-9, "文字留白範圍超出來源畫面")
    .describe("source_overlay_v2: observed quiet negative space of the actual footage (e.g. from viewed keyframes or measured luminance) where the reading group may sit").optional(),
  network: z.strictObject({ seed: z.number().int().min(0).max(0xffffffff), points: z.number().int().min(8).max(64),
    labels: z.array(z.string().trim().min(1).max(6)).length(3).optional(), hubLabel: z.string().trim().min(1).max(6).optional(),
    groupColors: z.tuple([z.string().regex(/^#[0-9a-f]{6}$/i), z.string().regex(/^#[0-9a-f]{6}$/i), z.string().regex(/^#[0-9a-f]{6}$/i)]).optional() }).optional(),
  intent: z.enum(["shortform", "standalone_showcase"]).default("shortform"),
  purpose: z.string().trim().min(1).max(160),
  evidenceRefs: z.array(z.string().trim().min(1).max(160)).min(1).max(8),
  style: motionSceneStyleSchema.optional(),
}).superRefine((input, context) => {
  if (input.holdBeatV3 && (input.designSystem === undefined || input.graphicPresentation || input.overlayPresentation || input.windowPresentation || input.strikeSurface === "source_overlay" || input.strikeSurface === "source_overlay_v2")) {
    context.addIssue({ code: "custom", path: ["holdBeatV3"], message: "第二拍只接受設計主題的實體字形版面。" });
  }
  if (input.posterV3 && (input.designSystem === undefined || input.graphicPresentation || input.overlayPresentation || input.windowPresentation || input.strikeSurface === "source_overlay" || input.strikeSurface === "source_overlay_v2")) {
    context.addIssue({ code: "custom", path: ["posterV3"], message: "首幀卡片只接受設計主題的實體字形版面。" });
  }
  if (input.copyFitV3 && (input.designSystem === undefined || input.graphicPresentation || input.overlayPresentation || input.windowPresentation || input.strikeSurface === "source_overlay" || input.strikeSurface === "source_overlay_v2")) {
    context.addIssue({ code: "custom", path: ["copyFitV3"], message: "自動縮字只接受設計主題的實體字形版面。" });
  }
  if (input.fixedWindowV3 && (input.templateId !== "level_bridge" || input.designSystem === undefined
    || input.graphicPresentation || input.overlayPresentation || input.windowPresentation)) {
    context.addIssue({ code: "custom", path: ["fixedWindowV3"], message: "固定影像窗需要模板自有的靜態多邊形遮罩。" });
  }
  if (input.graphicPresentation !== undefined && input.templateId !== "level_bridge") {
    context.addIssue({ code: "custom", path: ["graphicPresentation"], message: "Native paint presentation currently supports level_bridge only" });
  }
  if (input.strikePresentation !== undefined && input.templateId !== "strike_reframe") {
    context.addIssue({ code: "custom", path: ["strikePresentation"], message: "刪線呈現只接受 strike_reframe 模板" });
  }
  if (input.brandMark !== undefined && input.designSystem === undefined && (input.templateId !== "strike_reframe" || input.strikePresentation !== "semantic_replace_v1")) {
    context.addIssue({ code: "custom", path: ["brandMark"], message: "文字字標只接受 semantic_replace_v1 刪線呈現或設計系統" });
  }
  if (input.strikeSurface !== undefined && (input.templateId !== "strike_reframe" || input.strikePresentation !== "semantic_replace_v1")) {
    context.addIssue({ code: "custom", path: ["strikeSurface"], message: "畫面用途只接受明確 semantic_replace_v1 刪線呈現" });
  }
  if (input.textRegion !== undefined && input.strikeSurface !== "source_overlay_v2" && input.overlayPresentation !== "source_editorial_v1") {
    context.addIssue({ code: "custom", path: ["textRegion"], message: "文字留白範圍只接受 source_overlay_v2 或 source_editorial_v1" });
  }
  if ((REFERENCE_MOTION_DESIGN_ONLY_TEMPLATE_IDS as readonly string[]).includes(input.templateId) && input.designSystem === undefined) {
    context.addIssue({ code: "custom", path: ["designSystem"], message: "數據揭示與宣言快切只提供設計主題版本；請指定 designSystem" });
  }
  if (input.designSystem !== undefined) {
    const families: readonly string[] = REFERENCE_MOTION_DESIGN_CONTRACT.families;
    if (!families.includes(input.templateId) || input.graphicPresentation !== undefined || input.overlayPresentation !== undefined
      || input.windowPresentation !== undefined || input.strikeSurface !== undefined || input.textRegion !== undefined
      || (input.mediaPresentation !== undefined && input.mediaPresentation !== "legacy_layout")) {
      context.addIssue({ code: "custom", path: ["designSystem"], message: "設計系統只接受其對應模板家族，且不與其他呈現併用" });
    }
  }
  if (input.accentText !== undefined && (input.designSystem === undefined || !input.title.includes(input.accentText))) {
    context.addIssue({ code: "custom", path: ["accentText"], message: "強調字只接受設計系統，且必須出現在主標中" });
  }
  if (input.tag !== undefined && (input.designSystem === undefined || input.templateId !== "strike_reframe")) {
    context.addIssue({ code: "custom", path: ["tag"], message: "標籤只接受設計系統的 strike_reframe" });
  }
  if (input.verdicts !== undefined && (input.designSystem === undefined || input.templateId !== "comparison_pair")) {
    context.addIssue({ code: "custom", path: ["verdicts"], message: "好壞標記只接受設計系統的 comparison_pair" });
  }
  if (input.windowPresentation !== undefined && (!REFERENCE_MOTION_SOURCE_BACKDROP_CONTRACT.families.includes(input.templateId as typeof REFERENCE_MOTION_SOURCE_BACKDROP_CONTRACT.families[number])
    || input.graphicPresentation !== undefined || input.overlayPresentation !== undefined
    || (input.templateId === "comparison_pair" && input.mediaPresentation !== undefined && input.mediaPresentation !== "legacy_layout"))) {
    context.addIssue({ code: "custom", path: ["windowPresentation"], message: "同圖放大柔焦背景只接受 comparison_pair（圓角原比例視窗）、evidence_takeover、focus_wall，且不能與其他呈現併用" });
  }
  if (input.overlayPresentation !== undefined && (!REFERENCE_MOTION_EDITORIAL_CONTRACT.families.includes(input.templateId as typeof REFERENCE_MOTION_EDITORIAL_CONTRACT.families[number])
    || input.graphicPresentation !== undefined)) {
    context.addIssue({ code: "custom", path: ["overlayPresentation"], message: "實拍留白呈現只接受 level_bridge、context_stack、brand_recap，且不能與原生繪製併用" });
  }
});
export type ReferenceMotionTemplateInput = z.input<typeof referenceMotionTemplateInputSchema>;
export type ReferenceMotionSourceSlot = z.infer<typeof sourceSlotSchema>;

export function referenceMotionTemplate(id: ReferenceMotionTemplateId) {
  return REFERENCE_MOTION_TEMPLATES.find(item => item.id === id)!;
}
