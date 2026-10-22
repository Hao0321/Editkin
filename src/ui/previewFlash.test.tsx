import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { eqBrightnessAddition, PreviewFlashFilters, previewFlashFilterCss, previewFlashTerm, previewLayerFlashSteps } from "./previewFlash";
import { transitionBrightnessExpression } from "../render/creativeFilters";
import { findTransitionPreset, TRANSITION_PRESETS, transitionRenderers } from "../creative/corePack";
import type { TimelineClip } from "../domain/types";
import type { ActivePreviewLayer } from "../application/previewMedia";

const flashPreset = TRANSITION_PRESETS.find(preset => transitionRenderers(preset).includes("transition-flash"))!;
function clip(patch: Partial<TimelineClip> = {}): TimelineClip {
  return {
    id: "clip-a", assetId: "asset-a", trackId: "video", timelineStart: 4, sourceStart: 0, duration: 2, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1, hue: 0, exposure: 0, temperature: 0, tint: 0, pivot: .435, shadows: 0, highlights: 0, blacks: 0, whites: 0 },
    keyframes: [], creative: { effectPresetIds: [], transitionIn: { presetId: flashPreset.id, duration: .5 }, transitionOut: { presetId: flashPreset.id, duration: .4 } },
    ...patch,
  } as TimelineClip;
}

/** Evaluates the export's FFmpeg expression (max/min, + - * /) at a clip-local time. */
function exportTerm(target: TimelineClip, t: number): number {
  const expression = transitionBrightnessExpression(target, "t").replaceAll("max(", "Math.max(").replaceAll("min(", "Math.min(");
  return Function("t", `return ${expression};`)(t) as number;
}

describe("flash transitions: preview adds brightness like the export", () => {
  it("matches the bundled FFmpeg eq addition measured per 8-bit channel", () => {
    // Measured with vendor/ffmpeg 8.1.3: format=rgba,eq=brightness=B,format=rgba on flat colours.
    for (const [brightness, perChannel] of [[0.1, 29], [0.275, 79], [0.55, 163]] as const) {
      expect(Math.round(eqBrightnessAddition(brightness) * 255)).toBe(perChannel);
    }
    expect(eqBrightnessAddition(0)).toBe(0);
    expect(eqBrightnessAddition(-0.2)).toBe(0);
  });

  it("uses the export's own flash term, in and out, with the preset strength", () => {
    const target = clip();
    for (const t of [0, .1, .25, .49, .5, 1, 1.6, 1.7, 1.99, 2]) {
      expect(previewFlashTerm(target, t)).toBeCloseTo(exportTerm(target, t), 10);
    }
    expect(previewFlashTerm(target, 0)).toBeCloseTo(findTransitionPreset(flashPreset.id).parameters?.flashStrength ?? .55, 10);
    expect(previewFlashTerm(clip({ creative: { effectPresetIds: [] } }), 0)).toBe(0);
  });

  it("brightens only the flashing layer, in the export's order (clip, then enclosing compositions)", () => {
    const leaf = clip();
    const layer = { clip: leaf, displayClip: leaf, asset: {} as ActivePreviewLayer["asset"], source: "x" } as ActivePreviewLayer;
    expect(previewLayerFlashSteps(layer, 4)).toHaveLength(1); // t = 0 inside the clip: full flash
    expect(previewLayerFlashSteps(layer, 5)).toEqual([]); // mid-clip: no flash, no filter
    const steps = previewLayerFlashSteps(layer, 4);
    expect(previewFlashFilterCss("0-clip-a", steps)).toBe("url(#editkin-flash-0-clip-a)");
    expect(previewFlashFilterCss("0-clip-a", [])).toBe("");
    const html = renderToStaticMarkup(<PreviewFlashFilters layers={[{ clipId: "0-clip-a", steps }, { clipId: "1-other", steps: [] }]} />);
    expect(html).toContain('id="editkin-flash-0-clip-a"');
    expect(html).toContain('color-interpolation-filters="sRGB"');
    expect(html).toContain('type="linear"');
    expect(html).toContain(`intercept="${steps[0]}"`);
    expect(html).not.toContain("editkin-flash-1-other");
    expect(renderToStaticMarkup(<PreviewFlashFilters layers={[]} />)).toBe("");
  });
});
