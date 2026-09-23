import type { MotionGraphicPresetSeed } from "../domain/types";

export type LowerThirdPresetId = "clean_blue" | "documentary_white" | "signal_lime";

export interface LowerThirdPreset {
  id: LowerThirdPresetId;
  name: string;
  description: string;
  nameBar: MotionGraphicPresetSeed;
  unitBar: MotionGraphicPresetSeed;
}

const motion = {
  sequence: { unit: "all" as const, order: "forward" as const, exitOrder: "reverse" as const, staggerFrames: 0 },
  entrance: { durationFrames: 10, offsetXPixels: -42, offsetYPixels: 0, scale: .98, opacity: 0, easing: { type: "spring" as const, stiffness: 180, damping: 22, mass: 1, initialVelocity: 0 } },
  exit: { durationFrames: 7, offsetXPixels: -18, offsetYPixels: 0, scale: .99, opacity: 0, easing: { type: "ease_in" as const } },
};

function barSeed(input: {
  presetId: string;
  name: string;
  kind: "card" | "tag";
  x: number;
  y: number;
  width: number;
  fontSize: number;
  fontWeight: number;
  textColor: string;
  backgroundColor: string;
  accentColor: string;
}): MotionGraphicPresetSeed {
  return {
    schema: "hao.motion-composition/v2", presetId: input.presetId, name: input.name, kind: input.kind,
    x: input.x, y: input.y, width: input.width, fontSize: input.fontSize, fontFamily: "Noto Sans TC",
    fontWeight: input.fontWeight, letterSpacing: 0, outlineWidth: 2, shadowDepth: 0,
    cornerRadius: input.kind === "card" ? 4 : 3, animation: "slide_up", offsetX: 0, offsetY: 0,
    textColor: input.textColor, backgroundColor: input.backgroundColor, accentColor: input.accentColor,
    motionV2: structuredClone(motion),
    layoutV2: { safeArea: { top: .05, right: .05, bottom: .08, left: .05 }, maxLines: 1, minFontSize: input.kind === "card" ? 30 : 22, lineGap: 0, align: "left" },
  };
}

export const LOWER_THIRD_PRESETS: readonly LowerThirdPreset[] = [
  {
    id: "clean_blue", name: "藍白資訊", description: "教學、科技、產品",
    nameBar: barSeed({ presetId: "lower_third_clean_blue_name", name: "藍白資訊 · 人名 BAR", kind: "card", x: .068, y: .705, width: .34, fontSize: 46, fontWeight: 850, textColor: "#FFFFFF", backgroundColor: "#1558D6F2", accentColor: "#FFFFFF" }),
    unitBar: barSeed({ presetId: "lower_third_clean_blue_unit", name: "藍白資訊 · 單位 BAR", kind: "tag", x: .084, y: .79, width: .28, fontSize: 28, fontWeight: 700, textColor: "#12335F", backgroundColor: "#FFFFFFF5", accentColor: "#1558D6" }),
  },
  {
    id: "documentary_white", name: "紀錄片留白", description: "人物、訪談、紀錄",
    nameBar: barSeed({ presetId: "lower_third_documentary_white_name", name: "紀錄片留白 · 人名 BAR", kind: "card", x: .068, y: .705, width: .34, fontSize: 46, fontWeight: 850, textColor: "#111317", backgroundColor: "#FFFFFFF5", accentColor: "#111317" }),
    unitBar: barSeed({ presetId: "lower_third_documentary_white_unit", name: "紀錄片留白 · 單位 BAR", kind: "tag", x: .084, y: .79, width: .28, fontSize: 28, fontWeight: 700, textColor: "#FFFFFF", backgroundColor: "#111317EE", accentColor: "#FFFFFF" }),
  },
  {
    id: "signal_lime", name: "訊號綠", description: "實驗、數據、現場",
    nameBar: barSeed({ presetId: "lower_third_signal_lime_name", name: "訊號綠 · 人名 BAR", kind: "card", x: .068, y: .705, width: .34, fontSize: 46, fontWeight: 850, textColor: "#07110A", backgroundColor: "#B8FF74F2", accentColor: "#07110A" }),
    unitBar: barSeed({ presetId: "lower_third_signal_lime_unit", name: "訊號綠 · 單位 BAR", kind: "tag", x: .084, y: .79, width: .28, fontSize: 28, fontWeight: 700, textColor: "#FFFFFF", backgroundColor: "#102315F2", accentColor: "#B8FF74" }),
  },
] as const;
