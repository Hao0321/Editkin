import type { MotionGraphicPreset } from "./motionGraphicPresetTypes";

/** Original, editable motion recipes abstracted from spatial reels and editorial explainers. */
export const REEL_MOTION_PRESETS: readonly MotionGraphicPreset[] = [
  {
    id: "reel_spatial_headline", name: "空間展廊主標", family: "直式動態 · 空間",
    license: "MIT", provenance: "Editkin original procedural typography; art review required",
    renderer: "hao-motion-composition/v2",
    routing: { semanticRoles: ["hook", "chapter", "payoff"], formats: ["9:16", "16:9"], requires: ["none"],
      avoidWhen: ["dense_caption_region", "long_sentence"], intensity: "medium" },
    seed: {
      schema: "hao.motion-composition/v2", presetId: "reel_spatial_headline",
      name: "空間展廊主標", kind: "title", animation: "fade",
      x: .08, y: .085, width: .84, fontSize: 76, fontFamily: "Noto Sans TC",
      fontWeight: 850, letterSpacing: 1, outlineWidth: 0, shadowDepth: 0,
      cornerRadius: 18, textColor: "#F7F5F0", backgroundColor: "#00000000", accentColor: "#00000000",
      motionV2: {
        sequence: { unit: "all", order: "forward", exitOrder: "reverse", staggerFrames: 0 },
        entrance: { durationFrames: 12, offsetXPixels: 0, offsetYPixels: 16, scale: 1, opacity: 0,
          easing: { type: "ease_out" } },
        exit: { durationFrames: 8, offsetXPixels: 0, offsetYPixels: -18, scale: .97, opacity: 0,
          easing: { type: "ease_in" } },
      },
      layoutV2: { safeArea: { top: .06, right: .06, bottom: .1, left: .06 },
        maxLines: 2, minFontSize: 34, lineGap: 5, align: "left" },
    },
  },
  {
    id: "reel_editorial_step", name: "章節逐字標題", family: "直式動態 · 資訊",
    license: "MIT", provenance: "Editkin original procedural typography; art review required",
    renderer: "hao-motion-composition/v2",
    routing: { semanticRoles: ["hook", "chapter", "step"], formats: ["9:16", "16:9"], requires: ["none"],
      avoidWhen: ["long_sentence", "busy_background"], intensity: "medium" },
    seed: {
      schema: "hao.motion-composition/v2", presetId: "reel_editorial_step",
      name: "章節逐字標題", kind: "title", animation: "fade",
      x: .08, y: .11, width: .84, fontSize: 84, fontFamily: "Noto Sans TC",
      fontWeight: 900, letterSpacing: 0, outlineWidth: 0, shadowDepth: 1,
      cornerRadius: 16, textColor: "#24211E", backgroundColor: "#FBF6EDE8", accentColor: "#BF6848",
      motionV2: {
        sequence: { unit: "character", order: "forward", exitOrder: "reverse", staggerFrames: 1 },
        entrance: { durationFrames: 8, offsetXPixels: 30, offsetYPixels: 4, scale: .94, opacity: 0,
          easing: { type: "ease_out" } },
        exit: { durationFrames: 7, offsetXPixels: -20, offsetYPixels: -4, scale: .99, opacity: 0,
          easing: { type: "ease_in" } },
      },
      layoutV2: { safeArea: { top: .06, right: .06, bottom: .12, left: .06 },
        maxLines: 2, minFontSize: 36, lineGap: 6, align: "left" },
    },
  },
];
