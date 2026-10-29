// Free-space precheck: refuse an export before it starts when its output or work drive cannot hold it.
import { stat, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, parse, resolve } from "node:path";
import type { EditProject } from "../domain/types";
import type { RenderPlan } from "./planner";
import type { VideoEncoder } from "./ffmpegTypes";
import { currentRenderWorkRoot } from "./renderWorkspace";
import { usesAces16PrecompositionV1 } from "./aces16PrecompositionV1";

export type DiskRequirementKind = "output" | "work" | "system-temp";
/** Bytes an export will write under `path` (output file, work directory) or a minimum the OS temp drive must keep. */
export interface DiskRequirement { path: string; bytes: number; kind: DiskRequirementKind }
export interface VolumeSpace { key: string; root: string; availableBytes: number }
/** Returns undefined when the volume cannot be measured; such a volume never blocks an export. */
export type DiskSpaceProbe = (path: string) => Promise<VolumeSpace | undefined>;

/** Estimates are typical-high, not exact; this margin plus a small reserve keeps the drive from filling up completely. */
export const DISK_ESTIMATE_MARGIN = 1.15;
export const DISK_SAFETY_RESERVE_BYTES = 32 * 1024 ** 2;
/** When the OS temp directory is on another drive, small helper files still need a little space there. */
export const SYSTEM_TEMP_MINIMUM_BYTES = 16 * 1024 ** 2;
/** Caption/motion ASS, filter-graph scripts and the short native audio mixdown of one export. */
export const RENDER_WORK_FIXED_BYTES = 16 * 1024 ** 2;

