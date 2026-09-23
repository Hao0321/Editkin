import { createHash } from "node:crypto";
import { collectRenderArtifactIdentity } from "./renderArtifactIdentity";
import { renderReviewContentJson } from "../shared/renderReviewContent";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import type { ClipMask, EditProject, MediaAsset, OpenExrImageSequence, TimelineClip, TrackMatteMode } from "../domain/types";
import { acesOutputFilter, inputNormalizationFilters, primaryExposureFilter, primaryToneFilters } from "../color/primaryGrade";
import { DEFAULT_COLOR_MANAGEMENT } from "../domain/types";
import { projectFromComposition, validateProject } from "../domain/editGraph";
import { buildRenderPlan } from "./planner";
import type { RenderAudioClip, RenderPlan, RenderSegment } from "./planner";
import { compileNativeEngineGraph, createNativePlan, nativeCoreAvailable } from "./nativeCore";
import { buildEngineRenderGraph } from "./engineGraph";
import {
  effectFilters,
  lookColorTerms,
  transitionBrightnessExpression,
  transitionOpacityExpression,
  transitionScaleExpression,
  transitionXExpression,
} from "./creativeFilters";
import { buildAssFilter, writeAssContent } from "./captionAss";
import { resolveAssFontRoot } from "./fontRoot";
import { materializeNativeEffectSegments, projectAfterNativeEffectMaterialization, type NativeEffectRenderReceipt } from "../plugins/nativeEffectRender";
import { buildAces2DisplayVideoRenderRequest, containsSceneLinearMedia, type NativeAces2OutputTransform } from "./aces2SdrVideo";
import { buildGpuEngineVideoPreviewGraph, type GpuEngineVideoPreviewGraph } from "./gpuCompositor";
import type { ResidentSceneLinearVideoSequenceReceipt } from "./residentSceneLinearVideoSequence";
import { renderResidentSceneLinearAces2VideoProject } from "./residentSceneLinearVideoProject";
import { verifyFrozenRotoMatte } from "./autoRotoMatteIntegrity";
import {
  colorExpression,
  composedTransformExpressions,
  escapeExpression,
  ffmpegBlendMode,
  ffmpegBlendNeutral,
  finite,
  hasPrimaryToneAdjustment,
  sourceAlphaNormalizationFilters,
} from "./ffmpegExpressions";
export { buildAssFilter, writeAssContent } from "./captionAss";
export { sourceAlphaNormalizationFilters } from "./ffmpegExpressions";

export * from "./ffmpegTypes";
export { masterAudioFilter, probeMedia, resolveMediaPath, shouldUseNativeFinalAudio } from "./ffmpegMedia";
import type { MediaProbe, RenderOptions, RenderResult, VideoEncoder } from "./ffmpegTypes";
import { countDecodableNativeAudioSources, masterAudioFilter, prepareNativeFinalAudio, probeMedia, resolveMediaPath, runProcess, shouldUseNativeFinalAudio } from "./ffmpegMedia";
import { chooseEncoder, encoderArgs, isHdrOutput, renderComposite } from "./ffmpegComposite";
import {
  HIGH_BIT_DEPTH_ALPHA_PROFILE,
  assertHighBitDepthAlphaDeliveryProject,
  assertHighBitDepthAlphaOutputProbe,
  buildHighBitDepthAlphaDeliveryReceipt,
  probeHighBitDepthAlphaCapability,
} from "./highBitDepthAlphaDelivery";

interface NativeAces2DisplayReceipt {
  schema: "editkin.ocio-display-sequence/v1";
  status: "GREEN";
  colorProcessor: string;
  ocioVersion: string;
  acesVersion: string;
  configSha256: string;
  lutSha256: string;
  deviceCreationCount: number;
  frameCount: number;
  filePattern: "frame-%08d.png";
  artifactFormat: "rgba8" | "rgba16_unorm";
  displayColorSpace: string;
  firstFrameSha256?: string;
  lastFrameSha256?: string;
  audioIncluded: false;
}

