import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { buildEngineRenderGraph } from "./engineGraph";
import { createClipMask } from "../domain/masks";
import { createMotionGraphic } from "../motion/composition";
import { createTransformMotionBlurInstance } from "../domain/transformMotionBlur";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { commonVideoMotionGraphicsSupported } from "./gpuCompositorAdmission";

describe("native engine render graph", () => {
  it("compiles the current project into one typed preview/export graph", () => {
    const project = createDemoProject();
    const graph = buildEngineRenderGraph(project);
    expect(graph.schema).toBe("editkin.engine-graph/v1");
    expect(graph.workingFormat).toBe("rgba16_float");
    expect(graph.nodes.at(-1)).toMatchObject({ id: "output:main", kind: "output" });
    const { whiteBalanceRed: _red, whiteBalanceGreen: _green, whiteBalanceBlue: _blue, ...legacyGrade } = project.tracks[0].clips[0].color;
    expect(graph.nodes.find((node) => node.kind === "color")?.grade).toEqual(legacyGrade);
    expect(new Set(graph.nodes.map((node) => node.id)).size).toBe(graph.nodes.length);
    expect(graph.audio?.masterNode).toBe("audio:output");
  });

  it("preserves built-in transform motion blur as a typed engine node", () => {
    const project = createDemoProject();
    const clip = project.tracks[0].clips[0];
    clip.keyframes = [{ id: "move", time: 1, transform: { ...clip.transform, x: 120 }, color: { ...clip.color }, easing: "linear" }];
    clip.creative = { effectPresetIds: [], nativeEffectInstances: [createTransformMotionBlurInstance()] };
    const graph = buildEngineRenderGraph(project);
    expect(graph.nodes.find((node) => node.kind === "motion_blur")).toMatchObject({
      inputs: ["color:clip-demo"], shutterAngle: 180, samples: 8, sourceSampling: "decoded_temporal",
    });
  });

  it("does not invent audio nodes for still images or square upper-layer opacity", () => {
    const project = createDemoProject();
    project.assets[0].kind = "image";
    project.tracks[0].clips[0].transform.opacity = 0.5;
    const overlay = structuredClone(project.tracks[0].clips[0]);
    overlay.id = "overlay";
    overlay.transform.opacity = 0.4;
    project.tracks.push({ id: "overlay-track", name: "overlay", kind: "video", locked: false, muted: false, clips: [{ ...overlay, trackId: "overlay-track" }] });
    const graph = buildEngineRenderGraph(project);
    expect(graph.audio).toBeUndefined();
    expect(graph.nodes.find((node) => node.id === "transform:overlay")?.opacity).toBe(0.4);
    expect(graph.nodes.find((node) => node.kind === "composite")?.opacity).toBe(1);
  });

  it("transports the imported source alpha contract into the shared engine graph", () => {
    const project = createDemoProject();
    project.assets[0].kind = "image";
    project.assets[0].alphaMode = "premultiplied";
    const source = buildEngineRenderGraph(project).nodes.find((node) => node.kind === "source");
    expect(source).toMatchObject({ mediaKind: "image", alphaMode: "premultiplied" });
  });

  it("selects a true RGBA32F scene-linear graph for imported EXR media", () => {
    const project = createDemoProject();
    project.assets[0].kind = "image";
    project.assets[0].uri = "C:/plates/beauty.EXR";
    project.assets[0].color = { interpretation: "linear_rec709" };
    const graph = buildEngineRenderGraph(project);
    expect(graph.workingFormat).toBe("rgba32_float");
    expect(graph.nodes.find((node) => node.kind === "source")).toMatchObject({ inputColorSpace: "linear_rec709" });
    expect(graph.nodes.find((node) => node.kind === "color")).toMatchObject({ processor: "editkin-linear-primary/v1", workingSpace: "linear_rec709", outputSpace: "linear_rec709" });
    expect(graph.nodes.at(-1)).toMatchObject({ format: "rgba32_float" });
  });

  it("wraps encoded Rec.709 video in exactly one ACES2 display transform", () => {
    const project = createDemoProject();
    project.colorManagement = { ...project.colorManagement!, mode: "aces2", outputTransform: "rec709_sdr" };
    project.assets[0].color = { interpretation: "rec709" };
    const graph = buildEngineRenderGraph(project);
    expect(graph.workingFormat).toBe("rgba32_float");
    expect(graph.nodes.find((node) => node.id === "color:clip-demo")).toMatchObject({
      processor: "editkin-srgb-to-linear-rec709-primary/v1",
      inputSpace: "rec709", workingSpace: "linear_rec709", outputSpace: "linear_rec709",
    });
    expect(graph.nodes.filter((node) => node.processor === "editkin-ocio-aces2-linear-rec709-to-rec709-sdr/v1")).toEqual([
      expect.objectContaining({ id: "display:aces2", inputs: ["color:clip-demo"], inputSpace: "linear_rec709", workingSpace: "ACEScct", outputSpace: "rec709_sdr" }),
    ]);
    expect(graph.nodes.find((node) => node.id === graph.outputNode)).toMatchObject({ inputs: ["display:aces2"], format: "rgba32_float" });
  });

  it("preserves exact NTSC timebase instead of rounded JavaScript seconds", () => {
    const project = { ...createDemoProject(), fps: 30_000 / 1_001 };
    expect(buildEngineRenderGraph(project).timebase).toEqual({ numerator: 1_001, denominator: 30_000 });
  });

  it("fails closed instead of lowering motion-composition/v2 to the v1 native node", () => {
    const project = createDemoProject();
    const preset = findMotionGraphicPreset("v2-word-cascade");
    project.motionGraphics.push(createMotionGraphic("native-v2", "title", "NO DOWNGRADE", 0, 3, undefined, preset.seed));
    expect(commonVideoMotionGraphicsSupported(project)).toBe(false);
    expect(() => buildEngineRenderGraph(project)).toThrow(/禁止降級成 v1/);
  });

  it("projects a tracked tag into exact timeline-frame samples without inventing a lock through lost observations", () => {
    const project = createDemoProject();
    project.motionTracks.push({
      id: "subject", clipId: "clip-demo", name: "subject", engine: "fixture", analysisFps: 15,
      initialRect: { x: .1, y: .2, width: .2, height: .2 }, lostRatio: 1 / 3, createdAt: "2026-08-25T00:00:00Z",
      points: [
        { frame: 0, time: 0, rect: { x: .1, y: .2, width: .2, height: .2 }, confidence: 1, status: "manual", rotationDegrees: 0, scale: 1 },
        { frame: 15, time: 1, rect: { x: .3, y: .2, width: .2, height: .2 }, confidence: 0, status: "lost", rotationDegrees: 2, scale: 1.01 },
        { frame: 30, time: 2, rect: { x: .4, y: .2, width: .2, height: .2 }, confidence: .9, status: "tracked", rotationDegrees: 3, scale: 1.02 },
      ],
    });
    project.motionGraphics.push(createMotionGraphic("tracked-tag", "tag", "重點", 0, 3, "subject"));
    const tracking = buildEngineRenderGraph(project).nodes.find((node) => node.id === "motion-graphic:tracked-tag")?.tracking as { trackId: string; samples: Array<{ timelineFrame: number; x: number; status: string; rotationRadians: number; scale: number }> };
    expect(tracking.trackId).toBe("subject");
    expect(tracking.samples).toHaveLength(90);
    expect(tracking.samples[0]).toMatchObject({ timelineFrame: 0, status: "manual" });
    expect(tracking.samples[0].x).toBeCloseTo(.315);
    expect(tracking.samples[30]).toMatchObject({ timelineFrame: 30, status: "lost" });
    expect(tracking.samples[45]).toMatchObject({ timelineFrame: 45, status: "lost" });
    expect(tracking.samples[60]).toMatchObject({ timelineFrame: 60, status: "tracked" });
    expect(tracking.samples[60].x).toBeCloseTo(.615);
    expect(tracking.samples[60].rotationRadians).toBeCloseTo(3 * Math.PI / 180);
    expect(tracking.samples[60].scale).toBeCloseTo(1.02);
  });

  it("transports and interpolates a bounded surface quad without silently falling back to anchor tracking", () => {
    const project = createDemoProject();
    project.motionTracks.push({
      id: "surface", clipId: "clip-demo", name: "surface", engine: "fixture", analysisFps: 15,
      initialRect: { x: .2, y: .2, width: .4, height: .3 }, lostRatio: 0, createdAt: "2026-08-25T00:00:00Z",
      points: [
        { frame: 0, time: 0, rect: { x: .2, y: .2, width: .4, height: .3 }, confidence: 1, status: "manual", rotationDegrees: 0, scale: 1, quad: [{ x: .2, y: .2 }, { x: .6, y: .22 }, { x: .62, y: .5 }, { x: .18, y: .52 }] },
        { frame: 30, time: 2, rect: { x: .3, y: .24, width: .4, height: .3 }, confidence: .9, status: "tracked", rotationDegrees: 5, scale: 1.05, quad: [{ x: .32, y: .25 }, { x: .68, y: .29 }, { x: .72, y: .57 }, { x: .28, y: .54 }] },
      ],
    });
    const graphic = createMotionGraphic("surface-tag", "tag", "平面貼合", 0, 3, "surface");
    graphic.trackingMode = "surface";
    graphic.animation = "fade";
    project.motionGraphics.push(graphic);
    const node = buildEngineRenderGraph(project).nodes.find((candidate) => candidate.id === "motion-graphic:surface-tag");
    const samples = (node?.tracking as { samples: Array<{ destinationQuad?: Array<{ x: number; y: number }> }> }).samples;
    expect(node).toMatchObject({ trackingMode: "surface", animation: "fade" });
    expect(samples[0].destinationQuad).toEqual(project.motionTracks[0].points[0].quad);
    expect(samples[30].destinationQuad?.[0]).toMatchObject({ x: .26, y: .225 });
    const crossed = structuredClone(project);
    const quad = crossed.motionTracks[0].points[0].quad!;
    [quad[1], quad[2]] = [quad[2], quad[1]];
    expect(() => buildEngineRenderGraph(crossed)).toThrow(/平面四角/);
  });

  it("binds a frozen Auto Roto sequence into the formal matte stage", () => {
    const project = createDemoProject();
    const clip = project.tracks[0].clips[0];
    const mask = createClipMask("roto", "subject");
    mask.matteSequence = { schema: "editkin.auto-roto-matte/v1", engine: "editkin-native-color-temporal-roto/v1", width: 320, height: 180, analysisFps: 12, frameCount: 24, sequenceUri: "C:/matte.alpha8", manifestUri: "C:/matte.json", meanBoundaryChatter: .02, frozen: true, qualityState: "diagnostic" };
    clip.masks = [mask];
    expect(buildEngineRenderGraph(project).nodes).toContainEqual(expect.objectContaining({ kind: "mask", matteId: "C:/matte.json", matteMode: "alpha" }));
  });

  it("fails closed while a brush-corrected matte is waiting for re-analysis", () => {
    const project = createDemoProject();
    const clip = project.tracks[0].clips[0];
    const mask = createClipMask("roto-stale", "subject");
    mask.rotoCorrections = [{ id: "remove-1", frame: 3, mode: "background", radius: .04, points: [{ x: .7, y: .4 }] }];
    mask.matteSequence = { schema: "editkin.auto-roto-matte/v1", engine: "editkin-native-color-temporal-roto/v1", width: 320, height: 180, analysisFps: 12, frameCount: 24, sequenceUri: "C:/matte.alpha8", manifestUri: "C:/matte.json", meanBoundaryChatter: .02, stale: true, frozen: true, qualityState: "diagnostic" };
    clip.masks = [mask];
    expect(() => buildEngineRenderGraph(project)).toThrow(/roto-stale.*已過期/);
  });

  it("projects exact timing, parenting, track matte, adjustment, precomp, captions and motion graphics into one contract", () => {
    const project = createDemoProject();
    const base = project.tracks[0].clips[0];
    project.assets.push(
      { id: "overlay-asset", name: "overlay", kind: "image", uri: "C:/overlay.png", duration: 3, width: 1920, height: 1080 },
      { id: "adjustment-asset", name: "adjustment", kind: "image", uri: "C:/adjustment.png", duration: 3, width: 1920, height: 1080 },
      { id: "precomp-asset", name: "nested", kind: "video", uri: "editkin-composition://nested", duration: 3, width: 1920, height: 1080, compositionId: "nested" },
    );
    project.tracks.push(
      { id: "overlay-track", name: "overlay", kind: "video", locked: false, muted: false, clips: [{ ...structuredClone(base), id: "overlay", assetId: "overlay-asset", trackId: "overlay-track", timelineStart: 1, sourceStart: .5, duration: 3, layer: { enabled: true, role: "content", blendMode: "screen", parentClipId: base.id, trackMatte: { sourceClipId: base.id, mode: "luma" } } }] },
      { id: "adjustment-track", name: "grade", kind: "video", locked: false, muted: false, clips: [{ ...structuredClone(base), id: "grade", assetId: "adjustment-asset", trackId: "adjustment-track", timelineStart: 1, duration: 3, layer: { enabled: true, role: "adjustment", blendMode: "normal" }, creative: { effectPresetIds: ["glow"] } }] },
      { id: "precomp-track", name: "nested", kind: "video", locked: false, muted: false, clips: [{ ...structuredClone(base), id: "nested-clip", assetId: "precomp-asset", trackId: "precomp-track", timelineStart: 4, duration: 3 }] },
    );
    project.captions.push({ id: "cue-1", text: "同一張圖", start: 1.25, duration: 1.5, translation: { text: "One graph", language: "en" } });
    project.motionGraphics.push({ schema: "hao.motion-composition/v1", id: "title-1", name: "Title", kind: "title", text: "Editkin", timelineStart: 2, duration: 2, x: .5, y: .2, width: .7, fontSize: 72, textColor: "#FFFFFFFF", backgroundColor: "#000000AA", accentColor: "#A8FF3EFF", animation: "spring_soft", offsetX: 0, offsetY: 0 });

    const graph = buildEngineRenderGraph(project);
    expect(graph.nodes.find((node) => node.id === "source:overlay")?.timeline).toEqual({ timelineStartFrame: 30, sourceStartFrame: 15, durationFrames: 90 });
    expect(graph.nodes.find((node) => node.id === "transform:overlay")?.parent).toBe("transform:clip-demo");
    expect(graph.nodes).toContainEqual(expect.objectContaining({ kind: "composite", matteInput: expect.any(String), matteMode: "luma" }));
    expect(graph.nodes).toContainEqual(expect.objectContaining({ kind: "adjustment", affectedInputs: expect.any(Array) }));
    expect(graph.nodes).toContainEqual(expect.objectContaining({ kind: "precomposition", nestedGraphId: "composition:nested" }));
    expect(graph.nodes).toContainEqual(expect.objectContaining({ kind: "caption", cueId: "cue-1", translation: "One graph" }));
    expect(graph.nodes).toContainEqual(expect.objectContaining({ kind: "motion_graphic", graphicId: "title-1" }));
  });

  it("compiles a Null layer as a transform-only generator and excludes its media audio", () => {
    const project = createDemoProject();
    const controller = project.tracks[0].clips[0];
    controller.layer = { enabled: true, blendMode: "normal", role: "controller" };
    controller.transform = { x: 80, y: -35, scale: .8, rotation: 12, opacity: .9 };
    const child = structuredClone(controller);
    child.id = "child"; child.trackId = "child-track"; child.layer = { enabled: true, blendMode: "normal", role: "content", parentClipId: controller.id };
    project.tracks.push({ id: "child-track", name: "Child", kind: "video", locked: false, muted: false, clips: [child] });
    const graph = buildEngineRenderGraph(project);
    expect(graph.nodes.find((node) => node.id === "source:clip-demo")).toMatchObject({ assetId: "editkin.generator.null", mediaKind: "generator" });
    expect(graph.nodes.find((node) => node.id === "transform:clip-demo")).toMatchObject({ kind: "transform2d", inputs: ["source:clip-demo"] });
    expect(graph.nodes.some((node) => node.id === "color:clip-demo")).toBe(false);
    expect(graph.nodes.find((node) => node.id === "transform:child")?.parent).toBe("transform:clip-demo");
    expect(graph.audio?.nodes.some((node) => node.id.includes("clip-demo"))).toBe(false);
  });
});
