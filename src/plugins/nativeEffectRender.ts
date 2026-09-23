import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, particleSimulationEmitters, type EditProject, type TimelineClip } from "../domain/types";
import { isTransformMotionBlurInstance, transformMotionBlurParameters } from "../domain/transformMotionBlur";
import { buildGpuEngineVideoPreviewGraph } from "../render/gpuCompositor";
import { buildRenderPlan } from "../render/planner";
import type { RenderPlan, RenderSegment } from "../render/planner";
import { compareUtf8Bytes } from "../shared/utf8ByteOrder";
import { discoverInstalledPlugins, resolveGpuEffectGraphBindings, resolveNativeEffectBinding } from "./registry";
import type { NativeEffectPreviewReceipt, NativeEffectPreviewRuntime, NativeEffectRenderReceipt, NativeEffectRenderRuntime } from "./nativeEffectTypes";
export type { NativeEffectPreviewReceipt, NativeEffectPreviewRuntime, NativeEffectRenderReceipt, NativeEffectRenderRuntime } from "./nativeEffectTypes";
import { runProcess, sha256File } from "./nativeEffectGpuSequence";
import { materializeNativeEffectSegments, videoSegments } from "./nativeEffectMaterialization";
export { materializeNativeEffectSegments } from "./nativeEffectMaterialization";

/** Removes only authored layers proven to be baked into a resident-GPU sequence.
 * The source project remains immutable so preview, autosave, and later edits keep authored state. */
export function projectAfterNativeEffectMaterialization(
  project: EditProject,
  receipt: NativeEffectRenderReceipt | undefined,
): EditProject {
  const bakedCaptionIds = new Set(receipt?.clips.flatMap((clip) => clip.gpu?.typography?.captionCueIds ?? []) ?? []);
  const bakedMotionGraphicIds = new Set(receipt?.clips.flatMap((clip) => clip.gpu?.typography?.motionGraphicIds ?? []) ?? []);
  const bakedAdjustmentClipIds = new Set(receipt?.clips.flatMap((clip) => clip.gpu?.adjustment?.adjustmentClipIds ?? []) ?? []);
  const bakedMatteTargetClipIds = new Set(receipt?.clips.flatMap((clip) => clip.gpu?.matte?.targetClipIds ?? []) ?? []);
  const bakedOverlayClipIds = new Set(receipt?.clips.flatMap((clip) => clip.gpu?.composite?.overlayClipIds ?? []) ?? []);
  const bakedParticleSimulation = receipt?.clips.some((clip) => clip.gpu?.particle?.contract === "decoded-temporal-particle-overlay/v1"
    || clip.gpu?.particle?.contract === "decoded-temporal-multi-particle-overlay/v1") === true;
  const bakedOverlayRanges = new Map<string, Array<{ timelineStartFrame: number; durationFrames: number }>>();
  for (const range of receipt?.clips.flatMap((clip) => clip.gpu?.composite?.timelineRanges ?? []) ?? []) {
    if (range.fullyMaterialized || range.durationFrames <= 0 || bakedOverlayClipIds.has(range.clipId)) continue;
    const ranges = bakedOverlayRanges.get(range.clipId) ?? [];
    ranges.push({ timelineStartFrame: range.timelineStartFrame, durationFrames: range.durationFrames });
    bakedOverlayRanges.set(range.clipId, ranges);
  }
  const bakedVideoClipIds = new Set([...bakedAdjustmentClipIds, ...bakedMatteTargetClipIds, ...bakedOverlayClipIds]);
  if (!bakedCaptionIds.size && !bakedMotionGraphicIds.size && !bakedVideoClipIds.size && !bakedOverlayRanges.size && !bakedParticleSimulation) return project;
  const keepUnmaterializedRanges = (clip: TimelineClip): TimelineClip[] => {
    const ranges = bakedOverlayRanges.get(clip.id);
    if (!ranges?.length) return [clip];
    let pieces = [structuredClone(clip)];
    for (const range of ranges.sort((left, right) => left.timelineStartFrame - right.timelineStartFrame)) {
      const rangeStart = range.timelineStartFrame / project.fps;
      const rangeEnd = rangeStart + range.durationFrames / project.fps;
      pieces = pieces.flatMap((piece) => {
        const pieceStart = piece.timelineStart;
        const pieceEnd = pieceStart + piece.duration;
        const overlapStart = Math.max(pieceStart, rangeStart);
        const overlapEnd = Math.min(pieceEnd, rangeEnd);
        if (overlapEnd <= overlapStart + 1e-6) return [piece];
        const next: TimelineClip[] = [];
        if (pieceStart < overlapStart - 1e-6) next.push({ ...structuredClone(piece), duration: overlapStart - pieceStart });
        if (pieceEnd > overlapEnd + 1e-6) {
          next.push({
            ...structuredClone(piece),
            id: next.length ? `${piece.id}__unbaked_${Math.round(overlapEnd * project.fps)}` : piece.id,
            timelineStart: overlapEnd,
            sourceStart: piece.sourceStart + overlapEnd - pieceStart,
            duration: pieceEnd - overlapEnd,
          });
        }
        return next;
      });
    }
    return pieces;
  };
  return {
    ...project,
    tracks: bakedVideoClipIds.size || bakedOverlayRanges.size ? project.tracks.map((track) => ({
      ...track,
      clips: track.clips.flatMap((clip) => bakedVideoClipIds.has(clip.id) ? [] : keepUnmaterializedRanges(clip)),
    })) : project.tracks,
    captions: project.captions.filter((cue) => !bakedCaptionIds.has(cue.id)),
    motionGraphics: project.motionGraphics.filter((graphic) => !bakedMotionGraphicIds.has(graphic.id)),
    particleSimulation: bakedParticleSimulation ? undefined : project.particleSimulation,
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareUtf8Bytes(left, right))
      .map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

async function existingPreviewReceipt(
  receiptPath: string,
  outputPath: string,
  cacheKey: string,
): Promise<NativeEffectPreviewReceipt | undefined> {
  try {
    const parsed = JSON.parse(await readFile(receiptPath, "utf8")) as NativeEffectPreviewReceipt;
    if (parsed.schema !== "editkin.native-effect-preview/v1" || parsed.status !== "GREEN" || parsed.cacheKey !== cacheKey) return undefined;
    const output = await stat(outputPath);
    if (!output.isFile() || output.size <= 0 || parsed.sha256 !== await sha256File(outputPath)) return undefined;
    return { ...parsed, path: outputPath, cacheHit: true };
  } catch {
    return undefined;
  }
}

async function acquirePreviewLock(lockPath: string, receiptPath: string, outputPath: string, cacheKey: string, timeoutMs: number): Promise<"owned" | NativeEffectPreviewReceipt> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const cached = await existingPreviewReceipt(receiptPath, outputPath, cacheKey);
    if (cached) return cached;
    try {
      await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, { encoding: "utf8", flag: "wx" });
      return "owned";
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      try {
        const lock = await stat(lockPath);
        if (Date.now() - lock.mtimeMs > Math.max(timeoutMs * 2, 300_000)) await unlink(lockPath);
      } catch { /* Another process completed or reclaimed the lock. */ }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    }
  }
  throw new Error("原生特效預覽快取鎖等待逾時");
}

