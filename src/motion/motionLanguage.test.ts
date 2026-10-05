import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { applyCommand } from "../domain/commands";
import { createDemoProject } from "../domain/demo";
import { animatedClipState, createEmptyProject } from "../domain/editGraph";
import { projectSchema } from "../domain/schema";
import type { MotionGraphic, MotionGraphicV2Motion } from "../domain/types";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { KINETIC_MOTION_PRESETS } from "../creative/kineticMotionPresets";
import { writeAssContent } from "../render/captionAss";
import { prepareMotionPhysicalLayouts } from "../render/motionPhysicalGlyphLayouts";
import { createMotionGraphic } from "./composition";
import { motionGraphicV2FrameReceipt, motionGraphicV2LayoutReceipt } from "./compositionV2";
import { evaluateMotionGraphicV2Easing } from "./motionEasing";
import { motionClipPresetCommands, MOTION_CLIP_PRESET_IDS } from "./motionClipPresets";
import {
  CLIP_MOTION_RECIPES, KINETIC_TEXT_STYLES, MOTION_CURVES, MOTION_ENERGIES, clipMotionRecipeCommands, kineticTextMotion,
} from "./motionLanguage";

const peak = (name: keyof typeof MOTION_CURVES) => Math.max(...Array.from({ length: 2001 }, (_, i) => evaluateMotionGraphicV2Easing(i / 2000, MOTION_CURVES[name])));

function graphicWith(motion: MotionGraphicV2Motion, text = "動態全面升級"): MotionGraphic {
  const graphic = createMotionGraphic("kinetic", "title", text, 0, 3, undefined, findMotionGraphicPreset("kinetic_rise").seed);
  return { ...graphic, motionV2: motion };
}

describe("Motion Language v1 curves", () => {
  it("overshoots by the documented amount and settles without a visible end snap", () => {
    expect(peak("expoOut")).toBeLessThanOrEqual(1.000001);
    expect(peak("backOutSoft")).toBeGreaterThan(1.04);
    expect(peak("backOut")).toBeGreaterThan(1.08);
    expect(peak("backOutStrong")).toBeGreaterThan(peak("backOut"));
    expect(peak("springLand")).toBeGreaterThan(1.05);
    expect(peak("springLand")).toBeLessThan(1.1);
    expect(peak("springPop")).toBeGreaterThan(1.15);
    for (const name of ["springLand", "springSnappy", "springPop"] as const) {
      expect(Math.abs(evaluateMotionGraphicV2Easing(.999, MOTION_CURVES[name]) - 1)).toBeLessThan(.005);
    }
  });

  it("front-loads entrances: decisive attack, long glide", () => {
    const expo = (t: number) => evaluateMotionGraphicV2Easing(t, MOTION_CURVES.expoOut);
    expect(expo(.1)).toBeGreaterThan(.45);
    expect(expo(.3)).toBeGreaterThan(.85);
    expect(evaluateMotionGraphicV2Easing(.5, MOTION_CURVES.snapIn)).toBeLessThan(.2);
  });
});

describe("kineticTextMotion", () => {
  it("compiles every style and energy into a valid, schema-preserved motionV2", () => {
    const project = createEmptyProject("ML", { width: 1920, height: 1080, fps: 30 });
    for (const style of KINETIC_TEXT_STYLES) for (const energy of MOTION_ENERGIES) {
      const motion = kineticTextMotion(style, { fps: 30, unit: 1, energy, text: "動態全面升級" });
      expect(motion.entrance.durationFrames).toBeGreaterThanOrEqual(10);
      expect(motion.entrance.durationFrames).toBeLessThanOrEqual(21);
      expect(motion.exit.durationFrames).toBeLessThanOrEqual(10);
      expect(motion.sequence.scaleOrigin).toBe("center");
      const graphic = graphicWith(motion);
      const reopened = projectSchema.parse(JSON.parse(JSON.stringify(applyCommand(project, { type: "add_motion_graphic", graphic }))));
      expect(reopened.motionGraphics[0].motionV2).toEqual(motion);
      expect(() => motionGraphicV2FrameReceipt(reopened, reopened.motionGraphics[0], 3)).not.toThrow();
    }
  });

  it("keeps preset stagger for unknown text but caps measured long copy instead of zeroing it", () => {
    expect(kineticTextMotion("rise", { fps: 30, unit: 1 }).sequence.staggerFrames).toBe(2);
    expect(kineticTextMotion("rise", { fps: 30, unit: 1, text: "六個字的標題" }).sequence.staggerFrames).toBe(2);
    expect(kineticTextMotion("rise", { fps: 30, unit: 1, text: "這是一句十二個字的長標題啊" }).sequence.staggerFrames).toBe(1);
    const tooLong = kineticTextMotion("rise", { fps: 30, unit: 1, text: "這是一句非常非常非常非常長而且不該逐字排隊的說明文字" });
    expect(tooLong.sequence).toMatchObject({ unit: "all", staggerFrames: 0 });
  });

  it("strips rotation/blur for native paint and scales amplitude with energy and frame size", () => {
    const plain = kineticTextMotion("pop", { fps: 30, unit: 1, effects: false });
    expect(plain.entrance).not.toHaveProperty("rotationDegrees");
    expect(plain.entrance).not.toHaveProperty("blurPixels");
    const calm = kineticTextMotion("rise", { fps: 30, unit: 1, energy: "calm" });
    const hype = kineticTextMotion("rise", { fps: 30, unit: 2, energy: "hype" });
    expect(hype.entrance.offsetYPixels).toBeGreaterThan(calm.entrance.offsetYPixels * 5);
    expect(hype.entrance.durationFrames).toBeLessThan(calm.entrance.durationFrames);
  });

  it("registers append-only kinetic presets whose seeds satisfy the shared contract", () => {
    expect(KINETIC_MOTION_PRESETS.map(preset => preset.id)).toContain("kinetic_slam");
    for (const preset of KINETIC_MOTION_PRESETS) {
      expect(preset.seed.motionV2?.sequence.scaleOrigin).toBe("center");
      expect(findMotionGraphicPreset(preset.id)).toBeDefined();
    }
  });
});

