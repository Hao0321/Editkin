export type GpuEngineDisplayTransform =
  | "scene_linear_preview"
  | "aces2_rec709_sdr"
  | "aces2_rec2100_pq1000";

export interface GpuNativePreviewSurfaceRequest {
  x: number;
  y: number;
  width: number;
  height: number;
  surfaceColorSpace?: "srgb" | "rec2100_pq_1000";
}

export interface GpuNativePreviewSurface {
  bound: true;
  backend: "Dx12";
  surfaceFormat: string;
  presentMode: string;
  width: number;
  height: number;
  presentCount: number;
  cpuPixelReadbacks: 0;
  nativeSwapChain: true;
  surfaceColorSpace: "Auto" | "Bt2100Pq" | "ExtendedSrgbLinear";
  requestedColorSpace: "srgb" | "bt2100_pq" | "rec2100_pq_1000" | "scrgb" | "extended_srgb_linear";
  pixelContract: "legacy-sdr-video/v1" | "rec709-encoded-sdr-video/v2" | "rec2020-pq-encoded-rgb/v1" | "rec709-linear-scrgb/v1";
  hdrTransportConfigured: boolean;
  legacyVideoPresentationAllowed: boolean;
  dxgiColorSpaceConfiguration: "wgpu-dx12-IDXGISwapChain3-SetColorSpace1/v1";
  physicalDisplayHdrVisibility: "advisory-unverified";
  liveDisplayHeadroomMeasured: boolean;
  visible: boolean;
  displayHdrInfo: {
    advisoryOnly: true;
    bitsPerColor: number | null;
    chromaticity: {
      red: [number, number]; green: [number, number]; blue: [number, number]; white: [number, number];
    } | null;
    coarse: { gamut: string | null; highDynamicRange: boolean } | null;
    luminance: { minNits: number | null; maxNits: number | null; maxFullFrameNits: number | null; sdrWhiteNits: number | null } | null;
    headroom: { current: number | null; potential: number | null; reference: number | null } | null;
    toneMapHeadroom: number | null;
  };
  compositeExecutionMode?: "dirty-rect-ping-pong/v1" | "fused-four-layer/v1";
  compositeLayerCount?: number;
  compositeDirtyRectLayerCount?: number;
  compositeTextureCopyCount?: number;
  compositeFullFramePassCount?: number;
  compositeMaximumLayersPerPass?: number;
  adjustmentExecutionMode?: "none" | "trailing-full-frame/v1" | "pre-typography-full-frame/v1" | null;
  adjustmentBaseLayerCount?: number;
  adjustmentPassCount?: number;
  matteExecutionMode?: "none" | "sampled-track-matte/v1" | null;
  mattePassCount?: number;
  scaleFactor?: number;
  hostMode?: "screen-aligned-companion";
  hostClientOrigin?: { x: number; y: number };
  logicalBounds?: { x: number; y: number; width: number; height: number };
}
