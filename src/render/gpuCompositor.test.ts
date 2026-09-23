import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { DEFAULT_PARTICLE_SIMULATION, DEFAULT_SCENE_25D, DEFAULT_TRANSFORM_3D, type NativeEffectInstance } from "../domain/types";
import { createTransformMotionBlurInstance } from "../domain/transformMotionBlur";
import { buildGpuEnginePreviewGraph, buildGpuEngineVideoPreviewGraph, buildGpuRenderGraph, buildGpuVideoPreviewSource, canPresentGpuVideoOnNativeSurface, estimateGpuEngineVideoResources, gpuLayerPropertyBuffer } from "./gpuCompositor";
describe("production GPU render graph adapter", () => {
  it("maps image clips, blend modes, and safe expressions into the native contract", () => {
    const project = createDemoProject();
    project.assets[0].kind = "image";
    project.tracks[0].clips[0].layer = { enabled: true, blendMode: "screen" };
    project.tracks[0].clips[0].expressions = { x: "hao.expression/v1:value + time * 10" };
    const graph = buildGpuRenderGraph(project, 2)!;
    expect(graph.schema).toBe("hao.gpu-render-graph/v1");
    expect(graph.layers).toHaveLength(2);
    expect(graph.layers[1]).toMatchObject({ blendMode: "screen", transform: { x: 20 } });
    expect(gpuLayerPropertyBuffer(graph)[1]).toMatchObject({ blendMode: 2, enabled: 1 });
  });
  it("fails closed to the existing preview path when a video decoder is required", () => {
    expect(buildGpuRenderGraph(createDemoProject(), 1)).toBeUndefined();
  });
  it("routes a valid 2.5D image scene through resident EngineGraph with an exact receipt expectation", () => {
    const project = createDemoProject();
    project.assets[0].kind = "image";
    project.assets[0].uri = "C:/fixtures/back.png";
    project.scene25d = structuredClone(DEFAULT_SCENE_25D);
    const back = project.tracks[0].clips[0];
    back.transform3d = structuredClone(DEFAULT_TRANSFORM_3D);
    const front = structuredClone(back);
    front.id = "scene-front";
    front.trackId = "scene-front-track";
    front.transform3d = { position: [.2, -.1, .7], rotationDegrees: [-6, 20, 3], scale: [.55, .55, 1] };
    front.layer = { enabled: true, role: "content", blendMode: "normal", parentClipId: back.id };
    project.tracks.push({ id: front.trackId, name: "前景", kind: "video", locked: false, muted: false, clips: [front] });
    const preview = buildGpuEnginePreviewGraph(project, 1)!;
    expect(preview.scene25dExpectation).toEqual({ planeCount: 2, parentedPlaneCount: 1, cameraNodeId: "scene25d:camera" });
    expect(preview.graph.nodes.filter((node) => node.kind === "transform3d")).toHaveLength(2);
    expect(preview.graph.nodes.find((node) => node.id === "transform:scene-front")).toMatchObject({ parent: "transform:clip-demo" });
    expect(preview.assetBindings).toEqual({ "asset-demo": "C:/fixtures/back.png" });
  });
  it("fails resident 2.5D admission closed for disabled planes and incomplete transforms", () => {
    const project = createDemoProject();
    project.assets[0].kind = "image";
    project.assets[0].uri = "C:/fixtures/back.png";
    project.scene25d = structuredClone(DEFAULT_SCENE_25D);
    project.tracks[0].clips[0].transform3d = structuredClone(DEFAULT_TRANSFORM_3D);
    project.tracks[0].clips[0].layer = { enabled: false, role: "content", blendMode: "normal" };
    expect(buildGpuEnginePreviewGraph(project, 1)).toBeUndefined();
    project.tracks[0].clips[0].layer.enabled = true;
    project.tracks[0].clips[0].transform3d = undefined;
    expect(buildGpuEnginePreviewGraph(project, 1)).toBeUndefined();
  });
  it("routes validated 2.5D video planes to the resident hardware decoder with an exact scene receipt expectation", () => {
    const project = createDemoProject();
    project.width = 960; project.height = 540;
    project.assets[0].uri = "C:/fixtures/back.mp4";
    project.assets[0].width = 960; project.assets[0].height = 540;
    project.scene25d = structuredClone(DEFAULT_SCENE_25D);
    const back = project.tracks[0].clips[0];
    back.transform3d = structuredClone(DEFAULT_TRANSFORM_3D);
    const front = structuredClone(back);
    front.id = "video-plane-front"; front.trackId = "video-plane-front-track";
    front.transform3d = { position: [.2, -.1, .7], rotationDegrees: [-6, 20, 3], scale: [.55, .55, 1] };
    front.layer = { enabled: true, role: "content", blendMode: "normal", parentClipId: back.id };
    project.tracks.push({ id: front.trackId, name: "影片前景", kind: "video", locked: false, muted: false, clips: [front] });
    const preview = buildGpuEngineVideoPreviewGraph(project, 1)!;
    expect(preview.scene25dExpectation).toEqual({ planeCount: 2, videoPlaneCount: 2, parentedPlaneCount: 1, cameraNodeId: "scene25d:camera" });
    expect(preview.graph.nodes.filter((node) => node.kind === "transform3d")).toHaveLength(2);
    expect(preview.assetBindings).toEqual({ "asset-demo": "C:/fixtures/back.mp4" });
  });
  it("routes a bounded particle layer through resident EngineGraph with an exact receipt expectation", () => {
    const project = createDemoProject();
    project.assets[0].kind = "image";
    project.assets[0].uri = "C:/fixtures/background.png";
    project.particleSimulation = structuredClone(DEFAULT_PARTICLE_SIMULATION);
    const preview = buildGpuEnginePreviewGraph(project, 0.6)!;
    expect(preview.vfxSimulationExpectation).toEqual({ emitterCount: 1, particleCeiling: 64, executor: "wgpu-bounded-particle-compute/v1" });
    expect(preview.graph.nodes.find((node) => node.kind === "particle_emitter")).toMatchObject({
      id: "vfx:particles", maxParticles: 64, initialVelocity: [18, -76, 0],
    });
    expect(preview.graph.nodes.find((node) => node.inputs.includes("vfx:particles"))).toMatchObject({ kind: "composite" });
  });
  it("routes an unmodified, resolution-matched video clip to the resident decoder with exact source time", () => {
    const project = createDemoProject();
    project.width = 960;
    project.height = 540;
    project.assets[0].uri = "C:/fixtures/demo-source.mp4";
    project.tracks[0].clips[0].sourceStart = 2;
    expect(buildGpuVideoPreviewSource(project, 3)).toEqual({
      structureKey: "clip-demo:C:/fixtures/demo-source.mp4",
      inputPath: "C:/fixtures/demo-source.mp4",
      sourceTime: 5,
    });
  });
  it("routes a safe video through the common typed graph with timeline/source mapping intact", () => {
    const project = createDemoProject();
    project.width = 960;
    project.height = 540;
    project.assets[0].width = 960;
    project.assets[0].height = 540;
    project.assets[0].uri = "C:/fixtures/demo-source.mp4";
    project.tracks[0].clips[0].timelineStart = 1;
    project.tracks[0].clips[0].sourceStart = .5;
    const preview = buildGpuEngineVideoPreviewGraph(project, 2)!;
    expect(preview.graph.schema).toBe("editkin.engine-graph/v1");
    expect(preview.graph.audio).toBeUndefined();
    expect(preview.graph.nodes.find((node) => node.kind === "source")).toMatchObject({
      mediaKind: "video",
      timeline: { timelineStartFrame: 30, sourceStartFrame: 15 },
    });
    expect(preview.assetBindings).toEqual({ [project.assets[0].id]: "C:/fixtures/demo-source.mp4" });
    expect(preview.timelineFrame).toBe(60);
  });
  it("admits bounded decoded-temporal motion blur with static or animated transforms", () => {
    const project = createDemoProject();
    project.width = 960; project.height = 540;
    project.assets[0].width = 960; project.assets[0].height = 540;
    project.assets[0].uri = "C:/fixtures/moving-source.mp4";
    const clip = project.tracks[0].clips[0];
    clip.keyframes = [{ id: "move", time: 1, transform: { ...clip.transform, x: 180, rotation: 8 }, color: { ...clip.color }, easing: "linear" }];
    clip.creative = { effectPresetIds: [], nativeEffectInstances: [createTransformMotionBlurInstance()] };
    const preview = buildGpuEngineVideoPreviewGraph(project, .5)!;
    expect(preview.graph.nodes).toContainEqual(expect.objectContaining({
      id: "motion-blur:clip-demo:builtin-transform-motion-blur", kind: "motion_blur", shutterAngle: 180, samples: 8, sourceSampling: "decoded_temporal",
    }));
    clip.keyframes = [];
    expect(buildGpuEngineVideoPreviewGraph(project, .5)).toBeDefined();
    clip.keyframes = [{ id: "move", time: 1, transform: { ...clip.transform, x: 180, rotation: 8 }, color: { ...clip.color }, easing: "linear" }];
    clip.creative.nativeEffectInstances![0].parameters.samples = 9;
    expect(buildGpuEngineVideoPreviewGraph(project, .5)).toBeUndefined();
    clip.creative.nativeEffectInstances![0].parameters.samples = 8;
    clip.keyframes[0].transform.opacity = .5;
    expect(buildGpuEngineVideoPreviewGraph(project, .5)).toBeUndefined();
    clip.keyframes[0].transform.opacity = 1;
    clip.creative.nativeEffectInstances!.push({ id: "outer", pluginId: "creator.gpu-effect", capabilityId: "gain", pluginVersion: "1.0.0", manifestSha256: "a".repeat(64), runtimeType: "gpu_effect_graph", enabled: true, parameters: { gain: 1 } });
    expect(buildGpuEngineVideoPreviewGraph(project, .5)).toBeUndefined();
  });
  it("admits decoded-temporal blur only as the base of up to two independent video overlays", () => {
    const project = createDemoProject();
    project.width = 960; project.height = 540;
    project.assets[0].width = 960; project.assets[0].height = 540;
    project.assets[0].uri = "C:/fixtures/moving-source.mp4";
    project.captions = [];
    const base = project.tracks[0].clips[0];
    base.creative = { effectPresetIds: [], nativeEffectInstances: [createTransformMotionBlurInstance()] };
    const overlayAsset = { ...structuredClone(project.assets[0]), id: "asset-overlay", uri: "C:/fixtures/overlay.mp4" };
    project.assets.push(overlayAsset);
    const overlay: typeof base = {
      ...structuredClone(base), id: "clip-overlay", trackId: "track-overlay", assetId: overlayAsset.id,
      transform: { ...base.transform, x: 285, y: 145, scale: .32 },
      creative: { effectPresetIds: [], nativeEffectInstances: [] },
    };
    project.tracks.push({ id: "track-overlay", name: "Overlay", kind: "video", locked: false, muted: false, clips: [overlay] });
    const preview = buildGpuEngineVideoPreviewGraph(project, .5);
    expect(preview).toBeDefined();
    expect(preview?.graph.nodes.filter((node) => node.kind === "source")).toHaveLength(2);
    expect(preview?.graph.nodes.filter((node) => node.kind === "motion_blur" && node.sourceSampling === "decoded_temporal")).toHaveLength(1);
    const overlayTwoAsset = { ...structuredClone(project.assets[0]), id: "asset-overlay-two", uri: "C:/fixtures/overlay-two.mp4" };
    project.assets.push(overlayTwoAsset);
    const overlayTwo = { ...structuredClone(overlay), id: "clip-overlay-two", trackId: "track-overlay-two", assetId: overlayTwoAsset.id };
    project.tracks.push({ id: "track-overlay-two", name: "Overlay 2", kind: "video", locked: false, muted: false, clips: [overlayTwo] });
    expect(buildGpuEngineVideoPreviewGraph(project, .5)?.graph.nodes.filter((node) => node.kind === "source")).toHaveLength(3);
    const overlayThreeAsset = { ...structuredClone(project.assets[0]), id: "asset-overlay-three", uri: "C:/fixtures/overlay-three.mp4" };
    project.assets.push(overlayThreeAsset);
    const overlayThree = { ...structuredClone(overlay), id: "clip-overlay-three", trackId: "track-overlay-three", assetId: overlayThreeAsset.id };
    project.tracks.push({ id: "track-overlay-three", name: "Overlay 3", kind: "video", locked: false, muted: false, clips: [overlayThree] });
    expect(buildGpuEngineVideoPreviewGraph(project, .5)).toBeUndefined();
    project.tracks.pop();
    project.tracks.reverse();
    expect(buildGpuEngineVideoPreviewGraph(project, .5)).toBeUndefined();
    project.tracks.reverse();
    overlay.creative = { effectPresetIds: [], nativeEffectInstances: [createTransformMotionBlurInstance()] };
    expect(buildGpuEngineVideoPreviewGraph(project, .5)).toBeUndefined();
  });
  it("admits one fully covered trailing adjustment over decoded-temporal video and rejects wider stacks", () => {
    const project = createDemoProject();
    project.width = 960; project.height = 540;
    project.assets[0].width = 960; project.assets[0].height = 540;
    project.assets[0].uri = "C:/fixtures/moving-source.mp4";
    project.captions = [];
    const base = project.tracks[0].clips[0];
    base.creative = { effectPresetIds: [], nativeEffectInstances: [createTransformMotionBlurInstance()] };
    const adjustment = structuredClone(base);
    adjustment.id = "temporal-adjustment";
    adjustment.trackId = "track-adjustment";
    adjustment.layer = { enabled: true, blendMode: "normal", role: "adjustment" };
    adjustment.timelineStart = .25; adjustment.duration = 1.5;
    adjustment.color = { ...adjustment.color, contrast: 1.18, saturation: .78, exposure: .25 };
    adjustment.creative = { effectPresetIds: [], nativeEffectInstances: [] };
    project.tracks.push({ id: "track-adjustment", name: "Adjustment", kind: "video", locked: false, muted: false, clips: [adjustment] });
    const preview = buildGpuEngineVideoPreviewGraph(project, .75);
    expect(preview).toBeDefined();
    expect(preview?.graph.nodes.find((node) => node.kind === "motion_blur")).toMatchObject({ sourceSampling: "decoded_temporal", samples: 8 });
    expect(preview?.graph.nodes.find((node) => node.kind === "adjustment")).toMatchObject({ id: "adjustment:temporal-adjustment" });
    expect(preview?.graph.nodes.find((node) => node.id === preview.graph.outputNode)?.inputs).toEqual(["color:temporal-adjustment"]);
    const second = structuredClone(adjustment); second.id = "temporal-adjustment-two"; second.trackId = "track-adjustment-two";
    project.tracks.push({ id: second.trackId, name: "Adjustment 2", kind: "video", locked: false, muted: false, clips: [second] });
    expect(buildGpuEngineVideoPreviewGraph(project, .75)).toBeUndefined();
    project.tracks.pop();
    adjustment.timelineStart = base.timelineStart + base.duration - .5; adjustment.duration = 1;
    expect(buildGpuEngineVideoPreviewGraph(project, .75)).toBeUndefined();
  });
  it("admits exactly two pre-typography adjustments over one decoded-temporal video and rejects a third or an overlay mixture", () => {
    const project = createDemoProject();
    project.width = 960; project.height = 540; project.motionGraphics = [];
    project.assets[0].width = 960; project.assets[0].height = 540;
    project.assets[0].uri = "C:/fixtures/moving-source.mp4";
    project.captions = [{ id: "single-colour", text: "保持單色", start: .25, duration: 1.25 }];
    const base = project.tracks[0].clips[0];
    base.creative = { effectPresetIds: [], nativeEffectInstances: [createTransformMotionBlurInstance()] };
    const first = structuredClone(base);
    first.id = "temporal-adjustment-one"; first.trackId = "track-adjustment-one";
    first.layer = { enabled: true, blendMode: "normal", role: "adjustment" };
    first.timelineStart = .25; first.duration = 1.5; first.keyframes = [];
    first.color = { ...first.color, contrast: 1.18, saturation: .78, exposure: .25 };
    first.creative = { effectPresetIds: [], nativeEffectInstances: [] };
    const second = structuredClone(first);
    second.id = "temporal-adjustment-two"; second.trackId = "track-adjustment-two";
    second.timelineStart = .5; second.duration = 1;
    second.color = { ...second.color, contrast: 1.04, saturation: 1.12, exposure: -.12 };
    project.tracks.push(
      { id: first.trackId, name: "Adjustment 1", kind: "video", locked: false, muted: false, clips: [first] },
      { id: second.trackId, name: "Adjustment 2", kind: "video", locked: false, muted: false, clips: [second] },
    );

    const preview = buildGpuEngineVideoPreviewGraph(project, .75);
    expect(preview).toBeDefined();
    expect(preview?.graph.nodes.filter((node) => node.kind === "adjustment").map((node) => node.id))
      .toEqual(["adjustment:temporal-adjustment-one", "adjustment:temporal-adjustment-two"]);

    const third = structuredClone(second); third.id = "temporal-adjustment-three"; third.trackId = "track-adjustment-three";
    project.tracks.push({ id: third.trackId, name: "Adjustment 3", kind: "video", locked: false, muted: false, clips: [third] });
    expect(buildGpuEngineVideoPreviewGraph(project, .75)).toBeUndefined();
    project.tracks.pop();

    const overlayAsset = { ...structuredClone(project.assets[0]), id: "asset-overlay", uri: "C:/fixtures/overlay.mp4" };
    const overlay = structuredClone(base); overlay.id = "clip-overlay"; overlay.trackId = "track-overlay"; overlay.assetId = overlayAsset.id;
    overlay.creative = { effectPresetIds: [], nativeEffectInstances: [] }; overlay.keyframes = [];
    project.assets.push(overlayAsset);
    project.tracks.splice(1, 0, { id: overlay.trackId, name: "Overlay", kind: "video", locked: false, muted: false, clips: [overlay] });
    expect(buildGpuEngineVideoPreviewGraph(project, .75)).toBeUndefined();
  });

  it("admits one to four resource-governed emitters with optional safe overlay stages and rejects wider mixtures", () => {
    const project = createDemoProject();
    project.width = 960; project.height = 540; project.motionGraphics = [];
    project.assets[0].width = 960; project.assets[0].height = 540;
    project.assets[0].uri = "C:/fixtures/moving-source.mp4";
    project.captions = [{ id: "single-colour", text: "保持單色", start: .25, duration: 1.25 }];
    const base = project.tracks[0].clips[0];
    base.creative = { effectPresetIds: [], nativeEffectInstances: [createTransformMotionBlurInstance()] };
    const adjustment = structuredClone(base);
    adjustment.id = "temporal-adjustment"; adjustment.trackId = "track-adjustment";
    adjustment.layer = { enabled: true, blendMode: "normal", role: "adjustment" };
    adjustment.timelineStart = .25; adjustment.duration = 1.5; adjustment.keyframes = [];
    adjustment.color = { ...adjustment.color, contrast: 1.18, saturation: .78, exposure: .25 };
    adjustment.creative = { effectPresetIds: [], nativeEffectInstances: [] };
    project.tracks.push({ id: adjustment.trackId, name: "Adjustment", kind: "video", locked: false, muted: false, clips: [adjustment] });
    project.particleSimulation = {
      ...structuredClone(DEFAULT_PARTICLE_SIMULATION), maxParticles: 48,
      timeline: { start: .5, duration: 1 },
    };

    const preview = buildGpuEngineVideoPreviewGraph(project, .75);
    expect(preview).toBeDefined();
    expect(preview?.graph.nodes.filter((node) => node.kind === "particle_emitter")).toEqual([
      expect.objectContaining({ id: "vfx:particles", timeline: { timelineStartFrame: 15, sourceStartFrame: 0, durationFrames: 30 } }),
    ]);
    expect(preview?.vfxSimulationExpectation).toEqual({
      emitterCount: 1, particleCeiling: 48, executor: "wgpu-resident-video-particle-overlay/v1",
    });

    project.particleSimulation.additionalEmitters = [{
      id: "second", seed: 90210, ratePerSecond: 24, lifetimeSeconds: 1, maxParticles: 24,
      emitterPosition: [.5, .5], initialVelocity: [0, -20], gravity: [0, 20], radiusPixels: 4,
      color: [1, 1, 1, 1], timeline: { start: .5, duration: 1 },
    }];
    expect(buildGpuEngineVideoPreviewGraph(project, .75)?.vfxSimulationExpectation?.emitterCount).toBe(2);
    project.particleSimulation.additionalEmitters = [];

    project.particleSimulation.timeline = { start: base.timelineStart + base.duration - .25, duration: .5 };
    expect(buildGpuEngineVideoPreviewGraph(project, .75)).toBeUndefined();
    project.particleSimulation.timeline = { start: .5, duration: 1 };

    const overlayAsset = { ...structuredClone(project.assets[0]), id: "particle-overlay-asset", uri: "C:/fixtures/particle-overlay.mp4" };
    const overlay = structuredClone(base);
    overlay.id = "particle-overlay"; overlay.trackId = "particle-overlay-track"; overlay.assetId = overlayAsset.id;
    overlay.creative = { effectPresetIds: [], nativeEffectInstances: [] }; overlay.keyframes = [];
    overlay.transform = { x: 220, y: 120, scale: .35, rotation: 0, opacity: 1 };
    project.assets.push(overlayAsset);
    project.tracks.splice(project.tracks.length - 1, 0, { id: overlay.trackId, name: "Particle Overlay", kind: "video", locked: false, muted: false, clips: [overlay] });
    expect(buildGpuEngineVideoPreviewGraph(project, .75)?.graph.nodes.filter((node) => node.kind === "source")).toHaveLength(2);

    const secondEmitter = {
      id: "cool-trail", seed: 90210, ratePerSecond: 24, lifetimeSeconds: 1, maxParticles: 24,
      emitterPosition: [.35, .6] as [number, number], initialVelocity: [-20, -35] as [number, number], gravity: [0, 28] as [number, number], radiusPixels: 3,
      color: [.1, .7, 1, .9] as [number, number, number, number], timeline: { start: .6, duration: .8 },
    };
    const thirdEmitter = { ...structuredClone(secondEmitter), id: "warm-spark", seed: 90211 };
    const fourthEmitter = { ...structuredClone(secondEmitter), id: "violet-pop", seed: 90212 };
    const fifthEmitter = { ...structuredClone(secondEmitter), id: "overflow", seed: 90213 };
    for (const emitterCount of [1, 2, 3, 4] as const) {
      project.particleSimulation.additionalEmitters = [secondEmitter, thirdEmitter, fourthEmitter].slice(0, emitterCount - 1);
      expect(buildGpuEngineVideoPreviewGraph(project, .75)?.vfxSimulationExpectation, `${emitterCount} emitters`).toEqual({
        emitterCount, particleCeiling: 48 + (emitterCount - 1) * 24, executor: "wgpu-resident-video-particle-overlay/v1",
      });
    }
    project.particleSimulation.additionalEmitters = [secondEmitter, thirdEmitter, fourthEmitter, fifthEmitter];
    expect(buildGpuEngineVideoPreviewGraph(project, .75)).toBeUndefined();
    project.particleSimulation.additionalEmitters = [];

    const secondAdjustment = structuredClone(adjustment);
    secondAdjustment.id = "temporal-adjustment-two"; secondAdjustment.trackId = "track-adjustment-two";
    project.tracks.push({ id: secondAdjustment.trackId, name: "Adjustment 2", kind: "video", locked: false, muted: false, clips: [secondAdjustment] });
    expect(buildGpuEngineVideoPreviewGraph(project, .75)?.graph.nodes.filter((node) => node.kind === "adjustment")).toHaveLength(2);
    project.particleSimulation.additionalEmitters = [secondEmitter];
    expect(buildGpuEngineVideoPreviewGraph(project, .75)?.graph.nodes.filter((node) => node.kind === "particle_emitter")).toHaveLength(2);

    for (const animation of ["static", "animated"] as const) {
      for (const overlap of ["exact", "partial"] as const) {
        for (const adjustmentCount of [1, 2] as const) {
          for (const emitterCount of [1, 2, 3, 4] as const) {
            project.tracks = project.tracks.filter((track) => track.id !== secondAdjustment.trackId);
            if (adjustmentCount === 2) project.tracks.push({
              id: secondAdjustment.trackId, name: "Adjustment 2", kind: "video", locked: false, muted: false, clips: [secondAdjustment],
            });
            overlay.timelineStart = overlap === "exact" ? base.timelineStart : .5;
            overlay.duration = overlap === "exact" ? base.duration : .75;
            overlay.keyframes = animation === "static" ? [] : [{
              id: "bounded-overlay-animation", time: .5,
              transform: { ...overlay.transform, x: 260 }, color: { ...overlay.color }, easing: "linear",
            }];
            project.particleSimulation.additionalEmitters = [secondEmitter, thirdEmitter, fourthEmitter].slice(0, emitterCount - 1);
            const matrixPreview = buildGpuEngineVideoPreviewGraph(project, .75);
            expect(matrixPreview, `${animation}/${overlap}/${adjustmentCount}/${emitterCount}`).toBeDefined();
            expect(matrixPreview?.graph.nodes.filter((node) => node.kind === "source")).toHaveLength(2);
            expect(matrixPreview?.graph.nodes.filter((node) => node.kind === "particle_emitter")).toHaveLength(emitterCount);
            expect(matrixPreview?.graph.nodes.filter((node) => node.kind === "adjustment")).toHaveLength(adjustmentCount);
          }
        }
      }
    }
    project.particleSimulation.additionalEmitters = [secondEmitter];

    project.tracks = project.tracks.filter((track) => track.id !== secondAdjustment.trackId);
    project.tracks.push({ id: secondAdjustment.trackId, name: "Adjustment 2", kind: "video", locked: false, muted: false, clips: [secondAdjustment] });
    overlay.timelineStart = base.timelineStart; overlay.duration = base.duration;

    overlay.keyframes = [{ id: "unsafe-overlay-animation", time: .5, transform: { ...overlay.transform, x: 260 }, color: { ...overlay.color }, easing: "linear" }];
    expect(buildGpuEngineVideoPreviewGraph(project, .75)?.graph.nodes.find((node) => node.id === "transform:particle-overlay")).toEqual(
      expect.objectContaining({ kind: "transform2d", keyframes: [expect.objectContaining({ frame: 15, x: 260 })] }),
    );
    overlay.keyframes.push({ id: "second-overlay-animation", time: 1, transform: { ...overlay.transform, x: -260 }, color: { ...overlay.color }, easing: "ease_in_out" });
    expect(buildGpuEngineVideoPreviewGraph(project, .75)?.graph.nodes.find((node) => node.id === "transform:particle-overlay")).toEqual(
      expect.objectContaining({ kind: "transform2d", keyframes: [expect.objectContaining({ frame: 15, x: 260 }), expect.objectContaining({ frame: 30, x: -260 })] }),
    );
    project.particleSimulation.additionalEmitters = [secondEmitter];
    expect(buildGpuEngineVideoPreviewGraph(project, .75)?.vfxSimulationExpectation).toEqual({
      emitterCount: 2, particleCeiling: 72, executor: "wgpu-resident-video-particle-overlay/v1",
    });
    project.particleSimulation.additionalEmitters = [];
    overlay.keyframes.push({ id: "third-overlay-animation", time: 1.5, transform: { ...overlay.transform, x: 80 }, color: { ...overlay.color }, easing: "ease_out" });
    expect(buildGpuEngineVideoPreviewGraph(project, .75)).toBeUndefined();
    overlay.keyframes.splice(2, 1);
    overlay.timelineStart = .5;
    expect(buildGpuEngineVideoPreviewGraph(project, .75)).toBeDefined();
    overlay.timelineStart = base.timelineStart;

    overlay.timelineStart = base.timelineStart + base.duration + .25; overlay.duration = 1;
    expect(buildGpuEngineVideoPreviewGraph(project, .75)).toBeUndefined();
    overlay.timelineStart = base.timelineStart; overlay.duration = base.duration;

    const thirdAdjustment = structuredClone(adjustment);
    thirdAdjustment.id = "temporal-adjustment-three"; thirdAdjustment.trackId = "track-adjustment-three";
    project.tracks.push({ id: thirdAdjustment.trackId, name: "Adjustment 3", kind: "video", locked: false, muted: false, clips: [thirdAdjustment] });
    expect(buildGpuEngineVideoPreviewGraph(project, .75)).toBeUndefined();
    project.tracks = project.tracks.filter((track) => track.id !== thirdAdjustment.trackId);
    overlay.keyframes = [];

    project.tracks = project.tracks.filter((track) => track.id !== overlay.trackId);
    project.assets = project.assets.filter((asset) => asset.id !== overlayAsset.id);
    expect(buildGpuEngineVideoPreviewGraph(project, .75)?.graph.nodes.filter((node) => node.kind === "adjustment")).toHaveLength(2);
  });

  it("admits one exclusive decoded-temporal track matte on either packed-video side and rejects wider mixtures", () => {
    const project = createDemoProject();
    project.width = 960; project.height = 540; project.captions = []; project.motionGraphics = [];
    project.assets[0].width = 960; project.assets[0].height = 540; project.assets[0].uri = "C:/fixtures/matte.mp4";
    const matte = project.tracks[0].clips[0];
    matte.creative = { effectPresetIds: [], nativeEffectInstances: [createTransformMotionBlurInstance()] };
    const targetAsset = { ...structuredClone(project.assets[0]), id: "asset-temporal-matte-target", uri: "C:/fixtures/target.mp4" };
    const target = structuredClone(matte);
    target.id = "clip-temporal-matte-target"; target.assetId = targetAsset.id; target.trackId = "track-temporal-matte-target";
    target.timelineStart = .25; target.duration = 1.5;
    target.layer = { enabled: true, blendMode: "normal", role: "content", trackMatte: { sourceClipId: matte.id, mode: "luma" } };
    target.creative = { effectPresetIds: [], nativeEffectInstances: [] };
    project.assets.push(targetAsset);
    project.tracks.push({ id: target.trackId, name: "Matte target", kind: "video", locked: false, muted: false, clips: [target] });

    const preview = buildGpuEngineVideoPreviewGraph(project, .75);
    expect(preview).toBeDefined();
    expect(preview?.graph.nodes.find((node) => node.kind === "composite")).toMatchObject({
      matteInput: expect.stringMatching(/^motion-blur:clip-demo:/), matteMode: "luma",
    });
    expect(preview?.graph.nodes.find((node) => node.kind === "motion_blur")).toMatchObject({ sourceSampling: "decoded_temporal", samples: 8 });
    expect(preview?.graph.nodes.filter((node) => node.kind === "source")).toHaveLength(2);

    const adjustment = structuredClone(target); adjustment.id = "temporal-matte-adjustment"; adjustment.trackId = "temporal-matte-adjustment-track"; adjustment.layer = { enabled: true, blendMode: "normal", role: "adjustment" };
    project.tracks.push({ id: adjustment.trackId, name: "Adjustment", kind: "video", locked: false, muted: false, clips: [adjustment] });
    expect(buildGpuEngineVideoPreviewGraph(project, .75)).toBeUndefined();
    project.tracks.pop();
    target.creative = { effectPresetIds: [], nativeEffectInstances: [createTransformMotionBlurInstance()] }; matte.creative = { effectPresetIds: [], nativeEffectInstances: [] };
    expect(buildGpuEngineVideoPreviewGraph(project, .75)?.graph.nodes.find((node) => node.kind === "motion_blur")).toMatchObject({ sourceSampling: "decoded_temporal" });
    target.creative = { effectPresetIds: [], nativeEffectInstances: [] }; matte.creative = { effectPresetIds: [], nativeEffectInstances: [createTransformMotionBlurInstance()] };
    project.captions.push({ id: "not-yet-mixed", text: "MATTE", start: .5, duration: .5 });
    expect(buildGpuEngineVideoPreviewGraph(project, .75)).toBeUndefined();
    project.captions = [];
    matte.duration = target.duration / 2;
    expect(buildGpuEngineVideoPreviewGraph(project, .75)).toBeUndefined();
  });

  it("admits single-colour caption and bounded dynamic typography over decoded-temporal video", () => {
    const project = createDemoProject();
    project.width = 960; project.height = 540;
    project.assets[0].width = 960; project.assets[0].height = 540;
    project.assets[0].uri = "C:/fixtures/moving-source.mp4";
    const base = project.tracks[0].clips[0];
    base.creative = { effectPresetIds: [], nativeEffectInstances: [createTransformMotionBlurInstance()] };
    project.captions.push({ id: "caption", text: "字幕保持單色", start: .25, duration: 1.25 });
    project.motionGraphics.push({
      schema: "hao.motion-composition/v1", id: "title-card", name: "Title", kind: "card", text: "關鍵重點",
      timelineStart: .4, duration: 1.2, x: .08, y: .09, width: .48, fontSize: 54,
      fontFamily: "Noto Sans TC", fontWeight: 800, letterSpacing: 0, outlineWidth: 3, shadowDepth: 3, cornerRadius: 18,
      textColor: "#FFFFFFFF", backgroundColor: "#10151FEE", accentColor: "#A8FF3EFF", animation: "slide_up", offsetX: 0, offsetY: 0,
    });
    const preview = buildGpuEngineVideoPreviewGraph(project, .8);
    expect(preview).toBeDefined();
    expect(preview?.graph.nodes.filter((node) => node.kind === "caption")).toHaveLength(1);
    expect(preview?.graph.nodes.filter((node) => node.kind === "motion_graphic")).toHaveLength(1);
    expect(preview?.graph.nodes.find((node) => node.kind === "caption")).toMatchObject({ textColor: "#FFFFFF", translation: undefined });
    expect(preview?.graph.nodes.find((node) => node.kind === "motion_blur")).toMatchObject({ sourceSampling: "decoded_temporal", samples: 8 });
    expect(preview?.graph.nodes.find((node) => node.id === preview.graph.outputNode)?.inputs).toEqual(["composite:2"]);

    project.captions[0].translation = { text: "Unsupported second colour", language: "en" };
    expect(buildGpuEngineVideoPreviewGraph(project, .8)).toBeUndefined();
  });

  it("routes a bounded particle simulation over resident video on the native GPU graph", () => {
    const project = createDemoProject();
    project.width = 960;
    project.height = 540;
    project.assets[0].width = 960;
    project.assets[0].height = 540;
    project.assets[0].uri = "C:/fixtures/demo-source.mp4";
    project.particleSimulation = structuredClone(DEFAULT_PARTICLE_SIMULATION);
    const preview = buildGpuEngineVideoPreviewGraph(project, .6)!;
    expect(preview.vfxSimulationExpectation).toEqual({
      emitterCount: 1,
      particleCeiling: 64,
      executor: "wgpu-resident-video-particle-overlay/v1",
    });
    expect(preview.graph.nodes.find((node) => node.kind === "particle_emitter")).toMatchObject({
      id: "vfx:particles",
      maxParticles: 64,
    });
    expect(preview.graph.nodes.find((node) => node.inputs.includes("vfx:particles"))).toMatchObject({ kind: "composite" });
  });

  it("uses an aspect-safe prepared proxy for native multi-layer decode while preserving project coordinates", () => {
    const project = createDemoProject();
    project.width = 1920; project.height = 1080;
    project.assets[0].width = 1920; project.assets[0].height = 1080;
    project.assets[0].uri = "C:/fixtures/source-1080.mp4";
    project.assets[0].derivatives = {
      sourceSha256: "a".repeat(64), generatedAt: "2026-08-25T00:00:00.000Z",
      proxyUri: "C:/cache/proxy-540.mp4", proxyWidth: 960, proxyHeight: 540,
    };
    const preview = buildGpuEngineVideoPreviewGraph(project, 1)!;
    expect(preview.assetBindings).toEqual({ "asset-demo": "C:/cache/proxy-540.mp4" });
    expect(preview.decoderDimensions).toEqual({ "asset-demo": { width: 960, height: 540, source: "proxy" } });

    project.assets[0].derivatives.proxyWidth = 960; project.assets[0].derivatives.proxyHeight = 500;
    const fallback = buildGpuEngineVideoPreviewGraph(project, 1)!;
    expect(fallback.assetBindings).toEqual({ "asset-demo": "C:/fixtures/source-1080.mp4" });
    expect(fallback.decoderDimensions["asset-demo"].source).toBe("original");
  });

});
