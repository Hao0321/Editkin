import { describe, expect, it } from "vitest";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { projectSchema } from "../domain/schema";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { createMotionGraphic } from "./composition";
import { evaluateMotionGraphicV2Easing, motionGraphicV2FrameReceipt, motionGraphicV2LayoutReceipt } from "./compositionV2";

function v2Graphic(text = "Ship clearer stories") {
  const preset = findMotionGraphicPreset("v2-word-cascade");
  return createMotionGraphic("v2-title", "title", text, 0, 3, undefined, preset.seed);
}

describe("hao.motion-composition/v2 shared evaluator", () => {
  it("produces one deterministic safe-area auto-fit/wrap receipt", () => {
    const project = createEmptyProject("Motion v2", { width: 720, height: 1280, fps: 30 });
    const graphic = v2Graphic("A deliberately longer headline that must wrap");
    graphic.x = .94;
    graphic.y = .96;
    graphic.width = .7;
    const first = motionGraphicV2LayoutReceipt(project, graphic);
    const second = motionGraphicV2LayoutReceipt(project, structuredClone(graphic));
    expect(second).toEqual(first);
    expect(first.lineCount).toBeLessThanOrEqual(graphic.layoutV2!.maxLines);
    expect(first.fontSize).toBeGreaterThanOrEqual(graphic.layoutV2!.minFontSize);
    expect(first.box.x).toBeGreaterThanOrEqual(first.safeRect.x);
    expect(first.box.x + first.box.width).toBeLessThanOrEqual(first.safeRect.x + first.safeRect.width);
    expect(first.box.y + first.box.height).toBeLessThanOrEqual(first.safeRect.y + first.safeRect.height);
  });

  it("sequences words on integer frames and keeps same-frame evaluation identical", () => {
    const project = createEmptyProject("Motion v2", { width: 1920, height: 1080, fps: 30 });
    const graphic = v2Graphic("ONE TWO THREE");
    const layout = motionGraphicV2LayoutReceipt(project, graphic);
    const frame = motionGraphicV2FrameReceipt(project, graphic, 4, layout);
    const repeated = motionGraphicV2FrameReceipt(project, graphic, 4, layout);
    expect(repeated).toEqual(frame);
    const byUnit = layout.segments.map((segment) => frame.segments.find((item) => item.segmentId === segment.id)!.opacity);
    expect(byUnit[0]).toBeGreaterThan(byUnit[1]);
    expect(byUnit[1]).toBeGreaterThan(byUnit[2]);
    expect(frame.layoutReceiptId).toBe(layout.receiptId);
  });

  it("supports character center-out sequencing and parameterized spring curves", () => {
    const project = createEmptyProject("Motion v2", { width: 1920, height: 1080, fps: 30 });
    const graphic = v2Graphic("ABC");
    graphic.motionV2!.sequence = { unit: "character", order: "center_out", exitOrder: "reverse", staggerFrames: 2 };
    const layout = motionGraphicV2LayoutReceipt(project, graphic);
    const frame = motionGraphicV2FrameReceipt(project, graphic, 2, layout);
    const state = (unit: number) => frame.segments.find((item) => item.segmentId === layout.segments.find((segment) => segment.unitIndex === unit)!.id)!.opacity;
    expect(state(1)).toBeGreaterThan(state(0));
    expect(state(0)).toBeGreaterThanOrEqual(state(2));
    const soft = evaluateMotionGraphicV2Easing(.4, { type: "spring", stiffness: 90, damping: 18, mass: 1, initialVelocity: 0 });
    const snappy = evaluateMotionGraphicV2Easing(.4, { type: "spring", stiffness: 260, damping: 12, mass: .8, initialVelocity: 0 });
    expect(Number.isFinite(soft) && Number.isFinite(snappy)).toBe(true);
    expect(snappy).not.toBeCloseTo(soft, 4);
  });

  it("round-trips v2 through the current EditGraph schema", () => {
    const project = createEmptyProject("Motion v2");
    project.motionGraphics.push(v2Graphic());
    expect(projectSchema.parse(project)).toEqual(project);
    expect(validateProject(project)).toBe(project);
  });

  it("fails closed for invalid spring, impossible layout, v1 smuggling and event-budget overflow", () => {
    const project = createEmptyProject("Motion v2", { width: 320, height: 180, fps: 30 });
    const invalidSpring = v2Graphic();
    invalidSpring.motionV2!.entrance.easing = { type: "spring", stiffness: 0, damping: 18, mass: 1, initialVelocity: 0 };
    project.motionGraphics = [invalidSpring];
    expect(() => validateProject(project)).toThrow(/stiffness/);

    const impossible = v2Graphic("THIS HEADLINE CANNOT POSSIBLY FIT");
    impossible.width = .05;
    impossible.fontSize = 72;
    impossible.layoutV2 = { ...impossible.layoutV2!, minFontSize: 72, maxLines: 1 };
    expect(() => motionGraphicV2LayoutReceipt(project, impossible)).toThrow(/無法.*auto-fit/);

    const smuggled = v2Graphic();
    smuggled.schema = "hao.motion-composition/v1";
    expect(() => validateProject({ ...project, motionGraphics: [smuggled] })).toThrow(/v1 不可攜帶 v2/);

    const oversized = v2Graphic("字".repeat(129));
    expect(() => motionGraphicV2LayoutReceipt(project, oversized)).toThrow(/文字單元超過/);
  });
});