describe("v2 evaluator Motion Language pose", () => {
  const project = createEmptyProject("ML", { width: 1920, height: 1080, fps: 30 });

  it("leaves historical receipts with exactly the four pose fields", () => {
    const graphic = createMotionGraphic("old", "title", "Ship clearer stories", 0, 3, undefined, findMotionGraphicPreset("v2-word-cascade").seed);
    for (const frame of [0, 3, 10, 80]) {
      for (const segment of motionGraphicV2FrameReceipt(project, graphic, frame).segments) {
        expect(Object.keys(segment).sort()).toEqual(["opacity", "scale", "segmentId", "translateXPixels", "translateYPixels"]);
      }
    }
  });

  it("scales each segment about its own box center", () => {
    const motion = kineticTextMotion("zoom", { fps: 30, unit: 1, effects: false });
    const graphic = graphicWith(motion, "第二章");
    const layout = motionGraphicV2LayoutReceipt(project, graphic);
    for (const frame of [1, 3, 6]) {
      const receipt = motionGraphicV2FrameReceipt(project, graphic, frame, layout);
      for (const segment of layout.segments) {
        const state = receipt.segments.find(item => item.segmentId === segment.id)!;
        expect(state.scale).toBeLessThan(1);
        expect(segment.x + state.translateXPixels + segment.width * state.scale / 2).toBeCloseTo(segment.x + segment.width / 2, 4);
        expect(segment.y + state.translateYPixels + segment.height * state.scale / 2).toBeCloseTo(segment.y + segment.height / 2, 4);
      }
    }
  });

  it("evaluates rotation, blur, spread and the hold push continuously", () => {
    const pop = graphicWith(kineticTextMotion("pop", { fps: 30, unit: 1 }), "彈出");
    const early = motionGraphicV2FrameReceipt(project, pop, 1).segments[0];
    expect(early.rotationDegrees).toBeLessThan(0);
    const swipe = graphicWith(kineticTextMotion("swipe", { fps: 30, unit: 1 }), "第一步");
    const start = motionGraphicV2FrameReceipt(project, swipe, 0).segments;
    const settled = motionGraphicV2FrameReceipt(project, swipe, 40).segments;
    expect(start[0].blurPixels).toBeGreaterThan(10);
    expect(start[2].translateXPixels - start[0].translateXPixels).toBeGreaterThan(100);
    for (const state of settled) {
      expect(Object.is(state.translateXPixels, -0)).toBe(false);
      expect(state).toMatchObject({ translateXPixels: 0, blurPixels: 0, rotationDegrees: 0 });
    }
    const zoom = graphicWith(kineticTextMotion("zoom", { fps: 30, unit: 1 }), "第二章");
    const exitStart = 90 - zoom.motionV2!.exit.durationFrames;
    const holdStart = zoom.motionV2!.entrance.durationFrames - 1;
    expect(motionGraphicV2FrameReceipt(project, zoom, holdStart).segments[0].scale).toBeCloseTo(1, 5);
    expect(motionGraphicV2FrameReceipt(project, zoom, exitStart).segments[0].scale).toBeCloseTo(1.03, 5);
  });

  it("fails closed where the pose cannot be reproduced", () => {
    const blurred = graphicWith(kineticTextMotion("focus", { fps: 30, unit: 1 }));
    const panel = createMotionGraphic("panel", "card", "", 0, 3, undefined, findMotionGraphicPreset("reel_native_panel").seed);
    const blurredPanel = structuredClone(panel);
    blurredPanel.motionV2!.entrance.blurPixels = 6;
    expect(() => motionGraphicV2FrameReceipt(project, panel, 1)).not.toThrow();
    expect(() => motionGraphicV2FrameReceipt(project, blurredPanel, 1)).toThrow(/原生向量尚未支援旋轉／模糊/);
    const pushWithoutCenter = structuredClone(blurred);
    delete pushWithoutCenter.motionV2!.sequence.scaleOrigin;
    expect(() => motionGraphicV2FrameReceipt(project, pushWithoutCenter, 1)).toThrow(/holdScale/);
  });

  it("emits rotation/blur through the real physical ASS export and nothing for plain poses", async () => {
    let posed = createEmptyProject("ML ASS", { width: 1920, height: 1080, fps: 30 });
    posed = applyCommand(posed, { type: "add_motion_graphic", graphic: { ...graphicWith(kineticTextMotion("pop", { fps: 30, unit: 1 }), "彈出"), id: "pose" } });
    posed = applyCommand(posed, { type: "add_motion_graphic", graphic: { ...createMotionGraphic("plain", "title", "平穩", 0, 3, undefined, findMotionGraphicPreset("generic-title-v2").seed), id: "plain" } });
    const layouts = await prepareMotionPhysicalLayouts(posed, resolve("public/fonts"));
    const ass = writeAssContent(posed, posed.captionStyle, { physicalLayouts: layouts, requirePhysicalGlyphs: true });
    const events = ass.split("\n").filter(line => line.startsWith("Dialogue: 2,"));
    expect(events.some(line => line.includes("\\frz") && line.includes("\\org("))).toBe(true);
    const plainEvents = events.filter(line => !line.includes("\\frz") && !line.includes("\\blur"));
    expect(plainEvents.length).toBeGreaterThan(0);
  }, 60000);
});