const MIB = 1024 ** 2, GIB = 1024 ** 3;
export function formatDiskBytes(bytes: number): string {
  return bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GB` : `${Math.max(1, Math.ceil(bytes / MIB))} MB`;
}

async function nearestExistingPath(path: string): Promise<string | undefined> {
  let candidate = resolve(path);
  for (;;) {
    try {
      await stat(candidate);
      return candidate;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = dirname(candidate);
      if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === candidate) return undefined;
      candidate = parent;
    }
  }
}

export const probeVolumeSpace: DiskSpaceProbe = async path => {
  const existing = await nearestExistingPath(path);
  if (!existing) return undefined;
  try {
    const [info, space] = await Promise.all([stat(existing, { bigint: true }), statfs(existing, { bigint: true })]);
    const availableBytes = Number(space.bavail * space.bsize);
    if (!Number.isFinite(availableBytes) || availableBytes < 0) return undefined;
    const root = parse(existing).root || existing;
    return { key: info.dev ? `dev:${info.dev}` : `root:${root.toLowerCase()}`, root, availableBytes };
  } catch {
    return undefined;
  }
};

export class RenderDiskSpaceError extends Error {
  override name = "RenderDiskSpaceError";
}

/**
 * Groups requirements by volume (output and work directory usually share the output's drive) and throws a zh-TW
 * message naming each short drive, what it has, what this export needs and how much is missing.
 */
export async function assertRenderDiskSpace(requirements: readonly DiskRequirement[], probe: DiskSpaceProbe = probeVolumeSpace): Promise<void> {
  const volumes = new Map<string, { root: string; availableBytes: number; output: number; work: number }>();
  for (const requirement of requirements) {
    if (!Number.isFinite(requirement.bytes) || requirement.bytes < 0) continue;
    const space = await probe(requirement.path);
    if (!space) continue;
    const volume = volumes.get(space.key) ?? { root: space.root, availableBytes: space.availableBytes, output: 0, work: 0 };
    if (requirement.kind === "output") volume.output += requirement.bytes;
    else if (requirement.kind === "work") volume.work += requirement.bytes;
    volumes.set(space.key, volume);
  }
  const shortages: string[] = [];
  for (const volume of volumes.values()) {
    const estimated = volume.output + volume.work;
    const needed = estimated > 0 ? Math.ceil(estimated * DISK_ESTIMATE_MARGIN) + DISK_SAFETY_RESERVE_BYTES : SYSTEM_TEMP_MINIMUM_BYTES;
    if (volume.availableBytes >= needed) continue;
    const parts = estimated > 0 ? [
      ...(volume.output ? [`成片約 ${formatDiskBytes(volume.output)}`] : []),
      ...(volume.work ? [`暫存工作檔約 ${formatDiskBytes(volume.work)}`] : []),
      `另保留 ${formatDiskBytes(needed - estimated)} 安全空間`,
    ] : ["系統暫存資料夾的小型輔助檔"];
    shortages.push(`${volume.root} 只剩 ${formatDiskBytes(volume.availableBytes)}，這次輸出預估需要 ${formatDiskBytes(needed)}（${parts.join("、")}），還差 ${formatDiskBytes(needed - volume.availableBytes)}`);
  }
  if (shortages.length) {
    throw new RenderDiskSpaceError(`磁碟空間不足，已在開始輸出前停止：${shortages.join("；")}。請清出空間，或把影片改存到空間足夠的磁碟後再試；先前的輸出檔沒有被更動。`);
  }
}

/** The output (written next to the requested file), the export's work files, and a little room in the OS temp folder. */
export function exportDiskRequirements(outputPath: string, outputBytes: number, workBytes: number): DiskRequirement[] {
  return [
    { path: resolve(outputPath), bytes: outputBytes, kind: "output" },
    { path: currentRenderWorkRoot() ?? tmpdir(), bytes: RENDER_WORK_FIXED_BYTES + workBytes, kind: "work" },
    { path: tmpdir(), bytes: 0, kind: "system-temp" },
  ];
}

export interface RenderVideoShape { width: number; height: number; fps: number; durationSeconds: number }
// Typical-high bits per pixel at Editkin's encoder settings (H.264 CQ/CRF 18-19, HEVC 10-bit, ProRes 4444 + alpha).
const VIDEO_BITS_PER_PIXEL: Record<VideoEncoder, number> = {
  h264_nvenc: .35, h264_videotoolbox: .35, libx264: .35, hevc_nvenc: .3, hevc_videotoolbox: .3, libx265: .3, prores_ks: 6, ffv1: 64,
};
const frameCount = (shape: RenderVideoShape) => Math.max(0, Math.ceil(shape.durationSeconds * shape.fps));
const pixelCount = (shape: RenderVideoShape) => Math.max(0, shape.width) * Math.max(0, shape.height);

export function planShape(plan: Pick<RenderPlan, "width" | "height" | "fps" | "duration">): RenderVideoShape {
  return { width: plan.width, height: plan.height, fps: plan.fps, durationSeconds: plan.duration };
}

/** Encoded export (video plus AAC, or 24-bit PCM for ProRes alpha masters). */
export function estimateEncodedOutputBytes(shape: RenderVideoShape, encoder: VideoEncoder | string): number {
  const video = frameCount(shape) * pixelCount(shape) * (VIDEO_BITS_PER_PIXEL[encoder as VideoEncoder] ?? .35) / 8;
  const audioBytesPerSecond = (encoder === "prores_ks" || encoder === "ffv1") ? 48_000 * 2 * 3 : 192_000 / 8;
  return Math.ceil((video + Math.max(0, shape.durationSeconds) * audioBytesPerSecond) * 1.01) + 256 * 1024;
}

/** PNG frame sequence written by the native GPU compositor before it is encoded. */
export function estimatePngSequenceBytes(shape: RenderVideoShape, format: "rgba8" | "rgba16_unorm"): number {
  return Math.ceil(frameCount(shape) * pixelCount(shape) * (format === "rgba16_unorm" ? 5 : 2.5));
}

/** Intermediate AAC audio bed of the frame-sequence routes. */
export function estimateAudioBedBytes(durationSeconds: number): number {
  return Math.ceil(Math.max(0, durationSeconds) * 192_000 / 8 * 1.02) + 64 * 1024;
}

/** Short exports (up to 30 s) may decode up to eight sources to float PCM for the native final mix. */
export function estimateNativeAudioWorkBytes(durationSeconds: number): number {
  return durationSeconds > 0 && durationSeconds <= 30 ? Math.ceil(durationSeconds * 48_000 * 2 * 4 * 9) : 0;
}

/** Native effect clips are materialized as raw RGBA, PNG frames and an FFV1 intermediate. */
export function estimateNativeEffectWorkBytes(plan: RenderPlan): number {
  let bytes = 0;
  for (const layer of plan.videoLayers) {
    for (const segment of layer.segments) {
      if (segment.kind !== "clip" || !segment.clip.creative?.nativeEffectInstances?.some(instance => instance.enabled)) continue;
      bytes += Math.ceil(segment.duration * plan.fps) * plan.width * plan.height * 10;
    }
  }
  return bytes;
}

/** Pre-rendered compositions (ProRes 4444 alpha) and the mesh 3D pass are written before the final export starts. */
export function estimatePrepassWorkBytes(project: EditProject): number {
  const compositions = project.compositions.reduce((total, composition) => total
    + estimateEncodedOutputBytes({ width: composition.width, height: composition.height, fps: composition.fps, durationSeconds: composition.duration }, usesAces16PrecompositionV1(composition.colorManagement ?? project.colorManagement) ? "ffv1" : "prores_ks"), 0);
  const meshSeconds = project.scene3d?.enabled ? Math.max(0, ...project.scene3d.segments.map(segment => segment.timelineStart + segment.duration)) : 0;
  const mesh = meshSeconds > 0 ? estimateEncodedOutputBytes({ width: project.width, height: project.height, fps: project.fps, durationSeconds: meshSeconds }, "libx264") * 1.5 : 0;
  return Math.ceil(compositions + mesh);
}
