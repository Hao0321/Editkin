import type { MotionGraphicPresetSeed } from "../domain/types";
import { DEFAULT_COLOR } from "../domain/types";
import { registerCorePackExtension, type EffectPreset, type LookPreset, type TransitionPreset } from "./corePack";

export interface StudioMotionAsset {
  id: string;
  name: string;
  family: "花字" | "標籤" | "資訊卡";
  license: "MIT";
  provenance: "Editkin original procedural preset";
  previewClass: string;
  seed: MotionGraphicPresetSeed;
}

const base = { kind: "title" as const, width: 0.72, fontSize: 76, animation: "pop" as const };

export const STUDIO_MOTION_ASSETS: StudioMotionAsset[] = [
  { id: "studio_marker_burst", name: "爆點螢光筆", family: "花字", license: "MIT", provenance: "Editkin original procedural preset", previewClass: "marker", seed: { ...base, presetId: "studio_marker_burst", name: "爆點螢光筆", fontFamily: "Noto Sans TC", fontWeight: 900, letterSpacing: 1, outlineWidth: 8, shadowDepth: 9, textColor: "#FFFFFF", backgroundColor: "#111827E8", accentColor: "#F7E04A" } },
  { id: "studio_comic_impact", name: "漫畫衝擊字", family: "花字", license: "MIT", provenance: "Editkin original procedural preset", previewClass: "comic", seed: { ...base, presetId: "studio_comic_impact", name: "漫畫衝擊字", fontFamily: "Fredoka", fontWeight: 700, letterSpacing: 2, outlineWidth: 10, shadowDepth: 11, textColor: "#FFE032", backgroundColor: "#111111F2", accentColor: "#FF4D6D" } },
  { id: "studio_neon_edge", name: "霓虹邊光", family: "花字", license: "MIT", provenance: "Editkin original procedural preset", previewClass: "neon", seed: { ...base, presetId: "studio_neon_edge", name: "霓虹邊光", fontFamily: "Bebas Neue", fontWeight: 700, letterSpacing: 4, outlineWidth: 5, shadowDepth: 13, textColor: "#FFFFFF", backgroundColor: "#0B1024E6", accentColor: "#55F6FF" } },
  { id: "studio_editorial_serif", name: "雜誌切題", family: "花字", license: "MIT", provenance: "Editkin original procedural preset", previewClass: "editorial", seed: { ...base, presetId: "studio_editorial_serif", name: "雜誌切題", fontFamily: "Noto Serif TC", fontWeight: 800, letterSpacing: 0, outlineWidth: 2, shadowDepth: 4, textColor: "#FFF9EC", backgroundColor: "#2A2119E8", accentColor: "#D9A96E", animation: "slide_up" } },
  { id: "studio_soft_sticker", name: "奶油貼紙字", family: "花字", license: "MIT", provenance: "Editkin original procedural preset", previewClass: "soft", seed: { ...base, presetId: "studio_soft_sticker", name: "奶油貼紙字", fontFamily: "Fredoka", fontWeight: 650, letterSpacing: 1, outlineWidth: 7, shadowDepth: 6, textColor: "#3B234A", backgroundColor: "#FFF4F8F2", accentColor: "#FF82B2", animation: "spring_soft" } },
  { id: "studio_ink_brush", name: "手寫墨刷", family: "花字", license: "MIT", provenance: "Editkin original procedural preset", previewClass: "ink", seed: { ...base, presetId: "studio_ink_brush", name: "手寫墨刷", fontFamily: "LXGW WenKai Mono TC", fontWeight: 400, letterSpacing: 2, outlineWidth: 3, shadowDepth: 5, textColor: "#F8F5EC", backgroundColor: "#161616E8", accentColor: "#E94F37", animation: "slide_up" } },
  { id: "studio_sport_score", name: "競速比分字", family: "花字", license: "MIT", provenance: "Editkin original procedural preset", previewClass: "sport", seed: { ...base, presetId: "studio_sport_score", name: "競速比分字", fontFamily: "Bebas Neue", fontWeight: 700, letterSpacing: 3, outlineWidth: 6, shadowDepth: 8, textColor: "#07110A", backgroundColor: "#B6FF47F2", accentColor: "#FFFFFF" } },
  { id: "studio_proof_stamp", name: "證據章標題", family: "花字", license: "MIT", provenance: "Editkin original procedural preset", previewClass: "proof", seed: { ...base, presetId: "studio_proof_stamp", name: "證據章標題", fontFamily: "Noto Sans TC", fontWeight: 900, letterSpacing: 2, outlineWidth: 3, shadowDepth: 3, textColor: "#F7F1E8", backgroundColor: "#A32828E8", accentColor: "#F7F1E8", animation: "pop" } },
];

