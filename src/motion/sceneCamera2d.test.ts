import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import type { MotionScene2D } from "../domain/motionScene2d";
import type { SpringTargetTrack } from "../domain/motionContinuity";
import { prepareGlyphRun, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { createMotionGraphic } from "./composition";
import { motionGraphicV2FrameReceipt, motionGraphicV2LayoutReceipt, motionGraphicV2PhysicalLayoutReceipt } from "./compositionV2";
import { sampleSpringTargetTrack } from "./springTargetTrack";
import { assertMotionScene2DGraphicFrameInk, assertMotionScene2DPreparedFrameRange, assertMotionScenes2DPreparedFrameRange,
  motionSceneContourInk, prepareMotionSceneCamera2D, projectMotionScenePoint, sampleMotionSceneCamera2D } from "./sceneCamera2d";

const physicalText = "jJfTAVy漢g";

function track(position: number): SpringTargetTrack {
  return { fps: 30, initialPosition: position, initialVelocity: 0, initialTarget: position,
    spring: { stiffness: 100, damping: 20, mass: 1 }, events: [] };
}
function fixture(text = "") {
  const project = createEmptyProject("Original scene camera", { width: 320, height: 240, fps: 30 });
  const graphic = createMotionGraphic("stable-object", text ? "title" : "card", text, 0, 2, undefined,
    findMotionGraphicPreset(text ? "v2-word-cascade" : "reel_dot_grid").seed);
  graphic.x = .2; graphic.y = .2; graphic.width = .5; graphic.fontSize = 24; graphic.fontFamily = "Noto Sans TC"; graphic.fontWeight = 700;
  graphic.backgroundColor = "#00000000"; graphic.shadowDepth = 0; graphic.outlineWidth = 0; graphic.letterSpacing = 0;
  graphic.layoutV2 = { ...graphic.layoutV2!, widthMode: "fit_content", align: "left", minFontSize: 24, maxLines: 1,
    safeArea: { left: 0, right: 0, top: 0, bottom: 0 }, lineGap: 0 };
  graphic.motionV2 = { sequence: { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0 },
    entrance: { durationFrames: 1, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 0, easing: { type: "linear" } },
    exit: { durationFrames: 1, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 0, easing: { type: "linear" } } };
  if (graphic.vectorV2) graphic.vectorV2.heightPixels = 100;
  project.motionGraphics = [graphic];
  const scene: MotionScene2D = { schema: "editkin.motion-scene-2d/v1", id: "scene-camera", startFrame: 0, durationFrames: 60,
    fps: 30, graphicIds: [graphic.id], camera: { centerX: track(160), centerY: track(120), zoom: track(1) },
    safeArea: { left: 0, right: 0, top: 0, bottom: 0 },
    semanticCues: [{ id: "focus-original-object", frame: 0, purpose: "Read the original object before retargeting", graphicIds: [graphic.id], evidenceRefs: ["original-brief:focus"] }] };
  return { project: { ...project, motionScenes: [scene] }, scene, graphic };
}
let run: PreparedGlyphRun;
beforeAll(async () => {
  const face = bundledFontFaceSpec("EditkinFace-noto-sans-tc-700");
  run = await prepareGlyphRun(face.faceId, physicalText, new Uint8Array(await readFile(join(resolve("public/fonts"), face.fontFile))));
});

describe("shared original orthographic scene projection and true ink", () => {
  it("checks native fill instead of transparent legacy colors, including the finite shadow after camera scale", () => {
    const { project, scene, graphic } = fixture();
    graphic.vectorV2 = { schema: "editkin.motion-vector/v1", kind: "panel", heightPixels: 60, revealFrames: 1 };
    graphic.visualStyle = "native_paint";
    graphic.paintV1 = { schema: "editkin.motion-paint/v1", fill: { kind: "solid", color: "#ABCDEF" }, clips: [] };
    const layouts = () => new Map([[graphic.id, motionGraphicV2LayoutReceipt(project, graphic)]]);
    expect(() => assertMotionScenes2DPreparedFrameRange(project, layouts())).not.toThrow();
    scene.safeArea.left = 70;
    expect(() => assertMotionScenes2DPreparedFrameRange(project, layouts())).toThrow(/safe-area/);
    scene.safeArea.left = 0;
    graphic.paintV1.shadow = { color: "#00000080", blurPixels: 8, offsetXPixels: 0, offsetYPixels: 0 };
    scene.safeArea.left = 42;
    expect(() => assertMotionScenes2DPreparedFrameRange(project, layouts())).toThrow(/safe-area/);
    scene.safeArea.left = 0; scene.camera.zoom.initialPosition = 1.2; scene.camera.zoom.initialTarget = 1.2;
    expect(() => assertMotionScenes2DPreparedFrameRange(project, layouts())).not.toThrow();
    scene.safeArea.left = 15;
    expect(() => assertMotionScenes2DPreparedFrameRange(project, layouts())).toThrow(/safe-area/);
  });
  it("uses the exact shared affine map and identity outside half-open membership", () => {
    const { project, scene, graphic } = fixture();
    scene.camera = { centerX: track(100), centerY: track(60), zoom: track(1.25) };
    const camera = prepareMotionSceneCamera2D(project), projection = camera.sample(graphic.id, 20);
    expect(projection).toEqual({ sceneId: scene.id, active: true, scale: 1.25, translateX: 35, translateY: 45,
      velocity: { scale: 0, translateX: 0, translateY: 0 } });
    expect(projectMotionScenePoint({ x: 100, y: 60 }, projection)).toEqual({ x: 160, y: 120 });
    expect(projectMotionScenePoint({ x: 120, y: 80 }, projection)).toEqual({ x: 185, y: 145 });
    for (const frame of [-1, 60, 120]) expect(camera.sample(graphic.id, frame)).toEqual({ active: false, scale: 1, translateX: 0, translateY: 0,
      velocity: { scale: 0, translateX: 0, translateY: 0 } });
    expect(sampleMotionSceneCamera2D({ ...project, motionScenes: [] }, graphic.id, 20).active).toBe(false);
    expect(() => camera.sample(graphic.id, 1.5)).toThrow(/integer/);
  });

  it("retains velocity at retargets and returns equal nonmonotonic samples", () => {
    const { project, scene, graphic } = fixture();
    scene.camera.centerX.initialTarget = 120;
    scene.camera.centerX.events = [{ frame: 20, target: 190 }, { frame: 40, target: 150 }];
    const camera = prepareMotionSceneCamera2D(project);
    for (const event of scene.camera.centerX.events) {
      const prior = { ...scene.camera.centerX, events: scene.camera.centerX.events.filter(item => item.frame < event.frame) };
      const sample = sampleSpringTargetTrack(prior, event.frame), actual = camera.sample(graphic.id, event.frame);
      expect(actual.translateX).toBe(160 - sample.position);
      expect(actual.velocity.translateX).toBe(-sample.velocity);
      expect(Math.abs(actual.velocity.translateX)).toBeGreaterThan(.01);
    }
    const frames = [0, 19, 20, 21, 40, 59], forward = new Map(frames.map(frame => [frame, camera.sample(graphic.id, frame)]));
    for (const frame of [59, 20, 0, 40, 19, 21, 20]) expect(camera.sample(graphic.id, frame)).toEqual(forward.get(frame));
  });

  it("rejects in-place camera/cue/scope/range drift while stable repeated sampling serializes no source", () => {
    for (const kind of ["target", "cue", "scope", "graphic-range", "extra-key"] as const) {
      const { project, scene, graphic } = fixture();
      const camera = prepareMotionSceneCamera2D(project);
      if (kind === "target") scene.camera.centerX.initialTarget += 1;
      if (kind === "cue") scene.semanticCues[0].purpose += " changed";
      if (kind === "scope") scene.graphicIds = ["different-object"];
      if (kind === "graphic-range") graphic.duration += 1 / project.fps;
      if (kind === "extra-key") Object.defineProperty(scene.camera.zoom, "unadmitted", { value: 1 });
      expect(() => camera.sample(graphic.id, 10)).toThrow(/source changed/);
    }
    const { project, graphic } = fixture(), camera = prepareMotionSceneCamera2D(project);
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      const a = camera.sample(graphic.id, 10), b = camera.sample(graphic.id, 10);
      expect(a).toEqual(b); expect(stringify).not.toHaveBeenCalled();
      expect(Object.isFrozen(camera)).toBe(true); expect(Object.isFrozen(a.velocity)).toBe(true);
    } finally { stringify.mockRestore(); }
  });

  it("finds real cubic curve extrema rather than treating control points as ink", () => {
    expect(motionSceneContourInk("M 0 0 C 0 100 100 100 100 0 Z")).toEqual({ xMin: 0, yMin: 0, xMax: 100, yMax: 75 });
    expect(motionSceneContourInk("M -5 4 L 8 4 8 12 -5 12 Z")).toEqual({ xMin: -5, yMin: 4, xMax: 8, yMax: 12 });
    expect(() => motionSceneContourInk("M 0 0 Q 4 10 8 0 Z")).toThrow(/unsupported/);
    expect(() => motionSceneContourInk("M 0 0 C 0 100 100 100 100 0")).toThrow(/closed/);
  });

  it("requires actual physical receipts and detects outline/source changes instead of accepting estimated text", () => {
    const { project, scene, graphic } = fixture(physicalText);
    const estimated = motionGraphicV2LayoutReceipt(project, graphic);
    expect(() => assertMotionScene2DPreparedFrameRange(project, scene, new Map([[graphic.id, estimated]]))).toThrow(/physical glyph layout/);
    const layout = motionGraphicV2PhysicalLayoutReceipt(project, graphic, run);
    const changed = structuredClone(layout); changed.segments[0].outline!.ass += " l 0 0";
    expect(() => assertMotionScene2DPreparedFrameRange(project, scene, new Map([[graphic.id, changed]]))).toThrow(/receipt/);
    graphic.text = "changed";
    expect(() => assertMotionScene2DPreparedFrameRange(project, scene, new Map([[graphic.id, layout]]))).toThrow(/receipt/);
  });

  it("accepts complete actual glyph frames and rejects negative-bearing/descender ink crossing the safe-area", () => {
    const { project, scene, graphic } = fixture(physicalText);
    expect(run.glyphs.some(glyph => glyph.inkEm && glyph.inkEm.xMin < 0)).toBe(true);
    expect(run.glyphs.some(glyph => glyph.inkEm && glyph.inkEm.yMax > 0)).toBe(true);
    const layout = motionGraphicV2PhysicalLayoutReceipt(project, graphic, run), layouts = new Map([[graphic.id, layout]]);
    const receipt = assertMotionScene2DPreparedFrameRange(project, scene, layouts);
    expect(receipt.framesChecked).toBe(60); expect(receipt.graphicFramesChecked).toBe(60);
    expect(receipt.layoutReceiptIds[graphic.id]).toBe(layout.receiptId); expect(Object.isFrozen(receipt.layoutReceiptIds)).toBe(true);
    const inks = layout.segments.flatMap(segment => segment.outline?.ink ? [{ xMin: segment.x + segment.outline.ink.xMin,
      yMax: segment.y + segment.outline.ink.yMax }] : []);
    scene.safeArea.left = Math.min(...inks.map(ink => ink.xMin)) + .25;
    expect(() => assertMotionScene2DPreparedFrameRange(project, scene, layouts)).toThrow(/actual ink\/contour/);
    scene.safeArea.left = 0; scene.safeArea.bottom = project.height - Math.max(...inks.map(ink => ink.yMax)) + .25;
    expect(() => assertMotionScene2DPreparedFrameRange(project, scene, layouts)).toThrow(/actual ink\/contour/);
  });

  it("includes the physical scaled shadow and independently validates the current UI frame", () => {
    const { project, scene, graphic } = fixture(physicalText);
    const layout = motionGraphicV2PhysicalLayoutReceipt(project, graphic, run);
    const maximum = Math.max(...layout.segments.flatMap(segment => segment.outline?.ink ? [segment.x + segment.outline.ink.xMax] : []));
    scene.safeArea.right = project.width - maximum - 3;
    const plain = new Map([[graphic.id, layout]]);
    expect(() => assertMotionScene2DPreparedFrameRange(project, scene, plain)).not.toThrow();
    graphic.shadowDepth = 6;
    const shadow = motionGraphicV2PhysicalLayoutReceipt(project, graphic, run), layouts = new Map([[graphic.id, shadow]]);
    expect(() => assertMotionScene2DPreparedFrameRange(project, scene, layouts)).toThrow(/actual ink\/contour/);
    const projection = prepareMotionSceneCamera2D(project).sample(graphic.id, 20), frame = motionGraphicV2FrameReceipt(project, graphic, 20, shadow);
    expect(() => assertMotionScene2DGraphicFrameInk(project, graphic, shadow, frame, projection)).toThrow(/actual ink\/contour/);
    expect(() => assertMotionScene2DGraphicFrameInk(project, graphic, shadow, frame, { ...projection, scale: .5 })).toThrow(/current camera frame/);
  });

  it("checks actual cubic vector contours for every frame and blocks camera-driven crossings", () => {
    const { project, scene, graphic } = fixture();
    graphic.vectorV2 = { schema: "editkin.motion-vector/v1", kind: "ellipse", heightPixels: 100, revealFrames: 1 };
    graphic.backgroundColor = "#287DFF";
    const layout = motionGraphicV2LayoutReceipt(project, graphic), layouts = new Map([[graphic.id, layout]]);
    const receipts = assertMotionScenes2DPreparedFrameRange(project, layouts);
    expect(receipts[0].framesChecked).toBe(60); expect(Object.isFrozen(receipts)).toBe(true);
    scene.camera.centerX.initialTarget = 320;
    expect(() => assertMotionScenes2DPreparedFrameRange(project, layouts)).toThrow(/safe-area/);
    const current = prepareMotionSceneCamera2D(project), frame = motionGraphicV2FrameReceipt(project, graphic, 30, layout);
    expect(() => assertMotionScene2DGraphicFrameInk(project, graphic, layout, frame, current.sample(graphic.id, 30))).toThrow(/safe-area/);
  });
});