async function renderAudioBed(
  project: EditProject,
  plan: RenderPlan,
  output: string,
  ffmpegPath: string,
  timeoutMs: number,
): Promise<void> {
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-t", finite(plan.duration), "-i", "anullsrc=r=48000:cl=stereo"];
  const filters = [`[0:a]atrim=duration=${finite(plan.duration)},asetpts=PTS-STARTPTS[abase]`];
  const voiceLabels = ["[abase]"];
  const musicLabels: string[] = [];
  let inputIndex = 1;
  let audioIndex = 0;
  for (const item of plan.audioClips) {
    const asset = project.assets.find((candidate) => candidate.id === item.clip.assetId);
    if (!asset) throw new Error(`找不到音訊素材：${item.clip.assetId}`);
    args.push("-ss", finite(item.clip.sourceStart), "-t", finite(item.clip.duration), "-i", item.assetPath);
    const label = `aclip${audioIndex}`;
    const music = asset.role === "background-music";
    const fade = music ? Math.min(1.2, item.clip.duration / 5) : 0;
    const fadeFilter = music && fade > 0
      ? `,afade=t=in:st=0:d=${finite(fade)},afade=t=out:st=${finite(Math.max(0, item.clip.duration - fade))}:d=${finite(fade)}`
      : "";
    filters.push(
      `[${inputIndex}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${finite(item.clip.duration)},asetpts=PTS-STARTPTS${fadeFilter},adelay=${Math.round(item.clip.timelineStart * 1000)}:all=1,volume=${finite(item.clip.volume)}[${label}]`,
    );
    (music ? musicLabels : voiceLabels).push(`[${label}]`);
    inputIndex += 1;
    audioIndex += 1;
  }
  filters.push(`${voiceLabels.join("")}amix=inputs=${voiceLabels.length}:duration=longest:normalize=0[voicemix]`);
  if (musicLabels.length) {
    filters.push(`${musicLabels.join("")}amix=inputs=${musicLabels.length}:duration=longest:normalize=0[musicbus]`);
    if (voiceLabels.length > 1) {
      filters.push("[voicemix]asplit=2[voiceout][voicekey]");
      filters.push("[musicbus][voicekey]sidechaincompress=threshold=0.025:ratio=8:attack=25:release=360:makeup=1[duckedmusic]");
      filters.push("[voiceout][duckedmusic]amix=inputs=2:duration=longest:normalize=0[premaster]");
    } else {
      // A silent sidechain key makes FFmpeg framesync race at EOF: depending on
      // input scheduling, loudnorm may receive silence for the final ~0.12 s.
      // Keep the silent base only as the duration bed when there is no voice.
      filters.push("[voicemix][musicbus]amix=inputs=2:duration=longest:normalize=0[premaster]");
    }
    filters.push(masterAudioFilter("[premaster]", plan.duration));
  } else if (voiceLabels.length > 1) {
    filters.push(masterAudioFilter("[voicemix]", plan.duration));
  } else {
    filters.push(`[voicemix]atrim=duration=${finite(plan.duration)},asetpts=PTS-STARTPTS[aout]`);
  }
  args.push("-filter_complex", filters.join(";"), "-map", "[aout]", "-vn", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-t", finite(plan.duration), output);
  await runProcess(ffmpegPath, args, timeoutMs);
}

function hdrMetadataArgs(outputTransform: NativeAces2OutputTransform): string[] {
  if (outputTransform === "rec709_sdr") return [];
  const transfer = outputTransform === "rec2100_hlg_1000" ? 18 : 16;
  const mastering = "G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50)";
  return [
    "-x265-params", `colorprim=9:transfer=${transfer}:colormatrix=9:master-display=${mastering}:max-cll=1000,400`,
    "-bsf:v", `hevc_metadata=colour_primaries=9:transfer_characteristics=${transfer}:matrix_coefficients=9`,
  ];
}

async function renderSceneLinearAces2DisplayProject(
  project: EditProject,
  outputPath: string,
  plan: RenderPlan,
  options: RenderOptions,
  encoder: VideoEncoder,
  timeoutMs: number,
): Promise<RenderResult> {
  if (!options.gpuCompositorPath) throw new Error("Scene-linear ACES 2 SDR 輸出缺少原生 GPU compositor runtime。");
  const request = buildAces2DisplayVideoRenderRequest(project);
  const hdr = request.outputTransform !== "rec709_sdr";
  if (hdr && (project.captions.length > 0 || project.motionGraphics.length > 0)) {
    throw new Error("HDR 字幕／動態圖尚未完成 203-nit reference-white 校準；請先移除文字疊加，避免以 1000-nit 白色燒錄。");
  }
  const ffmpegPath = options.ffmpegPath ?? "ffmpeg";
  const ffprobePath = options.ffprobePath ?? "ffprobe";
  const workspace = await mkdtemp(join(tmpdir(), "editkin-aces2-sdr-"));
  const requested = resolve(outputPath);
  await mkdir(dirname(requested), { recursive: true });
  const temporaryOutput = join(dirname(requested), `.${basename(requested)}.${process.pid}.aces2-rendering.mp4`);
  try {
    const graphPath = join(workspace, "graph.json");
    const bindingsPath = join(workspace, "bindings.json");
    const sequencePath = join(workspace, "display-sequence");
    const audioPath = join(workspace, "audio.m4a");
    await writeFile(graphPath, `${JSON.stringify(request.graph, null, 2)}\n`, "utf8");
    await writeFile(bindingsPath, `${JSON.stringify(request.assetBindings, null, 2)}\n`, "utf8");
    const { stdout } = await runProcess(options.gpuCompositorPath, [
      "engine-render-display-sequence", graphPath, bindingsPath, String(request.startFrame), String(request.frameCount), sequencePath, "gpu",
    ], timeoutMs);
    const execution = JSON.parse(stdout) as { receipt?: NativeAces2DisplayReceipt };
    const receipt = execution.receipt;
    if (!receipt || receipt.schema !== "editkin.ocio-display-sequence/v1" || receipt.status !== "GREEN"
      || receipt.colorProcessor !== request.colorProcessor || receipt.ocioVersion !== "2.5.2" || receipt.acesVersion !== "2.0"
      || receipt.filePattern !== "frame-%08d.png" || receipt.frameCount !== request.frameCount
      || receipt.artifactFormat !== (hdr ? "rgba16_unorm" : "rgba8") || receipt.displayColorSpace !== request.outputTransform
      || receipt.deviceCreationCount !== 1 || receipt.audioIncluded !== false) {
      throw new Error("原生 ACES 2 SDR 影格序列 receipt 不完整或與請求不一致。");
    }
    await renderAudioBed(project, plan, audioPath, ffmpegPath, timeoutMs);
    let assPath: string | undefined;
    const assFonts = await resolveAssFontRoot(options.fontRoot, project);
    if (!hdr && (project.captions.length > 0 || project.motionGraphics.length > 0)) {
      assPath = join(workspace, "captions.ass");
      await writeFile(assPath, writeAssContent(project, project.captionStyle, assFonts), "utf8");
    }
    const videoFilter = hdr
      ? "format=gbrp16le,zscale=matrix=2020_ncl:range=limited,format=yuv420p10le"
      : `${assPath ? `${buildAssFilter(assPath, assFonts.fontRoot)},` : ""}format=yuv420p`;
    const colorMetadata = hdr
      ? ["-color_primaries:v", "bt2020", "-colorspace:v", "bt2020nc", "-color_trc:v", request.outputTransform === "rec2100_hlg_1000" ? "arib-std-b67" : "smpte2084"]
      : ["-color_primaries:v", "bt709", "-colorspace:v", "bt709", "-color_trc:v", "bt709"];
    await runProcess(ffmpegPath, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-framerate", finite(project.fps), "-start_number", String(request.startFrame), "-i", join(sequencePath, "frame-%08d.png"),
      "-i", audioPath,
      "-map", "0:v:0", "-map", "1:a:0", "-vf", videoFilter,
      "-frames:v", String(request.frameCount), ...encoderArgs(encoder), "-pix_fmt", hdr ? "yuv420p10le" : "yuv420p",
      ...colorMetadata,
      // The bundled FFmpeg/libx264 build writes the matrix tag from container options but does
      // not persist primaries/transfer into the H.264 VUI. Stamp the elementary stream too so
      // ffprobe, NLEs and platform transcoders all observe the same Rec.709 contract.
      ...(hdr ? hdrMetadataArgs(request.outputTransform) : ["-bsf:v", "h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1"]),
      "-c:a", "copy", "-t", finite(plan.duration), "-video_track_timescale", "90000", "-movflags", "+faststart", temporaryOutput,
    ], timeoutMs);
    const outputProbe = await probeMedia(temporaryOutput, ffprobePath);
    const expectedPrimaries = hdr ? "bt2020" : "bt709";
    const expectedTransfer = request.outputTransform === "rec2100_hlg_1000" ? "arib-std-b67" : request.outputTransform === "rec2100_pq_1000" ? "smpte2084" : "bt709";
    const expectedMatrix = hdr ? "bt2020nc" : "bt709";
    if (!outputProbe.hasVideo || !outputProbe.hasAudio || outputProbe.colorPrimaries !== expectedPrimaries
      || outputProbe.colorTransfer !== expectedTransfer || outputProbe.colorMatrix !== expectedMatrix
      || (hdr && outputProbe.pixelFormat !== "yuv420p10le")
      || Math.abs(outputProbe.duration - plan.duration) > Math.max(.15, 2 / project.fps)) {
      throw new Error(`原生 ACES 2 display 輸出 QA 失敗：duration=${outputProbe.duration}, pix_fmt=${outputProbe.pixelFormat ?? "unknown"}, primaries=${outputProbe.colorPrimaries ?? "unknown"}, transfer=${outputProbe.colorTransfer ?? "unknown"}, matrix=${outputProbe.colorMatrix ?? "unknown"}`);
    }
    await rm(requested, { force: true });
    await rename(temporaryOutput, requested);
    const version = await runProcess(ffmpegPath, ["-version"], 10_000);
    return {
      outputPath: requested,
      duration: outputProbe.duration,
      encoder,
      planner: hdr ? "editkin-common-graph-wgpu-aces2-hdr-display-sequence/v1" : "editkin-common-graph-wgpu-aces2-display-sequence/v1",
      ffmpegVersion: version.stdout.split(/\r?\n/)[0] ?? "unknown",
      colorPipeline: receipt,
    };
  } finally {
    await rm(temporaryOutput, { force: true });
    await rm(workspace, { recursive: true, force: true });
  }
}