let studioCreativeInitialized = false;

const STUDIO_LOOKS: LookPreset[] = [
  ["studio_skin_daylight", "人物日光清透", { brightness: .035, contrast: 1.04, saturation: 1.02, hue: -2 }],
  ["studio_food_amber", "食物暖琥珀", { brightness: .02, contrast: 1.08, saturation: 1.12, hue: -7 }],
  ["studio_city_cyan", "城市青橙", { brightness: -.01, contrast: 1.14, saturation: 1.08, hue: 8 }],
  ["studio_film_cream", "奶油底片", { brightness: .045, contrast: .94, saturation: .88, hue: -4 }],
  ["studio_product_white", "產品高級白", { brightness: .06, contrast: 1.02, saturation: .94, hue: 0 }],
  ["studio_night_violet", "夜景紫藍", { brightness: -.045, contrast: 1.18, saturation: 1.12, hue: 14 }],
  ["studio_documentary_olive", "紀錄橄欖", { brightness: -.018, contrast: 1.1, saturation: .78, hue: -12 }],
  ["studio_soft_pink", "柔霧蜜桃", { brightness: .04, contrast: .96, saturation: .92, hue: -9 }],
].map(([id, name, patch]) => ({ id: id as string, name: name as string, license: "MIT", provenance: "Editkin original grade preset", renderer: "editkin-primary-grade", color: { ...DEFAULT_COLOR, ...(patch as Partial<typeof DEFAULT_COLOR>) } }));

export const STUDIO_CINEMATIC_LOOKS: LookPreset[] = [
  ["cine_neutral_balance", "中性平衡", { brightness: .008, contrast: 1.01, saturation: .99, hue: 0 }],
  ["cine_creator_clean_pop", "創作者清透", { brightness: .025, contrast: 1.09, saturation: 1.07, hue: -2 }],
  ["cine_soft_daylight_skin", "柔光日常膚色", { brightness: .04, contrast: .96, saturation: .98, hue: -4 }],
  ["cine_cool_precision", "冷調精密", { brightness: .005, contrast: 1.12, saturation: .9, hue: 8 }],
  ["cine_warm_documentary", "溫暖紀實", { brightness: -.008, contrast: 1.08, saturation: .84, hue: -10 }],
  ["cine_muted_editorial", "低彩編輯誌", { brightness: .018, contrast: .92, saturation: .7, hue: -3 }],
  ["cine_dense_print", "深色印刷感", { brightness: -.045, contrast: 1.24, saturation: .88, hue: 0 }],
  ["cine_pastel_air", "空氣粉彩", { brightness: .06, contrast: .86, saturation: .76, hue: -6 }],
  ["cine_neon_night_guard", "霓虹夜景保護", { brightness: -.035, contrast: 1.2, saturation: 1.18, hue: 10 }],
  ["cine_dawn_gold", "黎明金", { brightness: .025, contrast: 1.05, saturation: 1.02, hue: -14 }],
  ["cine_moonlit_steel", "月光鋼藍", { brightness: -.02, contrast: 1.15, saturation: .82, hue: 16 }],
  ["cine_silver_monochrome", "銀灰黑白", { brightness: .01, contrast: 1.18, saturation: 0, hue: 0 }],
].map(([id, name, patch]) => ({ id: id as string, name: name as string, license: "MIT", provenance: "Editkin original parameterized primary-grade preset", renderer: "editkin-primary-grade", color: { ...DEFAULT_COLOR, ...(patch as Partial<typeof DEFAULT_COLOR>) } }));

