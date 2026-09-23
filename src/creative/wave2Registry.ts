import rawWave2 from "./haoWave2Public.json";
import { DEFAULT_CAPTION_STYLE, type ClipLayout, type MotionGraphicAnimation, type MotionGraphicKind, type MotionGraphicPresetSeed } from "../domain/types";
import { registerCorePackExtension, type EffectPreset, type TemplatePreset, type TextStylePreset, type TransitionPreset } from "./corePack";

interface Wave2Base { id: string; name: string; family: string; license: string; provenance: string }
export interface Wave2MotionPreset extends Wave2Base { kind: string; presetType: "label" | "widget" | "template"; seed: MotionGraphicPresetSeed }
export interface Wave2MediaFrame extends Wave2Base { kind: string; requiresRealMedia: true }
export interface Wave2Registry {
  schema: "hao.core-pack-additions/v1";
  motionPresets: Wave2MotionPreset[];
  mediaFrames: Wave2MediaFrame[];
  counts: { textStyles: number; labels: number; effects: number; transitions: number; templates: number; dataWidgets: number; mediaFrames: number; total: number };
}

type RawWave2 = typeof rawWave2;
let registry: Wave2Registry | undefined;

const FAMILY_COLORS: Record<string, { backgroundColor: string; textColor: string; accentColor: string }> = {
  cinematic_alert_depth: { backgroundColor: "#101218EE", textColor: "#FFFFFF", accentColor: "#FF3B30" },
  structured_signal: { backgroundColor: "#F5F7FBF2", textColor: "#101827", accentColor: "#2653EB" },
  iridescent_object_stage: { backgroundColor: "#17142FE8", textColor: "#FFFFFF", accentColor: "#8B7CFF" },
  tactile_system_notes: { backgroundColor: "#FFF5C9F2", textColor: "#151515", accentColor: "#FF5A36" },
  local_editorial_calm: { backgroundColor: "#E9E0CFF2", textColor: "#17201B", accentColor: "#376B50" },
  surreal_signal_play: { backgroundColor: "#251344EA", textColor: "#FFFFFF", accentColor: "#5EF2C2" },
};

function requireRedistributable(items: Array<{ id: string; license?: string; provenance?: string }>, kind: string): void {
  const invalid = items.find((item) => !item.license || !item.provenance);
  if (invalid) throw new Error(`Wave 2 ${kind} 缺少授權或來源：${invalid.id}`);
}

function animationFor(value: string): MotionGraphicAnimation {
  if (["pop", "stamp", "bounce", "drop_impact"].includes(value)) return "pop";
  if (["slide_up", "word_rise", "soft_rise", "hand_slide"].includes(value)) return "slide_up";
  if (["counter", "stagger"].includes(value)) return "spring_soft";
  return "fade";
}

function labelSeed(item: RawWave2["labels"][number]): MotionGraphicPresetSeed {
  return {
    presetId: item.id, name: item.name, kind: "tag", width: 0.28, fontSize: 38,
    textColor: item.ink, backgroundColor: item.fill, accentColor: item.ink,
    animation: item.shape === "stamp" || item.shape === "check" ? "pop" : "slide_up",
  };
}

function widgetKind(kind: string): MotionGraphicKind {
  return ["metric", "progress", "donut", "gauge", "kpi", "retention"].includes(kind) ? "counter" : "card";
}

function widgetSeed(item: RawWave2["dataWidgets"][number]): MotionGraphicPresetSeed {
  const colors = FAMILY_COLORS[item.family] ?? FAMILY_COLORS.structured_signal;
  const kind = widgetKind(item.kind);
  return {
    presetId: item.id, name: item.name, kind, width: kind === "counter" ? 0.24 : 0.52,
    fontSize: kind === "counter" ? 68 : 42, animation: kind === "counter" ? "spring_soft" : "pop", ...colors,
  };
}

function templateSeed(item: RawWave2["templates"][number]): MotionGraphicPresetSeed {
  const family = item.id.replace("exp26w2_", "");
  return { presetId: item.id, name: item.name, kind: "title", width: 0.7, fontSize: 64, animation: "slide_up", ...(FAMILY_COLORS[family] ?? FAMILY_COLORS.structured_signal) };
}

