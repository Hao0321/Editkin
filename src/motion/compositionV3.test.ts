import { describe, expect, it } from "vitest";
import { MOTION_DESIGN_V3_PRESETS } from "../creative/motionDesignV3Presets";
import { MOTION_DESIGN_V3_TEMPLATE_IDS } from "../domain/motionCompositionV3Contract";
import type { MotionGraphic } from "../domain/types";
import { motionGraphicV3Faces, motionGraphicV3Frame, motionGraphicV3Layout } from "./compositionV3";
import { wrapText } from "./v3/textMetrics";

const LANDSCAPE = { width: 1920, height: 1080, fps: 30 };
const PORTRAIT = { width: 1080, height: 1920, fps: 30 };

function presetGraphic(id: string, overrides: Partial<MotionGraphic> = {}): MotionGraphic {
  const preset = MOTION_DESIGN_V3_PRESETS.find(item => item.id === id)!;
  return { ...preset.seed, id: `g-${id}`, timelineStart: 1, duration: 3, ...overrides } as MotionGraphic;
}

describe("Motion Design v3 composition", () => {
  it("ships at least one preset for every template", () => {
    const covered = new Set(MOTION_DESIGN_V3_PRESETS.map(preset => preset.seed.designV3!.template));
    expect([...covered].sort()).toEqual([...MOTION_DESIGN_V3_TEMPLATE_IDS].sort());
  });

  it.each(MOTION_DESIGN_V3_PRESETS.map(preset => preset.id))("%s lays out inside the frame and evaluates every frame in both formats", (id) => {
    for (const project of [LANDSCAPE, PORTRAIT]) {
      const graphic = presetGraphic(id);
      const layout = motionGraphicV3Layout(project, graphic);
      expect(layout.box.x).toBeGreaterThanOrEqual(0);
      expect(layout.box.y).toBeGreaterThanOrEqual(0);
      expect(layout.box.x + layout.box.width).toBeLessThanOrEqual(project.width);
      expect(layout.box.y + layout.box.height).toBeLessThanOrEqual(project.height);
      const start = Math.round(graphic.timelineStart * project.fps), total = Math.round(graphic.duration * project.fps);
      let peak = 0;
      for (let frame = start; frame < start + total; frame += 1) {
        const state = motionGraphicV3Frame(project, graphic, frame, layout);
        peak = Math.max(peak, state.ops.length);
        for (const op of state.ops) {
          expect(op.opacity).toBeGreaterThan(0);
          expect(op.opacity).toBeLessThanOrEqual(1);
          if (op.kind === "text") expect(Number.isFinite(op.x + op.y + op.fontSize)).toBe(true);
          else for (const command of op.path) expect(command.points.every(Number.isFinite)).toBe(true);
        }
      }
      expect(peak).toBeGreaterThan(0);
      expect(motionGraphicV3Frame(project, graphic, start - 1, layout).visible).toBe(false);
      expect(motionGraphicV3Frame(project, graphic, start + total, layout).visible).toBe(false);
    }
  });

  it("starts empty, settles with its copy on screen and has fully left on the last frame", () => {
    for (const preset of MOTION_DESIGN_V3_PRESETS) {
      for (const duration of [1, 3, 6]) {
        const graphic = presetGraphic(preset.id, { duration });
        const start = Math.round(graphic.timelineStart * LANDSCAPE.fps), total = Math.round(graphic.duration * LANDSCAPE.fps);
        expect(motionGraphicV3Frame(LANDSCAPE, graphic, start).ops.map(op => op.id), `${preset.id} first`).toEqual([]);
        expect(motionGraphicV3Frame(LANDSCAPE, graphic, start + total - 1).ops.map(op => op.id), `${preset.id} last`).toEqual([]);
        if (duration < 3) continue;
        const settled = motionGraphicV3Frame(LANDSCAPE, graphic, start + Math.round(total * .55)).ops.filter(op => op.kind === "text" && !op.id.endsWith(":shadow"));
        expect(settled.length, preset.id).toBeGreaterThan(0);
      }
    }
  });

  it("is deterministic for repeated evaluation", () => {
    const graphic = presetGraphic("v3_title_reveal");
    const first = motionGraphicV3Frame(LANDSCAPE, graphic, 45);
    const second = motionGraphicV3Frame(LANDSCAPE, structuredClone(graphic), 45);
    expect(second.ops).toEqual(first.ops);
  });

  it("counts figures up to the authored value and keeps prefix and grouping", () => {
    const graphic = presetGraphic("v3_stat_counter_signal");
    const start = Math.round(graphic.timelineStart * LANDSCAPE.fps);
    const copy = (frame: number) => motionGraphicV3Frame(LANDSCAPE, graphic, frame).ops
      .filter(op => op.kind === "text" && op.id.startsWith("value:") && !op.id.endsWith(":shadow")).map(op => (op.kind === "text" ? op.text : "")).join("");
    expect(copy(start + 60)).toBe("NT$4,990");
    expect(copy(start + 4)).toMatch(/^NT\$[\d,]+$/u);
    expect(copy(start + 4)).not.toBe("NT$4,990");
  });

  it("scales design pixels with the canvas so 4K matches 1080p proportions", () => {
    const graphic = presetGraphic("v3_lower_third_bar");
    const at = (project: typeof LANDSCAPE) => motionGraphicV3Frame(project, graphic, 60).ops.find(op => op.id === "name")!;
    const hd = at(LANDSCAPE), uhd = at({ width: 3840, height: 2160, fps: 30 });
    expect(hd.kind === "text" && uhd.kind === "text" && uhd.fontSize / hd.fontSize).toBeCloseTo(2, 5);
  });

  it("rejects a stale layout for a changed graphic", () => {
    const graphic = presetGraphic("v3_tag_live");
    const layout = motionGraphicV3Layout(LANDSCAPE, graphic);
    expect(() => motionGraphicV3Frame(LANDSCAPE, { ...graphic, text: "改過的字" }, 40, layout)).toThrow(/不一致/u);
  });

  it("names every bundled face a template may draw with", () => {
    expect(motionGraphicV3Faces(presetGraphic("v3_stat_counter"))).toEqual(expect.arrayContaining([{ family: "Bebas Neue", weight: 400 }, { family: "Noto Sans TC", weight: 800 }]));
    expect(motionGraphicV3Faces({ ...presetGraphic("v3_tag_live"), schema: "hao.motion-composition/v2", designV3: undefined })).toEqual([]);
  });

  it("breaks headlines between phrases and balances the lines", () => {
    const font = { family: "Noto Sans TC", weight: 900, size: 78, letterSpacing: 0, lineHeight: 90 };
    expect(wrapText("這台相機，改變了我拍片的方式", font, 78 * 13, 3)).toEqual(["這台相機，", "改變了我拍片的方式"]);
    expect(wrapText("一二三四五六七八九十一二三四五六七八", font, 78 * 10, 3)).toHaveLength(2);
    expect(() => wrapText("一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二", font, 78 * 10, 3)).toThrow(/超出版型/u);
  });
});
