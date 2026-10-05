import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { createDemoProject } from "../domain/demo";
import type { MotionScene2D } from "../domain/motionScene2d";
import type { SpringTargetTrack } from "../domain/motionContinuity";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareGlyphRun } from "../typography/preparedGlyphRun";
import { canonicalJson } from "../shared/canonicalJson";
import { createMotionGraphic } from "./composition";
import { motionGraphicV2FrameReceipt, motionGraphicV2PhysicalLayoutReceipt } from "./compositionV2";
import { prepareMotionSceneCamera2D } from "./sceneCamera2d";
import { nativeMotionPaintFrame, nativeMotionPaintTrack, prepareNativeMotionPaint } from "./nativeMotionPaint";
import { buildGpuEngineVideoPreviewGraph, canPresentGpuVideoOnNativeSurface, commonVideoMotionGraphicsSupported,
  estimateGpuEngineVideoResources } from "../render/gpuCompositor";
import { expectedEngineVideoLayers } from "../desktop/residentGpuPreviewExpectations";

const faceId = "EditkinFace-bebas-neue-400";
const bytes = readFile(resolve("public/fonts", bundledFontFaceSpec(faceId).fontFile));
async function physical(text: string) { return prepareGlyphRun(faceId, text, new Uint8Array(await bytes)); }
function fixture(text = "AV\nO") {
  const project = createEmptyProject("Actual paint track", { width: 640, height: 360, fps: 30 });
  const graphic = createMotionGraphic("paint-title", "title", text, .5, 3, undefined, findMotionGraphicPreset("v2-word-cascade").seed);
  Object.assign(graphic, { fontFamily: "Bebas Neue", fontWeight: 400, fontSize: 48, backgroundColor: "#00000000",
    shadowDepth: 0, outlineWidth: 0, x: .1, y: .1, width: .7, letterSpacing: 0, visualStyle: "native_paint" });
  graphic.layoutV2 = { ...graphic.layoutV2!, minFontSize: 48, maxLines: 4, widthMode: "fit_content", align: "left" };
  graphic.motionV2!.sequence.unit = "character";
  graphic.paintV1 = { schema: "editkin.motion-paint/v1", fill: { kind: "linear", start: { x: 0, y: 0 }, end: { x: 1, y: 0 },
    stops: [{ at: 0, color: "#175CD380" }, { at: 1, color: "#A9E9F7" }] }, clips: [] };
  project.motionGraphics = [graphic];
  return { project, graphic };
}
function spring(position: number): SpringTargetTrack {
  return { fps: 30, initialPosition: position, initialVelocity: 0, initialTarget: position,
    spring: { stiffness: 100, damping: 20, mass: 1 }, events: [] };
}
function scene(graphicId: string): MotionScene2D {
  return { schema: "editkin.motion-scene-2d/v1", id: "camera", startFrame: 15, durationFrames: 90, fps: 30,
    graphicIds: [graphicId], camera: { centerX: spring(320), centerY: spring(180), zoom: spring(1) },
    safeArea: { left: 0, right: 0, top: 0, bottom: 0 },
    semanticCues: [{ id: "focus", frame: 0, purpose: "Read the actual physical title", graphicIds: [graphicId], evidenceRefs: ["original:paint"] }] };
}
function coveredVideoFixture() {
  const result = fixture(), demo = createDemoProject(), source = demo.assets[0], clip = demo.tracks[0].clips[0];
  result.project.assets = [{ ...source, kind: "video", uri: "C:/fixtures/physical-paint-source.mp4", width: result.project.width,
    height: result.project.height, duration: 4, color: { interpretation: "rec709" } }];
  result.project.tracks = [{ ...demo.tracks[0], clips: [{ ...clip, timelineStart: 0, sourceStart: 0, duration: 4 }] }];
  result.project.colorManagement = { ...demo.colorManagement!, mode: "aces2", outputTransform: "rec709_sdr" };
  return result;
}

