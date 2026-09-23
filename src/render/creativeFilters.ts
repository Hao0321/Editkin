import { findEffectPreset, findLookPreset, findTransitionPreset, resolveCreativeState, transitionRenderers, type TransitionRenderer } from "../creative/corePack";
import type { TimelineClip } from "../domain/types";

function n(value: number): string {
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function localTime(variable: string): string {
  return variable;
}

export function lookColorTerms(clip: TimelineClip): { brightness: string; contrast: string; saturation: string; hue: string } {
  const lookId = resolveCreativeState(clip).lookPresetId;
  if (!lookId) return { brightness: "0", contrast: "1", saturation: "1", hue: "0" };
  const color = findLookPreset(lookId).color;
  return {
    brightness: n(color.brightness),
    contrast: n(color.contrast),
    saturation: n(color.saturation),
    hue: n(color.hue),
  };
}

export function effectFilters(clip: TimelineClip): string[] {
  const filters: string[] = [];
  for (const id of resolveCreativeState(clip).effectPresetIds) {
    const preset = findEffectPreset(id);
    switch (preset.renderer) {
      case "ffmpeg-film-grain":
        filters.push(id === "analog_print_soft" ? "noise=alls=4:allf=t+u" : "noise=alls=7:allf=t");
        break;
      case "ffmpeg-monochrome":
        filters.push("hue=s=0", id === "xerox_pulse" ? "eq=contrast=1.42:brightness=0.02" : "eq=contrast=1.18");
        break;
      case "ffmpeg-bloom":
        filters.push("eq=brightness=0.055:contrast=0.98", "gblur=sigma=0.65");
        break;
      case "ffmpeg-crisp":
        filters.push("unsharp=5:5:0.65:3:3:0.25");
        break;
      case "ffmpeg-vignette":
        filters.push("vignette=PI/5");
        break;
      case "ffmpeg-denoise":
        filters.push("hqdn3d=2:1.5:3:2.25");
        break;
      case "ffmpeg-detail-pop":
        filters.push("eq=contrast=1.07:saturation=1.04", "unsharp=5:5:0.8:3:3:0.3");
        break;
      case "ffmpeg-pastel":
        filters.push("eq=brightness=0.035:contrast=0.94:saturation=0.9", "gblur=sigma=0.25");
        break;
      case "ffmpeg-night-depth":
        filters.push("eq=brightness=-0.035:contrast=1.16:saturation=1.06", "colorbalance=bs=.035:rs=-.018");
        break;
      case "ffmpeg-highlight-soft":
        filters.push("curves=master='0/0 0.72/0.77 1/0.94'", "gblur=sigma=0.18");
        break;
      default:
        throw new Error(`Editkin 尚未支援 effect renderer：${preset.renderer}`);
    }
  }
  return filters;
}

function transitionByRenderer(clip: TimelineClip, renderer: TransitionRenderer, variable: string, incoming: boolean): { duration: number; local: string; parameters: ReturnType<typeof findTransitionPreset>["parameters"] } | undefined {
  const transition = incoming ? clip.creative?.transitionIn : clip.creative?.transitionOut;
  if (!transition) return undefined;
  const preset = findTransitionPreset(transition.presetId);
  if (!transitionRenderers(preset).includes(renderer)) return undefined;
  return { duration: transition.duration, local: localTime(variable), parameters: preset.parameters };
}

export function transitionOpacityExpression(clip: TimelineClip, variable = "T"): string {
  const expressions: string[] = [];
  const fadeIn = transitionByRenderer(clip, "transition-fade", variable, true);
  if (fadeIn) expressions.push(`pow(min(1,max(0,${fadeIn.local}/${n(fadeIn.duration)})),${n(fadeIn.parameters?.fadeCurve ?? 1)})`);
  const fadeOut = transitionByRenderer(clip, "transition-fade", variable, false);
  if (fadeOut) expressions.push(`pow(min(1,max(0,(${n(clip.duration)}-${fadeOut.local})/${n(fadeOut.duration)})),${n(fadeOut.parameters?.fadeCurve ?? 1)})`);
  return expressions.length ? expressions.join("*") : "1";
}

export function transitionScaleExpression(clip: TimelineClip, variable = "t"): string {
  const terms: string[] = [];
  const zoomIn = transitionByRenderer(clip, "transition-zoom", variable, true);
  if (zoomIn) terms.push(`1+${n(zoomIn.parameters?.zoomAmount ?? .08)}*max(0,1-${zoomIn.local}/${n(zoomIn.duration)})`);
  const zoomOut = transitionByRenderer(clip, "transition-zoom", variable, false);
  if (zoomOut) terms.push(`1+${n(zoomOut.parameters?.zoomAmount ?? .08)}*max(0,(${zoomOut.local}-${n(clip.duration - zoomOut.duration)})/${n(zoomOut.duration)})`);
  return terms.length ? terms.join("*") : "1";
}

export function transitionXExpression(clip: TimelineClip, width: number, variable = "t"): string {
  const terms: string[] = [];
  const whipIn = transitionByRenderer(clip, "transition-whip", variable, true);
  if (whipIn) terms.push(`${n(-(whipIn.parameters?.direction ?? 1) * (whipIn.parameters?.travelPercent ?? 100) / 100 * width)}*max(0,1-${whipIn.local}/${n(whipIn.duration)})`);
  const whipOut = transitionByRenderer(clip, "transition-whip", variable, false);
  if (whipOut) terms.push(`${n((whipOut.parameters?.direction ?? 1) * (whipOut.parameters?.travelPercent ?? 100) / 100 * width)}*max(0,(${whipOut.local}-${n(clip.duration - whipOut.duration)})/${n(whipOut.duration)})`);
  return terms.length ? terms.join("+") : "0";
}

export function transitionBrightnessExpression(clip: TimelineClip, variable = "t"): string {
  const terms: string[] = [];
  const flashIn = transitionByRenderer(clip, "transition-flash", variable, true);
  if (flashIn) terms.push(`${n(flashIn.parameters?.flashStrength ?? .55)}*max(0,1-${flashIn.local}/${n(flashIn.duration)})`);
  const flashOut = transitionByRenderer(clip, "transition-flash", variable, false);
  if (flashOut) terms.push(`${n(flashOut.parameters?.flashStrength ?? .55)}*max(0,(${flashOut.local}-${n(clip.duration - flashOut.duration)})/${n(flashOut.duration)})`);
  return terms.length ? terms.join("+") : "0";
}
