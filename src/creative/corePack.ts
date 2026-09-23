import rawPack from "./haoCorePack.json";
import { DEFAULT_CAPTION_STYLE, type CaptionStyle, type ClipCreativeState, type ColorAdjustments, type TimelineClip } from "../domain/types";

export interface CreativePresetBase {
  id: string;
  name: string;
  license: string;
  provenance: string;
  renderer: string;
}

export interface LookPreset extends CreativePresetBase {
  color: ColorAdjustments;
}

export interface EffectPreset extends CreativePresetBase {}

export type TransitionRenderer = "transition-fade" | "transition-zoom" | "transition-whip" | "transition-flash";

export interface TransitionPreset extends CreativePresetBase {
  defaultDuration: number;
  /**
   * A preset may combine several already-shipped clip entrance/exit primitives.
   * `renderer` remains the primary primitive for backwards-compatible packs.
   */
  renderers?: TransitionRenderer[];
  parameters?: {
    fadeCurve?: number;
    zoomAmount?: number;
    travelPercent?: number;
    direction?: -1 | 1;
    flashStrength?: number;
  };
  routing?: {
    intents: string[];
    beatRoles: string[];
    avoidRoles: string[];
    requiredHandlesFrames: number;
    fallbackId: string;
    intensity: "low" | "medium" | "high";
  };
}

export interface TextStylePreset extends CreativePresetBase {
  style: Omit<CaptionStyle, "presetId">;
}

export interface TemplatePreset extends CreativePresetBase {}

export interface CorePackExtension {
  looks?: LookPreset[];
  effects?: EffectPreset[];
  transitions?: TransitionPreset[];
  textStyles?: TextStylePreset[];
  templates?: TemplatePreset[];
}

export interface HaoCorePack {
  schemaVersion: number;
  id: string;
  name: string;
  version: string;
  license: string;
  attribution: string;
  source: {
    compiler: string;
    referenceCount: number;
    privateImagesEmbedded: boolean;
    filterRuntime: string;
    motionRuntime: string;
  };
  presets: {
    looks: LookPreset[];
    effects: EffectPreset[];
    transitions: TransitionPreset[];
    textStyles: TextStylePreset[];
    templates: TemplatePreset[];
  };
}

export const HAO_CORE_PACK = rawPack as HaoCorePack;
export const LOOK_PRESETS = HAO_CORE_PACK.presets.looks;
export const EFFECT_PRESETS = HAO_CORE_PACK.presets.effects;
export const TRANSITION_PRESETS = HAO_CORE_PACK.presets.transitions;
export const TEXT_STYLE_PRESETS = HAO_CORE_PACK.presets.textStyles;
export const TEMPLATE_PRESETS = HAO_CORE_PACK.presets.templates;

function registerUnique<T extends CreativePresetBase>(target: T[], additions: T[], kind: string): void {
  const ids = new Set(target.map((item) => item.id));
  for (const item of additions) {
    if (ids.has(item.id)) continue;
    if (!item.license || !item.provenance || !item.renderer) throw new Error(`${kind} preset 缺少授權、來源或 renderer：${item.id}`);
    target.push(item);
    ids.add(item.id);
  }
}

export function registerCorePackExtension(extension: CorePackExtension): void {
  registerUnique(LOOK_PRESETS, extension.looks ?? [], "look");
  registerUnique(EFFECT_PRESETS, extension.effects ?? [], "effect");
  registerUnique(TRANSITION_PRESETS, extension.transitions ?? [], "transition");
  registerUnique(TEXT_STYLE_PRESETS, extension.textStyles ?? [], "text style");
  registerUnique(TEMPLATE_PRESETS, extension.templates ?? [], "template");
}

function requirePreset<T extends CreativePresetBase>(items: T[], id: string, kind: string): T {
  const preset = items.find((item) => item.id === id);
  if (!preset) throw new Error(`找不到 ${kind} preset：${id}`);
  return preset;
}

export function findLookPreset(id: string): LookPreset {
  return requirePreset(LOOK_PRESETS, id, "look");
}

export function findEffectPreset(id: string): EffectPreset {
  return requirePreset(EFFECT_PRESETS, id, "effect");
}

export function findTransitionPreset(id: string): TransitionPreset {
  return requirePreset(TRANSITION_PRESETS, id, "transition");
}

export function transitionRenderers(preset: TransitionPreset): TransitionRenderer[] {
  const values = preset.renderers?.length ? preset.renderers : [preset.renderer];
  return [...new Set(values)] as TransitionRenderer[];
}

