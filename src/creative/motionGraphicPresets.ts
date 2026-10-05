import type { MotionGraphic } from "../domain/types";
import type { MotionGraphicPreset } from "./motionGraphicPresetTypes";
import { initializeStudioCreativeAssets, STUDIO_MOTION_ASSETS } from "./studioAssets";
import { initializeWave2Registry } from "./wave2Registry";
import { TRAVEL_EDITORIAL_PRESETS } from "./travelEditorialPresets";
import { LOWER_THIRD_PRESETS } from "./lowerThirdPresets";
import { REEL_MOTION_PRESETS } from "./reelMotionPresets";
import { NATIVE_VECTOR_PRESETS } from "./nativeVectorPresets";
import { DEFAULT_MOTION_V2_PRESETS } from "../motion/defaultGraphicSeedsV2";
import { KINETIC_MOTION_PRESETS } from "./kineticMotionPresets";

export type { MotionGraphicPreset } from "./motionGraphicPresetTypes";

let registry: MotionGraphicPreset[] | undefined;

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

const BUILTIN_MOTION_PRESETS: MotionGraphicPreset[] = [{
  id: "surface-track",
  name: "平面貼合圖卡",
  family: "動態追蹤",
  license: "MIT",
  provenance: "Editkin original procedural preset",
  renderer: "hao-motion-composition/v1",
  seed: {
    presetId: "surface-track", name: "平面貼合圖卡", kind: "tag", trackingMode: "surface",
    animation: "fade", x: .1, y: .1, width: .34, fontSize: 30, offsetX: 0, offsetY: 0,
  },
}, {
  id: "v2-word-cascade",
  name: "逐詞彈性主標",
  family: "動態文字 v2",
  license: "MIT",
  provenance: "Editkin original deterministic motion-composition/v2 preset",
  renderer: "hao-motion-composition/v2",
  seed: {
    schema: "hao.motion-composition/v2", presetId: "v2-word-cascade", name: "逐詞彈性主標", kind: "title",
    animation: "fade", x: .08, y: .12, width: .76, fontSize: 72, fontWeight: 850, letterSpacing: 0,
    outlineWidth: 3, shadowDepth: 5, cornerRadius: 18, offsetX: 0, offsetY: 0,
    textColor: "#FFFFFF", backgroundColor: "#101827E8", accentColor: "#77E4FF",
    motionV2: {
      sequence: { unit: "word", order: "forward", exitOrder: "reverse", staggerFrames: 2 },
      entrance: { durationFrames: 10, offsetXPixels: 0, offsetYPixels: 48, scale: .82, opacity: 0, easing: { type: "spring", stiffness: 170, damping: 18, mass: 1, initialVelocity: 0 } },
      exit: { durationFrames: 8, offsetXPixels: 0, offsetYPixels: -20, scale: .96, opacity: 0, easing: { type: "ease_in" } },
    },
    layoutV2: { safeArea: { top: .05, right: .05, bottom: .05, left: .05 }, maxLines: 2, minFontSize: 30, lineGap: 4, align: "left" },
  },
}];