async function renderResolvedProject(project: EditProject, outputPath: string, options: RenderOptions, alphaIntermediate = false): Promise<RenderResult> {
  const { initializeWave2Registry } = await import("../creative/wave2Registry");
  initializeWave2Registry();
  const alphaDelivery = !alphaIntermediate && options.deliveryProfile === HIGH_BIT_DEPTH_ALPHA_PROFILE;
  const preserveHighBitDepthAlpha = alphaIntermediate || alphaDelivery;
  if (alphaDelivery) assertHighBitDepthAlphaDeliveryProject(project, outputPath);
  const hasMotionCompositionV2 = project.motionGraphics.some((graphic) => graphic.schema === "hao.motion-composition/v2");
  if (hasMotionCompositionV2 && (preserveHighBitDepthAlpha || containsSceneLinearMedia(project) || project.colorManagement?.mode === "aces2" || isHdrOutput(project))) {
    throw new Error("motion-composition/v2 本輪只支援一般 Rec.709 正式輸出；預合成 alpha、ACES 2 與 HDR 必須等待共享原生／scene-linear evaluator，禁止 silently downgrade。");
  }
  const ffmpegPath = options.ffmpegPath ?? "ffmpeg";
  const ffprobePath = options.ffprobePath ?? "ffprobe";
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  const plan = buildRenderPlan(project, (uri) => resolveMediaPath(uri, options.assetBase));
  const sceneLinear = containsSceneLinearMedia(project);
  const alphaCapability = alphaDelivery
    ? await probeHighBitDepthAlphaCapability(ffmpegPath, ffprobePath, timeoutMs)
    : undefined;
  let residentAcesPreview: GpuEngineVideoPreviewGraph | undefined;
  if (!sceneLinear && project.colorManagement?.mode === "aces2" && project.colorManagement.outputTransform === "rec709_sdr") {
    const nativeProject = structuredClone(project);
    for (const asset of nativeProject.assets.filter((candidate) => candidate.kind === "video" && !candidate.compositionId)) {
      asset.uri = resolveMediaPath(asset.uri, options.assetBase);
      if (asset.derivatives?.proxyUri) asset.derivatives.proxyUri = resolveMediaPath(asset.derivatives.proxyUri, options.assetBase);
      if (asset.derivatives?.overlayProxyUri) asset.derivatives.overlayProxyUri = resolveMediaPath(asset.derivatives.overlayProxyUri, options.assetBase);
    }
    residentAcesPreview = buildGpuEngineVideoPreviewGraph(nativeProject, 0);
  }
  const encoder: VideoEncoder = preserveHighBitDepthAlpha ? "prores_ks" : sceneLinear && isHdrOutput(project)
    ? "libx265"
    : await chooseEncoder(ffmpegPath, options.preferGpu !== false, timeoutMs, isHdrOutput(project));
  if (sceneLinear) {
    if (preserveHighBitDepthAlpha) throw new Error("Scene-linear 預合成／Alpha 主檔目前必須先輸出 OpenEXR；不可提早套用 SDR Output Transform。");
    return renderSceneLinearAces2DisplayProject(project, outputPath, plan, options, encoder, timeoutMs);
  }
  if (residentAcesPreview && !preserveHighBitDepthAlpha) {
    return renderResidentSceneLinearAces2VideoProject(project, residentAcesPreview, outputPath, plan, options, encoder, timeoutMs, {
      runProcess, renderAudioBed, probeMedia, encoderArgs, finite,
    });
  }
  let planner = hasMotionCompositionV2 ? "typescript-motion-composition-v2-ass-frame-receipt/v2" : "typescript-fallback";
  const nativeCoreReady = await nativeCoreAvailable(options.nativeCorePath);
  if (nativeCoreReady && !hasMotionCompositionV2) {
    await compileNativeEngineGraph(buildEngineRenderGraph(project), options.nativeCorePath!);
    const native = await createNativePlan(project, options.nativeCorePath!);
    const expectedFrames = Math.round(plan.duration * project.fps);
    if (native.durationFrames !== expectedFrames) throw new Error(`Rust/TypeScript render plan 不一致：${native.durationFrames} / ${expectedFrames}`);
    planner = native.engine;
  }

  const workspace = await mkdtemp(join(tmpdir(), "editkin-render-"));
  const requested = resolve(outputPath);
  await mkdir(dirname(requested), { recursive: true });
  const temporaryOutput = join(dirname(requested), `.${basename(requested)}.${process.pid}.rendering.${preserveHighBitDepthAlpha ? "mov" : "mp4"}`);
  try {
    const decodableAudioSourceCount = !preserveHighBitDepthAlpha && nativeCoreReady && plan.duration > 0 && plan.duration <= 30
      ? await countDecodableNativeAudioSources(plan, ffprobePath)
      : 0;
    const nativeAudio = shouldUseNativeFinalAudio({
      alphaIntermediate: preserveHighBitDepthAlpha,
      nativeCoreReady,
      durationSeconds: plan.duration,
      decodableAudioSourceCount,
    })
      ? await prepareNativeFinalAudio(project, plan, workspace, {
          ffmpegPath,
          ffprobePath,
          nativeCorePath: options.nativeCorePath!,
          timeoutMs,
          assetBase: options.assetBase,
        })
      : undefined;
    if (nativeAudio) planner = `${planner}+hao-core-native-audio-dag/v1`;
    const nativeEffects = await materializeNativeEffectSegments(project, plan, {
      ffmpegPath,
      nativeCorePath: options.nativeCorePath ?? "",
      gpuCompositorPath: options.gpuCompositorPath,
      pluginRoots: options.pluginRoots ?? [],
      fontRoot: options.fontRoot,
      workspace: join(workspace, "native-effects"),
      timeoutMs,
    });
    if (nativeEffects) planner = `${planner}+${nativeEffects.clips.some((clip) => clip.executionMode === "resident-gpu-shader-sequence/v1") ? "gpu-effect-sequence/v1" : "native-effect-sequence/v1"}`;
    const postMaterializationProject = projectAfterNativeEffectMaterialization(project, nativeEffects);
    const assFonts = await resolveAssFontRoot(options.fontRoot, postMaterializationProject);
    let assPath: string | undefined;
    if (postMaterializationProject.captions.length > 0 || postMaterializationProject.motionGraphics.length > 0) {
      assPath = join(workspace, "captions.ass");
      await writeFile(assPath, writeAssContent(postMaterializationProject, postMaterializationProject.captionStyle, assFonts), "utf8");
    }
    await renderComposite(ffmpegPath, ffprobePath, temporaryOutput, postMaterializationProject, plan, assPath, encoder, timeoutMs, assFonts.fontRoot, options.colorRoot, options.assetBase, options.autoRotoCacheRoot, preserveHighBitDepthAlpha, nativeAudio?.outputPath);
    const outputProbe = await probeMedia(temporaryOutput, ffprobePath);
    if (!outputProbe.hasVideo || !outputProbe.hasAudio || Math.abs(outputProbe.duration - plan.duration) > Math.max(0.15, 2 / project.fps)) {
      throw new Error(`輸出 QA 失敗：duration=${outputProbe.duration}, expected=${plan.duration}`);
    }
    if (alphaDelivery) assertHighBitDepthAlphaOutputProbe(outputProbe);
    const alphaDeliveryReceipt = alphaDelivery
      ? await buildHighBitDepthAlphaDeliveryReceipt(temporaryOutput, outputProbe, alphaCapability!)
      : undefined;
    await rm(requested, { force: true });
    await rename(temporaryOutput, requested);
    const { stdout } = await runProcess(ffmpegPath, ["-version"], 10_000);
    return { outputPath: requested, duration: outputProbe.duration, encoder, planner: alphaDelivery ? `${planner}+prores4444-alpha-delivery/v1` : planner, ffmpegVersion: stdout.split(/\r?\n/)[0] ?? "unknown", nativeEffects, nativeAudio: nativeAudio?.receipt, alphaDelivery: alphaDeliveryReceipt };
  } finally {
    await rm(temporaryOutput, { force: true });
    await rm(workspace, { recursive: true, force: true });
  }
}

