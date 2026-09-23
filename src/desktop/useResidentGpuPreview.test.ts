import { describe, expect, it } from "vitest";
import type { EngineRenderGraph } from "../render/engineGraph";
import type { GpuNativePreviewSurface } from "./types";
import type { GpuEngineVideoPresentedFrame } from "./types";
import { depthOfFieldCoverageMatches, legacySdrNativeSurfaceValid, pqHdrNativeSurfaceValid, sceneLinearAces2PresentContractValid, sceneLinearCompositeReceiptMatches } from "./residentGpuPreviewReceipts";

function surface(patch: Partial<GpuNativePreviewSurface> = {}): GpuNativePreviewSurface {
  return {
    bound: true,
    backend: "Dx12",
    surfaceFormat: "Bgra8UnormSrgb",
    surfaceColorSpace: "Auto",
    requestedColorSpace: "srgb",
    pixelContract: "legacy-sdr-video/v1",
    hdrTransportConfigured: false,
    legacyVideoPresentationAllowed: true,
    dxgiColorSpaceConfiguration: "wgpu-dx12-IDXGISwapChain3-SetColorSpace1/v1",
    physicalDisplayHdrVisibility: "advisory-unverified",
    liveDisplayHeadroomMeasured: true,
    displayHdrInfo: {
      advisoryOnly: true,
      bitsPerColor: 8,
      chromaticity: null,
      coarse: { gamut: "Srgb", highDynamicRange: false },
      luminance: { minNits: .5, maxNits: 270, maxFullFrameNits: 270, sdrWhiteNits: 80 },
      headroom: null,
      toneMapHeadroom: 1,
    },
    presentMode: "Mailbox",
    width: 960,
    height: 540,
    presentCount: 1,
    visible: true,
    cpuPixelReadbacks: 0,
    nativeSwapChain: true,
    ...patch,
  };
}

