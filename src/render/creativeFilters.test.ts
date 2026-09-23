import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { initializeStudioCreativeAssets } from "../creative/studioAssets";
import { effectFilters, lookColorTerms, transitionBrightnessExpression, transitionOpacityExpression, transitionScaleExpression, transitionXExpression } from "./creativeFilters";

initializeStudioCreativeAssets();

describe("creative FFmpeg filters", () => {
  it("turns every interactive creative choice into a renderer expression", () => {
    const clip = createDemoProject().tracks[0].clips[0];
    clip.creative = {
      lookPresetId: "ai_cobalt_crisp",
      effectPresetIds: ["film_grain_soft", "scanline_focus"],
      transitionIn: { presetId: "luma_fade", duration: 0.4 },
      transitionOut: { presetId: "prism_flash_cut", duration: 0.2 },
    };
    expect(lookColorTerms(clip)).toEqual({ brightness: "0.01", contrast: "1.14", saturation: "1.08", hue: "-8" });
    expect(effectFilters(clip)).toEqual(["noise=alls=7:allf=t", "unsharp=5:5:0.65:3:3:0.25"]);
    expect(transitionOpacityExpression(clip)).toContain("0.4");
    expect(transitionBrightnessExpression(clip)).toContain("0.48");
  });

  it("generates motion only for matching transition renderers", () => {
    const clip = createDemoProject().tracks[0].clips[0];
    clip.creative = { effectPresetIds: [], transitionIn: { presetId: "chromatic_whip_cut", duration: 0.22 } };
    expect(transitionXExpression(clip, 1920)).toContain("-1920");
    expect(transitionScaleExpression(clip)).toBe("1");
  });

  it("turns a compound template into more than one real render expression", () => {
    const clip = createDemoProject().tracks[0].clips[0];
    clip.creative = { effectPresetIds: [], transitionIn: { presetId: "cine_proof_flash_push", duration: 0.14 } };
    expect(transitionBrightnessExpression(clip)).toContain("0.38");
    expect(transitionScaleExpression(clip)).toContain("0.06");
    expect(transitionOpacityExpression(clip)).toBe("1");
  });
});
