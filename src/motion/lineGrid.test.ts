import { describe, expect, it } from "vitest";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { motionVectorV2Schema } from "../domain/schema";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { createMotionGraphic } from "./composition";
import { motionGraphicV2FrameReceipt, motionGraphicV2LayoutReceipt } from "./compositionV2";
import { motionVectorPaths } from "./vectorGeometry";

function fixture() {
  const project = createEmptyProject("Blue-white grid", { width: 540, height: 960, fps: 30 });
  const graphic = createMotionGraphic("grid", "card", "", 0, 8, undefined, findMotionGraphicPreset("reel_line_grid").seed);
  graphic.x = 0; graphic.y = 0; graphic.width = 1;
  graphic.layoutV2!.safeArea = { top: 0, right: 0, bottom: 0, left: 0 };
  graphic.vectorV2 = { schema: "editkin.motion-vector/v1", kind: "line_grid", heightPixels: 960,
    revealFrames: 1, spacingPixels: 36, lineWidthPixels: .5, majorEvery: 4 };
  project.motionGraphics.push(graphic);
  return { project, graphic };
}

describe("native line grid", () => {
  it("preserves editable spacing and two colors when the project reopens, without camera drift", () => {
    const { project, graphic } = fixture();
    const reopened = JSON.parse(JSON.stringify(project)) as typeof project; validateProject(reopened);
    const saved = reopened.motionGraphics[0], layout = motionGraphicV2LayoutReceipt(reopened, saved);
    const at = (frame: number) => motionVectorPaths(saved, layout, motionGraphicV2FrameReceipt(reopened, saved, frame, layout));
    expect(saved.vectorV2).toEqual(graphic.vectorV2);
    expect(at(80)).toEqual(at(190));
    expect(at(80).map(path => path.color)).toEqual(["#175CD31C", "#175CD330"]);
    for (const path of at(80)) {
      const numbers = [...path.svg.matchAll(/-?\d+(?:\.\d+)?/g)].map(match => Number(match[0]));
      numbers.forEach((number, index) => { expect(number).toBeGreaterThanOrEqual(0); expect(number).toBeLessThanOrEqual(index % 2 ? 960 : 540); });
      expect(path.ass).toMatch(/^m /); expect(path.svg).toMatch(/^M /);
    }
  });
  it("rejects excessive line density before render", () => {
    const { project, graphic } = fixture();
    project.width = 4096; project.height = 1920; graphic.vectorV2!.heightPixels = 1920;
    if (graphic.vectorV2!.kind === "line_grid") graphic.vectorV2!.spacingPixels = 8;
    expect(() => motionGraphicV2LayoutReceipt(project, graphic)).toThrow(/256/);
  });
  it("rejects thick lines and fractional major intervals, rather than producing solid bands", () => {
    const { project, graphic } = fixture();
    expect(() => motionVectorV2Schema.parse({ ...graphic.vectorV2, majorEvery: 2.5 })).toThrow();
    graphic.vectorV2 = { ...graphic.vectorV2!, kind: "line_grid", spacingPixels: 8, lineWidthPixels: 8, majorEvery: 4 };
    expect(() => validateProject(project)).toThrow(/占滿/);
  });
});