describe("native preview color transport contract", () => {
  it("accepts only the explicit legacy SDR swap-chain contract", () => {
    expect(legacySdrNativeSurfaceValid(surface())).toBe(true);
  });

  it("rejects a PQ swap chain before legacy SDR pixels can be presented", () => {
    expect(legacySdrNativeSurfaceValid(surface({
      surfaceFormat: "Rgb10a2Unorm",
      surfaceColorSpace: "Bt2100Pq",
      requestedColorSpace: "bt2100_pq",
      pixelContract: "rec2020-pq-encoded-rgb/v1",
      hdrTransportConfigured: true,
      legacyVideoPresentationAllowed: false,
    }))).toBe(false);
  });

  it("rejects an incomplete advisory display receipt", () => {
    expect(legacySdrNativeSurfaceValid(surface({
      displayHdrInfo: { ...surface().displayHdrInfo, advisoryOnly: false as true },
    }))).toBe(false);
  });

  it("accepts only the exact Rec.2100 PQ 10-bit swap-chain contract", () => {
    const pqSurface = surface({
      surfaceFormat: "Rgb10a2Unorm",
      surfaceColorSpace: "Bt2100Pq",
      requestedColorSpace: "rec2100_pq_1000",
      pixelContract: "rec2020-pq-encoded-rgb/v1",
      hdrTransportConfigured: true,
      legacyVideoPresentationAllowed: false,
    });
    expect(pqHdrNativeSurfaceValid(pqSurface)).toBe(true);
    expect(pqHdrNativeSurfaceValid({ ...pqSurface, surfaceFormat: "Bgra8UnormSrgb" })).toBe(false);
    expect(legacySdrNativeSurfaceValid(pqSurface)).toBe(false);
  });

  it("accepts only the exact scene-linear ACES2 product receipt", () => {
    const receipt = {
      sceneLinearExecution: true, workingColorSpace: "linear_rec709", workingFormat: "rgba16_float",
      displayTransform: "editkin-ocio-aces2-linear-rec709-to-rec709-sdr/v1",
      outputSpace: "rec709_sdr", lutSha256: "0808837eb979b6f59e79db411f6bd861469456a89bf399ffe652a99bf0c454b3", lutPayloadSha256: null,
      inputTransform: "editkin-srgb-to-linear-rec709-primary/v1",
      ocioVersion: "2.5.2", acesVersion: "2.0",
      configSha256: "eda5b0008a43b72b98ad540e32eb0eb83b340dde54e35bddba64ccbafac1029a",
      productPathCpuPixelCopies: 0,
      effectExecutionMode: "none", shaderOperationCount: 0, builtInEffectCount: 0,
      temporalExecutionMode: "none", temporalLayerCount: 0, temporalSampleTextureCount: 0,
      matteExecutionMode: "none", mattePassCount: 0,
      depthExecutionMode: "none", depthFormat: "none", depthTestedLayerCount: 0, depthPassCount: 0,
      depthOfFieldExecutionMode: "none", depthOfFieldDepthSource: "none", depthOfFieldPassCount: 0, depthOfField: null,
      surface: surface(),
    } as GpuEngineVideoPresentedFrame["receipt"];
    expect(sceneLinearAces2PresentContractValid(receipt)).toBe(true);
    expect(sceneLinearAces2PresentContractValid({ ...receipt, workingFormat: undefined })).toBe(false);
    expect(sceneLinearAces2PresentContractValid({ ...receipt, productPathCpuPixelCopies: 1 as 0 })).toBe(false);
    expect(sceneLinearAces2PresentContractValid({ ...receipt, shaderOperationCount: undefined })).toBe(false);
    expect(sceneLinearAces2PresentContractValid({ ...receipt, matteExecutionMode: undefined })).toBe(false);
    expect(sceneLinearAces2PresentContractValid({ ...receipt, depthExecutionMode: undefined })).toBe(false);
    expect(sceneLinearAces2PresentContractValid({ ...receipt, outputSpace: "rec2100_pq_1000" })).toBe(false);
  });

  it("binds the PQ processor receipt to the PQ surface and rejects an SDR/PQ mismatch", () => {
    const pqSurface = surface({
      surfaceFormat: "Rgb10a2Unorm", surfaceColorSpace: "Bt2100Pq", requestedColorSpace: "rec2100_pq_1000",
      pixelContract: "rec2020-pq-encoded-rgb/v1", hdrTransportConfigured: true, legacyVideoPresentationAllowed: false,
    });
    const receipt = {
      sceneLinearExecution: true, workingColorSpace: "linear_rec709", workingFormat: "rgba16_float",
      displayTransform: "editkin-ocio-aces2-linear-rec709-to-rec2100-pq-1000/v1", outputSpace: "rec2100_pq_1000",
      lutSha256: "0cad3aecbc3c5e12aec4f0c489bea6eb5a3a4c0e322aa28010468b856b6b121f",
      lutPayloadSha256: "2c400e0cb185ba44ceecf19aae2ddbd5d90a976f39f43d324ff8bc118ef9f7e1",
      inputTransform: "editkin-srgb-to-linear-rec709-primary/v1", ocioVersion: "2.5.2", acesVersion: "2.0",
      configSha256: "eda5b0008a43b72b98ad540e32eb0eb83b340dde54e35bddba64ccbafac1029a", productPathCpuPixelCopies: 0,
      effectExecutionMode: "none", shaderOperationCount: 0, builtInEffectCount: 0,
      temporalExecutionMode: "none", temporalLayerCount: 0, temporalSampleTextureCount: 0,
      matteExecutionMode: "none", mattePassCount: 0, depthExecutionMode: "none", depthFormat: "none", depthTestedLayerCount: 0, depthPassCount: 0,
      depthOfFieldExecutionMode: "none", depthOfFieldDepthSource: "none", depthOfFieldPassCount: 0, depthOfField: null, surface: pqSurface,
    } as GpuEngineVideoPresentedFrame["receipt"];
    expect(sceneLinearAces2PresentContractValid(receipt, "rec2100_pq_1000")).toBe(true);
    expect(sceneLinearAces2PresentContractValid({ ...receipt, surface: surface() }, "rec2100_pq_1000")).toBe(false);
    expect(sceneLinearAces2PresentContractValid(receipt, "rec709_sdr")).toBe(false);
  });

  it("accepts the exact Depth32Float camera lens route and rejects synthetic coverage", () => {
    const depthOfField = { contract: "camera_depth_of_field/v1", nodeId: "scene25d:depth-of-field", focusDistance: 3.25, aperture: 3.5,
      maxBlurRadius: 14, near: .1, far: 20, executionMode: "scene-linear-depth32f-gather-dof/v1", depthSource: "depth32_float",
      executor: "wgpu-depth-aware-gather/v1", passCount: 1, animationContract: "static/v1", keyframeCount: 0, sampledTimelineFrame: 0 } as const;
    const receipt = {
      sceneLinearExecution: true, workingColorSpace: "linear_rec709", workingFormat: "rgba16_float",
      displayTransform: "editkin-ocio-aces2-linear-rec709-to-rec709-sdr/v1", outputSpace: "rec709_sdr",
      lutSha256: "0808837eb979b6f59e79db411f6bd861469456a89bf399ffe652a99bf0c454b3", lutPayloadSha256: null,
      inputTransform: "editkin-srgb-to-linear-rec709-primary/v1",
      ocioVersion: "2.5.2", acesVersion: "2.0", configSha256: "eda5b0008a43b72b98ad540e32eb0eb83b340dde54e35bddba64ccbafac1029a",
      productPathCpuPixelCopies: 0, effectExecutionMode: "none", shaderOperationCount: 0, builtInEffectCount: 0,
      temporalExecutionMode: "none", temporalLayerCount: 0, temporalSampleTextureCount: 0, matteExecutionMode: "none", mattePassCount: 0,
      compositeExecutionMode: "scene-linear-depth32f-gather-dof/v1", compositeLayerCount: 2, compositeMaximumLayersPerPass: 2, compositeFullFramePassCount: 3,
      depthExecutionMode: "scene-linear-depth32f-opaque-planes/v1", depthFormat: "depth32_float", depthTestedLayerCount: 2, depthPassCount: 1,
      depthOfFieldExecutionMode: "scene-linear-depth32f-gather-dof/v1", depthOfFieldDepthSource: "depth32_float", depthOfFieldPassCount: 1, depthOfField,
      surface: surface(),
    } as GpuEngineVideoPresentedFrame["receipt"];
    const graph = { nodes: [
      { id: "scene25d:camera", kind: "camera", inputs: [], near: .1, far: 20 },
      { id: "scene25d:depth-of-field", kind: "depth_of_field", inputs: ["scene25d:composite", "scene25d:camera"], focusDistance: 3.25, aperture: 3.5, maxBlurRadius: 14 },
    ] } as unknown as EngineRenderGraph;
    expect(sceneLinearAces2PresentContractValid(receipt)).toBe(true);
    expect(sceneLinearCompositeReceiptMatches(receipt, 2, 0)).toBe(true);
    expect(depthOfFieldCoverageMatches(depthOfField, graph)).toBe(true);
    expect(depthOfFieldCoverageMatches({ ...depthOfField, depthSource: "synthetic" as "depth32_float" }, graph)).toBe(false);
    const animatedGraph = structuredClone(graph);
    animatedGraph.nodes[1].keyframes = [{ frame: 10, focusDistance: 4.75, aperture: 5.5, maxBlurRadius: 18, easing: "ease_in_out" }];
    const animated = { ...depthOfField, focusDistance: 4, aperture: 4.5, maxBlurRadius: 16,
      animationContract: "timeline-keyframes/v1" as const, keyframeCount: 1, sampledTimelineFrame: 5 };
    expect(depthOfFieldCoverageMatches(animated, animatedGraph, 5)).toBe(true);
    expect(depthOfFieldCoverageMatches({ ...animated, sampledTimelineFrame: 4 }, animatedGraph, 5)).toBe(false);
    expect(sceneLinearCompositeReceiptMatches({ ...receipt, compositeFullFramePassCount: 2 }, 2, 0)).toBe(false);
  });
});
