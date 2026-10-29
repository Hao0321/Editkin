/** Shared mesh render result contract; independent of either render adapter. */
export interface Mesh3dRenderReceipt {
  schema: "editkin.mesh-3d-render/v1";
  /** v1: original per-vertex scenes. v2: the same CPU z-buffer with per-pixel shading, blended glyph/line draws and scene post (engine extension 2026-10-23). */
  executor: "shared-cpu-triangle-zbuffer/v1" | "shared-cpu-triangle-zbuffer/v2"; frameCount: number; width: number; height: number;
  maxTriangles: number; durationSeconds: number; renderMilliseconds: number; peakResidentBytes: number; maxFrameMilliseconds: number;
  geometryFonts: { weight: number; file: string; sha256: string }[];
  /** Bundled faces (compiled catalog ID, file, verified SHA-256) of text_extrude / band_text objects; present only when the scene uses them. */
  textFaces?: { faceId: string; file: string; sha256: string }[];
  sources: { clipId: string; sourceSha256: string; sourceStart: number; duration: number; decodedWidth: number; decodedHeight: number }[];
  colorContract: "opaque-rec709-sdr/v1";
  /**
   * vertex-…/v1: every draw lit per vertex (key + ambient). per-pixel-…/v1: the scene opts into fill/hemisphere light,
   * radial background, post or a polish key light (size, distance, shadow), so every draw is shaded per pixel.
   * vertex-plus-per-pixel-materials/v1: only objects with extended materials, glyph masks or "front" UV modes are shaded
   * per pixel; the rest keep the per-vertex path. …/soft-shadowmap/v1 (polish): the same per-pixel contract with the key
   * light's soft shadow map (scene light.shadow); every other scene keeps …/no-shadowmap/v1.
   */
  lightingContract: "vertex-directional-plus-ambient/no-shadowmap/v1" | "per-pixel-key-fill-hemisphere-specular/no-shadowmap/v1"
    | "vertex-plus-per-pixel-materials/no-shadowmap/v1" | "per-pixel-key-fill-hemisphere-specular/soft-shadowmap/v1";
  /** Scene post effects in application order (ao after the motion-blur average); present only when the scene declares `post`. */
  post?: Array<"dof" | "bloom" | "motionBlur" | "fisheye" | "vignette" | "ao">;
  /**
   * Polish lighting the scene uses; present only when it uses any. "ggx-roughness": a material's GGX roughness (specular
   * lobe and blurred reflection). "area-key": a key light of angular size (light.size > 0). "sphere-key": a positional key
   * light at light.distance with falloff.
   */
  lightingFeatures?: Array<"ggx-roughness" | "area-key" | "sphere-key">;
  overlaysV1?: { bindingsSha256: string; compositor: "shared-project-frame/v1"; depth: "float64" };
  /**
   * tube_set geometry (2026-10-29); present only when the scene uses it: objects, polylines and instanced tips over all
   * segments, and the most triangles (tips included) the tube sets of one segment draw in a frame (each at its largest
   * extent: highest growth, widest reveal windows).
   */
  tubeSets?: { objects: number; polylines: number; tips: number; maxTriangles: number };
  /**
   * CPU execution of the job (mesh3dParallel): `workers` threads in the job's worker pool (0 = calling thread only) and
   * `poolFrames` frames they rendered; `fallback` says why the rest ran on the calling thread. Bytes do not depend on it.
   */
  parallel?: { workers: number; poolFrames: number; fallback?: string };
}