describe("baked clip camera recipes", () => {
  const project = createDemoProject();
  const clip = project.tracks.flatMap(track => track.clips).find(item => item.id === "clip-demo")!;
  const context = { projectWidth: project.width, projectHeight: project.height };

  it("bakes every recipe into linear keyframes that hold after the move", () => {
    for (const recipe of CLIP_MOTION_RECIPES) {
      const commands = clipMotionRecipeCommands(clip, recipe, { ...context, fps: 30 });
      expect(commands.length).toBeGreaterThanOrEqual(2);
      expect(commands.every(command => command.type === "add_keyframe" && command.keyframe.easing === "linear")).toBe(true);
    }
    const punch = clipMotionRecipeCommands(clip, "punch_in", { ...context, fps: 30 });
    const last = punch.at(-1)!;
    expect(last.type === "add_keyframe" && last.keyframe.transform.scale).toBeCloseTo(1.14 * clip.transform.scale, 3);
  });

  it("keeps the focus point fixed on screen while punching in", () => {
    const keyed = applyCommand(project, { type: "batch", commands: clipMotionRecipeCommands(clip, "punch_in", { ...context, fps: 30, focus: { x: .75, y: .3 } }) });
    const animated = keyed.tracks.flatMap(track => track.clips).find(item => item.id === "clip-demo")!;
    const focus = { x: (.75 - .5) * project.width, y: (.3 - .5) * project.height };
    for (const frame of [0, 2, 4, 8, 20]) {
      const state = animatedClipState(animated, frame / 30, 30).transform;
      const relative = state.scale / clip.transform.scale;
      expect(focus.x * relative + (state.x - clip.transform.x)).toBeCloseTo(focus.x, 1);
      expect(focus.y * relative + (state.y - clip.transform.y)).toBeCloseTo(focus.y, 1);
    }
  });

  it("matches the true curve on every rendered frame within bake tolerance", () => {
    const keyed = applyCommand(project, { type: "batch", commands: clipMotionRecipeCommands(clip, "push_settle", { ...context, fps: 30, energy: "punchy" }) });
    const animated = keyed.tracks.flatMap(track => track.clips).find(item => item.id === "clip-demo")!;
    const scales = Array.from({ length: 16 }, (_, frame) => animatedClipState(animated, frame / 30, 30).transform.scale / clip.transform.scale);
    expect(Math.max(...scales)).toBeGreaterThan(1.13);
    expect(scales.at(-1)!).toBeCloseTo(1.13, 2);
  });

  it("keeps legacy preset ids exact and requires frame size for new recipes", () => {
    expect(MOTION_CLIP_PRESET_IDS.slice(0, 4)).toEqual(["float_in", "slow_push", "gallery_drift", "chapter_snap"]);
    expect(motionClipPresetCommands(clip, 30, "chapter_snap").map(command => command.type === "add_keyframe" && command.keyframe.time)).toEqual([0, 8 / 30, 12 / 30]);
    expect(() => motionClipPresetCommands(clip, 30, "punch_in")).toThrow(/畫面尺寸/);
    expect(motionClipPresetCommands(clip, 30, "punch_in", context).length).toBeGreaterThan(1);
  });
});