export function findTextStylePreset(id: string): TextStylePreset {
  return requirePreset(TEXT_STYLE_PRESETS, id, "text style");
}

export function captionStyleFromPreset(id: string): CaptionStyle {
  const preset = findTextStylePreset(id);
  return { ...DEFAULT_CAPTION_STYLE, presetId: preset.id, ...preset.style };
}

export function resolveCreativeState(clip: TimelineClip): Required<Pick<ClipCreativeState, "effectPresetIds">> & Omit<ClipCreativeState, "effectPresetIds"> {
  const creative = clip.creative ?? { effectPresetIds: [] };
  if (creative.lookPresetId) findLookPreset(creative.lookPresetId);
  for (const id of creative.effectPresetIds) findEffectPreset(id);
  if (creative.transitionIn) findTransitionPreset(creative.transitionIn.presetId);
  if (creative.transitionOut) findTransitionPreset(creative.transitionOut.presetId);
  return creative;
}

export function combineLookColor(base: ColorAdjustments, lookPresetId?: string): ColorAdjustments {
  if (!lookPresetId) return { ...base };
  const look = findLookPreset(lookPresetId).color;
  return {
    ...base,
    brightness: Math.max(-1, Math.min(1, base.brightness + look.brightness)),
    contrast: Math.max(0.1, Math.min(3, base.contrast * look.contrast)),
    saturation: Math.max(0, Math.min(3, base.saturation * look.saturation)),
    hue: Math.max(-180, Math.min(180, base.hue + look.hue)),
  };
}

export function previewEffectFilter(effectPresetIds: string[]): string {
  const filters: string[] = [];
  for (const id of effectPresetIds) {
    const renderer = findEffectPreset(id).renderer;
    if (renderer === "ffmpeg-film-grain") filters.push("contrast(1.04)");
    else if (renderer === "ffmpeg-monochrome") filters.push("grayscale(1)", "contrast(1.16)");
    else if (renderer === "ffmpeg-bloom") filters.push("brightness(1.08)");
    else if (renderer === "ffmpeg-crisp") filters.push("contrast(1.1)");
    else if (renderer === "ffmpeg-vignette") filters.push("contrast(1.04)");
    else if (renderer === "ffmpeg-denoise") filters.push("contrast(.99)");
    else if (renderer === "ffmpeg-detail-pop") filters.push("contrast(1.12) saturate(1.04)");
    else if (renderer === "ffmpeg-pastel") filters.push("brightness(1.04) contrast(.94) saturate(.9)");
    else if (renderer === "ffmpeg-night-depth") filters.push("brightness(.92) contrast(1.16) saturate(1.06)");
    else if (renderer === "ffmpeg-highlight-soft") filters.push("brightness(1.03) contrast(.97)");
  }
  return filters.join(" ");
}

export function previewTransitionState(clip: TimelineClip, localTime: number): { opacity: number; scale: number; xPercent: number; brightness: number } {
  const state = resolveCreativeState(clip);
  let opacity = 1;
  let scale = 1;
  let xPercent = 0;
  let brightness = 1;
  const apply = (presetId: string, duration: number, progress: number, incoming: boolean) => {
    const preset = findTransitionPreset(presetId);
    const renderers = transitionRenderers(preset);
    const eased = Math.max(0, Math.min(1, progress));
    const edge = incoming ? 1 - eased : eased;
    if (renderers.includes("transition-fade")) opacity *= eased ** (preset.parameters?.fadeCurve ?? 1);
    if (renderers.includes("transition-zoom")) scale *= 1 + (preset.parameters?.zoomAmount ?? .08) * edge;
    if (renderers.includes("transition-whip")) xPercent += (incoming ? -1 : 1) * (preset.parameters?.direction ?? 1) * (preset.parameters?.travelPercent ?? 28) * edge;
    if (renderers.includes("transition-flash")) brightness *= 1 + (preset.parameters?.flashStrength ?? .55) * edge;
    void duration;
  };
  if (state.transitionIn && localTime < state.transitionIn.duration) {
    apply(state.transitionIn.presetId, state.transitionIn.duration, localTime / state.transitionIn.duration, true);
  }
  if (state.transitionOut && localTime > clip.duration - state.transitionOut.duration) {
    apply(state.transitionOut.presetId, state.transitionOut.duration, (clip.duration - localTime) / state.transitionOut.duration, false);
  }
  return { opacity, scale, xPercent, brightness };
}