/** Original editable lyric materials; the song and lyric text always come from the project. */
export const MUSIC_VIDEO_LYRIC_PRESETS: readonly MotionGraphicPreset[] = [
  { id: "mv_illustrated_word", name: "插畫 MV 空間字", family: "音樂 MV · 插畫場景", license: "MIT", provenance: "Editkin original editable motion typography", renderer: "hao-motion-composition/v2",
    routing: { semanticRoles: ["verified_lyric", "title", "phrase"], formats: ["9:16", "16:9"], requires: ["none"], avoidWhen: ["unverified_lyric", "dense_caption_region"], intensity: "high" },
    seed: { schema: "hao.motion-composition/v2", presetId: "mv_illustrated_word", name: "插畫 MV 空間字", kind: "title", animation: "fade",
      x: .57, y: .34, width: .36, fontSize: 78, fontFamily: "Noto Sans TC", fontWeight: 900, letterSpacing: 2,
      outlineWidth: 2, shadowDepth: 2, cornerRadius: 0, textColor: "#FFF4DC", backgroundColor: "#00000000", accentColor: "#FF8E85",
      motionV2: { sequence: { unit: "character", order: "forward", exitOrder: "reverse", staggerFrames: 1 },
        entrance: { durationFrames: 7, offsetXPixels: 34, offsetYPixels: 8, scale: .88, opacity: 0, easing: { type: "ease_out" } },
        exit: { durationFrames: 6, offsetXPixels: -18, offsetYPixels: -8, scale: 1.06, opacity: 0, easing: { type: "ease_in" } } },
      layoutV2: { safeArea: { top: .05, right: .05, bottom: .05, left: .05 }, maxLines: 1, minFontSize: 30, lineGap: 0, align: "center" } } },
  { id: "mv_illustrated_word_fast", name: "插畫 MV 節拍字", family: "音樂 MV · 插畫場景", license: "MIT", provenance: "Editkin original editable motion typography", renderer: "hao-motion-composition/v2",
    routing: { semanticRoles: ["verified_lyric", "title", "rapid_phrase"], formats: ["9:16", "16:9"], requires: ["none"], avoidWhen: ["unverified_lyric", "dense_caption_region"], intensity: "high" },
    seed: { schema: "hao.motion-composition/v2", presetId: "mv_illustrated_word_fast", name: "插畫 MV 節拍字", kind: "title", animation: "fade",
      x: .57, y: .34, width: .36, fontSize: 78, fontFamily: "Noto Sans TC", fontWeight: 900, letterSpacing: 2,
      outlineWidth: 2, shadowDepth: 2, cornerRadius: 0, textColor: "#FFF4DC", backgroundColor: "#00000000", accentColor: "#FF8E85",
      motionV2: { sequence: { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0 },
        entrance: { durationFrames: 3, offsetXPixels: 25, offsetYPixels: 8, scale: .9, opacity: 0, easing: { type: "ease_out" } },
        exit: { durationFrames: 3, offsetXPixels: -18, offsetYPixels: -8, scale: 1.08, opacity: 0, easing: { type: "ease_in" } } },
      layoutV2: { safeArea: { top: .05, right: .05, bottom: .05, left: .05 }, maxLines: 1, minFontSize: 30, lineGap: 0, align: "center" } } },
  { id: "mv_illustrated_word_impact", name: "插畫 MV 衝擊字", family: "音樂 MV · 插畫場景", license: "MIT", provenance: "Editkin original editable motion typography", renderer: "hao-motion-composition/v2",
    routing: { semanticRoles: ["verified_lyric", "title", "accent_phrase"], formats: ["9:16", "16:9"], requires: ["none"], avoidWhen: ["unverified_lyric", "dense_caption_region"], intensity: "high" },
    seed: { schema: "hao.motion-composition/v2", presetId: "mv_illustrated_word_impact", name: "插畫 MV 衝擊字", kind: "title", animation: "fade",
      x: .57, y: .34, width: .36, fontSize: 82, fontFamily: "Noto Sans TC", fontWeight: 900, letterSpacing: 1,
      outlineWidth: 3, shadowDepth: 3, cornerRadius: 0, textColor: "#FFF4DC", backgroundColor: "#00000000", accentColor: "#FF8E85",
      motionV2: { sequence: { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0 },
        entrance: { durationFrames: 7, offsetXPixels: 48, offsetYPixels: 0, scale: .68, opacity: 0,
          easing: { type: "spring", stiffness: 180, damping: 21, mass: 1, initialVelocity: 0 } },
        exit: { durationFrames: 5, offsetXPixels: -28, offsetYPixels: -10, scale: 1.08, opacity: 0, easing: { type: "ease_in" } } },
      layoutV2: { safeArea: { top: .05, right: .05, bottom: .05, left: .05 }, maxLines: 1, minFontSize: 30, lineGap: 0, align: "center" } } },
  { id: "mv_illustrated_word_ripple", name: "插畫 MV 字元漣漪", family: "音樂 MV · 插畫場景", license: "MIT", provenance: "Editkin original editable motion typography", renderer: "hao-motion-composition/v2",
    routing: { semanticRoles: ["verified_lyric", "title", "phrase"], formats: ["9:16", "16:9"], requires: ["none"], avoidWhen: ["unverified_lyric", "dense_caption_region"], intensity: "medium" },
    seed: { schema: "hao.motion-composition/v2", presetId: "mv_illustrated_word_ripple", name: "插畫 MV 字元漣漪", kind: "title", animation: "fade",
      x: .57, y: .34, width: .36, fontSize: 76, fontFamily: "Noto Sans TC", fontWeight: 900, letterSpacing: 3,
      outlineWidth: 2, shadowDepth: 2, cornerRadius: 0, textColor: "#FFF4DC", backgroundColor: "#00000000", accentColor: "#FF8E85",
      motionV2: { sequence: { unit: "character", order: "center_out", exitOrder: "reverse", staggerFrames: 2 },
        entrance: { durationFrames: 8, offsetXPixels: 0, offsetYPixels: 38, scale: .7, opacity: 0,
          easing: { type: "spring", stiffness: 150, damping: 20, mass: 1, initialVelocity: 0 } },
        exit: { durationFrames: 6, offsetXPixels: 0, offsetYPixels: -24, scale: 1.08, opacity: 0, easing: { type: "ease_in" } } },
      layoutV2: { safeArea: { top: .05, right: .05, bottom: .05, left: .05 }, maxLines: 1, minFontSize: 30, lineGap: 0, align: "center" } } },
  { id: "mv_afterglow_lyric", name: "餘暉逐字歌詞", family: "音樂 MV · 餘暉", license: "MIT", provenance: "Editkin original procedural lyric typography", renderer: "hao-motion-composition/v2",
    routing: { semanticRoles: ["verified_lyric", "phrase"], formats: ["9:16", "16:9"], requires: ["none"], avoidWhen: ["unverified_lyric", "dense_caption_region"], intensity: "medium" },
    seed: { schema: "hao.motion-composition/v2", presetId: "mv_afterglow_lyric", name: "餘暉逐字歌詞", kind: "title", animation: "fade",
      x: .08, y: .7, width: .84, fontSize: 54, fontFamily: "Noto Sans TC", fontWeight: 850, letterSpacing: 1,
      outlineWidth: 0, shadowDepth: 1, cornerRadius: 20, textColor: "#FFF7F0", backgroundColor: "#10152A70", accentColor: "#C77883",
      motionV2: { sequence: { unit: "character", order: "forward", exitOrder: "forward", staggerFrames: 1 },
        entrance: { durationFrames: 8, offsetXPixels: 0, offsetYPixels: 26, scale: .94, opacity: 0, easing: { type: "ease_out" } },
        exit: { durationFrames: 7, offsetXPixels: 0, offsetYPixels: -16, scale: .98, opacity: 0, easing: { type: "ease_in" } } },
      layoutV2: { safeArea: { top: .06, right: .07, bottom: .1, left: .07 }, maxLines: 2, minFontSize: 32, lineGap: 4, align: "center" } } },
  { id: "mv_afterglow_lyric_fast", name: "餘暉瞬間歌詞", family: "音樂 MV · 餘暉", license: "MIT", provenance: "Editkin original procedural lyric typography", renderer: "hao-motion-composition/v2",
    routing: { semanticRoles: ["verified_lyric", "rapid_phrase"], formats: ["9:16", "16:9"], requires: ["none"], avoidWhen: ["unverified_lyric", "dense_caption_region"], intensity: "medium" },
    seed: { schema: "hao.motion-composition/v2", presetId: "mv_afterglow_lyric_fast", name: "餘暉瞬間歌詞", kind: "title", animation: "fade",
      x: .08, y: .7, width: .84, fontSize: 54, fontFamily: "Noto Sans TC", fontWeight: 850, letterSpacing: 1,
      outlineWidth: 0, shadowDepth: 1, cornerRadius: 20, textColor: "#FFF7F0", backgroundColor: "#10152A70", accentColor: "#C77883",
      motionV2: { sequence: { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0 },
        entrance: { durationFrames: 4, offsetXPixels: 0, offsetYPixels: 18, scale: .96, opacity: 0, easing: { type: "ease_out" } },
        exit: { durationFrames: 4, offsetXPixels: 0, offsetYPixels: -12, scale: .98, opacity: 0, easing: { type: "ease_in" } } },
      layoutV2: { safeArea: { top: .06, right: .07, bottom: .1, left: .07 }, maxLines: 2, minFontSize: 32, lineGap: 4, align: "center" } } },
  { id: "mv_paper_air_lyric", name: "紙感逐字歌詞", family: "音樂 MV · 紙感", license: "MIT", provenance: "Editkin original procedural lyric typography", renderer: "hao-motion-composition/v2",
    routing: { semanticRoles: ["verified_lyric", "phrase"], formats: ["9:16", "16:9"], requires: ["none"], avoidWhen: ["unverified_lyric", "dense_caption_region"], intensity: "low" },
    seed: { schema: "hao.motion-composition/v2", presetId: "mv_paper_air_lyric", name: "紙感逐字歌詞", kind: "title", animation: "fade",
      x: .08, y: .72, width: .84, fontSize: 48, fontFamily: "Noto Serif TC", fontWeight: 700, letterSpacing: 0,
      outlineWidth: 0, shadowDepth: 1, cornerRadius: 20, textColor: "#25242A", backgroundColor: "#FFF8E8B8", accentColor: "#AC7A70",
      motionV2: { sequence: { unit: "character", order: "forward", exitOrder: "forward", staggerFrames: 1 },
        entrance: { durationFrames: 9, offsetXPixels: 0, offsetYPixels: 20, scale: .96, opacity: 0, easing: { type: "ease_out" } },
        exit: { durationFrames: 8, offsetXPixels: 0, offsetYPixels: -12, scale: .99, opacity: 0, easing: { type: "ease_in" } } },
      layoutV2: { safeArea: { top: .06, right: .08, bottom: .1, left: .08 }, maxLines: 2, minFontSize: 30, lineGap: 5, align: "center" } } },
  { id: "mv_paper_air_lyric_fast", name: "紙感瞬間歌詞", family: "音樂 MV · 紙感", license: "MIT", provenance: "Editkin original procedural lyric typography", renderer: "hao-motion-composition/v2",
    routing: { semanticRoles: ["verified_lyric", "rapid_phrase"], formats: ["9:16", "16:9"], requires: ["none"], avoidWhen: ["unverified_lyric", "dense_caption_region"], intensity: "low" },
    seed: { schema: "hao.motion-composition/v2", presetId: "mv_paper_air_lyric_fast", name: "紙感瞬間歌詞", kind: "title", animation: "fade",
      x: .08, y: .72, width: .84, fontSize: 48, fontFamily: "Noto Serif TC", fontWeight: 700, letterSpacing: 0,
      outlineWidth: 0, shadowDepth: 1, cornerRadius: 20, textColor: "#25242A", backgroundColor: "#FFF8E8B8", accentColor: "#AC7A70",
      motionV2: { sequence: { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0 },
        entrance: { durationFrames: 4, offsetXPixels: 0, offsetYPixels: 12, scale: .98, opacity: 0, easing: { type: "ease_out" } },
        exit: { durationFrames: 4, offsetXPixels: 0, offsetYPixels: -8, scale: .99, opacity: 0, easing: { type: "ease_in" } } },
      layoutV2: { safeArea: { top: .06, right: .08, bottom: .1, left: .08 }, maxLines: 2, minFontSize: 30, lineGap: 5, align: "center" } } },
] as const;