const STUDIO_EFFECTS: EffectPreset[] = [
  ["studio_vignette_soft", "柔和聚焦暗角", "ffmpeg-vignette"], ["studio_clean_denoise", "乾淨降噪", "ffmpeg-denoise"],
  ["studio_detail_pop", "產品細節增強", "ffmpeg-detail-pop"], ["studio_pastel_wash", "柔霧粉彩", "ffmpeg-pastel"],
  ["studio_night_depth", "夜景深邃", "ffmpeg-night-depth"], ["studio_highlight_rolloff", "高光柔化", "ffmpeg-highlight-soft"],
].map(([id, name, renderer]) => ({ id, name, renderer, license: "MIT", provenance: "Editkin original FFmpeg filter preset" }));

const STUDIO_TRANSITIONS: TransitionPreset[] = [
  { id: "studio_eyeline_match", name: "快速水平滑接", renderer: "transition-whip", defaultDuration: .2 },
  { id: "studio_action_match", name: "快速推近", renderer: "transition-zoom", defaultDuration: .18 },
  { id: "studio_proof_reveal", name: "證據亮閃揭示", renderer: "transition-flash", defaultDuration: .16, parameters: { flashStrength: .42 } },
  { id: "studio_chapter_breath", name: "章節呼吸淡化", renderer: "transition-fade", defaultDuration: .34 },
  { id: "studio_ui_focus", name: "介面焦點推近", renderer: "transition-zoom", defaultDuration: .22 },
  { id: "studio_location_slide", name: "地點方向滑接", renderer: "transition-whip", defaultDuration: .24 },
  { id: "studio_before_after", name: "前後對照閃切", renderer: "transition-flash", defaultDuration: .14 },
  { id: "studio_soft_memory", name: "回憶柔淡", renderer: "transition-fade", defaultDuration: .42 },
].map((transition) => ({ ...transition, license: "MIT", provenance: "Editkin original motivated transition preset" }));

