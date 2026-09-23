import { describe, expect, it } from "vitest";
import { applyCommand } from "../domain/commands";
import { createDemoProject } from "../domain/demo";
import { PROJECT_FORMATS, projectFormatLabel } from "./projectFormats";
import { buildLowerThirdCommand, isLowerThirdGraphic } from "./lowerThirds";

describe("project format presets", () => {
  it("provides distinct landscape, short, square and feed formats", () => {
    expect(new Set(PROJECT_FORMATS.map((format) => `${format.width}x${format.height}`)).size).toBe(PROJECT_FORMATS.length);
    expect(PROJECT_FORMATS.find((format) => format.id === "vertical")).toMatchObject({ ratio: "9:16", width: 1080, height: 1920 });
    expect(PROJECT_FORMATS.find((format) => format.id === "landscape")).toMatchObject({ ratio: "16:9", width: 1920, height: 1080 });
  });

  it("labels known and custom resolutions honestly", () => {
    expect(projectFormatLabel(1080, 1920)).toContain("9:16");
    expect(projectFormatLabel(2048, 858)).toContain("自訂");
  });

  it("changes only the canvas and preserves source assets, timing and transforms", () => {
    const project = createDemoProject();
    const normalized = applyCommand(project, { type: "set_project_resolution", width: project.width, height: project.height });
    const snapshot = structuredClone({ assets: normalized.assets, tracks: normalized.tracks });
    const result = applyCommand(normalized, { type: "set_project_resolution", width: 1080, height: 1920 });
    expect([result.width, result.height]).toEqual([1080, 1920]);
    expect({ assets: result.assets, tracks: result.tracks }).toEqual(snapshot);
  });

  it("rescales pixel-based motion typography with canvas height and round-trips without drift", () => {
    const source = createDemoProject();
    const withBars = applyCommand(source, buildLowerThirdCommand(source, {
      presetId: "clean_blue", personName: "王小明", organization: "Editkin", timelineStart: 0,
    }, (prefix) => `${prefix}-ratio`));
    const original = structuredClone(withBars.motionGraphics.filter(isLowerThirdGraphic));
    const vertical = applyCommand(withBars, { type: "set_project_resolution", width: 1080, height: 1920 });
    const factor = 1920 / 1080;
    vertical.motionGraphics.filter(isLowerThirdGraphic).forEach((graphic, index) => {
      expect(graphic.fontSize).toBeCloseTo(original[index].fontSize * factor, 5);
      expect(graphic.layoutV2?.minFontSize).toBeCloseTo(original[index].layoutV2!.minFontSize * factor, 5);
      expect(graphic.layoutV2?.lineGap).toBeCloseTo(original[index].layoutV2!.lineGap * factor, 5);
      expect(graphic.outlineWidth).toBeCloseTo((original[index].outlineWidth ?? 0) * factor, 5);
    });
    const roundTrip = applyCommand(vertical, { type: "set_project_resolution", width: 1920, height: 1080 });
    expect(roundTrip.motionGraphics.filter(isLowerThirdGraphic)).toEqual(original);
  });
});