function compositionMaterializationOrder(project: EditProject): string[] {
  const assets = new Map(project.assets.map((asset) => [asset.id, asset] as const));
  const compositions = new Map(project.compositions.map((composition) => [composition.id, composition] as const));
  const order: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (compositionId: string): void => {
    if (visited.has(compositionId)) return;
    if (visiting.has(compositionId)) throw new Error(`預合成環狀參照：${compositionId}`);
    const composition = compositions.get(compositionId);
    if (!composition) throw new Error(`找不到預合成：${compositionId}`);
    visiting.add(compositionId);
    for (const clip of composition.tracks.flatMap((track) => track.clips)) {
      const dependency = assets.get(clip.assetId)?.compositionId;
      if (dependency) visit(dependency);
    }
    visiting.delete(compositionId);
    visited.add(compositionId);
    order.push(compositionId);
  };
  for (const composition of project.compositions) visit(composition.id);
  return order;
}

function withMaterializedCompositions(project: EditProject, paths: ReadonlyMap<string, string>): EditProject {
  return {
    ...structuredClone(project),
    assets: project.assets.map((asset) => asset.compositionId ? {
      ...structuredClone(asset),
      uri: paths.get(asset.compositionId) ?? asset.uri,
      compositionId: undefined,
    } : structuredClone(asset)),
    compositions: [],
  };
}

