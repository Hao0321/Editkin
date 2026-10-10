import type { MotionGraphicPreset } from "./motionGraphicPresetTypes";
import type { MotionVectorV2 } from "../domain/types";

function vectorPreset(id: string, name: string, vector: MotionVectorV2, width: number, y: number): MotionGraphicPreset {
  return {
    id, name, family: "自研圖形 · 資訊 Motion", license: "MIT",
    provenance: "Editkin original cubic geometry and deterministic integer-frame reveal; art review required",
    renderer: "hao-motion-composition/v2",
    routing: { semanticRoles: ["chapter", "step", "diagram"], formats: ["9:16", "16:9"], requires: ["none"],
      avoidWhen: ["occludes_primary_focus"], intensity: "low" },
    seed: { schema: "hao.motion-composition/v2", presetId: id, name, kind: "card", text: "", animation: "fade",
      x: .08, y, width, fontSize: 32, fontFamily: "Noto Sans TC", fontWeight: 700,
      outlineWidth: vector.kind === "panel" ? 2 : 0, shadowDepth: 0, cornerRadius: 10,
      textColor: vector.kind === "line_grid" ? "#175CD330" : "#24211E", backgroundColor: vector.kind === "panel" ? "#F9F4EBF5" : "#DAD3C8",
      accentColor: vector.schema === "editkin.motion-vector-annotation/v1" ? "#175CD3" : vector.kind === "line_grid" ? "#175CD31C" : vector.kind === "dot_grid" ? "#77706440" : "#BF6848",
      vectorV2: vector,
      motionV2: { sequence: { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0 },
        entrance: { durationFrames: 8, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 0, easing: { type: "ease_out" } },
        exit: { durationFrames: 6, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 0, easing: { type: "ease_in" } } },
      layoutV2: { safeArea: { top: .04, right: .04, bottom: .08, left: .04 }, maxLines: 1, minFontSize: 8, lineGap: 0, align: "left" },
    },
  };
}

export const NATIVE_VECTOR_PRESETS: readonly MotionGraphicPreset[] = [
  vectorPreset("reel_step_progress", "章節分段進度", { schema: "editkin.motion-vector/v1", kind: "step_progress", heightPixels: 12, revealFrames: 18, steps: 6, activeStep: 1, gapPixels: 12 }, .84, .085),
  vectorPreset("reel_rule_reveal", "短線揭露", { schema: "editkin.motion-vector/v1", kind: "rule", heightPixels: 5, revealFrames: 14 }, .64, .275),
  vectorPreset("reel_ink_annotation", "文字上方刪線", { schema: "editkin.motion-vector-annotation/v1", kind: "rule", heightPixels: 4, revealFrames: 7 }, .64, .275),
  vectorPreset("reel_dot_grid", "紙面點陣", { schema: "editkin.motion-vector/v1", kind: "dot_grid", heightPixels: 480, revealFrames: 1, spacingPixels: 42, dotRadiusPixels: 1.4 }, .84, .32),
  vectorPreset("reel_line_grid", "藍白網格", { schema: "editkin.motion-vector/v1", kind: "line_grid", heightPixels: 480,
    revealFrames: 1, spacingPixels: 72, lineWidthPixels: 1, majorEvery: 4 }, .84, .32),
  vectorPreset("reel_native_panel", "圓角資訊面板", { schema: "editkin.motion-vector/v1", kind: "panel", heightPixels: 360, revealFrames: 1 }, .84, .32),
  vectorPreset("reel_native_disc", "圓形焦點", { schema: "editkin.motion-vector/v1", kind: "ellipse", heightPixels: 200, revealFrames: 1 }, .185185, .32),
  vectorPreset("reel_connection_field", "能力聚合連線", { schema: "editkin.motion-vector/v1", kind: "connection_field", heightPixels: 600,
    revealFrames: 1, seed: 32021, points: 32, dotRadiusPixels: 4, lineWidthPixels: 1.2,
    burstFrames: 12, gatherStartFrame: 30, gatherFrames: 12, connectStartFrame: 60, connectFrames: 12 }, .84, .29),
];
