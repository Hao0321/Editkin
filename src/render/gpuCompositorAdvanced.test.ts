import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { DEFAULT_COLOR, DEFAULT_PARTICLE_SIMULATION, DEFAULT_SCENE_25D, DEFAULT_TRANSFORM_3D, type NativeEffectInstance } from "../domain/types";
import { createTransformMotionBlurInstance } from "../domain/transformMotionBlur";
import { buildGpuEnginePreviewGraph, buildGpuEngineVideoPreviewGraph, buildGpuRenderGraph, buildGpuVideoPreviewSource, canPresentGpuVideoOnNativeSurface, estimateGpuEngineVideoResources, gpuLayerPropertyBuffer } from "./gpuCompositor";
describe("advanced production GPU render graph adapter", () => {
  it("selects the 15 fps overlay proxy only for small layers in a six-source 30 fps graph", () => {
    const project = createDemoProject();
    project.width = 960; project.height = 540; project.fps = 30;
    project.assets[0].width = 960; project.assets[0].height = 540; project.assets[0].uri = "C:/fixtures/base.mp4";
    project.assets[0].derivatives = { sourceSha256: "a".repeat(64), generatedAt: "2026-08-25T00:00:00.000Z", proxyUri: "C:/cache/base-540.mp4", proxyWidth: 960, proxyHeight: 540 };
    for (let index = 1; index < 6; index += 1) {
      const asset = { ...structuredClone(project.assets[0]), id: `asset-overlay-${index}`, uri: `C:/fixtures/overlay-${index}.mp4`, derivatives: {
        sourceSha256: String(index).repeat(64), generatedAt: "2026-08-25T00:00:00.000Z",
        proxyUri: `C:/cache/overlay-${index}-540.mp4`, proxyWidth: 960, proxyHeight: 540,
        overlayProxyUri: `C:/cache/overlay-${index}-216.mp4`, overlayProxyWidth: 384, overlayProxyHeight: 216,
        overlayProxyFrameRateNumerator: 15, overlayProxyFrameRateDenominator: 1, overlayProxyProfile: "editkin-small-overlay-performance/v1" as const,
      } };
      project.assets.push(asset);
      project.tracks[0].clips.push({ ...structuredClone(project.tracks[0].clips[0]), id: `clip-overlay-${index}`, assetId: asset.id, transform: { ...project.tracks[0].clips[0].transform, scale: .18 } });
    }
    const preview = buildGpuEngineVideoPreviewGraph(project, 1)!;
    expect(preview.decoderDimensions["asset-demo"]).toEqual({ width: 960, height: 540, source: "proxy" });
    expect(Object.values(preview.decoderDimensions).filter((item) => item.source === "overlay-proxy")).toHaveLength(5);
    expect(preview.assetBindings["asset-overlay-3"]).toBe("C:/cache/overlay-3-216.mp4");
    project.fps = 24;
    const fallback = buildGpuEngineVideoPreviewGraph(project, 1)!;
    expect(Object.values(fallback.decoderDimensions).every((item) => item.source === "proxy")).toBe(true);
  });

  it("routes one static transform and one built-in effect through common native video", () => {
    const project = createDemoProject();
    project.width = 960;
    project.height = 540;
    project.assets[0].width = 960;
    project.assets[0].height = 540;
    project.tracks[0].clips[0].creative = { effectPresetIds: ["mono_halftone"] };
    project.tracks[0].clips[0].transform.scale = .8;
    project.tracks[0].clips[0].transform.x = 42;
    project.tracks[0].clips[0].transform.rotation = 5;
    const preview = buildGpuEngineVideoPreviewGraph(project, 1)!;
    expect(preview.graph.nodes).toContainEqual(expect.objectContaining({
      kind: "transform2d", x: 42, scaleX: .8, scaleY: .8,
    }));
    expect(preview.graph.nodes).toContainEqual(expect.objectContaining({
      kind: "effect", pluginId: "editkin.builtin.mono_halftone",
    }));
  });

  it("routes bounded Rec.709 primary-grade controls through common native video", () => {
    const project = createDemoProject();
    project.width = 960;
    project.height = 540;
    project.assets[0].width = 960;
    project.assets[0].height = 540;
    project.tracks[0].clips[0].color = {
      ...DEFAULT_COLOR,
      brightness: .04, contrast: 1.15, saturation: 1.2, hue: 0, exposure: .35,
      temperature: .25, tint: -.15, pivot: .45, shadows: .2, highlights: -.1, blacks: .1, whites: -.05,
    };
    const preview = buildGpuEngineVideoPreviewGraph(project, 1)!;
    const colorNode = preview.graph.nodes.find((node) => node.kind === "color")!;
    expect(colorNode.processor).toBe("editkin-rec709-primary/v2");
    expect(colorNode.grade).toEqual(project.tracks[0].clips[0].color);
  });

  it("fails native-video grading closed for unsupported hue and out-of-contract values", () => {
    const project = createDemoProject();
    project.width = 960;
    project.height = 540;
    project.assets[0].width = 960;
    project.assets[0].height = 540;
    project.tracks[0].clips[0].color.hue = 5;
    expect(buildGpuEngineVideoPreviewGraph(project, 1)).toBeUndefined();
    project.tracks[0].clips[0].color.hue = 0;
    project.tracks[0].clips[0].color.exposure = 4;
    expect(buildGpuEngineVideoPreviewGraph(project, 1)).toBeUndefined();
  });

  it("routes bounded transform and opacity keyframes into the resident video graph", () => {
    const project = createDemoProject();
    project.width = 960;
    project.height = 540;
    project.assets[0].width = 960;
    project.assets[0].height = 540;
    const clip = project.tracks[0].clips[0];
    clip.transform = { x: -180, y: -60, scale: .55, rotation: -6, opacity: .35 };
    clip.keyframes = [
      { id: "move-a", time: .5, transform: { x: 0, y: 80, scale: .85, rotation: 6, opacity: .75 }, color: structuredClone(clip.color), easing: "ease_in_out" },
      { id: "move-b", time: 1, transform: { x: 180, y: -40, scale: .45, rotation: -4, opacity: .5 }, color: structuredClone(clip.color), easing: "hold" },
    ];
    const preview = buildGpuEngineVideoPreviewGraph(project, .75)!;
    expect(preview.graph.nodes.find((node) => node.kind === "transform2d")?.keyframes).toEqual([
      expect.objectContaining({ frame: 15, x: 0, y: 80, scaleX: .85, opacity: .75, easing: "ease_in_out" }),
      expect.objectContaining({ frame: 30, x: 180, y: -40, scaleX: .45, opacity: .5, easing: "hold" }),
    ]);
  });

  it("routes animated visible-layer parenting and fails closed for broken parent graphs", () => {
    const project = createDemoProject();
    project.width = 960; project.height = 540;
    project.assets[0].width = 960; project.assets[0].height = 540;
    project.assets[0].uri = "C:/fixtures/parent.mp4";
    const parent = project.tracks[0].clips[0];
    parent.timelineStart = 0; parent.duration = 3;
    parent.transform = { x: 80, y: -35, scale: .8, rotation: 12, opacity: .9 };
    parent.keyframes = [{ id: "parent-move", time: 1, transform: { x: 120, y: 20, scale: .7, rotation: 20, opacity: .75 }, color: structuredClone(parent.color), easing: "ease_in_out" }];
    const childAsset = { ...structuredClone(project.assets[0]), id: "asset-child", uri: "C:/fixtures/child.mp4" };
    const child = {
      ...structuredClone(parent), id: "clip-child", assetId: childAsset.id, timelineStart: .5, sourceStart: .25, duration: 1.5,
      transform: { x: -70, y: 55, scale: .45, rotation: -6, opacity: .8 },
      keyframes: [{ id: "child-move", time: .75, transform: { x: 40, y: -25, scale: .6, rotation: 3, opacity: .65 }, color: structuredClone(parent.color), easing: "linear" as const }],
      layer: { enabled: true, role: "content" as const, blendMode: "normal" as const, parentClipId: parent.id },
    };
    project.assets.push(childAsset); project.tracks[0].clips.push(child);
    const preview = buildGpuEngineVideoPreviewGraph(project, 1)!;
    expect(preview.graph.nodes.find((node) => node.id === "transform:clip-child")).toMatchObject({
      kind: "transform2d", parent: "transform:clip-demo", keyframes: [expect.objectContaining({ frame: 23, x: 40 })],
    });

    child.layer.parentClipId = "missing-parent";
    expect(buildGpuEngineVideoPreviewGraph(project, 1)).toBeUndefined();
    child.layer.parentClipId = parent.id;
    parent.layer = { enabled: true, role: "content", blendMode: "normal", parentClipId: child.id };
    expect(buildGpuEngineVideoPreviewGraph(project, 1)).toBeUndefined();
    parent.layer.parentClipId = undefined;
    parent.duration = .75;
    expect(buildGpuEngineVideoPreviewGraph(project, 1)).toBeUndefined();
  });

  it("routes an animated Null controller without adding an asset binding", () => {
    const project = createDemoProject();
    project.width = 960; project.height = 540;
    project.assets[0].width = 960; project.assets[0].height = 540; project.assets[0].uri = "C:/fixtures/controller-source.mp4";
    const controller = project.tracks[0].clips[0];
    controller.layer = { enabled: true, blendMode: "normal", role: "controller" };
    controller.transform = { x: 80, y: -35, scale: .8, rotation: 12, opacity: .9 };
    controller.keyframes = [{ id: "controller-key", time: 1, transform: { x: 120, y: 20, scale: .7, rotation: 20, opacity: .75 }, color: structuredClone(controller.color), easing: "linear" }];
    const childAsset = { ...structuredClone(project.assets[0]), id: "asset-child", uri: "C:/fixtures/child.mp4" };
    const child = { ...structuredClone(controller), id: "clip-child", assetId: childAsset.id, trackId: "child-track", layer: { enabled: true, blendMode: "normal" as const, role: "content" as const, parentClipId: controller.id }, keyframes: [] };
    project.assets.push(childAsset); project.tracks.push({ id: "child-track", name: "Child", kind: "video", locked: false, muted: false, clips: [child] });
    const preview = buildGpuEngineVideoPreviewGraph(project, 1)!;
    expect(preview.assetBindings).toEqual({ "asset-child": "C:/fixtures/child.mp4" });
    expect(preview.graph.nodes.find((node) => node.id === "source:clip-demo")).toMatchObject({ assetId: "editkin.generator.null", mediaKind: "generator" });
    expect(preview.graph.nodes.find((node) => node.id === "transform:clip-child")?.parent).toBe("transform:clip-demo");
    expect(preview.graph.nodes.filter((node) => node.kind === "color")).toHaveLength(1);
  });

  it("routes exactly two independent video branches through a typed blend graph", () => {
    const project = createDemoProject();
    project.width = 960;
    project.height = 540;
    project.assets[0].width = 960;
    project.assets[0].height = 540;
    project.assets[0].uri = "C:/fixtures/base.mp4";
    const overlayAsset = { ...structuredClone(project.assets[0]), id: "asset-overlay", uri: "C:/fixtures/overlay.mp4" };
    const overlayClip = {
      ...structuredClone(project.tracks[0].clips[0]),
      id: "clip-overlay",
      assetId: overlayAsset.id,
      sourceStart: .5,
      transform: { ...structuredClone(project.tracks[0].clips[0].transform), x: 240, y: 120, scale: .4 },
      creative: { effectPresetIds: ["mono_halftone"] },
      layer: { enabled: true, blendMode: "screen" as const },
    };
    project.assets.push(overlayAsset);
    project.tracks[0].clips.push(overlayClip);
    const preview = buildGpuEngineVideoPreviewGraph(project, 1)!;
    expect(preview.assetBindings).toEqual({
      "asset-demo": "C:/fixtures/base.mp4",
      "asset-overlay": "C:/fixtures/overlay.mp4",
    });
    expect(preview.graph.nodes.filter((node) => node.kind === "source")).toHaveLength(2);
    expect(preview.graph.nodes.filter((node) => node.kind === "composite")).toEqual([
      expect.objectContaining({ inputs: ["color:clip-demo", "effect:clip-overlay:mono_halftone"], blendMode: "screen", opacity: 1 }),
    ]);
  });

  it("routes all four bounded track-matte modes and rejects an uncovered matte timeline", () => {
    for (const mode of ["alpha", "alpha_inverted", "luma", "luma_inverted"] as const) {
      const project = createDemoProject();
      project.width = 960; project.height = 540;
      project.assets[0].width = 960; project.assets[0].height = 540; project.assets[0].uri = "C:/fixtures/matte.mp4";
      const targetAsset = { ...structuredClone(project.assets[0]), id: `asset-target-${mode}`, uri: "C:/fixtures/target.mp4" };
      const target = { ...structuredClone(project.tracks[0].clips[0]), id: `clip-target-${mode}`, assetId: targetAsset.id,
        layer: { enabled: true, blendMode: "normal" as const, trackMatte: { sourceClipId: "clip-demo", mode } } };
      project.assets.push(targetAsset); project.tracks[0].clips.push(target);
      const preview = buildGpuEngineVideoPreviewGraph(project, 1)!;
      expect(preview.graph.nodes.find((node) => node.kind === "composite")).toMatchObject({
        matteInput: "color:clip-demo", matteMode: mode,
      });
      expect(estimateGpuEngineVideoResources(960, 540, 96, 2, 0, 0, 1)?.matteCount).toBe(1);
      project.tracks[0].clips[0].duration = target.duration / 2;
      expect(buildGpuEngineVideoPreviewGraph(project, 1)).toBeUndefined();
    }
  });

  it("recursively resolves a bounded precomposition to one leaf decoder while preserving graph markers", () => {
    const project = createDemoProject();
    project.width = 960; project.height = 540;
    project.assets[0].width = 960; project.assets[0].height = 540; project.assets[0].uri = "C:/fixtures/leaf.mp4";
    const child = structuredClone(project.tracks[0].clips[0]);
    child.id = "nested-leaf"; child.timelineStart = 0; child.sourceStart = .5; child.duration = 2;
    child.transform = { x: 20, y: -10, scale: .8, rotation: 5, opacity: .9 };
    const composition = {
      schema: "editkin.composition/v1" as const, id: "comp-a", name: "A", width: 960, height: 540, fps: 30, duration: 2,
      tracks: [{ id: "comp-track", name: "nested", kind: "video" as const, locked: false, muted: false, clips: [{ ...child, trackId: "comp-track" }] }],
      captions: [], captionStyle: structuredClone(project.captionStyle), motionTracks: [], motionGraphics: [], director: structuredClone(project.director), updatedAt: project.updatedAt,
    };
    project.compositions.push(composition);
    project.assets.push({ id: "asset-comp-a", name: "A", kind: "video", uri: "editkin-composition://comp-a", compositionId: "comp-a", duration: 2, width: 960, height: 540 });
    const outer = project.tracks[0].clips[0]; outer.assetId = "asset-comp-a"; outer.timelineStart = 1; outer.sourceStart = .25; outer.duration = 1.5;
    outer.transform = { x: 100, y: 50, scale: .5, rotation: 10, opacity: .8 };
    const preview = buildGpuEngineVideoPreviewGraph(project, 1.5)!;
    expect(preview.assetBindings).toEqual({ "asset-demo": "C:/fixtures/leaf.mp4" });
    expect(preview.graph.nodes).toContainEqual(expect.objectContaining({
      id: "source:clip-demo", kind: "precomposition", inputs: ["source:clip-demo:resolved-leaf"], nestedGraphId: "composition:comp-a",
    }));
    expect(preview.graph.nodes.find((node) => node.id === "source:clip-demo:resolved-leaf")).toMatchObject({
      kind: "source", assetId: "asset-demo", timeline: { timelineStartFrame: 30, sourceStartFrame: 23, durationFrames: 45 },
    });
    const resolvedTransform = preview.graph.nodes.find((node) => node.id === "transform:clip-demo")!;
    expect(resolvedTransform.scaleX).toBeCloseTo(.4); expect(resolvedTransform.rotationRadians).toBeCloseTo(15 * Math.PI / 180); expect(resolvedTransform.opacity).toBeCloseTo(.72);
    composition.tracks[0].clips.push({ ...structuredClone(child), id: "nested-extra" });
    expect(buildGpuEngineVideoPreviewGraph(project, 1.5)).toBeUndefined();
  });

  it("routes twelve independent video tracks through the resource-admitted native graph", () => {
    const project = createDemoProject();
    project.width = 960;
    project.height = 540;
    project.assets[0].width = 960;
    project.assets[0].height = 540;
    project.assets[0].uri = "C:/fixtures/base.mp4";
    for (let index = 1; index < 12; index += 1) {
      const asset = { ...structuredClone(project.assets[0]), id: `asset-pip-${index}`, uri: `C:/fixtures/pip-${index}.mp4` };
      project.assets.push(asset);
      project.tracks[0].clips.push({
        ...structuredClone(project.tracks[0].clips[0]),
        id: `clip-pip-${index}`,
        assetId: asset.id,
        sourceStart: index * .5,
        transform: { ...structuredClone(project.tracks[0].clips[0].transform), x: index * 80, y: -120, scale: .18 },
        creative: { effectPresetIds: ["mono_halftone"] },
      });
    }
    const preview = buildGpuEngineVideoPreviewGraph(project, 1)!;
    expect(Object.keys(preview.assetBindings)).toHaveLength(12);
    expect(preview.graph.nodes.filter((node) => node.kind === "source")).toHaveLength(12);
    expect(preview.graph.nodes.filter((node) => node.kind === "composite")).toHaveLength(11);
    expect(preview.graph.nodes.find((node) => node.id === preview.graph.outputNode)?.inputs).toEqual(["composite:11"]);
  });

  it("fails the common native-video graph closed for unsupported semantics and a resource-over-budget layer stack", () => {
    const project = createDemoProject();
    project.width = 960;
    project.height = 540;
    project.assets[0].width = 960;
    project.assets[0].height = 540;
    project.tracks[0].clips[0].creative = { effectPresetIds: ["film_grain_soft"] };
    expect(buildGpuEngineVideoPreviewGraph(project, 1)).toBeUndefined();
    project.tracks[0].clips[0].creative = { effectPresetIds: ["mono_halftone", "xerox_pulse"] };
    expect(buildGpuEngineVideoPreviewGraph(project, 1)).toBeUndefined();
    project.tracks[0].clips[0].creative = { effectPresetIds: [] };
    project.tracks[0].clips[0].keyframes.push({
      id: "animated", time: 0, easing: "linear",
      transform: structuredClone(project.tracks[0].clips[0].transform),
      color: structuredClone(project.tracks[0].clips[0].color),
    });
    expect(buildGpuEngineVideoPreviewGraph(project, 1)).toBeUndefined();
    project.tracks[0].clips[0].keyframes = [];
    project.tracks[0].clips[0].expressions = { x: "hao.expression/v1:value+time" };
    expect(buildGpuEngineVideoPreviewGraph(project, 1)).toBeUndefined();
    project.tracks[0].clips[0].expressions = {};
    project.tracks[0].clips[0].layer = { enabled: true, blendMode: "screen" };
    expect(buildGpuEngineVideoPreviewGraph(project, 1)).toBeUndefined();
    project.tracks[0].clips[0].layer = { enabled: true, blendMode: "normal" };
    for (let index = 1; index < 58; index += 1) project.tracks[0].clips.push({ ...structuredClone(project.tracks[0].clips[0]), id: `extra-${index}` });
    expect(buildGpuEngineVideoPreviewGraph(project, 1)).toBeUndefined();
  });

  it("calculates the same closed resident allocation plan as the native executor", () => {
    expect(estimateGpuEngineVideoResources(960, 540, 384, 12, 0)).toMatchObject({
      schema: "editkin.resident-video-resource-plan/v1",
      pixelCount: 518_400,
      bytesPerVideoLayer: 18_662_400,
      workingBytesPerPixel: 4,
      temporalSampleCount: 0,
      temporalResidentRingSlots: 0,
      temporalResidentBytes: 0,
      compositorWorkingBytes: 6_220_800,
      overlayBytes: 0,
      particleCount: 0,
      particleSnapshotCapacityPerEmitter: 2,
      particleSnapshotBytes: 0,
      adjustmentCount: 0,
      matteCount: 0,
      adjustmentWorkingBytes: 0,
      requiredBytes: 230_169_600,
      budgetBytes: 402_653_184,
      maxVideoLayers: 21,
    });
    expect(estimateGpuEngineVideoResources(960, 540, 160, 1, 0, 0, 0, 0, 8)).toMatchObject({
      temporalSampleCount: 8,
      temporalResidentRingSlots: 5,
      temporalResidentBytes: 31_104_000,
      requiredBytes: 55_987_200,
    });
    expect(estimateGpuEngineVideoResources(960, 540, 219, 12, 0)?.requiredBytes).toBeGreaterThan(219 * 1024 * 1024);
    expect(estimateGpuEngineVideoResources(320, 180, 64, 1, 1, 0, 0, 1)).toMatchObject({
      particleCount: 1,
      particleSnapshotCapacityPerEmitter: 2,
      particleSnapshotBytes: 460_800,
      requiredBytes: 3_456_000,
    });
    expect(estimateGpuEngineVideoResources(960, 540, 384, 2, 0, 1)).toMatchObject({
      adjustmentCount: 1,
      adjustmentWorkingBytes: 4_147_200,
      requiredBytes: 47_692_800,
    });
  });

  it("routes a bounded trailing adjustment layer without inventing a decoder binding", () => {
    const project = createDemoProject();
    project.width = 960; project.height = 540;
    project.assets[0].width = 960; project.assets[0].height = 540;
    project.assets[0].uri = "C:/fixtures/base.mp4";
    const adjustment = structuredClone(project.tracks[0].clips[0]);
    adjustment.id = "adjustment-grade";
    adjustment.trackId = "video-adjustment";
    adjustment.layer = { enabled: true, blendMode: "normal", role: "adjustment" };
    adjustment.timelineStart = .5; adjustment.duration = 2;
    adjustment.color = { ...adjustment.color, contrast: 1.2, saturation: .75, exposure: .2, temperature: .1 };
    project.tracks.push({ id: "video-adjustment", name: "Adjustment", kind: "video", locked: false, muted: false, clips: [adjustment] });
    const preview = buildGpuEngineVideoPreviewGraph(project, 1)!;
    expect(preview.assetBindings).toEqual({ "asset-demo": "C:/fixtures/base.mp4" });
    expect(preview.graph.nodes).toContainEqual(expect.objectContaining({
      id: "adjustment:adjustment-grade", kind: "adjustment",
      timeline: { timelineStartFrame: 15, sourceStartFrame: 0, durationFrames: 60 },
    }));
    expect(preview.graph.nodes.find((node) => node.id === preview.graph.outputNode)?.inputs)
      .toEqual(["color:adjustment-grade"]);
  });

  it("resolves imported auto SDR video to the explicit native display contract", () => {
    const project = createDemoProject();
    project.width = 960; project.height = 540;
    project.assets[0].width = 960; project.assets[0].height = 540;
    project.assets[0].uri = "C:/fixtures/imported-auto.mp4";
    project.assets[0].color = { interpretation: "auto" };

    const preview = buildGpuEngineVideoPreviewGraph(project, 1);

    expect(preview).toBeDefined();
    expect(preview?.graph.nodes.find((node) => node.id === `source:${project.tracks[0].clips[0].id}`))
      .toMatchObject({ inputColorSpace: "rec709" });
    expect(preview?.graph.nodes.find((node) => node.id === `color:${project.tracks[0].clips[0].id}`))
      .toMatchObject({
        processor: "editkin-rec709-primary/v2",
        inputSpace: "rec709",
        workingSpace: "rec709",
        outputSpace: "rec709_sdr",
      });
    expect(project.assets[0].color).toEqual({ interpretation: "auto" });
  });

  it("does not misrepresent effects or resolution scaling as native video parity", () => {
    const project = createDemoProject();
    project.width = 960;
    project.height = 540;
    project.tracks[0].clips[0].creative = { effectPresetIds: ["vfx.glow"] };
    expect(buildGpuVideoPreviewSource(project, 1)).toBeUndefined();
    project.tracks[0].clips[0].creative = { effectPresetIds: [] };
    project.width = 1920;
    expect(buildGpuVideoPreviewSource(project, 1)).toBeUndefined();
  });

  it("never labels a pending third-party native effect as resident preview parity", () => {
    const project = createDemoProject();
    project.width = 960; project.height = 540;
    project.assets[0].width = 960; project.assets[0].height = 540;
    project.assets[0].uri = "C:/fixtures/base.mp4";
    project.tracks[0].clips[0].creative = { effectPresetIds: [], nativeEffectInstances: [{
      id: "native-1", pluginId: "creator.native-effect", capabilityId: "gain", pluginVersion: "1.0.0",
      manifestSha256: "a".repeat(64), enabled: true, parameters: { gain: 0.8 },
    }] };
    expect(buildGpuVideoPreviewSource(project, 1)).toBeUndefined();
    expect(buildGpuEngineVideoPreviewGraph(project, 1)).toBeUndefined();
    project.tracks[0].clips[0].creative.nativeEffectInstances![0].runtimeType = "gpu_effect_graph";
    expect(buildGpuEngineVideoPreviewGraph(project, 1)?.graph.nodes).toContainEqual(expect.objectContaining({
      kind: "effect", pluginId: `creator.native-effect/gain@1.0.0#${"a".repeat(64)}`,
    }));
    project.tracks[0].clips[0].creative.nativeEffectInstances![0].enabled = false;
    expect(buildGpuEngineVideoPreviewGraph(project, 1)).toBeDefined();
  });

  it("converges bounded scene-linear effects, a static matte, a temporal target, and particles while keeping unsafe sources fail-closed", () => {
    const project = createDemoProject();
    project.width = 960; project.height = 540;
    project.assets[0].width = 960; project.assets[0].height = 540; project.assets[0].uri = "C:/fixtures/matte.mp4";
    project.assets[0].color = { interpretation: "rec709" };
    project.colorManagement = { ...project.colorManagement!, mode: "aces2", outputTransform: "rec709_sdr" };
    const matte = project.tracks[0].clips[0];
    matte.creative = { effectPresetIds: ["mono_halftone"] };
    const targetAsset = { ...structuredClone(project.assets[0]), id: "asset-scene-linear-target", uri: "C:/fixtures/target.mp4" };
    const gpuEffect: NativeEffectInstance = {
      id: "scene-linear-gpu", pluginId: "creator.scene-linear", capabilityId: "look", pluginVersion: "1.0.0",
      manifestSha256: "a".repeat(64), runtimeType: "gpu_effect_graph" as const, enabled: true, parameters: { gain: .82 },
    };
    const target = {
      ...structuredClone(matte), id: "clip-scene-linear-target", assetId: targetAsset.id,
      creative: { effectPresetIds: [], nativeEffectInstances: [gpuEffect] },
      layer: { enabled: true, blendMode: "normal" as const, role: "content" as const, trackMatte: { sourceClipId: matte.id, mode: "luma" as const } },
    };
    project.assets.push(targetAsset);
    project.tracks[0].clips.push(target);
    const admitted = buildGpuEngineVideoPreviewGraph(project, 1);
    expect(admitted).toBeDefined();
    expect(admitted?.graph.nodes).toContainEqual(expect.objectContaining({ kind: "effect", pluginId: expect.stringContaining("creator.scene-linear/look@1.0.0") }));
    expect(admitted?.graph.nodes.find((node) => node.kind === "composite")).toMatchObject({ matteMode: "luma" });

    target.creative.nativeEffectInstances.push({ ...gpuEffect, id: "cpu-effect", runtimeType: "native_effect" });
    expect(buildGpuEngineVideoPreviewGraph(project, 1)).toBeUndefined();
    target.creative.nativeEffectInstances = [gpuEffect, createTransformMotionBlurInstance()];
    project.particleSimulation = { ...structuredClone(DEFAULT_PARTICLE_SIMULATION), timeline: { start: 0, duration: target.duration } };
    const converged = buildGpuEngineVideoPreviewGraph(project, 1);
    expect(converged).toBeDefined();
    expect(converged?.graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "motion_blur", sourceSampling: "decoded_temporal", samples: 8 }),
      expect.objectContaining({ kind: "particle_emitter" }),
      expect.objectContaining({ kind: "composite", matteMode: "luma" }),
    ]));
    project.particleSimulation = undefined;
    target.creative.nativeEffectInstances = [gpuEffect];
    matte.creative.nativeEffectInstances = [createTransformMotionBlurInstance()];
    expect(buildGpuEngineVideoPreviewGraph(project, 1)).toBeUndefined();
  });

  it("admits bounded single-color captions but keeps unsupported overlays out of native HWND airspace", () => {
    const project = createDemoProject();
    project.width = 960;
    project.height = 540;
    project.assets[0].width = 960;
    project.assets[0].height = 540;
    expect(canPresentGpuVideoOnNativeSurface(project)).toBe(true);
    project.captions.push({ id: "caption", text: "must stay visible", start: 0, duration: 1 });
    expect(canPresentGpuVideoOnNativeSurface(project)).toBe(true);
    expect(buildGpuEngineVideoPreviewGraph(project, .5)?.graph.nodes).toContainEqual(expect.objectContaining({ kind: "caption", textColor: "#FFFFFF" }));
    project.captions[0].start = project.tracks[0].clips[0].timelineStart + project.tracks[0].clips[0].duration + 1;
    expect(canPresentGpuVideoOnNativeSurface(project)).toBe(false);
    project.captions[0].start = 0;
    project.captionStyle.italic = true;
    expect(canPresentGpuVideoOnNativeSurface(project)).toBe(false);
    project.captionStyle.italic = false;
    project.motionGraphics.push({
      schema: "hao.motion-composition/v1", id: "title", name: "title", kind: "title", text: "native later",
      timelineStart: 0, duration: 1, x: .1, y: .1, width: .8, fontSize: 64, textColor: "#fff",
      backgroundColor: "#000", accentColor: "#fff", animation: "fade", offsetX: 0, offsetY: 0,
    });
    expect(canPresentGpuVideoOnNativeSurface(project)).toBe(false);
    project.motionGraphics[0].textColor = "#FFFFFFFF";
    project.motionGraphics[0].backgroundColor = "#10151FEE";
    project.motionGraphics[0].accentColor = "#A8FF3EFF";
    expect(canPresentGpuVideoOnNativeSurface(project)).toBe(true);
    expect(buildGpuEngineVideoPreviewGraph(project, .5)?.graph.nodes).toContainEqual(expect.objectContaining({ kind: "motion_graphic", animation: "fade" }));
    project.motionGraphics[0].animation = "slide_up";
    expect(canPresentGpuVideoOnNativeSurface(project)).toBe(true);
    expect(buildGpuEngineVideoPreviewGraph(project, .5)?.graph.nodes).toContainEqual(expect.objectContaining({ kind: "motion_graphic", animation: "slide_up" }));
    project.motionGraphics[0].animation = "pop";
    expect(canPresentGpuVideoOnNativeSurface(project)).toBe(true);
    project.motionGraphics[0].animation = "spring_soft";
    expect(canPresentGpuVideoOnNativeSurface(project)).toBe(true);
    project.motionTracks.push({
      id: "subject", clipId: project.tracks[0].clips[0].id, name: "subject", engine: "fixture", analysisFps: 15,
      initialRect: { x: .1, y: .2, width: .2, height: .2 }, lostRatio: 0, createdAt: "2026-08-25T00:00:00Z",
      points: [
        { frame: 0, time: 0, rect: { x: .1, y: .2, width: .2, height: .2 }, confidence: 1, status: "manual" },
        { frame: 15, time: 1, rect: { x: .3, y: .2, width: .2, height: .2 }, confidence: .9, status: "tracked" },
      ],
    });
    project.motionGraphics[0].trackId = "subject";
    project.motionGraphics[0].offsetX = .015;
    project.motionGraphics[0].offsetY = -.02;
    expect(canPresentGpuVideoOnNativeSurface(project)).toBe(true);
    expect(buildGpuEngineVideoPreviewGraph(project, .5)?.graph.nodes).toContainEqual(expect.objectContaining({ kind: "motion_graphic", tracking: expect.objectContaining({ trackId: "subject", samples: expect.any(Array) }) }));
    project.motionGraphics[0].animation = "spin_3d" as typeof project.motionGraphics[0]["animation"];
    expect(canPresentGpuVideoOnNativeSurface(project)).toBe(false);
  });

});
