import { describe, expect, it } from "vitest";
import { applyCommand } from "../domain/commands";
import { createDemoProject } from "../domain/demo";
import { projectDuration } from "../domain/editGraph";
import { motionGraphicV2LayoutReceipt } from "../motion/compositionV2";
import { buildLowerThirdCommand, isLowerThirdGraphic, LOWER_THIRD_PRESETS } from "./lowerThirds";

describe("editable person and organization bars", () => {
  it("builds every style as two independently editable native graphics", () => {
    for (const preset of LOWER_THIRD_PRESETS) {
      let id = 0;
      const project = createDemoProject();
      const result = applyCommand(project, buildLowerThirdCommand(project, {
        presetId: preset.id, personName: "王小明", organization: "Editkin · 創辦人", timelineStart: 1,
      }, (prefix) => `${prefix}-${id++}`));
      const bars = result.motionGraphics.filter(isLowerThirdGraphic);
      expect(bars).toHaveLength(2);
      expect(bars.map((graphic) => graphic.text)).toEqual(["王小明", "Editkin · 創辦人"]);
      expect(bars[0].y).toBeLessThan(bars[1].y);
      expect(bars[0].x).toBeLessThan(bars[1].x);
      expect(bars[0].width).toBeLessThanOrEqual(.52);
      expect(bars[1].width).toBeLessThanOrEqual(.56);
      expect(bars.every((graphic) => graphic.animation === "slide_up")).toBe(true);
    }
  });

  it("replaces only an overlapping lower third and preserves other graphics", () => {
    let id = 0;
    const project = createDemoProject();
    const first = applyCommand(project, buildLowerThirdCommand(project, {
      presetId: "clean_blue", personName: "第一位", organization: "A 單位", timelineStart: 1, duration: 4,
    }, (prefix) => `${prefix}-${id++}`));
    const separate = applyCommand(first, buildLowerThirdCommand(first, {
      presetId: "clean_blue", personName: "第二位", organization: "B 單位", timelineStart: 8, duration: 3,
    }, (prefix) => `${prefix}-${id++}`));
    expect(separate.motionGraphics.filter(isLowerThirdGraphic)).toHaveLength(4);
    const replaced = applyCommand(separate, buildLowerThirdCommand(separate, {
      presetId: "documentary_white", personName: "第一位更新", organization: "新單位", timelineStart: 2, duration: 2,
    }, (prefix) => `${prefix}-${id++}`));
    const bars = replaced.motionGraphics.filter(isLowerThirdGraphic);
    expect(bars).toHaveLength(4);
    expect(bars.some((graphic) => graphic.text === "第一位")).toBe(false);
    expect(bars.some((graphic) => graphic.text === "第二位")).toBe(true);
    expect(bars.some((graphic) => graphic.text === "第一位更新")).toBe(true);
  });

  it("keeps normal names compact and rejects copy that cannot remain a lower third", () => {
    const project = createDemoProject();
    const command = buildLowerThirdCommand(project, {
      presetId: "clean_blue", personName: "王小明", organization: "Editkin 創辦人", timelineStart: 0,
    }, (prefix) => prefix);
    const result = applyCommand(project, command);
    const [name, unit] = result.motionGraphics.filter(isLowerThirdGraphic);
    expect(name.width).toBe(.2);
    expect(unit.width).toBe(.18);
    expect(() => buildLowerThirdCommand(project, {
      presetId: "clean_blue", personName: "這是一個不應該被塞進字幕條的超長人名文字", organization: "Editkin", timelineStart: 0,
    }, (prefix) => prefix)).toThrow("人名必須是 1–18 個字");
  });

  it("never extends the project into black frames", () => {
    const project = createDemoProject();
    const end = projectDuration(project);
    expect(() => buildLowerThirdCommand(project, {
      presetId: "clean_blue", personName: "王小明", organization: "Editkin", timelineStart: end,
    }, (prefix) => prefix)).toThrow("播放頭不在畫面片段內");
    const result = applyCommand(project, buildLowerThirdCommand(project, {
      presetId: "clean_blue", personName: "王小明", organization: "Editkin", timelineStart: end - .5, duration: 5,
    }, (prefix) => prefix));
    expect(projectDuration(result)).toBe(end);
  });

  it("keeps the two-bar rhythm consistent in landscape and vertical projects", () => {
    const layouts = [[1920, 1080], [1080, 1920]].map(([width, height]) => {
      const project = createDemoProject();
      project.width = width;
      project.height = height;
      const result = applyCommand(project, buildLowerThirdCommand(project, {
        presetId: "clean_blue", personName: "王小明", organization: "Editkin 創辦人", timelineStart: 1,
      }, (prefix) => prefix));
      const [name, unit] = result.motionGraphics.filter(isLowerThirdGraphic);
      const nameLayout = motionGraphicV2LayoutReceipt(result, name);
      const unitLayout = motionGraphicV2LayoutReceipt(result, unit);
      return {
        nameHeight: nameLayout.box.height / height,
        unitHeight: unitLayout.box.height / height,
        gap: (unitLayout.box.y - nameLayout.box.y - nameLayout.box.height) / height,
      };
    });
    expect(layouts[0].gap).toBeGreaterThan(0);
    expect(Math.abs(layouts[0].gap - layouts[1].gap)).toBeLessThan(.002);
    expect(Math.abs(layouts[0].nameHeight - layouts[1].nameHeight)).toBeLessThan(.002);
    expect(Math.abs(layouts[0].unitHeight - layouts[1].unitHeight)).toBeLessThan(.002);
  });
});
