import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { validateProject } from "../domain/editGraph";
import { floatingVideoFramePresetV2, floatingFrameLayout } from "../motion/floatingVideoFrame";
import { createMotionGraphic } from "../motion/composition";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { prepareNativeMotionPaint } from "../motion/nativeMotionPaint";
import { prepareGlyphRun } from "../typography/preparedGlyphRun";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { buildEngineRenderGraph, timebaseForFps } from "./engineGraph";
import { buildGpuEngineVideoPreviewGraph } from "./gpuCompositor";
import { nativeFloatingVideoFrameSpec, prepareNativeFloatingVideoFrames, sampleNativeFloatingVideoFrame } from "./nativeFloatingVideoFrame";

function fixture() {
  const project = createDemoProject();
  project.width = 1080; project.height = 1920; project.captions = []; project.motionGraphics = [];
  project.colorManagement = { ...project.colorManagement!, mode: "aces2", outputTransform: "rec709_sdr" };
  Object.assign(project.assets[0], { uri: "D:/synthetic-controls/native-floating.mp4", width: 1920, height: 1080,
    displayAspectRatio: 16 / 9, color: { interpretation: "rec709" }, duration: 12 });
  const clip = project.tracks[0].clips[0];
  Object.assign(clip, { timelineStart: 1, sourceStart: .5, duration: 2, floatingFrame: floatingVideoFramePresetV2("matte") });
  return { project, clip };
}
describe("explicit native flat floating assembly", () => {
  it("keeps old native graph/selector refusal until actual floating preparation is passed", () => {
    const { project } = fixture(), before = JSON.stringify(project);
    expect(() => buildEngineRenderGraph(project)).toThrow(/浮空/);
    expect(buildGpuEngineVideoPreviewGraph(project, 1)).toBeUndefined();
    expect(JSON.stringify(project)).toBe(before);
  });
  it("places source color before assembly and preserves post-assembly clip transform and timeline", () => {
    const { project, clip } = fixture();
    clip.transform = { ...clip.transform, x: 14, y: -20, scale: .9, rotation: 8, opacity: .75 };
    clip.keyframes = [{ id: "floating-affine-keyframe", time: 1, transform: { ...clip.transform, x: 22 }, color: { ...clip.color }, easing: "linear" }];
    const handle = prepareNativeFloatingVideoFrames(project), graph = buildEngineRenderGraph(project, { nativeFloatingVideoFrames: handle });
    const floating = graph.nodes.find(node => node.kind === "floating_video_frame_2d")!;
    const grade = graph.nodes.find(node => node.id === floating.inputs[0])!;
    expect(grade.kind).toBe("color"); expect(grade.inputs).toEqual(["source:clip-demo"]);
    const transform = graph.nodes.find(node => node.id === "transform:clip-demo")!;
    expect(transform.inputs).toEqual([floating.id]); expect(transform).toMatchObject({ x: 14, y: -20, scaleX: .9, rotationRadians: 8 * Math.PI / 180, opacity: .75 });
    expect(transform.keyframes).toMatchObject([{ frame: 30, x: 22 }]);
    expect(floating.spec).toMatchObject({ schema: "editkin.native-floating-video-frame/v1", timeline: { timelineStartFrame: 30, sourceStartFrame: 15, durationFrames: 60 }, timebase: graph.timebase });
  });
  it("owns the true source DAR, original input and coded dimensions rather than a canvas proxy", () => {
    const { project, clip } = fixture();
    project.assets[0].derivatives = { sourceSha256: "a".repeat(64), generatedAt: "2026-10-05T00:00:00Z",
      proxyUri: "D:/synthetic-controls/wrong-canvas-proxy.mp4", proxyWidth: 540, proxyHeight: 960 };
    const handle = prepareNativeFloatingVideoFrames(project);
    const result = buildGpuEngineVideoPreviewGraph(project, 1, undefined, handle)!;
    expect(result).toBeDefined(); expect(result.assetBindings[clip.assetId]).toBe(project.assets[0].uri);
    expect(result.decoderDimensions[clip.assetId]).toEqual({ width: 1920, height: 1080, source: "original" });
    expect(nativeFloatingVideoFrameSpec(project, handle, clip.id).source.displayAspectRatio).toBe(16 / 9);
  });
  it("retains factory ownership and rejects source, clock, frame or geometry drift", () => {
    const { project, clip } = fixture(), handle = prepareNativeFloatingVideoFrames(project);
    expect(() => nativeFloatingVideoFrameSpec(project, structuredClone(handle), clip.id)).toThrow(/factory-owned/);
    for (const change of [(p: typeof project) => { p.assets[0].uri = "changed.mp4"; },
      (p: typeof project) => { p.fps = 24; }, (p: typeof project) => { p.width = 1090; },
      (p: typeof project) => { p.tracks[0].clips[0].floatingFrame!.yawDegrees = 2; }]) {
      const changed = structuredClone(project); change(changed);
      expect(() => nativeFloatingVideoFrameSpec(changed, handle, clip.id)).toThrow(/stale/);
      expect(buildGpuEngineVideoPreviewGraph(changed, 1, undefined, handle)).toBeUndefined();
    }
  });
  it("resolves auto only on the execution clone without invalidating actual authored owner", () => {
    const { project } = fixture(); project.assets[0].color = { interpretation: "auto" };
    const before = JSON.stringify(project), handle = prepareNativeFloatingVideoFrames(project);
    expect(buildGpuEngineVideoPreviewGraph(project, 1, undefined, handle)).toBeDefined();
    expect(JSON.stringify(project)).toBe(before);
  });
  it("shares full-canvas perspective, absolute content rectangle and integer entrance/exit phases", async () => {
    const nativeComparisons: unknown[] = [];
    for (const preset of ["matte", "prism", "graphite", "portrait_orbit"] as const) {
      for (const aspect of ["source", "canvas", "portrait"] as const) {
        const { project, clip } = fixture(); clip.floatingFrame = { ...floatingVideoFramePresetV2(preset), aspect };
        const handle = prepareNativeFloatingVideoFrames(project), spec = nativeFloatingVideoFrameSpec(project, handle, clip.id);
        for (const localFrame of [0, 5, 6, 29, 53, 54, 59]) {
          const sample = sampleNativeFloatingVideoFrame(spec, 30 + localFrame);
          const expected = floatingFrameLayout(clip.floatingFrame, project.width, project.height,
            { width: 16 / 9, height: 1, fps: 30, durationFrames: 60, localFrame });
          expect(sample.quad).toEqual(expected.geometry.quad); expect(sample.opacity).toBe(expected.opacity);
          expect(sample.contentRect).toEqual([expected.geometry.left + expected.geometry.border + expected.sourceContentRect.left,
            expected.geometry.top + expected.geometry.border + expected.sourceContentRect.top, expected.sourceContentRect.width, expected.sourceContentRect.height]);
          expect(sample.contentRect[2] / sample.contentRect[3]).toBeCloseTo(16 / 9, 10);
          nativeComparisons.push({ preset, aspect, spec, localFrame, expected: sample });
        }
      }
    }
    if (process.env.EDITKIN_FLOATING_FIXTURE_OUT) {
      await writeFile(process.env.EDITKIN_FLOATING_FIXTURE_OUT, JSON.stringify({
        schema: "editkin.native-floating-independent-comparison/v1", geometryPixels: .002,
        opacityError: .000001, cases: nativeComparisons,
      }, null, 2));
    }
  });
  it("owns the literal rational clock and rejects fractional project-frame starts instead of rounding", () => {
    const { project, clip } = fixture(); project.fps = 30_000 / 1001;
    clip.timelineStart = 30 / project.fps; clip.sourceStart = 15 / project.fps; clip.duration = 60 / project.fps;
    const handle = prepareNativeFloatingVideoFrames(project);
    expect(nativeFloatingVideoFrameSpec(project, handle, clip.id).timebase).toEqual(timebaseForFps(project.fps));
    clip.sourceStart += .001; expect(() => prepareNativeFloatingVideoFrames(project)).toThrow(/exact/);
  });
  it("fails closed on legacy, HDR, nested, matte, temporal and unsupported effect mixtures", () => {
    for (const change of [(p: ReturnType<typeof fixture>["project"]) => { p.assets[0].color = { interpretation: "hlg" }; },
      (p: ReturnType<typeof fixture>["project"]) => { p.assets[0].color = { interpretation: "auto", transfer: "arib-std-b67" }; },
      (p: ReturnType<typeof fixture>["project"]) => { p.assets[0].compositionId = "nested"; },
      (p: ReturnType<typeof fixture>["project"]) => { p.tracks[0].clips[0].layer = { enabled: true, blendMode: "normal", trackMatte: { sourceClipId: "other", mode: "alpha" } }; },
      (p: ReturnType<typeof fixture>["project"]) => { p.tracks[0].clips[0].creative = { effectPresetIds: ["mono_halftone"] }; },
      (p: ReturnType<typeof fixture>["project"]) => { p.tracks[0].clips[0].expressions = { x: "hao.expression/v1:value + time" }; }]) {
      const { project } = fixture(); change(project); expect(() => prepareNativeFloatingVideoFrames(project)).toThrow();
    }
    const { project, clip } = fixture();
    clip.floatingFrame = { schema: "editkin.floating-video-frame/v1", style: "matte", size: .58, yawDegrees: -12, pitchDegrees: 3 };
    expect(() => prepareNativeFloatingVideoFrames(project)).toThrow(/legacy/);
  });
  it("admits only the explicit v2 ACES SDR project boundary while preserving other validation guards", () => {
    const { project } = fixture(); expect(() => validateProject(project)).not.toThrow();
    project.colorManagement!.outputTransform = "rec2100_pq_1000";
    expect(() => validateProject(project)).toThrow(/浮空/);
  });
  it("coexists with real physical display glyph paint without moving the final ACES suffix", async () => {
    const { project, clip } = fixture();
    const graphic = createMotionGraphic("display-title", "title", "FLOAT", 1, 2, undefined, findMotionGraphicPreset("v2-word-cascade").seed);
    Object.assign(graphic, { fontFamily: "Bebas Neue", fontWeight: 400, fontSize: 48,
      backgroundColor: "#00000000", shadowDepth: 0, outlineWidth: 0, visualStyle: "native_paint" });
    graphic.layoutV2 = { ...graphic.layoutV2!, minFontSize: 48, maxLines: 4 };
    graphic.paintV1 = { schema: "editkin.motion-paint/v2", colorIntent: "display_rec709_sdr", fill: { kind: "solid", color: "#175CD3" }, clips: [] };
    project.motionGraphics = [graphic];
    const faceId = "EditkinFace-bebas-neue-400", bytes = new Uint8Array(await readFile(resolve("public/fonts", bundledFontFaceSpec(faceId).fontFile)));
    const paint = prepareNativeMotionPaint(project, new Map([[graphic.id, await prepareGlyphRun(faceId, graphic.text, bytes)]]));
    const floating = prepareNativeFloatingVideoFrames(project), graph = buildEngineRenderGraph(project, { nativeMotionPaint: paint, nativeFloatingVideoFrames: floating });
    const aces = graph.nodes.find(node => node.id === "display:aces2")!;
    expect(aces.inputs).toEqual([`transform:${clip.id}`]);
    const output = graph.nodes.find(node => node.id === graph.outputNode)!;
    expect(graph.nodes.find(node => node.id === output.inputs[0])?.inputs).toEqual([aces.id, `motion-graphic:${graphic.id}`]);
    expect(buildGpuEngineVideoPreviewGraph(project, 1, paint, floating)?.graph.nodes.some(node => node.kind === "native_motion_paint")).toBe(true);
  });
});