export const STUDIO_CINEMATIC_TRANSITIONS: TransitionPreset[] = [
  { id: "cine_short_fade_through_base", name: "短淡出／淡入", renderer: "transition-fade", defaultDuration: .2, parameters: { fadeCurve: .72 }, routing: { intents: ["continuity", "breath"], beatRoles: ["bridge"], avoidRoles: ["impact"], requiredHandlesFrames: 0, fallbackId: "luma_fade", intensity: "low" } },
  { id: "cine_emotion_fade_through_base", name: "情緒慢淡出／淡入", renderer: "transition-fade", defaultDuration: .55, parameters: { fadeCurve: 1.35 }, routing: { intents: ["memory", "emotion"], beatRoles: ["hold", "resolution"], avoidRoles: ["fast_action"], requiredHandlesFrames: 0, fallbackId: "luma_fade", intensity: "low" } },
  { id: "cine_chapter_fade_through_base", name: "章節暗場淡出／淡入", renderer: "transition-fade", defaultDuration: .34, parameters: { fadeCurve: 1.75 }, routing: { intents: ["chapter_change"], beatRoles: ["reset"], avoidRoles: ["match_action"], requiredHandlesFrames: 0, fallbackId: "luma_fade", intensity: "medium" } },
  { id: "cine_semantic_punch", name: "語意推近", renderer: "transition-zoom", defaultDuration: .18, parameters: { zoomAmount: .055 }, routing: { intents: ["emphasis", "proof"], beatRoles: ["build"], avoidRoles: ["emotional_hold"], requiredHandlesFrames: 0, fallbackId: "cine_short_fade_through_base", intensity: "medium" } },
  { id: "cine_impact_zoom", name: "衝擊拉近", renderer: "transition-zoom", defaultDuration: .12, parameters: { zoomAmount: .14 }, routing: { intents: ["impact", "payoff"], beatRoles: ["impact"], avoidRoles: ["dialogue_breath"], requiredHandlesFrames: 0, fallbackId: "cine_semantic_punch", intensity: "high" } },
  { id: "cine_ui_detail_push", name: "介面細節推近", renderer: "transition-zoom", defaultDuration: .26, parameters: { zoomAmount: .035 }, routing: { intents: ["tutorial", "detail"], beatRoles: ["explain"], avoidRoles: ["fast_action"], requiredHandlesFrames: 0, fallbackId: "cine_short_fade_through_base", intensity: "low" } },
  { id: "cine_axis_carry_left", name: "向左畫面滑出入", renderer: "transition-whip", defaultDuration: .16, parameters: { travelPercent: 72, direction: -1 }, routing: { intents: ["energy", "direction_change"], beatRoles: ["build"], avoidRoles: ["emotional_hold"], requiredHandlesFrames: 0, fallbackId: "cine_short_fade_through_base", intensity: "high" } },
  { id: "cine_axis_carry_right", name: "向右畫面滑出入", renderer: "transition-whip", defaultDuration: .16, parameters: { travelPercent: 72, direction: 1 }, routing: { intents: ["energy", "direction_change"], beatRoles: ["build"], avoidRoles: ["emotional_hold"], requiredHandlesFrames: 0, fallbackId: "cine_short_fade_through_base", intensity: "high" } },
  { id: "cine_soft_direction_slide", name: "柔和方向滑接", renderer: "transition-whip", defaultDuration: .28, parameters: { travelPercent: 34, direction: 1 }, routing: { intents: ["orientation", "process"], beatRoles: ["bridge"], avoidRoles: ["impact"], requiredHandlesFrames: 0, fallbackId: "cine_short_fade_through_base", intensity: "medium" } },
  { id: "cine_proof_flash", name: "證據快閃", renderer: "transition-flash", defaultDuration: .12, parameters: { flashStrength: .42 }, routing: { intents: ["proof", "comparison"], beatRoles: ["impact"], avoidRoles: ["photosensitive_risk"], requiredHandlesFrames: 0, fallbackId: "cine_short_fade_through_base", intensity: "medium" } },
  { id: "cine_payoff_burst", name: "成果亮閃", renderer: "transition-flash", defaultDuration: .1, parameters: { flashStrength: .78 }, routing: { intents: ["payoff", "reveal"], beatRoles: ["impact"], avoidRoles: ["photosensitive_risk", "calm_interview"], requiredHandlesFrames: 0, fallbackId: "cine_proof_flash", intensity: "high" } },
  { id: "cine_exposure_breath", name: "曝光呼吸", renderer: "transition-flash", defaultDuration: .24, parameters: { flashStrength: .24 }, routing: { intents: ["dream", "memory", "time_change"], beatRoles: ["bridge"], avoidRoles: ["high_key_source"], requiredHandlesFrames: 0, fallbackId: "cine_short_fade_through_base", intensity: "low" } },
].map((preset) => ({ ...preset, license: "MIT", provenance: "Editkin original parameterized clip entrance/exit template" } as TransitionPreset));