describe("factory-owned numeric native motion paint tracks", () => {
  it("retains every multiline character layer and samples the existing current frame/camera evaluator", async () => {
    const { project, graphic } = fixture(), run = await physical(graphic.text);
    const cameraScene = scene(graphic.id);
    cameraScene.camera.centerX.initialTarget = 330;
    cameraScene.camera.centerX.events = [{ frame: 45, target: 310 }];
    cameraScene.camera.zoom.initialTarget = 1.05;
    project.motionScenes = [cameraScene];
    const handle = prepareNativeMotionPaint(project, new Map([[graphic.id, run]]));
    const track = nativeMotionPaintTrack(project, handle, graphic.id);
    expect(track.timeline).toEqual({ timelineStartFrame: 15, sourceStartFrame: 0, durationFrames: 90 });
    expect(track.frames).toHaveLength(90);
    expect(track.scene).toMatchObject({ width: 640, height: 360, max_scale: 32, background: [0, 0, 0, 0] });
    expect(track.scene.layers).toHaveLength(3);
    expect(track.frames.every(row => row.length === track.scene.layers.length)).toBe(true);
    expect(track.frames[0].every(pose => pose.opacity === 0)).toBe(true);
    const layout = motionGraphicV2PhysicalLayoutReceipt(project, graphic, run), camera = prepareMotionSceneCamera2D(project);
    for (const timelineFrame of [15, 17, 31, 60, 102, 104, 31]) {
      const frame = motionGraphicV2FrameReceipt(project, graphic, timelineFrame, layout), projection = camera.sample(graphic.id, timelineFrame);
      layout.segments.forEach((segment, index) => {
        const state = frame.segments.find(item => item.segmentId === segment.id)!;
        expect(track.scene.layers[index].id).toBe(segment.id);
        expect(track.scene.layers[index].path).toEqual({ commands: segment.outline!.commands, fill_rule: "non_zero" });
        expect(track.frames[timelineFrame - track.timeline.timelineStartFrame][index]).toEqual({
          x: (segment.x + state.translateXPixels) * projection.scale + projection.translateX,
          y: (segment.y + state.translateYPixels) * projection.scale + projection.translateY,
          scale: state.scale * projection.scale, opacity: state.opacity,
        });
      });
      expect(nativeMotionPaintFrame(project, handle, timelineFrame).poses).toEqual(track.frames[timelineFrame - 15]);
    }
    expect(nativeMotionPaintFrame(project, handle, 14).scene.layers).toHaveLength(0);
    expect(nativeMotionPaintFrame(project, handle, 105).scene.layers).toHaveLength(0);
    expect(track.scene.layers[0].paint.kind === "linear" && track.scene.layers[0].paint.stops[0].color[3]).toBe(128 / 255);
  });

  it("privately caches deeply frozen tracks and rejects cloned handles and changed canvas/source after cache", async () => {
    const { project, graphic } = fixture(), run = await physical(graphic.text);
    const handle = prepareNativeMotionPaint(project, new Map([[graphic.id, run]])), track = nativeMotionPaintTrack(project, handle, graphic.id);
    expect(nativeMotionPaintTrack(project, handle, graphic.id)).toBe(track);
    expect(nativeMotionPaintTrack(structuredClone(project), handle, graphic.id)).toBe(track);
    expect(Object.isFrozen(track)).toBe(true); expect(Object.isFrozen(track.scene)).toBe(true);
    expect(track.frames.every(row => Object.isFrozen(row) && row.every(Object.isFrozen))).toBe(true);
    expect(JSON.parse(track.sourceSignature)).toEqual(JSON.parse(canonicalJson({ width: project.width, height: project.height,
      fps: project.fps, graphics: project.motionGraphics, scenes: [] })));
    for (const copied of [structuredClone(handle), JSON.parse(JSON.stringify(handle))]) {
      expect(() => nativeMotionPaintTrack(project, copied, graphic.id)).toThrow(/factory-owned/);
    }
    expect(() => prepareNativeMotionPaint(project, new Map([[graphic.id, structuredClone(run)]]))).toThrow(/factory/);
    for (const key of ["canvas", "fps", "text", "paint", "motion"] as const) {
      const changed = structuredClone(project);
      if (key === "canvas") changed.width += 1;
      else if (key === "fps") changed.fps = 60;
      else if (key === "text") changed.motionGraphics[0].text += "W";
      else if (key === "paint") changed.motionGraphics[0].paintV1!.fill = { kind: "solid", color: "#ffffff" };
      else changed.motionGraphics[0].motionV2!.entrance.offsetXPixels += 1;
      expect(() => nativeMotionPaintTrack(changed, handle, graphic.id)).toThrow(/stale/);
    }
    expect(() => nativeMotionPaintTrack(project, handle, "missing")).toThrow(/missing from actual preparation/);
  });

  it("binds camera changes and rejects unsupported combined pose scale before a track can enter a graph", async () => {
    const { project, graphic } = fixture(), run = await physical(graphic.text);
    const cameraScene = scene(graphic.id); project.motionScenes = [cameraScene];
    const handle = prepareNativeMotionPaint(project, new Map([[graphic.id, run]]));
    nativeMotionPaintTrack(project, handle, graphic.id);
    const changed = structuredClone(project); changed.motionScenes![0].camera.centerX.initialTarget += 1;
    expect(() => nativeMotionPaintTrack(changed, handle, graphic.id)).toThrow(/stale/);
    graphic.motionV2!.entrance.scale = .01;
    cameraScene.camera.zoom = spring(.5);
    const tooSmall = prepareNativeMotionPaint(project, new Map([[graphic.id, run]]));
    expect(() => nativeMotionPaintTrack(project, tooSmall, graphic.id)).toThrow(/pose exceeds native bounds/);
  });

  it("admits the shared 18,000 pose boundary and refuses a third independently legal physical graphic", async () => {
    const { project, graphic } = fixture("A"), run = await physical(graphic.text);
    graphic.duration = 300;
    const second = { ...structuredClone(graphic), id: "second" };
    project.motionGraphics.push(second);
    expect(prepareNativeMotionPaint(project, new Map([[graphic.id, run], [second.id, run]])).graphicIds).toEqual([graphic.id, second.id]);
    const third = { ...structuredClone(graphic), id: "third" }; project.motionGraphics.push(third);
    expect(() => prepareNativeMotionPaint(project, new Map([[graphic.id, run], [second.id, run], [third.id, run]]))).toThrow(/shared 18,000 pose budget/);
  });

  it("refuses duplicate identities and an authored signature beyond its bounded transport budget", async () => {
    const { project, graphic } = fixture("A"), run = await physical(graphic.text);
    project.motionGraphics.push(structuredClone(graphic));
    expect(() => prepareNativeMotionPaint(project, new Map([[graphic.id, run]]))).toThrow(/duplicate graphic identity/);
    project.motionGraphics.pop();
    graphic.paintV1!.clips = [{ fillRule: "non_zero", commands: [{ type: "M", x: 0, y: 0 },
      ...Array.from({ length: 8190 }, () => ({ type: "L" as const, x: .5, y: .5 })), { type: "Z" }] }];
    expect(() => prepareNativeMotionPaint(project, new Map([[graphic.id, run]]))).toThrow(/source signature exceeds bounded size/);
  });

  it("admits current covered ACES2 video with actual paint and accounts for the native retained frames and geometry reserve", async () => {
    const { project, graphic } = coveredVideoFixture(), run = await physical(graphic.text);
    const handle = prepareNativeMotionPaint(project, new Map([[graphic.id, run]]));
    expect(commonVideoMotionGraphicsSupported(project, handle)).toBe(true);
    expect(canPresentGpuVideoOnNativeSurface(project, handle)).toBe(true);
    const preview = buildGpuEngineVideoPreviewGraph(project, .6, handle)!;
    expect(preview).toBeDefined(); expect(preview.timelineFrame).toBe(18);
    expect(preview.graph.workingFormat).toBe("rgba16_float");
    expect(preview.graph.nodes.find(node => node.id === preview.graph.outputNode)?.format).toBe("rgba16_float");
    expect(expectedEngineVideoLayers(preview.graph).map(layer => layer.assetId)).toEqual([project.assets[0].id]);
    expect(preview.graph.nodes.find(node => node.graphicId === graphic.id)).toMatchObject({
      id: "motion-graphic:paint-title", kind: "native_motion_paint", track: nativeMotionPaintTrack(project, handle, graphic.id),
    });
    expect(preview.graph.nodes.some(node => node.id === "source:clip-demo" && node.kind === "source")).toBe(true);
    expect(preview.graph.nodes.find(node => node.id === "display:aces2")?.processor).toBe("editkin-ocio-aces2-linear-rec709-to-rec709-sdr/v1");
    const resources = estimateGpuEngineVideoResources(project.width, project.height, preview.graph.cacheBudgetMb, 1, 1, 0, 0, 0, 0, 8, 0, 0, 1)!;
    const pixels = project.width * project.height, geometryReserve = 16 * 1024 * 1024;
    expect(resources).toMatchObject({ nativePaintCount: 1, overlayBytes: pixels * 8, nativePaintCpuBytes: pixels * 16,
      nativePaintStagingBytes: pixels * 8, nativePaintGeometryBytes: geometryReserve,
      requiredBytes: pixels * (36 + 24 + 8 + 16 + 8) + geometryReserve });
    expect(resources.maxVideoLayers).toBe(Math.floor((resources.budgetBytes - pixels * (24 + 8 + 16 + 8) - geometryReserve) / (pixels * 36)));
    expect(estimateGpuEngineVideoResources(640, 360, 1024, 1, 1, 0, 0, 0, 0, 4, 0, 0, 1)).toBeUndefined();
  });

  it("keeps missing/copied/stale paint, encoded SDR and uncovered timeline out of the common video route", async () => {
    const { project, graphic } = coveredVideoFixture(), handle = prepareNativeMotionPaint(project, new Map([[graphic.id, await physical(graphic.text)]]));
    expect(buildGpuEngineVideoPreviewGraph(project, .6)).toBeUndefined();
    expect(commonVideoMotionGraphicsSupported(project)).toBe(false);
    expect(buildGpuEngineVideoPreviewGraph(project, .6, structuredClone(handle))).toBeUndefined();
    const stale = structuredClone(project); stale.motionGraphics[0].paintV1!.fill = { kind: "solid", color: "#ff0000" };
    expect(buildGpuEngineVideoPreviewGraph(stale, .6, handle)).toBeUndefined();
    const encoded = structuredClone(project); encoded.colorManagement = undefined;
    expect(buildGpuEngineVideoPreviewGraph(encoded, .6, handle)).toBeUndefined();
    expect(canPresentGpuVideoOnNativeSurface(encoded, handle)).toBe(false);
    const uncovered = structuredClone(project); uncovered.tracks[0].clips[0].duration = 2;
    expect(buildGpuEngineVideoPreviewGraph(uncovered, .6, handle)).toBeUndefined();
  });
});