async function encodePreviewProxy(
  intermediatePath: string,
  sourcePath: string,
  assetKind: "video" | "image",
  clip: TimelineClip,
  outputPath: string,
  project: EditProject,
  runtime: NativeEffectPreviewRuntime,
): Promise<boolean> {
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", intermediatePath];
  if (assetKind === "video") args.push("-ss", String(clip.sourceStart), "-t", String(clip.duration), "-i", sourcePath);
  args.push(
    "-map", "0:v:0",
    ...(assetKind === "video" ? ["-map", "1:a:0?"] : []),
    "-frames:v", String(Math.round(clip.duration * project.fps)),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
    ...(assetKind === "video" ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"]),
    "-movflags", "+faststart", "-t", String(clip.duration), outputPath,
  );
  await runProcess(runtime.ffmpegPath, args, runtime.timeoutMs);
  if (assetKind !== "video") return false;
  try {
    await runProcess(runtime.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", outputPath, "-map", "0:a:0", "-t", "0.02", "-f", "null", "-"], Math.min(runtime.timeoutMs, 30_000));
    return true;
  } catch {
    return false;
  }
}

/** Builds a WebView-compatible preview proxy with the exact same isolated CPU
 * native-effect sequence used by formal export. It is intentionally labelled a
 * cache preview: it is not a resident GPU plugin execution path. */
export async function renderNativeEffectPreviewProxy(
  project: EditProject,
  clipId: string,
  runtime: NativeEffectPreviewRuntime,
): Promise<NativeEffectPreviewReceipt> {
  const track = project.tracks.find((candidate) => candidate.kind === "video" && candidate.clips.some((clip) => clip.id === clipId));
  const clip = track?.clips.find((candidate) => candidate.id === clipId);
  if (!track || !clip) throw new Error(`原生特效預覽只支援專案根層視訊片段：${clipId}`);
  const enabled = clip.creative?.nativeEffectInstances?.filter((instance) => instance.enabled && instance.runtimeType !== "gpu_effect_graph") ?? [];
  if (!enabled.length) throw new Error(`片段沒有啟用的原生特效：${clipId}`);
  const asset = project.assets.find((candidate) => candidate.id === clip.assetId);
  if (!asset || asset.kind === "audio" || asset.compositionId) throw new Error(`原生特效快取預覽目前只接受根層影片／圖片素材：${clipId}`);
  if (project.colorManagement?.mode === "aces2") throw new Error("第三方原生效果尚未宣告 ACES scene-linear contract，已阻擋預覽");
  if (!runtime.pluginRoots.length) throw new Error("原生效果預覽缺少 Plugin runtime");
  await Promise.all([access(runtime.ffmpegPath), access(runtime.nativeCorePath), mkdir(runtime.cacheRoot, { recursive: true })]);
  const sourcePath = resolve(runtime.assetBase ?? process.cwd(), asset.uri);
  const sourceStat = await stat(sourcePath);
  if (!sourceStat.isFile()) throw new Error(`原生特效預覽來源不是檔案：${sourcePath}`);
  const registry = await discoverInstalledPlugins(runtime.pluginRoots);
  for (const instance of enabled) resolveNativeEffectBinding(registry, instance);
  const cacheIdentity = stableValue({
    schema: "editkin.native-effect-preview-cache-key/v1",
    project: { width: project.width, height: project.height, fps: project.fps, colorManagement: project.colorManagement ?? null },
    clip: { id: clip.id, assetId: clip.assetId, timelineStart: clip.timelineStart, sourceStart: clip.sourceStart, duration: clip.duration, nativeEffectInstances: enabled },
    asset: { kind: asset.kind, color: asset.color ?? null, sourcePath, size: sourceStat.size, mtimeMs: sourceStat.mtimeMs },
  });
  const cacheKey = createHash("sha256").update(JSON.stringify(cacheIdentity)).digest("hex");
  const cacheDirectory = join(runtime.cacheRoot, "native-effect-preview");
  await mkdir(cacheDirectory, { recursive: true });
  const outputPath = join(cacheDirectory, `${cacheKey}.mp4`);
  const receiptPath = join(cacheDirectory, `${cacheKey}.json`);
  const lockPath = join(cacheDirectory, `${cacheKey}.lock`);
  const cached = await existingPreviewReceipt(receiptPath, outputPath, cacheKey);
  if (cached) return cached;
  const lock = await acquirePreviewLock(lockPath, receiptPath, outputPath, cacheKey, runtime.timeoutMs);
  if (lock !== "owned") return lock;
  const workspace = join(cacheDirectory, `.work-${cacheKey}-${process.pid}-${Date.now()}`);
  try {
    const cachedAfterLock = await existingPreviewReceipt(receiptPath, outputPath, cacheKey);
    if (cachedAfterLock) return cachedAfterLock;
    await Promise.all([rm(outputPath, { force: true }), rm(receiptPath, { force: true })]);
    await mkdir(workspace, { recursive: true });
    const plan = buildRenderPlan(project, (uri) => resolve(runtime.assetBase ?? process.cwd(), uri));
    const effectReceipt = await materializeNativeEffectSegments(project, plan, {
      ffmpegPath: runtime.ffmpegPath,
      nativeCorePath: runtime.nativeCorePath,
      pluginRoots: runtime.pluginRoots,
      workspace,
      timeoutMs: runtime.timeoutMs,
      targetClipIds: new Set([clipId]),
    });
    if (!effectReceipt || effectReceipt.clipCount !== 1 || effectReceipt.clips[0].clipId !== clipId) throw new Error("原生特效預覽沒有產生唯一片段 receipt");
    const segment = videoSegments(plan).find((candidate) => candidate.clip.id === clipId);
    if (!segment) throw new Error(`原生特效預覽找不到已 materialize 的片段：${clipId}`);
    const temporaryOutput = join(workspace, "preview.mp4");
    const audioSourceRetained = await encodePreviewProxy(segment.assetPath, sourcePath, asset.kind, clip, temporaryOutput, project, runtime);
    const sha256 = await sha256File(temporaryOutput);
    const receipt: NativeEffectPreviewReceipt = {
      schema: "editkin.native-effect-preview/v1",
      status: "GREEN",
      mode: "cached-cpu-native-sequence/v1",
      clipId,
      cacheKey,
      cacheHit: false,
      path: outputPath,
      sha256,
      sourceStart: 0,
      duration: clip.duration,
      width: project.width,
      height: project.height,
      fps: project.fps,
      audioSourceRetained,
      effectReceipt,
    };
    const temporaryReceipt = join(workspace, "preview.json");
    await writeFile(temporaryReceipt, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    await rename(temporaryOutput, outputPath);
    await rename(temporaryReceipt, receiptPath);
    return receipt;
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await unlink(lockPath).catch(() => undefined);
  }
}