export function initializeWave2Registry(): Wave2Registry {
  if (registry) return registry;
  if (rawWave2.schema !== "hao.core-pack-additions/v1") throw new Error("Wave 2 registry schema 不相容");
  const licensedGroups = [rawWave2.textStyles, rawWave2.labels, rawWave2.effects, rawWave2.transitions, rawWave2.templates, rawWave2.dataWidgets, rawWave2.mediaFrames];
  licensedGroups.forEach((items, index) => requireRedistributable(items, `group-${index + 1}`));

  const textStyles: TextStylePreset[] = rawWave2.textStyles.map((item) => ({
    id: item.id, name: item.name, license: item.license, provenance: item.provenance, renderer: item.renderer,
    style: { ...DEFAULT_CAPTION_STYLE, ...item.style, alignment: item.style.alignment as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 },
  }));
  const effects = rawWave2.effects.map((item) => ({ ...item })) as EffectPreset[];
  const transitions: TransitionPreset[] = rawWave2.transitions.map((item) => {
    const parameters = "parameters" in item ? item.parameters as TransitionPreset["parameters"] : undefined;
    return { ...item, renderer: item.fallbackRenderer, ...(parameters ? { parameters } : {}) } as TransitionPreset;
  });
  const templates = rawWave2.templates.map((item) => ({ ...item })) as TemplatePreset[];
  registerCorePackExtension({ textStyles, effects, transitions, templates });

  const motionPresets: Wave2MotionPreset[] = [
    ...rawWave2.labels.map((item) => ({ ...item, kind: item.shape, presetType: "label" as const, seed: labelSeed(item) })),
    ...rawWave2.dataWidgets.map((item) => ({ ...item, presetType: "widget" as const, seed: widgetSeed(item) })),
    ...rawWave2.templates.map((item) => ({ ...item, kind: "template", family: item.id.replace("exp26w2_", ""), presetType: "template" as const, seed: templateSeed(item) })),
  ];
  const counts = {
    textStyles: rawWave2.textStyles.length, labels: rawWave2.labels.length, effects: rawWave2.effects.length,
    transitions: rawWave2.transitions.length, templates: rawWave2.templates.length, dataWidgets: rawWave2.dataWidgets.length,
    mediaFrames: rawWave2.mediaFrames.length, total: 0,
  };
  counts.total = Object.entries(counts).filter(([key]) => key !== "total").reduce((sum, [, value]) => sum + value, 0);
  registry = { schema: rawWave2.schema, motionPresets, mediaFrames: rawWave2.mediaFrames as Wave2MediaFrame[], counts };
  return registry;
}

export function mediaFrameLayout(kind: string): ClipLayout {
  const full = { x: 0, y: 0, width: 1, height: 1 };
  const layouts: Record<string, ClipLayout> = {
    split_v: { crop: { x: 0, y: 0, width: 0.5, height: 1 }, viewport: { x: 0, y: 0, width: 0.5, height: 1 } },
    split_h: { crop: { x: 0, y: 0, width: 1, height: 0.5 }, viewport: { x: 0, y: 0, width: 1, height: 0.5 } },
    portrait: { crop: { x: 0.22, y: 0, width: 0.56, height: 1 }, viewport: { x: 0.28, y: 0.05, width: 0.44, height: 0.9 } },
    letterbox: { crop: full, viewport: { x: 0, y: 0.12, width: 1, height: 0.76 } },
    circle: { crop: { x: 0.2, y: 0, width: 0.6, height: 1 }, viewport: { x: 0.62, y: 0.08, width: 0.3, height: 0.48 } },
    pip: { crop: full, viewport: { x: 0.65, y: 0.62, width: 0.3, height: 0.3 } },
    caption_safe: { crop: full, viewport: { x: 0.04, y: 0.04, width: 0.92, height: 0.78 } },
  };
  return layouts[kind] ?? { crop: full, viewport: kind === "device" || kind === "rounded" || kind === "card" ? { x: 0.08, y: 0.08, width: 0.84, height: 0.84 } : full };
}
