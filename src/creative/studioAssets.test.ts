import { describe, expect, it } from "vitest";
import { EFFECT_PRESETS, LOOK_PRESETS, TRANSITION_PRESETS } from "./corePack";
import { initializeStudioCreativeAssets, STUDIO_MOTION_ASSETS } from "./studioAssets";
import { createDemoProject } from "../domain/demo";
import { effectFilters } from "../render/creativeFilters";

describe("Editkin Studio asset extension", () => {
  it("registers original display type, grades, filters and motivated transitions with provenance", () => {
    initializeStudioCreativeAssets();
    expect(STUDIO_MOTION_ASSETS).toHaveLength(8);
    expect(LOOK_PRESETS.filter((preset) => preset.id.startsWith("studio_") || preset.id.startsWith("cine_"))).toHaveLength(20);
    expect(EFFECT_PRESETS.filter((preset) => preset.id.startsWith("studio_"))).toHaveLength(6);
    expect(TRANSITION_PRESETS.filter((preset) => preset.id.startsWith("studio_") || preset.id.startsWith("cine_"))).toHaveLength(28);
    expect([...STUDIO_MOTION_ASSETS, ...LOOK_PRESETS, ...EFFECT_PRESETS, ...TRANSITION_PRESETS].every((preset) => preset.license && preset.provenance)).toBe(true);
  });

  it("maps each new screen effect to a real FFmpeg filter", () => {
    initializeStudioCreativeAssets();
    const clip = createDemoProject().tracks[0].clips[0];
    clip.creative = { effectPresetIds: EFFECT_PRESETS.filter((preset) => preset.id.startsWith("studio_")).map((preset) => preset.id) };
    expect(effectFilters(clip)).toEqual(expect.arrayContaining(["vignette=PI/5", "hqdn3d=2:1.5:3:2.25"]));
  });
});
