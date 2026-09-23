import { describe, expect, it } from "vitest";
import { EFFECT_PRESETS, TEMPLATE_PRESETS, TEXT_STYLE_PRESETS, TRANSITION_PRESETS } from "./corePack";
import { initializeWave2Registry, mediaFrameLayout } from "./wave2Registry";
import { createMotionGraphic } from "../motion/composition";

describe("Wave 2 creative registry", () => {
  it("registers every licensed preset exactly once", () => {
    const first = initializeWave2Registry();
    const second = initializeWave2Registry();
    expect(first).toBe(second);
    expect(first.counts).toEqual({ textStyles: 18, labels: 12, effects: 12, transitions: 8, templates: 6, dataWidgets: 18, mediaFrames: 12, total: 86 });
    expect(TEXT_STYLE_PRESETS.filter((item) => item.id.startsWith("exp26w2_")).length).toBe(18);
    expect(EFFECT_PRESETS.filter((item) => item.id.startsWith("exp26w2_")).length).toBe(12);
    expect(TRANSITION_PRESETS.filter((item) => item.id.startsWith("exp26w2_")).length).toBe(8);
    expect(TEMPLATE_PRESETS.filter((item) => item.id.startsWith("exp26w2_")).length).toBe(6);
    expect([...first.motionPresets, ...first.mediaFrames].every((item) => item.license && item.provenance)).toBe(true);
  });

  it("turns a library preset into an editable motion graphic", () => {
    const preset = initializeWave2Registry().motionPresets.find((item) => item.presetType === "widget")!;
    const graphic = createMotionGraphic("motion-wave2", preset.seed.kind ?? "card", "42%", 1, 3, undefined, preset.seed);
    expect(graphic).toMatchObject({ id: "motion-wave2", presetId: preset.id, text: "42%", name: preset.name });
  });

  it("keeps every media frame crop and viewport normalized", () => {
    for (const item of initializeWave2Registry().mediaFrames) {
      const layout = mediaFrameLayout(item.kind);
      for (const rect of [layout.crop, layout.viewport]) {
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.y).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.width).toBeLessThanOrEqual(1);
        expect(rect.y + rect.height).toBeLessThanOrEqual(1);
      }
    }
  });
});