/**
 * Original, procedural materials rendered from editable text by the native overlay
 * path. They intentionally expose no prerecorded bitmap/video dependency.
 */
export const HOLOGRAM_MOTION_PRESETS: readonly MotionGraphicPreset[] = [{
  id: "holo_prism_scan", name: "稜鏡掃描主標", family: "全息掃描", license: "MIT",
  provenance: "Editkin original procedural hologram material", renderer: "hao-motion-composition/v1",
  routing: { semanticRoles: ["hook", "chapter", "payoff"], formats: ["9:16", "16:9", "1:1"], requires: ["none"], avoidWhen: ["calm_interview", "dense_caption_region"], intensity: "high" },
  seed: { presetId: "holo_prism_scan", name: "稜鏡掃描主標", kind: "title", visualStyle: "holo_scan_cyan", animation: "fade", x: .08, y: .12, width: .76, fontSize: 70, fontFamily: "Noto Sans TC", fontWeight: 900, letterSpacing: 2, outlineWidth: 4, shadowDepth: 4, cornerRadius: 10, textColor: "#F5FEFFFF", backgroundColor: "#06141CCC", accentColor: "#52F7FFFF" },
}, {
  id: "holo_surface_grid", name: "平面網格標籤", family: "全息追蹤", license: "MIT",
  provenance: "Editkin original procedural hologram material", renderer: "hao-motion-composition/v1",
  routing: { semanticRoles: ["object_label", "proof", "location"], formats: ["9:16", "16:9", "1:1"], requires: ["none", "motion_track", "surface_quad"], avoidWhen: ["unreliable_planar_track"], intensity: "medium" },
  seed: { presetId: "holo_surface_grid", name: "平面網格標籤", kind: "tag", visualStyle: "holo_grid_lime", animation: "fade", x: .1, y: .16, width: .48, fontSize: 38, fontFamily: "Noto Sans TC", fontWeight: 800, letterSpacing: 1, outlineWidth: 3, shadowDepth: 3, cornerRadius: 8, textColor: "#F7FFF3FF", backgroundColor: "#07150ED0", accentColor: "#8BFF58FF" },
}, {
  id: "holo_target_lock", name: "目標鎖定標籤", family: "追蹤 HUD", license: "MIT",
  provenance: "Editkin original procedural HUD material", renderer: "hao-motion-composition/v1",
  routing: { semanticRoles: ["object_label", "challenge_target", "warning"], formats: ["9:16", "16:9"], requires: ["none", "motion_track"], avoidWhen: ["calm_interview", "tracking_lost"], intensity: "high" },
  seed: { presetId: "holo_target_lock", name: "目標鎖定標籤", kind: "tag", visualStyle: "target_lock_red", animation: "spring_soft", x: .62, y: .16, width: .32, fontSize: 34, fontFamily: "Noto Sans TC", fontWeight: 700, letterSpacing: 2, outlineWidth: 2, shadowDepth: 2, cornerRadius: 4, textColor: "#FFFFFFFF", backgroundColor: "#190708C8", accentColor: "#FF4D5EFF" },
}, {
  id: "holo_spectral_wire", name: "光譜線框主標", family: "全息掃描", license: "MIT",
  provenance: "Editkin original procedural wire material", renderer: "hao-motion-composition/v1",
  routing: { semanticRoles: ["hook", "chapter", "technical_explanation"], formats: ["9:16", "16:9", "1:1"], requires: ["none"], avoidWhen: ["warm_lifestyle"], intensity: "medium" },
  seed: { presetId: "holo_spectral_wire", name: "光譜線框主標", kind: "title", visualStyle: "spectral_wire_violet", animation: "slide_up", x: .08, y: .16, width: .72, fontSize: 64, fontFamily: "Noto Sans TC", fontWeight: 850, letterSpacing: 1, outlineWidth: 4, shadowDepth: 5, cornerRadius: 12, textColor: "#FFFFFFFF", backgroundColor: "#120B29CE", accentColor: "#A78BFAFF" },
}, {
  id: "holo_depth_glass", name: "深度玻璃字卡", family: "擬 3D 文字", license: "MIT",
  provenance: "Editkin original procedural depth material", renderer: "hao-motion-composition/v1",
  routing: { semanticRoles: ["proof", "fact", "comparison"], formats: ["9:16", "16:9", "1:1"], requires: ["none"], avoidWhen: ["high_motion_background"], intensity: "medium" },
  seed: { presetId: "holo_depth_glass", name: "深度玻璃字卡", kind: "card", visualStyle: "depth_glass_blue", animation: "pop", x: .08, y: .64, width: .64, fontSize: 46, fontFamily: "Noto Sans TC", fontWeight: 800, letterSpacing: 1, outlineWidth: 3, shadowDepth: 5, cornerRadius: 16, textColor: "#F4FAFFFF", backgroundColor: "#081729D4", accentColor: "#60A5FAFF" },
}, {
  id: "holo_telemetry_beam", name: "遙測光束標籤", family: "追蹤 HUD", license: "MIT",
  provenance: "Editkin original procedural telemetry material", renderer: "hao-motion-composition/v1",
  routing: { semanticRoles: ["metric", "location", "object_label"], formats: ["9:16", "16:9"], requires: ["none", "motion_track"], avoidWhen: ["no_numeric_or_entity_payload"], intensity: "medium" },
  seed: { presetId: "holo_telemetry_beam", name: "遙測光束標籤", kind: "tag", visualStyle: "telemetry_beam_amber", animation: "slide_up", x: .58, y: .7, width: .36, fontSize: 34, fontFamily: "Noto Sans TC", fontWeight: 700, letterSpacing: 2, outlineWidth: 2, shadowDepth: 3, cornerRadius: 5, textColor: "#FFF9E8FF", backgroundColor: "#1E1607D0", accentColor: "#FBBF24FF" },
}, {
  id: "holo_neon_extrude", name: "霓虹擬立體衝擊字", family: "擬 3D 文字", license: "MIT",
  provenance: "Editkin original procedural extrusion material", renderer: "hao-motion-composition/v1",
  routing: { semanticRoles: ["hook", "impact", "payoff"], formats: ["9:16", "16:9", "1:1"], requires: ["none"], avoidWhen: ["calm_interview", "long_sentence"], intensity: "high" },
  seed: { presetId: "holo_neon_extrude", name: "霓虹擬立體衝擊字", kind: "title", visualStyle: "neon_extrude_white", animation: "spring_soft", x: .08, y: .11, width: .78, fontSize: 74, fontFamily: "Noto Sans TC", fontWeight: 900, letterSpacing: 1, outlineWidth: 5, shadowDepth: 7, cornerRadius: 9, textColor: "#FFFFFFFF", backgroundColor: "#080B12D0", accentColor: "#7DD3FCFF" },
}, {
  id: "holo_quantum_label", name: "量子點陣資訊卡", family: "全息追蹤", license: "MIT",
  provenance: "Editkin original procedural particle-grid material", renderer: "hao-motion-composition/v1",
  routing: { semanticRoles: ["fact", "status", "comparison"], formats: ["9:16", "16:9", "1:1"], requires: ["none", "motion_track"], avoidWhen: ["dense_caption_region"], intensity: "medium" },
  seed: { presetId: "holo_quantum_label", name: "量子點陣資訊卡", kind: "card", visualStyle: "quantum_label_magenta", animation: "pop", x: .08, y: .66, width: .58, fontSize: 42, fontFamily: "Noto Sans TC", fontWeight: 850, letterSpacing: 1, outlineWidth: 3, shadowDepth: 4, cornerRadius: 10, textColor: "#FFF8FFFF", backgroundColor: "#210B22D0", accentColor: "#F472B6FF" },
}];

