/** Shared mesh render result contract; independent of either render adapter. */
export interface Mesh3dRenderReceipt {
  schema: "editkin.mesh-3d-render/v1"; executor: "shared-cpu-triangle-zbuffer/v1"; frameCount: number; width: number; height: number;
  maxTriangles: number; durationSeconds: number; renderMilliseconds: number; peakResidentBytes: number; maxFrameMilliseconds: number;
  geometryFonts: { weight: number; file: string; sha256: string }[];
  sources: { clipId: string; sourceSha256: string; sourceStart: number; duration: number; decodedWidth: number; decodedHeight: number }[];
  colorContract: "opaque-rec709-sdr/v1"; lightingContract: "vertex-directional-plus-ambient/no-shadowmap/v1";
  overlaysV1?: { bindingsSha256: string; compositor: "shared-project-frame/v1"; depth: "float64" };
}
