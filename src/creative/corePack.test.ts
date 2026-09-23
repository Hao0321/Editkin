import { describe, expect, it } from "vitest";
import { HAO_CORE_PACK, captionStyleFromPreset, combineLookColor, previewTransitionState } from "./corePack";
import { createDemoProject } from "../domain/demo";
import { DEFAULT_COLOR } from "../domain/types";

describe("community creative defaults", () => {
  it("contains no private reference art and keeps the public renderer contracts", () => {
    expect(HAO_CORE_PACK.source.referenceCount).toBe(0);
    expect(HAO_CORE_PACK.source.privateImagesEmbedded).toBe(false);
    expect(HAO_CORE_PACK.presets.looks).toHaveLength(10);
    expect(HAO_CORE_PACK.presets.effects).toHaveLength(6);
    expect(HAO_CORE_PACK.presets.transitions).toHaveLength(16);
    expect(HAO_CORE_PACK.presets.textStyles).toHaveLength(30);
    expect(HAO_CORE_PACK.presets.templates).toHaveLength(23);
    expect(HAO_CORE_PACK.presets.looks.every(preset => preset.renderer === "ffmpeg-eq")).toBe(true);
  });

  it("uses neutral look and caption values in the actual preview helpers", () => {
    const color = combineLookColor({ ...DEFAULT_COLOR, brightness: 0.1, contrast: 1.1, saturation: 1, hue: 2 }, "clean_neutral");
    expect(color).toMatchObject({ brightness: 0.1, contrast: 1.1, saturation: 1, hue: 2 });
    const caption = captionStyleFromPreset("clean_caption");
    expect(caption).toMatchObject({ presetId: "clean_caption", color: "#FFFFFF", bold: true });
  });

  it("previews supported transitions deterministically", () => {
    const clip = createDemoProject().tracks[0].clips[0];
    clip.creative = { effectPresetIds: [], transitionIn: { presetId: "lens_blur_cut", duration: 0.4 } };
    expect(previewTransitionState(clip, 0)).toMatchObject({ scale: 1.08 });
    expect(previewTransitionState(clip, 0.4)).toMatchObject({ scale: 1 });
    const supported = new Set(["transition-fade", "transition-zoom", "transition-whip", "transition-flash"]);
    expect(HAO_CORE_PACK.presets.transitions.every(preset => supported.has(preset.renderer))).toBe(true);
    expect(HAO_CORE_PACK.presets.transitions.every(preset => !Object.hasOwn(preset, "nativeRenderer"))).toBe(true);
  });
});