export async function renderProject(project: EditProject, outputPath: string, options: RenderOptions = {}): Promise<RenderResult> {
  const snapshot = structuredClone(project);
  const projectContentSha256 = createHash("sha256").update(renderReviewContentJson(snapshot)).digest("hex");
  const result = await renderProjectContent(snapshot, outputPath, options);
  try {
    return { ...result, artifactIdentity: await collectRenderArtifactIdentity(result.outputPath, projectContentSha256, options.ffprobePath) };
  } catch (error) {
    throw new Error(`影片已產生並保留於 ${result.outputPath}，但輸出身分未驗證：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function renderProjectContent(project: EditProject, outputPath: string, options: RenderOptions): Promise<RenderResult> {
  validateProject(project);
  if (options.deliveryProfile === HIGH_BIT_DEPTH_ALPHA_PROFILE) assertHighBitDepthAlphaDeliveryProject(project, outputPath);
  if (project.compositions.length === 0) return renderResolvedProject(project, outputPath, options);
  const workspace = await mkdtemp(join(tmpdir(), "editkin-precomp-"));
  const materialized = new Map<string, string>();
  try {
    const compositions = new Map(project.compositions.map((composition) => [composition.id, composition] as const));
    for (const compositionId of compositionMaterializationOrder(project)) {
      const composition = compositions.get(compositionId)!;
      const nested = projectFromComposition(project, composition);
      const resolvedNested = withMaterializedCompositions(nested, materialized);
      const path = join(workspace, `${compositionId.replace(/[^a-z0-9._-]/gi, "_")}.mov`);
      await renderResolvedProject(resolvedNested, path, { ...options, preferGpu: false }, true);
      materialized.set(compositionId, path);
    }
    return await renderResolvedProject(withMaterializedCompositions(project, materialized), outputPath, options);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