/**
 * One registry is shared by the editor UI and the MCP planner boundary. Keeping the
 * resolved seed here prevents an agent from having to reconstruct visual parameters
 * from a display name or copy the whole creative pack into context.
 */
export function motionGraphicPresets(): readonly MotionGraphicPreset[] {
  if (registry) return registry;
  initializeStudioCreativeAssets();
  const wave2 = initializeWave2Registry();
  const items: MotionGraphicPreset[] = [
    ...DEFAULT_MOTION_V2_PRESETS.map((item) => ({ ...item, seed: { ...item.seed } })),
    ...BUILTIN_MOTION_PRESETS.map((item) => ({ ...item, seed: { ...item.seed } })),
    ...MUSIC_VIDEO_LYRIC_PRESETS.map((item) => ({ ...item, seed: { ...item.seed } })),
    ...REEL_MOTION_PRESETS.map((item) => ({ ...item, seed: { ...item.seed } })),
    ...NATIVE_VECTOR_PRESETS.map((item) => ({ ...item, seed: { ...item.seed } })),
    ...KINETIC_MOTION_PRESETS.map((item) => ({ ...item, seed: { ...item.seed } })),
    ...TRAVEL_EDITORIAL_PRESETS.map((item) => ({ ...item, seed: { ...item.seed } })),
    ...LOWER_THIRD_PRESETS.flatMap((item) => [
      { id: item.nameBar.presetId!, name: item.nameBar.name!, family: `人物字幕條 · ${item.name}`, license: "MIT", provenance: "Editkin original editable lower-third preset", renderer: "hao-motion-composition/v2" as const, seed: { ...item.nameBar }, routing: { semanticRoles: ["speaker_name", "identity"], formats: ["9:16", "16:9", "1:1"] as Array<"9:16" | "16:9" | "1:1">, requires: ["none"] as Array<"none">, avoidWhen: ["identity_unverified", "dense_lower_frame"], intensity: "low" as const } },
      { id: item.unitBar.presetId!, name: item.unitBar.name!, family: `人物字幕條 · ${item.name}`, license: "MIT", provenance: "Editkin original editable lower-third preset", renderer: "hao-motion-composition/v2" as const, seed: { ...item.unitBar }, routing: { semanticRoles: ["speaker_affiliation", "identity"], formats: ["9:16", "16:9", "1:1"] as Array<"9:16" | "16:9" | "1:1">, requires: ["none"] as Array<"none">, avoidWhen: ["identity_unverified", "dense_lower_frame"], intensity: "low" as const } },
    ]),
    ...HOLOGRAM_MOTION_PRESETS.map((item) => ({ ...item, seed: { ...item.seed } })),
    ...STUDIO_MOTION_ASSETS.map((item) => ({
      id: item.id,
      name: item.name,
      family: item.family,
      license: item.license,
      provenance: item.provenance,
      renderer: "hao-motion-composition/v1" as const,
      seed: { ...item.seed },
    })),
    ...wave2.motionPresets.map((item) => ({
      id: item.id,
      name: item.name,
      family: item.family,
      license: item.license,
      provenance: item.provenance,
      renderer: "hao-motion-composition/v1" as const,
      seed: { ...item.seed },
    })),
  ];
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new Error(`動態圖文 preset id 重複：${item.id}`);
    if (!item.seed.presetId || item.seed.presetId !== item.id) throw new Error(`動態圖文 preset identity 不一致：${item.id}`);
    ids.add(item.id);
  }
  registry = deepFreeze(items);
  return registry;
}

