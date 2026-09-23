import { describe, expect, it } from "vitest";
import { initializeStudioCreativeAssets } from "../creative/studioAssets";
import { initializeWave2Registry } from "../creative/wave2Registry";
import { transitionRenderers } from "../creative/corePack";
import { filterTransitionPresets } from "./PresetPreviewGallery";

initializeStudioCreativeAssets();
initializeWave2Registry();

describe("simplified transition library", () => {
  it("opens with a bounded recommendation shelf while preserving the full library", () => {
    expect(filterTransitionPresets("recommended")).toHaveLength(12);
    expect(filterTransitionPresets("all")).toHaveLength(52);
  });

  it("separates the eight compound templates and every one drives multiple primitives", () => {
    const compound = filterTransitionPresets("compound");
    expect(compound).toHaveLength(8);
    expect(compound.every((preset) => transitionRenderers(preset).length >= 2)).toBe(true);
  });
});
