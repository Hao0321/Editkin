import type { MotionGraphicPreset } from "./motionGraphicPresetTypes";

// Original full-bleed editorial typography. These are planning candidates, not
// art-approved defaults. A frame must have a quiet/dark upper area before use.
const LIGHT_INK_PRESETS: readonly MotionGraphicPreset[] = [
  { id: "travel_editorial_hero", name: "旅行誌・留白主標", family: "旅行誌",
    license: "MIT", provenance: "Editkin original editorial typography, 2026-08-31; art review required",
    renderer: "hao-motion-composition/v2",
    routing: { semanticRoles: ["hook", "location", "payoff"], formats: ["9:16"], requires: ["none"], avoidWhen: ["bright_upper_background", "face_in_title_area", "long_sentence"], intensity: "low" },
    seed: { schema: "hao.motion-composition/v2", presetId: "travel_editorial_hero", name: "旅行誌・留白主標", kind: "title",
      animation: "fade", x: .06, y: .19, width: .82, fontSize: 106, fontFamily: "Noto Serif TC", fontWeight: 750, letterSpacing: 4,
      outlineWidth: 0, shadowDepth: 2, cornerRadius: 0, offsetX: 0, offsetY: 0,
      textColor: "#FFF9EF", backgroundColor: "#00000000", accentColor: "#1E1B18A0",
      motionV2: { sequence: { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0 },
        entrance: { durationFrames: 12, offsetXPixels: 0, offsetYPixels: 16, scale: 1, opacity: 0, easing: { type: "ease_out" } },
        exit: { durationFrames: 5, offsetXPixels: 0, offsetYPixels: -4, scale: 1, opacity: 0, easing: { type: "ease_in" } } },
      layoutV2: { safeArea: { top: .09, right: .12, bottom: .2, left: .06 }, maxLines: 1, minFontSize: 64, lineGap: 0, align: "left" } },
  },
  { id: "travel_editorial_eyebrow", name: "旅行誌・地點眉標", family: "旅行誌",
    license: "MIT", provenance: "Editkin original editorial typography, 2026-08-31; art review required",
    renderer: "hao-motion-composition/v2",
    routing: { semanticRoles: ["location", "identity"], formats: ["9:16"], requires: ["none"], avoidWhen: ["bright_upper_background", "unverified_location"], intensity: "low" },
    seed: { schema: "hao.motion-composition/v2", presetId: "travel_editorial_eyebrow", name: "旅行誌・地點眉標", kind: "title",
      animation: "fade", x: .0875, y: .155, width: .72, fontSize: 28, fontFamily: "Noto Sans TC", fontWeight: 500, letterSpacing: 5,
      outlineWidth: 0, shadowDepth: 1, cornerRadius: 0, offsetX: 0, offsetY: 0,
      textColor: "#FFF9EF", backgroundColor: "#00000000", accentColor: "#1E1B18A0",
      motionV2: { sequence: { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0 },
        entrance: { durationFrames: 9, offsetXPixels: 0, offsetYPixels: 8, scale: 1, opacity: 0, easing: { type: "ease_out" } },
        exit: { durationFrames: 5, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 0, easing: { type: "ease_in" } } },
      layoutV2: { safeArea: { top: .09, right: .12, bottom: .2, left: .06 }, maxLines: 1, minFontSize: 26, lineGap: 0, align: "left" } },
  },
];

// A bright real background needs dark ink, not a heavier neon/glow outline.
// Both variants keep the same layout and timing; planners must inspect the shot.
export const TRAVEL_EDITORIAL_PRESETS: readonly MotionGraphicPreset[] = [
  ...LIGHT_INK_PRESETS,
  ...LIGHT_INK_PRESETS.map(preset => ({
    ...preset, id: `${preset.id}_dark`, name: `${preset.name}・深墨`,
    routing: { ...preset.routing!, avoidWhen: ["dark_upper_background", "face_in_title_area", "long_sentence"] },
    seed: { ...preset.seed, presetId: `${preset.id}_dark`, name: `${preset.name}・深墨`,
      textColor: "#302720", accentColor: "#FFF9EF00", shadowDepth: 0 },
  })),
];
