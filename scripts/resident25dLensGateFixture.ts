import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { PNG } from "pngjs";
import { createEmptyProject, validateProject } from "../src/domain/editGraph";
import { projectSchema } from "../src/domain/schema";
import { DEFAULT_COLOR, DEFAULT_SCENE_25D, DEFAULT_TRANSFORM, type EditProject, type Scene25dSettings } from "../src/domain/types";
import { buildGpuEngineVideoPreviewGraph } from "../src/render/gpuCompositor";

const runFile = promisify(execFile);
export const root = resolve(import.meta.dirname, "..");
export const lensEvidenceRoot = resolve(root, "..", "..", ".rd", "benchmarks", "editkin-resident-25d-depth-of-field-video-project-render");
export const ffmpeg = resolve(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
export const ffprobe = resolve(root, "vendor/ffmpeg/win32-x64/ffprobe.exe");
export const nearSource = resolve(lensEvidenceRoot, "near-detail-h264.mp4");
export const farSource = resolve(lensEvidenceRoot, "far-detail-h264.mp4");
export const fps = 30;
export const frameCount = 12;
export const nearFocus = 3.25;
export const farFocus = 4.75;

export type LensSettings = Scene25dSettings["depthOfField"];
export interface PixelDelta { changed: number; high: number; maximum: number }

export async function ensureLensDetailSources(): Promise<void> {
  await mkdir(lensEvidenceRoot, { recursive: true });
  const source = resolve(root, "public/demo-source.mp4");
  const create = async (output: string, matrix: string) => runFile(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", source,
    "-t", "1.2", "-vf", `scale=960:540:force_original_aspect_ratio=increase,crop=960:540,unsharp=7:7:2.2:7:7:0,colorchannelmixer=${matrix},format=yuv420p`,
    "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-c:a", "aac", "-b:a", "128k",
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-movflags", "+faststart", output], { windowsHide: true, timeout: 60_000 });
  await Promise.all([create(nearSource, "rr=1.35:gg=.72:bb=.72"), create(farSource, "rr=.72:gg=.82:bb=1.35")]);
}

export function createLensProject(options: { focusDistance?: number; enabled?: boolean; order?: "near-far" | "far-near"; keyframes?: LensSettings["keyframes"] } = {}): EditProject {
  const { focusDistance = nearFocus, enabled = true, order = "near-far", keyframes = [] } = options;
  const value = createEmptyProject("Resident 2.5D camera depth of field", { width: 960, height: 540, fps });
  value.assets.push(
    { id: "near-video", name: "Near detail H.264", kind: "video", uri: nearSource, duration: 1.2, width: 960, height: 540, alphaMode: "opaque", color: { interpretation: "rec709" } },
    { id: "far-video", name: "Far detail H.264", kind: "video", uri: farSource, duration: 1.2, width: 960, height: 540, alphaMode: "opaque", color: { interpretation: "rec709" } },
  );
  const base = { timelineStart: 0, sourceStart: 0, duration: frameCount / fps, volume: .5, transform: { ...DEFAULT_TRANSFORM },
    color: { ...DEFAULT_COLOR }, keyframes: [], creative: { effectPresetIds: [], nativeEffectInstances: [] },
    layer: { enabled: true, blendMode: "normal" as const, role: "content" as const } };
  const near = { ...structuredClone(base), id: "near-plane", assetId: "near-video", trackId: "near-track",
    transform3d: { position: [-.95, 0, .75] as [number, number, number], rotationDegrees: [0, 0, 0] as [number, number, number], scale: [.72, .72, 1] as [number, number, number] } };
  const far = { ...structuredClone(base), id: "far-plane", assetId: "far-video", trackId: "far-track",
    transform3d: { position: [1, 0, -.75] as [number, number, number], rotationDegrees: [0, 0, 0] as [number, number, number], scale: [1.05, 1.05, 1] as [number, number, number] } };
  const tracks = {
    near: { id: "near-track", name: "Near focus plane", kind: "video" as const, locked: false, muted: false, clips: [near] },
    far: { id: "far-track", name: "Far focus plane", kind: "video" as const, locked: false, muted: false, clips: [far] },
  };
  value.tracks = order === "near-far" ? [tracks.near, tracks.far] : [tracks.far, tracks.near];
  value.scene25d = structuredClone(DEFAULT_SCENE_25D);
  value.scene25d.depthOfField = { enabled, focusDistance, aperture: 3.5, maxBlurRadius: 14, keyframes: structuredClone(keyframes) };
  value.scene25d.ambientLight.intensity = .4;
  value.scene25d.directionalLight = { color: [1, .96, .9], intensity: .8, direction: [.2, -.2, 1], keyframes: [] };
  value.colorManagement = { ...value.colorManagement!, mode: "aces2", outputTransform: "rec709_sdr" };
  return value;
}

export function lensRouteAccepted(value: EditProject, expectsDof = true): boolean {
  try {
    const parsed = projectSchema.parse(JSON.parse(JSON.stringify(value)));
    const graph = buildGpuEngineVideoPreviewGraph(validateProject(parsed), 0);
    return Boolean(graph?.scene25dExpectation) && (!expectsDof || graph!.graph.nodes.some((node) => node.kind === "depth_of_field"));
  } catch { return false; }
}

export function setLens(value: EditProject, patch: Partial<LensSettings>): void {
  value.scene25d!.depthOfField = { ...value.scene25d!.depthOfField, ...patch };
}

export function comparePixels(left: PNG, right: PNG): PixelDelta {
  let changed = 0; let high = 0; let maximum = 0;
  for (let offset = 0; offset < left.data.length; offset += 4) {
    const delta = Math.abs(left.data[offset] - right.data[offset]) + Math.abs(left.data[offset + 1] - right.data[offset + 1]) + Math.abs(left.data[offset + 2] - right.data[offset + 2]);
    maximum = Math.max(maximum, delta); if (delta > 8) changed += 1; if (delta > 32) high += 1;
  }
  return { changed, high, maximum };
}
