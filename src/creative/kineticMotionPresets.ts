import type { MotionGraphicPreset } from "./motionGraphicPresetTypes";
import { KINETIC_TEXT_STYLE_SPECS, kineticTextMotion, type KineticTextStyle, type MotionEnergy } from "../motion/motionLanguage";

type Routing = NonNullable<MotionGraphicPreset["routing"]>;

interface KineticPresetSpec {
  style: KineticTextStyle;
  energy: MotionEnergy;
  roles: string[];
  intensity: Routing["intensity"];
}

/** Append-only: a retune is a new id, so saved bindings and seed SHAs never move. */
const KINETIC_PRESET_SPECS: readonly KineticPresetSpec[] = [
  { style: "slam", energy: "standard", roles: ["hook", "number", "payoff", "verdict"], intensity: "high" },
  { style: "slam", energy: "hype", roles: ["hook", "number", "payoff"], intensity: "high" },
  { style: "pop", energy: "punchy", roles: ["keyword", "emphasis", "hook"], intensity: "high" },
  { style: "pop", energy: "hype", roles: ["keyword", "emphasis"], intensity: "high" },
  { style: "rise", energy: "standard", roles: ["title", "chapter", "explanation"], intensity: "medium" },
  { style: "drop", energy: "punchy", roles: ["reveal", "turn", "answer"], intensity: "high" },
  { style: "swipe", energy: "standard", roles: ["step", "list", "comparison"], intensity: "medium" },
  { style: "zoom", energy: "standard", roles: ["chapter", "scene_change"], intensity: "medium" },
  { style: "focus", energy: "standard", roles: ["detail", "label", "explanation"], intensity: "low" },
];

const ENERGY_LABEL: Record<MotionEnergy, string> = { calm: "柔和", standard: "標準", punchy: "強勁", hype: "爆發" };

export function kineticPresetId(style: KineticTextStyle, energy: MotionEnergy): string {
  return energy === "standard" ? `kinetic_${style}` : `kinetic_${style}_${energy}`;
}

/** Authored at the 1080 / 30 fps reference like every other registered seed. */
export const KINETIC_MOTION_PRESETS: readonly MotionGraphicPreset[] = KINETIC_PRESET_SPECS.map(({ style, energy, roles, intensity }) => {
  const id = kineticPresetId(style, energy), spec = KINETIC_TEXT_STYLE_SPECS[style];
  const name = `${spec.label}・${ENERGY_LABEL[energy]}`;
  // Whole-line styles scale each line about its center, so they need the
  // widest safe margin; per-character styles keep the usual title box.
  const wholeLine = spec.unit === "all";
  return {
    id, name, family: "動態文字 · Motion Language",
    license: "MIT", provenance: "Editkin original Hao Motion Language v1 preset; art review required",
    renderer: "hao-motion-composition/v2",
    routing: { semanticRoles: roles, formats: ["9:16", "16:9", "1:1"], requires: ["none"],
      avoidWhen: wholeLine ? ["long_sentence", "dense_caption_region", "edge_aligned_title"] : ["long_sentence", "dense_caption_region"], intensity },
    seed: {
      schema: "hao.motion-composition/v2", presetId: id, name, kind: "title", animation: "fade",
      x: wholeLine ? .14 : .08, y: style === "drop" ? .24 : .14, width: wholeLine ? .72 : .84, fontSize: style === "focus" ? 64 : 88,
      fontFamily: "Noto Sans TC", fontWeight: style === "focus" ? 700 : 900, letterSpacing: 0,
      outlineWidth: 0, shadowDepth: 3, cornerRadius: 0,
      textColor: "#FFFFFF", backgroundColor: "#00000000", accentColor: "#0B0F1ACC",
      motionV2: kineticTextMotion(style, { fps: 30, unit: 1, energy }),
      layoutV2: { safeArea: { top: .06, right: .06, bottom: .1, left: .06 }, maxLines: 2,
        minFontSize: style === "focus" ? 32 : 40, lineGap: 6, align: wholeLine ? "center" : "left" },
    },
  };
});
