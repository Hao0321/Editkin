import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { floatingVideoFramePresetV2 } from "../motion/floatingVideoFrame";
import { expectedEngineVideoTopology } from "../desktop/residentGpuPreviewExpectations";
import { buildEngineRenderGraph } from "./engineGraph";
import { prepareNativeFloatingVideoFrames, sampleNativeFloatingVideoFrame, type NativeFloatingVideoFrameSpec } from "./nativeFloatingVideoFrame";
import { assertNativeFloatingLoadReceipt, assertNativeFloatingFrameReceipt, nativeFloatRuntimeMatches, nativeFloatingVisualMatches, NATIVE_VIDEO_TARGET_ADMISSION } from "./nativeFloatingVideoFrameReceipt";

// Wire controls use a genuinely prepared graph, but authored receipts below are
// unsigned fixtures. They do not assert native rendering, pixels or runtime delivery.
function fixture(two = false) {
  const project = createDemoProject(); project.width = 1280; project.height = 720; project.captions = []; project.motionGraphics = [];
  project.colorManagement = { ...project.colorManagement!, mode: "aces2", outputTransform: "rec709_sdr" };
  Object.assign(project.assets[0], { width: 1920, height: 1080, duration: 10, color: { interpretation: "rec709" }, displayAspectRatio: 16 / 9 });
  const clip = project.tracks[0].clips[0];
  Object.assign(clip, { timelineStart: 1, sourceStart: 0, duration: 2, floatingFrame: {
    ...floatingVideoFramePresetV2("matte"), yawDegrees: 0, pitchDegrees: 0,
    motion: { entranceFrames: 6, exitFrames: 6, travelY: .012 },
  } });
  clip.transform = { x: 12, y: -7, scale: 1, rotation: 0, opacity: .8 }; clip.keyframes = [];
  if (two) project.tracks[0].clips.push({ ...structuredClone(clip), id: "second-floating", transform: { ...clip.transform, x: -20 } });
  const graph = buildEngineRenderGraph(project, { nativeFloatingVideoFrames: prepareNativeFloatingVideoFrames(project) });
  const topology = expectedEngineVideoTopology(graph);
  const owners = graph.nodes.filter(node => node.kind === "floating_video_frame_2d");
  function visual(spec: NativeFloatingVideoFrameSpec, x: number, y: number, frame: number, backdrop: boolean) {
    const sample = sampleNativeFloatingVideoFrame(spec, frame), panelColor = [0x12, 0x15, 0x16].map(value => value / 255);
    const linear = panelColor.map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    // With yaw=pitch=0 the independent geometric inverse is an affine translation.
    const travel = sample.quad[0][1] * graph.height;
    return { floatingPanel: [...sample.outerRect], floatingContent: [...sample.contentRect],
      floatingMask: [sample.radius, sample.feather, sample.border, backdrop ? 2 : 1], floatingShadow: [...sample.shadow],
      floatingColor: [...linear, 0], projectiveEnabled: 1, translateX: x, translateY: y, scale: 1, rotation: 0,
      opacity: .8 * sample.opacity, sourceWidth: graph.width, sourceHeight: graph.height,
      projectiveH0: 1, projectiveH1: 0, projectiveH2: -x,
      projectiveH3: 0, projectiveH4: 1, projectiveH5: -y - travel, projectiveH6: 0, projectiveH7: 0,
      effectKind: 0, shaderOpCount: 0, matteMode: 0, motionSampleCount: 0, motionContractCode: 0, sceneDepthEnabled: 0, inputTransfer: 2 };
  }
  const videoTargetIdentity = { schema: "editkin.actual-video-target-identity/v1", generation: 1, backend: "Dx12",
    executableSha256: "a".repeat(64), executableBytes: 100,
    adapter: "unsigned-wire-control", deviceType: "DiscreteGpu", target: { renderTargetContract: "editkin.resident-offscreen-render-target/v1",
      offscreen: true, width: graph.width, height: graph.height, nativeWindow: false, nativeSwapChain: false } };
  const load = { generation: 1, videoTargetIdentity, layers: topology.layers.map((layer, layerIndex) => {
    const owner = owners.find(node => layer.transform.inputs[0] === node.id)!;
    return { layerIndex, sourceNodeId: layer.sourceNodeId, assetId: layer.assetId,
      floatingVideoFrameNodeId: owner.id, floatingVideoFrame: structuredClone(owner.spec),
      floatingSourceProfile: { schema: "editkin.native-floating-source-profile/v1", profile: "unrotated-square-pixel-rec709-first-profile",
        actualNativeMediaType: { codedWidth: 1920, codedHeight: 1080, rotationDegrees: null as number | null, sampleAspectRatio: null as number[] | null,
          colorPrimaries: null as number | null, transferFunction: null as number | null, yuvMatrix: null as number | null, nominalRange: null as number | null },
        negotiatedDimensions: [1920, 1080], rotationMetadataStatus: "not_declared", sampleAspectMetadataStatus: "not_declared",
        effectiveRotationDegrees: 0, effectiveSampleAspectRatio: [1, 1], missingGeometryPolicy: "media_foundation_default_unrotated_square_pixels",
        nativeColorMetadataVerified: false, decodedOrientationPixelsVerified: false, declaredFirstProfileAccepted: true } };
  }) };
  function receipt(frame: number) {
    const layers = topology.layers.filter(layer => {
      const timeline = layer.source.timeline as NativeFloatingVideoFrameSpec["timeline"];
      return frame >= timeline.timelineStartFrame && frame < timeline.timelineStartFrame + timeline.durationFrames;
    });
    return { timelineFrame: frame, generation: 1, videoTargetIdentity,
      layers: layers.map(layer => ({ layerIndex: topology.layers.indexOf(layer), sourceNodeId: layer.sourceNodeId, assetId: layer.assetId, active: true,
        sourceFrame: frame - (layer.source.timeline as NativeFloatingVideoFrameSpec["timeline"]).timelineStartFrame })),
      activeFloatingVideoFrames: layers.map((layer, index) => {
        const owner = owners.find(node => layer.transform.inputs[0] === node.id)!; const spec = owner.spec as NativeFloatingVideoFrameSpec;
        return { materialContract: "editkin.native-floating-frame-material/v1", sourceNodeId: layer.sourceNodeId, assetId: layer.assetId,
          floatingNodeId: owner.id, timelineFrame: frame, localFrame: frame - spec.timeline.timelineStartFrame,
          descriptor: structuredClone(spec), sample: { ...sampleNativeFloatingVideoFrame(spec, frame), panelColor: [0x12, 0x15, 0x16].map(value => value / 255) },
          actualStagedVisualUniform: visual(spec, Number(layer.transform.x), Number(layer.transform.y), frame, index === 0),
          radialBackdropSelected: index === 0, colorBoundary: "source_grade_then_srgb_material_then_single_aces2_then_display_paint" };
      }) };
  }
  return { graph, load, receipt, topology, visual };
}
describe("native floating receipt admission (unsigned wire controls only)", () => {
  it("requires the exact advertised material runtime and retains empty old graphs", () => {
    const ready = { event: "ready", engine: "editkin-wgpu-resident-engine/v1", generation: 1, backend: "Dx12",
      videoInteropProtocol: "media-foundation-d3d11-d3d12-wgpu/v1", nativeFloatingVideoFrameContract: "editkin.native-floating-frame-material/v1", videoTargetAdmission: NATIVE_VIDEO_TARGET_ADMISSION };
    expect(nativeFloatRuntimeMatches(ready)).toBe(true);
    expect(nativeFloatRuntimeMatches({ ...ready, generation: 0 })).toBe(false);
    expect(nativeFloatRuntimeMatches({ ...ready, backend: "Vulkan" })).toBe(true);
    expect(nativeFloatRuntimeMatches({})).toBe(false); expect(nativeFloatRuntimeMatches({ nativeFloatingVideoFrameContract: "v0" })).toBe(false);
    const { graph } = fixture(); const old = { ...graph, nodes: graph.nodes.filter(node => node.kind !== "floating_video_frame_2d") };
    expect(() => assertNativeFloatingLoadReceipt(old, {})).not.toThrow();
    expect(() => assertNativeFloatingFrameReceipt(old, 0, {})).not.toThrow();
  });
  it("accepts literal load identity and refuses missing, stale or reordered ownership", () => {
    const { graph, load } = fixture(true); expect(() => assertNativeFloatingLoadReceipt(graph, load)).not.toThrow();
    for (const change of [(copy: typeof load) => { copy.layers[0].floatingVideoFrameNodeId = "old"; },
      (copy: typeof load) => { ((copy.layers[0].floatingVideoFrame as NativeFloatingVideoFrameSpec).timeline as { sourceStartFrame: number }).sourceStartFrame = 1; },
      (copy: typeof load) => { copy.layers.reverse(); }, (copy: typeof load) => { copy.layers.pop(); }]) {
      const copy = structuredClone(load); change(copy); expect(() => assertNativeFloatingLoadReceipt(graph, copy)).toThrow();
    }
  });
  it("accepts each entrance, settled and exit sample with post-affine homography", () => {
    const { graph, receipt } = fixture();
    for (const frame of [30, 31, 36, 45, 84, 88, 89]) expect(() => assertNativeFloatingFrameReceipt(graph, frame, receipt(frame))).not.toThrow();
  });
  it("requires actual native coded geometry and preserves unmeasured metadata boundaries", () => {
    const { graph, load } = fixture();
    for (const change of [(copy: typeof load) => { copy.layers[0].floatingSourceProfile.actualNativeMediaType.codedWidth = 1280; },
      (copy: typeof load) => { copy.layers[0].floatingSourceProfile.actualNativeMediaType.rotationDegrees = 180; },
      (copy: typeof load) => { copy.layers[0].floatingSourceProfile.actualNativeMediaType.sampleAspectRatio = [2, 1]; },
      (copy: typeof load) => { copy.layers[0].floatingSourceProfile.nativeColorMetadataVerified = true; },
      (copy: typeof load) => { copy.layers[0].floatingSourceProfile.decodedOrientationPixelsVerified = true; },
      (copy: typeof load) => { copy.layers[0].floatingSourceProfile.actualNativeMediaType.transferFunction = 16; }]) {
      const copy = structuredClone(load); change(copy); expect(() => assertNativeFloatingLoadReceipt(graph, copy)).toThrow();
    }
    expect(() => assertNativeFloatingLoadReceipt(graph, { layers: load.layers.map(({ floatingSourceProfile: _profile, ...row }) => row) })).toThrow();
  });
  it("rejects late delivery, fractional request, source-clock drift and duplicate rows", () => {
    const { graph, receipt } = fixture();
    expect(() => assertNativeFloatingFrameReceipt(graph, 46, receipt(45))).toThrow();
    expect(() => assertNativeFloatingFrameReceipt(graph, 45.5, receipt(45))).toThrow();
    const source = receipt(45); source.layers[0].sourceFrame += 1; expect(() => assertNativeFloatingFrameReceipt(graph, 45, source)).toThrow();
    const duplicate = receipt(45); duplicate.activeFloatingVideoFrames.push(structuredClone(duplicate.activeFloatingVideoFrames[0]));
    expect(() => assertNativeFloatingFrameReceipt(graph, 45, duplicate)).toThrow();
  });
  it("rejects missing old-binary fields and a changed literal descriptor", () => {
    const { graph, receipt } = fixture(); const copy = receipt(45);
    expect(() => assertNativeFloatingFrameReceipt(graph, 45, { ...copy, activeFloatingVideoFrames: undefined })).toThrow();
    copy.activeFloatingVideoFrames[0].descriptor.frame.yawDegrees = 1;
    expect(() => assertNativeFloatingFrameReceipt(graph, 45, copy)).toThrow();
  });
  it("enforces pixel geometry and phase instead of accepting arbitrary finite sample values", () => {
    const { graph, receipt } = fixture();
    for (const change of [(row: ReturnType<typeof receipt>["activeFloatingVideoFrames"][number]) => { (row.sample.outerRect as unknown as number[])[0] += .003; },
      (row: ReturnType<typeof receipt>["activeFloatingVideoFrames"][number]) => { (row.sample.quad[0] as unknown as number[])[0] += .003 / graph.width; },
      (row: ReturnType<typeof receipt>["activeFloatingVideoFrames"][number]) => { row.sample.opacity = .123; },
      (row: ReturnType<typeof receipt>["activeFloatingVideoFrames"][number]) => { row.sample.radius += 1; }]) {
      const copy = receipt(31); change(copy.activeFloatingVideoFrames[0]); expect(() => assertNativeFloatingFrameReceipt(graph, 31, copy)).toThrow();
    }
  });
  it("refuses corrupt staged contain, mask, shadow, color, homography or color boundary", () => {
    const { graph, receipt } = fixture();
    for (const key of ["floatingPanel", "floatingContent", "floatingMask", "floatingShadow", "floatingColor"]) {
      const copy = receipt(45); const visual = copy.activeFloatingVideoFrames[0].actualStagedVisualUniform as Record<string, unknown>;
      (visual[key] as number[])[0] += .1; expect(() => assertNativeFloatingFrameReceipt(graph, 45, copy)).toThrow();
    }
    const h = receipt(45); h.activeFloatingVideoFrames[0].actualStagedVisualUniform.projectiveH2 += .01;
    expect(() => assertNativeFloatingFrameReceipt(graph, 45, h)).toThrow();
    const boundary = receipt(45); boundary.activeFloatingVideoFrames[0].colorBoundary = "double_output_transform";
    expect(() => assertNativeFloatingFrameReceipt(graph, 45, boundary)).toThrow();
  });
  it("allows exactly the first active surface backdrop and distinguishes pre-surface visuals", () => {
    const { graph, receipt, topology, visual } = fixture(true); const copy = receipt(45);
    expect(() => assertNativeFloatingFrameReceipt(graph, 45, copy)).not.toThrow();
    copy.activeFloatingVideoFrames[1].actualStagedVisualUniform.floatingMask[3] = 2;
    copy.activeFloatingVideoFrames[1].radialBackdropSelected = true;
    expect(() => assertNativeFloatingFrameReceipt(graph, 45, copy)).toThrow();
    const owner = graph.nodes.find(node => node.kind === "floating_video_frame_2d")!.spec as NativeFloatingVideoFrameSpec;
    expect(nativeFloatingVisualMatches(graph, 45, topology.layers[0], visual(owner, 12, -7, 45, false))).toBe(true);
    expect(nativeFloatingVisualMatches(graph, 45, topology.layers[0], visual(owner, 12, -7, 45, true))).toBe(false);
    // The real loader's inactive initial preview is sampled at local zero,
    // without making an inactive floating owner valid in a delivered frame.
    expect(nativeFloatingVisualMatches(graph, 0, topology.layers[0], visual(owner, 12, -7, 30, false))).toBe(true);
    const inactive = receipt(0); inactive.activeFloatingVideoFrames.push(receipt(30).activeFloatingVideoFrames[0]);
    expect(() => assertNativeFloatingFrameReceipt(graph, 0, inactive)).toThrow();
  });
});
