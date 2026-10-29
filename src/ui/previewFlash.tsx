import type { ActivePreviewLayer } from "../application/previewMedia";
import type { TimelineClip } from "../domain/types";
import { findTransitionPreset, transitionRenderers } from "../creative/corePack";
// Preview-side styles for the GPU retry and the effect-preview notice live with this Preview helper module.
import "./previewSafety.css";

/**
 * Flash transitions in the browser preview, matched to the export.
 *
 * The export brightens a flash with FFmpeg `eq` (src/render/creativeFilters.ts transitionBrightnessExpression):
 * `eq` adds an integer offset to the 8-bit limited-range luma, floor(floor(100·b + 100)·511/200) − 256 code values
 * (vf_eq process_c), which comes back as the same addition on R, G and B of offset/219 of full scale. Measured on
 * the bundled FFmpeg 8.1: b = 0.1 → +29, 0.275 → +79, 0.55 → +163 per 8-bit channel, clipped at white. CSS
 * `brightness()` multiplies instead (black stayed black), so the preview now adds the same amount with an SVG
 * component-transfer filter on the layer itself: lower layers and transparent letterbox areas stay untouched,
 * exactly as in the export.
 */
export function eqBrightnessAddition(brightness: number): number {
  if (!Number.isFinite(brightness) || brightness <= 0) return 0;
  const offset = Math.floor(Math.floor(100 * Math.min(1, brightness) + 100) * 511 / 200) - 256;
  return Math.max(0, offset) / 219;
}

/** The export's flash term for one clip at its local time (in + out, same defaults as the export). */
export function previewFlashTerm(clip: TimelineClip, localTime: number): number {
  let term = 0;
  const flash = (transition: { presetId: string; duration: number } | undefined, incoming: boolean) => {
    if (!transition || !(transition.duration > 0)) return;
    const preset = findTransitionPreset(transition.presetId);
    if (!transitionRenderers(preset).includes("transition-flash")) return;
    const strength = preset.parameters?.flashStrength ?? .55;
    const progress = incoming ? 1 - localTime / transition.duration : (localTime - (clip.duration - transition.duration)) / transition.duration;
    term += strength * Math.max(0, progress);
  };
  flash(clip.creative?.transitionIn, true);
  flash(clip.creative?.transitionOut, false);
  return term;
}

/**
 * Additive amounts for one preview layer, in the export's order: the clip itself first, then each enclosing
 * composition clip from the innermost outwards (each pre-render applies its own eq). Zero steps are dropped.
 */
export function previewLayerFlashSteps(layer: ActivePreviewLayer, playhead: number): number[] {
  const displayClip = layer.displayClip ?? layer.clip;
  const leafTime = (layer.displayPlayhead ?? playhead) - displayClip.timelineStart;
  const ancestors = layer.compositionAncestors ?? [];
  const steps = [previewFlashTerm(displayClip, leafTime)];
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index];
    steps.push(previewFlashTerm(ancestor.clip, ancestor.playhead - ancestor.clip.timelineStart));
  }
  return steps.map(eqBrightnessAddition).filter(step => step > 0);
}

export function previewFlashFilterId(clipId: string): string {
  return `editkin-flash-${clipId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/** The CSS filter function for a layer's flash, or "" when it is not flashing. */
export function previewFlashFilterCss(clipId: string, steps: readonly number[]): string {
  return steps.length ? `url(#${previewFlashFilterId(clipId)})` : "";
}

/** Hidden SVG definitions for every flashing layer of the current frame. */
export function PreviewFlashFilters({ layers }: { layers: ReadonlyArray<{ clipId: string; steps: readonly number[] }> }) {
  const flashing = layers.filter(layer => layer.steps.length > 0);
  if (!flashing.length) return null;
  return <svg aria-hidden="true" width="0" height="0" focusable="false" style={{ position: "absolute", width: 0, height: 0, overflow: "hidden" }} data-testid="preview-flash-filters">
    <defs>
      {flashing.map(layer => <filter key={layer.clipId} id={previewFlashFilterId(layer.clipId)} x="0" y="0" width="1" height="1" colorInterpolationFilters="sRGB"
        data-flash-additions={layer.steps.map(step => step.toFixed(5)).join(" ")}>
        {layer.steps.map((step, index) => <feComponentTransfer key={index}>
          <feFuncR type="linear" slope="1" intercept={step} />
          <feFuncG type="linear" slope="1" intercept={step} />
          <feFuncB type="linear" slope="1" intercept={step} />
        </feComponentTransfer>)}
      </filter>)}
    </defs>
  </svg>;
}