export const STUDIO_COMPOUND_TRANSITIONS: TransitionPreset[] = [
  { id: "cine_soft_fade_push", name: "柔淡微推", renderer: "transition-fade", renderers: ["transition-fade", "transition-zoom"], defaultDuration: .3, parameters: { fadeCurve: .9, zoomAmount: .035 }, routing: { intents: ["continuity", "tutorial"], beatRoles: ["bridge", "explain"], avoidRoles: ["impact"], requiredHandlesFrames: 0, fallbackId: "cine_short_fade_through_base", intensity: "low" } },
  { id: "cine_memory_fade_push", name: "回憶淡化推近", renderer: "transition-fade", renderers: ["transition-fade", "transition-zoom"], defaultDuration: .52, parameters: { fadeCurve: 1.35, zoomAmount: .065 }, routing: { intents: ["memory", "emotion"], beatRoles: ["hold", "resolution"], avoidRoles: ["fast_action"], requiredHandlesFrames: 0, fallbackId: "cine_emotion_fade_through_base", intensity: "medium" } },
  { id: "cine_left_slide_fade", name: "向左滑淡", renderer: "transition-whip", renderers: ["transition-whip", "transition-fade"], defaultDuration: .22, parameters: { travelPercent: 44, direction: -1, fadeCurve: .78 }, routing: { intents: ["orientation", "process"], beatRoles: ["bridge"], avoidRoles: ["emotional_hold"], requiredHandlesFrames: 0, fallbackId: "cine_axis_carry_left", intensity: "medium" } },
  { id: "cine_right_slide_fade", name: "向右滑淡", renderer: "transition-whip", renderers: ["transition-whip", "transition-fade"], defaultDuration: .22, parameters: { travelPercent: 44, direction: 1, fadeCurve: .78 }, routing: { intents: ["orientation", "process"], beatRoles: ["bridge"], avoidRoles: ["emotional_hold"], requiredHandlesFrames: 0, fallbackId: "cine_axis_carry_right", intensity: "medium" } },
  { id: "cine_proof_flash_push", name: "證據亮閃推近", renderer: "transition-flash", renderers: ["transition-flash", "transition-zoom"], defaultDuration: .14, parameters: { flashStrength: .38, zoomAmount: .06 }, routing: { intents: ["proof", "emphasis"], beatRoles: ["impact"], avoidRoles: ["photosensitive_risk"], requiredHandlesFrames: 0, fallbackId: "cine_proof_flash", intensity: "medium" } },
  { id: "cine_payoff_flash_push", name: "成果爆點推近", renderer: "transition-flash", renderers: ["transition-flash", "transition-zoom"], defaultDuration: .11, parameters: { flashStrength: .72, zoomAmount: .12 }, routing: { intents: ["payoff", "reveal"], beatRoles: ["impact"], avoidRoles: ["photosensitive_risk", "calm_interview"], requiredHandlesFrames: 0, fallbackId: "cine_impact_zoom", intensity: "high" } },
  { id: "cine_left_energy_relay", name: "向左能量滑接", renderer: "transition-whip", renderers: ["transition-whip", "transition-flash"], defaultDuration: .13, parameters: { travelPercent: 76, direction: -1, flashStrength: .25 }, routing: { intents: ["energy", "motion_continuity"], beatRoles: ["build", "impact"], avoidRoles: ["photosensitive_risk", "dialogue_breath"], requiredHandlesFrames: 0, fallbackId: "cine_axis_carry_left", intensity: "high" } },
  { id: "cine_right_energy_relay", name: "向右能量滑接", renderer: "transition-whip", renderers: ["transition-whip", "transition-flash"], defaultDuration: .13, parameters: { travelPercent: 76, direction: 1, flashStrength: .25 }, routing: { intents: ["energy", "motion_continuity"], beatRoles: ["build", "impact"], avoidRoles: ["photosensitive_risk", "dialogue_breath"], requiredHandlesFrames: 0, fallbackId: "cine_axis_carry_right", intensity: "high" } },
].map((preset) => ({ ...preset, license: "MIT", provenance: "Editkin original compound clip entrance/exit template" } as TransitionPreset));

export function initializeStudioCreativeAssets(): void {
  if (studioCreativeInitialized) return;
  registerCorePackExtension({ looks: [...STUDIO_LOOKS, ...STUDIO_CINEMATIC_LOOKS], effects: STUDIO_EFFECTS, transitions: [...STUDIO_TRANSITIONS, ...STUDIO_CINEMATIC_TRANSITIONS, ...STUDIO_COMPOUND_TRANSITIONS] });
  studioCreativeInitialized = true;
}