export function findMotionGraphicPreset(id: string): MotionGraphicPreset {
  const preset = motionGraphicPresets().find((item) => item.id === id);
  if (!preset) throw new Error(`找不到動態圖文 preset：${id}`);
  return preset;
}

/**
 * A preset id on an Autopilot command is only meaningful when the authored
 * graphic still contains that registered preset's resolved visual seed. This
 * fail-closed check prevents a planner from attaching a trusted id to arbitrary
 * styling while keeping text/timing/tracking as project-specific parameters.
 */
export function assertMotionGraphicPresetBinding(graphic: MotionGraphic, presetId: string): MotionGraphicPreset {
  const preset = findMotionGraphicPreset(presetId);
  if (graphic.presetId !== preset.id) throw new Error(`動態圖文 ${graphic.id} 的 presetId 綁定不一致：${preset.id}`);
  const resolved = graphic as unknown as Record<string, unknown>;
  const sameValue = (left: unknown, right: unknown): boolean => {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length && left.every((value, index) => sameValue(value, right[index]));
    if (left && right && typeof left === "object" && typeof right === "object") {
      const leftEntries = Object.entries(left as Record<string, unknown>);
      const rightRecord = right as Record<string, unknown>;
      return leftEntries.length === Object.keys(rightRecord).length && leftEntries.every(([key, value]) => Object.hasOwn(rightRecord, key) && sameValue(value, rightRecord[key]));
    }
    return false;
  };
  for (const [key, expected] of Object.entries(preset.seed)) {
    if (key === "text" || expected === undefined) continue;
    if (!sameValue(resolved[key], expected)) throw new Error(`動態圖文 ${graphic.id} 未忠實解析 preset ${preset.id}：${key}`);
  }
  return preset;
}

export function compactMotionGraphicPresets() {
  return motionGraphicPresets().map(({ id, name, family, license, renderer, seed, routing }) => ({
    id,
    name,
    family,
    license,
    renderer,
    kind: seed.kind ?? "card",
    animation: seed.animation ?? "fade",
    visualStyle: seed.visualStyle ?? "solid_panel",
    ...(routing ? { routing } : {}),
  }));
}
