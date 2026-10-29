import { assertUnifiedLayerFormalExportAdmissionV1 } from "../application/unifiedLayerExecutionAdmissionV1";
import { withTimeRemapExportV1 } from "./timeRemapExportV1";
import { clipAudioEnvelopeFilter } from "./clipAudioEnvelopeFilters";
import { audioSidechainStagesV1, audioTimelineDelayFilterV1 } from "./audioFinalMixV1";
import { secondsToSamplesV1 } from "./longRenderClockV1";
import { selectReferencedCompositionsForRenderV1 } from "./referencedCompositionPrepassV1";
import { createHash } from "node:crypto";
import { materializeMesh3dProject, renderMesh3dVideo } from "./mesh3dRender";
import { assertExportFeaturesRenderableV1 } from "./exportFeatureGuardV1";
import { renderScene25dImageEngineProjectV1, scene25dExportPlanV1, scene25dRefusalV1 } from "./scene25dNativeExportV1";
import { collectRenderArtifactIdentity } from "./renderArtifactIdentity";
import { PendingNativeCloseError } from "../shared/pendingNativeClose";
import { createNativeAudioStageParentCleanupV1 } from "../application/nativeAudioStageWorkOwnerV1";
import { aces16PrecompositionAssetV1, usesAces16PrecompositionV1 } from "./aces16PrecompositionV1";
import { renderReviewContentJson } from "../shared/renderReviewContent";
import { assertRenderActive, publishRenderOutput, RENDER_DEADLINE_BASE_MS, renderLifetimeRemainingMs, withRenderLifetime } from "./renderLifetime";
import { FFMPEG_PROGRESS_ARGS } from "./mediaProcess";
import { reportRenderPart, reportRenderStage, type RenderStageId } from "./renderProgress";
import { noteRenderEncoder } from "./renderEncoderNotes";
import { createRenderWorkDirectory, removeRenderWorkDirectory, withRenderWorkRoot } from "./renderWorkspace";
import {
  assertRenderDiskSpace,
  estimateAudioBedBytes,
  estimateEncodedOutputBytes,
  estimateNativeAudioWorkBytes,
  estimateNativeEffectWorkBytes,
  estimatePngSequenceBytes,
  estimatePrepassWorkBytes,
  exportDiskRequirements,
  planShape,
} from "./renderDiskSpace";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClipMask, EditProject, MediaAsset, OpenExrImageSequence, TimelineClip, TrackMatteMode } from "../domain/types";
import { assertMotionPaintContract } from "../domain/motionPaint";
import { acesOutputFilter, inputNormalizationFilters, primaryExposureFilter, primaryToneFilters } from "../color/primaryGrade";
import { DEFAULT_COLOR_MANAGEMENT } from "../domain/types";
import { projectDuration, projectFromComposition, validateProject } from "../domain/editGraph";
import { buildRenderPlan } from "./planner";
import type { RenderAudioClip, RenderPlan, RenderSegment } from "./planner";
import { compileNativeEngineGraph, createNativePlan, nativeCoreAvailable } from "./nativeCore";
import { buildEngineRenderGraph } from "./engineGraph";
import { timelineTransitionNativeDeclineV1 } from "./timelineTransitionNativeV1";
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
import { prepareMotionNativePaintForRender, prepareMotionPhysicalLayouts } from "./motionPhysicalGlyphLayouts";
import { AssMotionBudget } from "./assMotionBudget";
import { materializeNativeEffectSegments, projectAfterNativeEffectMaterialization, type NativeEffectRenderReceipt } from "../plugins/nativeEffectRender";
import { buildAces2DisplayVideoRenderRequest, containsSceneLinearMedia, type NativeAces2OutputTransform } from "./aces2SdrVideo";
import { buildGpuEngineVideoPreviewGraph, type GpuEngineVideoPreviewGraph } from "./gpuCompositor";
import { assertFormalOriginalBindingsV1, formalExportDerivativesV1 } from "./longRenderFormalOriginalsV1";
import { classifyRenderV1 } from "./longRenderClassifierV1";
import { resolveLongRenderPolicyV1 } from "./longRenderPolicyV1";
import { renderLongChunkIntermediateV2 } from "./longCompositeChunkV2";
import { chunkedCompositeExportV1 } from "./chunkedCompositeExportV1";
import { renderResidentSceneLinearVideoStreamV3 } from "./residentSceneLinearVideoStreamV3";
import { residentMuxFrameLimitArgsV3 } from "./residentStreamPlanV3";
import { chunkedSceneLinearSequenceV1 } from "./chunkedSceneLinearSequenceV1";
import { registerLongRenderRouteProvidersV1 } from "./longRenderRouterV1";
import { dispatchLongRouteV1, runLongRenderV1, type LongDispatchStateV1 } from "./longRenderRunnerV1";
import { type LongChunkIntermediateRequestV1, type LongChunkIntermediateResultV1, type LongRenderClassificationV1 } from "./longRenderContractsV1";
import { prepareNativeFloatingVideoFrames } from "./nativeFloatingVideoFrame";
import { assertMediaAssetDisplayGeometry } from "./mediaDisplayGeometry";
import type { ResidentSceneLinearVideoSequenceReceipt } from "./residentSceneLinearVideoSequence";
import { renderResidentSceneLinearAces2VideoProject, residentVideoCoversFormalDuration } from "./residentSceneLinearVideoProject";
import { verifyFrozenRotoMatte } from "./autoRotoMatteIntegrity";
import {
  colorExpression,
  composedTransformExpressions,
  escapeExpression,
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

registerLongRenderRouteProvidersV1({ chunkedComposite: chunkedCompositeExportV1, residentStreamV3: renderResidentSceneLinearVideoStreamV3, chunkedSceneLinear: chunkedSceneLinearSequenceV1 });

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
  ffprobePath = "ffprobe",
): Promise<void> {
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-t", finite(plan.duration), "-i", "anullsrc=r=48000:cl=stereo"];
  const filters = [`[0:a]atrim=duration=${finite(plan.duration)},asetpts=PTS-STARTPTS[abase]`];
  const voiceLabels = ["[abase]"];
  const musicLabels: string[] = [];
  const audioStreams = new Map<string, boolean>();
  let inputIndex = 1;
  let audioIndex = 0;
  for (const item of plan.audioClips) {
    const asset = project.assets.find((candidate) => candidate.id === item.clip.assetId);
    if (!asset) throw new Error(`找不到音訊素材：${item.clip.assetId}`);
    let hasAudio = audioStreams.get(item.assetPath);
    if (hasAudio === undefined) {
      hasAudio = (await probeMedia(item.assetPath, ffprobePath)).hasAudio;
      audioStreams.set(item.assetPath, hasAudio);
    }
    if (!hasAudio) continue;
    args.push("-ss", finite(item.clip.sourceStart), "-t", finite(item.clip.duration), "-i", item.assetPath);
    const label = `aclip${audioIndex}`;
    const music = asset.role === "background-music";
    const fade = music ? Math.min(1.2, item.clip.duration / 5) : 0;
    const fadeFilter = item.clip.audioEnvelope ? clipAudioEnvelopeFilter(item.clip, music) : music && fade > 0
      ? `,afade=t=in:st=0:d=${finite(fade)},afade=t=out:st=${finite(Math.max(0, item.clip.duration - fade))}:d=${finite(fade)}`
      : "";
    filters.push(
      `[${inputIndex}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${finite(item.clip.duration)},asetpts=PTS-STARTPTS${fadeFilter},${audioTimelineDelayFilterV1(item.clip.timelineStart)},volume=${finite(item.clip.volume)}[${label}]`,
    );
    (music ? musicLabels : voiceLabels).push(`[${label}]`);
    inputIndex += 1;
    audioIndex += 1;
  }
  filters.push(`${voiceLabels.join("")}amix=inputs=${voiceLabels.length}:duration=longest:normalize=0[voicemix]`);
  if (musicLabels.length) {
    filters.push(`${musicLabels.join("")}amix=inputs=${musicLabels.length}:duration=longest:normalize=0[${voiceLabels.length > 1 ? "musicraw" : "musicbus"}]`);
    if (voiceLabels.length > 1) {
      const stages = audioSidechainStagesV1(secondsToSamplesV1(plan.duration, 48000));
      filters.push(`[voicemix]${stages.voiceSplit}`, `[musicraw]${stages.musicPad}`, ...stages.tail);
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
  args.push("-filter_complex", filters.join(";"), "-map", "[aout]", "-vn", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-t", finite(plan.duration), ...FFMPEG_PROGRESS_ARGS, output);
  await runProcess(ffmpegPath, args, timeoutMs, undefined, { ffmpegProgress: true, paths: [output] });
}

/** Seconds of video an export renders: the final timeline plus its referenced pre-rendered compositions. */
function renderWorkSeconds(project: EditProject): number {
  try {
    return projectDuration(project) + selectReferencedCompositionsForRenderV1(project).compositions.reduce((total, composition) => total + Math.max(0, composition.duration || 0), 0);
  } catch {
    return 0;
  }
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
  const requested = resolve(outputPath);
  const shape = planShape(plan);
  await assertRenderDiskSpace(exportDiskRequirements(requested, estimateEncodedOutputBytes(shape, encoder),
    estimatePngSequenceBytes(shape, hdr ? "rgba16_unorm" : "rgba8") + estimateAudioBedBytes(plan.duration)));
  await mkdir(dirname(requested), { recursive: true });
  const workspace = await createRenderWorkDirectory("editkin-aces2-sdr-");
  const temporaryOutput = join(dirname(requested), `.${basename(requested)}.${process.pid}.aces2-rendering.mp4`);
  try {
    const graphPath = join(workspace, "graph.json");
    const bindingsPath = join(workspace, "bindings.json");
    const sequencePath = join(workspace, "display-sequence");
    const audioPath = join(workspace, "audio.m4a");
    await writeFile(graphPath, `${JSON.stringify(request.graph, null, 2)}\n`, "utf8");
    await writeFile(bindingsPath, `${JSON.stringify(request.assetBindings, null, 2)}\n`, "utf8");
    reportRenderStage("frames");
    const { stdout } = await runProcess(options.gpuCompositorPath, [
      "engine-render-display-sequence", graphPath, bindingsPath, String(request.startFrame), String(request.frameCount), sequencePath, "gpu",
    ], timeoutMs, undefined, { paths: [sequencePath] });
    const execution = JSON.parse(stdout) as { receipt?: NativeAces2DisplayReceipt };
    const receipt = execution.receipt;
    if (!receipt || receipt.schema !== "editkin.ocio-display-sequence/v1" || receipt.status !== "GREEN"
      || receipt.colorProcessor !== request.colorProcessor || receipt.ocioVersion !== "2.5.2" || receipt.acesVersion !== "2.0"
      || receipt.filePattern !== "frame-%08d.png" || receipt.frameCount !== request.frameCount
      || receipt.artifactFormat !== (hdr ? "rgba16_unorm" : "rgba8") || receipt.displayColorSpace !== request.outputTransform
      || receipt.deviceCreationCount !== 1 || receipt.audioIncluded !== false) {
      throw new Error("原生 ACES 2 SDR 影格序列 receipt 不完整或與請求不一致。");
    }
    reportRenderStage("audio", plan.duration);
    await renderAudioBed(project, plan, audioPath, ffmpegPath, timeoutMs, ffprobePath);
    let assPath: string | undefined;
    const assFonts = await resolveAssFontRoot(options.fontRoot, project);
    const physicalLayouts = await prepareMotionPhysicalLayouts(project, options.fontRoot);
    const aggregateBudget = new AssMotionBudget();
    if (!hdr && (project.captions.length > 0 || project.motionGraphics.length > 0)) {
      assPath = join(workspace, "captions.ass");
      await writeFile(assPath, writeAssContent(project, project.captionStyle, { ...assFonts, physicalLayouts, requirePhysicalGlyphs: true, aggregateBudget }), "utf8");
    }
    const videoFilter = hdr
      ? "format=gbrp16le,zscale=matrix=2020_ncl:range=limited,format=yuv420p10le"
      : `${assPath ? `${buildAssFilter(assPath, assFonts.fontRoot)},` : ""}format=yuv420p`;
    const colorMetadata = hdr
      ? ["-color_primaries:v", "bt2020", "-colorspace:v", "bt2020nc", "-color_trc:v", request.outputTransform === "rec2100_hlg_1000" ? "arib-std-b67" : "smpte2084"]
      : ["-color_primaries:v", "bt709", "-colorspace:v", "bt709", "-color_trc:v", "bt709"];
    reportRenderStage("encode", plan.duration);
    await runProcess(ffmpegPath, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-framerate", finite(project.fps), "-start_number", String(request.startFrame), "-i", join(sequencePath, "frame-%08d.png"),
      "-i", audioPath,
      "-map", "0:v:0", "-map", "1:a:0", "-vf", videoFilter,
      ...residentMuxFrameLimitArgsV3(plan.duration, project.fps, request.frameCount), ...encoderArgs(encoder), "-pix_fmt", hdr ? "yuv420p10le" : "yuv420p",
      ...colorMetadata,
      // The bundled FFmpeg/libx264 build writes the matrix tag from container options but does
      // not persist primaries/transfer into the H.264 VUI. Stamp the elementary stream too so
      // ffprobe, NLEs and platform transcoders all observe the same Rec.709 contract.
      ...(hdr ? hdrMetadataArgs(request.outputTransform) : ["-bsf:v", "h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1"]),
      "-c:a", "copy", "-t", finite(plan.duration), "-video_track_timescale", "90000", "-movflags", "+faststart", ...FFMPEG_PROGRESS_ARGS, temporaryOutput,
    ], timeoutMs, undefined, { ffmpegProgress: true, paths: [temporaryOutput] });
    reportRenderStage("verify");
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
    await publishRenderOutput(temporaryOutput, requested);
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
    await removeRenderWorkDirectory(workspace);
  }
}

async function renderResolvedProject(project: EditProject, outputPath: string, options: RenderOptions, alphaIntermediate = false, long?: LongDispatchStateV1): Promise<RenderResult> {
  // A service or MCP render never mounts the Inspector; register every shipped creative extension before the
  // project's looks, effects and transitions are resolved (unknown presets throw rather than render without them).
  const [{ initializeStudioCreativeAssets }, { initializeWave2Registry }] = await Promise.all([
    import("../creative/studioAssets"),
    import("../creative/wave2Registry"),
  ]);
  initializeStudioCreativeAssets();
  initializeWave2Registry();
  const stage = (id: RenderStageId, totalSeconds?: number) => reportRenderStage(alphaIntermediate ? "precompose" : id, totalSeconds);
  if (alphaIntermediate) stage("precompose");
  const alphaDelivery = !alphaIntermediate && options.deliveryProfile === HIGH_BIT_DEPTH_ALPHA_PROFILE;
  const preserveHighBitDepthAlpha = alphaIntermediate || alphaDelivery;
  const workingPrecomposition16 = alphaIntermediate && usesAces16PrecompositionV1(project.colorManagement);
  if (alphaDelivery) assertHighBitDepthAlphaDeliveryProject(project, outputPath);
  const hasMotionCompositionV2 = project.motionGraphics.some((graphic) => graphic.schema === "hao.motion-composition/v2");
  const hasNativeMotionPaint = project.motionGraphics.some((graphic) => graphic.paintV1 || graphic.visualStyle === "native_paint");
  const allV2HaveNativePaint = hasMotionCompositionV2 && project.motionGraphics
    .filter((graphic) => graphic.schema === "hao.motion-composition/v2")
    .every((graphic) => Boolean(graphic.paintV1) && graphic.visualStyle === "native_paint");
  if (hasNativeMotionPaint) for (const graphic of project.motionGraphics) assertMotionPaintContract(graphic);
  const nativePaintResidentRoute = allV2HaveNativePaint && !preserveHighBitDepthAlpha && !containsSceneLinearMedia(project)
    && project.colorManagement?.mode === "aces2" && project.colorManagement.outputTransform === "rec709_sdr" && !isHdrOutput(project);
  const hasMotionDesignV3 = project.motionGraphics.some((graphic) => graphic.schema === "hao.motion-composition/v3");
  const hasFloatingVideoFrame = project.tracks.some(track => track.clips.some(clip => clip.floatingFrame));
  const nativeFloatingResidentRoute = hasFloatingVideoFrame && !preserveHighBitDepthAlpha && !containsSceneLinearMedia(project)
    && project.colorManagement?.mode === "aces2" && project.colorManagement.outputTransform === "rec709_sdr" && !isHdrOutput(project);
  if (hasNativeMotionPaint && !nativePaintResidentRoute) {
    throw new Error("Native paint 正式輸出要求全部 v2 都是 paintV1 實體文字或已支援靜態向量、完整 resident video 與 ACES2 rec709_sdr；alpha、HDR、普通 v2 或其他輸出不可降級。");
  }
  if (hasMotionCompositionV2 && !nativePaintResidentRoute && (preserveHighBitDepthAlpha || containsSceneLinearMedia(project) || project.colorManagement?.mode === "aces2" || isHdrOutput(project))) {
    throw new Error("motion-composition/v2 本輪只支援一般 Rec.709 正式輸出；預合成 alpha、ACES 2 與 HDR 必須等待共享原生／scene-linear evaluator，禁止 silently downgrade。");
  }
  // v3 draws display-referred ASS ops. Both ACES 2 Rec.709 SDR routes burn ASS after the ACES output transform (the
  // composite graph, and the scene-linear display sequence), and the resident GPU route declines v3 graphics, so v3 is
  // valid there. Alpha masters and HDR outputs burn no ASS, so they stay refused.
  if (hasMotionDesignV3 && (preserveHighBitDepthAlpha || isHdrOutput(project)
    || (project.colorManagement?.mode === "aces2" && project.colorManagement.outputTransform !== "rec709_sdr")
    || (containsSceneLinearMedia(project) && project.colorManagement?.mode !== "aces2"))) {
    throw new Error("motion-composition/v3 只支援 Rec.709 或 ACES 2 Rec.709 SDR 正式輸出；預合成 alpha 與 HDR 不燒錄 ASS，禁止 silently downgrade。");
  }
  const ffmpegPath = options.ffmpegPath ?? "ffmpeg";
  const ffprobePath = options.ffprobePath ?? "ffprobe";
  // No fixed stage cap: long stages get whatever remains of the duration-scaled export deadline.
  const timeoutMs = options.timeoutMs ?? renderLifetimeRemainingMs() ?? RENDER_DEADLINE_BASE_MS;
  const plan = buildRenderPlan(project, (uri) => resolveMediaPath(uri, options.assetBase));
  if ((nativePaintResidentRoute || nativeFloatingResidentRoute) && !residentVideoCoversFormalDuration(project, Math.round(plan.duration * project.fps))) {
    throw new Error("Native paint resident 正式輸出目前不接受 video coverage 空檔；請補齊底層影片。");
  }
  const sceneLinear = containsSceneLinearMedia(project);
  const alphaCapability = alphaDelivery
    ? await probeHighBitDepthAlphaCapability(ffmpegPath, ffprobePath, timeoutMs)
    : undefined;
  let residentAcesPreview: GpuEngineVideoPreviewGraph | undefined;
  if (!sceneLinear && project.colorManagement?.mode === "aces2" && project.colorManagement.outputTransform === "rec709_sdr") {
    if ((nativePaintResidentRoute || nativeFloatingResidentRoute) && !options.gpuCompositorPath) throw new Error("Native paint／浮框正式輸出缺少原生 GPU compositor runtime。");
    const nativeProject = structuredClone(project);
    for (const asset of nativeProject.assets.filter((candidate) => candidate.kind === "video" && !candidate.compositionId)) {
      asset.uri = resolveMediaPath(asset.uri, options.assetBase);
      // LV-02: formal output decodes originals only; preview proxies stay on the saved project for preview.
      if (asset.derivatives) asset.derivatives = formalExportDerivativesV1(asset.derivatives);
    }
    const nativeMotionPaint = nativePaintResidentRoute
      ? await prepareMotionNativePaintForRender(nativeProject, options.fontRoot) : undefined;
    if (nativeFloatingResidentRoute) {
      const floatingAssetIds = new Set(nativeProject.tracks.flatMap(track => track.clips)
        .filter(clip => clip.floatingFrame).map(clip => clip.assetId));
      for (const asset of nativeProject.assets.filter(asset => floatingAssetIds.has(asset.id))) {
        const actualProbe = await probeMedia(asset.uri, ffprobePath);
        assertMediaAssetDisplayGeometry(asset, actualProbe);
        const rotation = actualProbe.displayRotationDegrees ?? 0;
        if (rotation % 360 !== 0 || actualProbe.sampleAspectRatio !== 1
          || actualProbe.encodedWidth !== asset.width || actualProbe.encodedHeight !== asset.height
          || [actualProbe.colorPrimaries, actualProbe.colorTransfer, actualProbe.colorMatrix].some(value => value !== undefined && value !== "bt709")) {
          throw new Error("Native 浮框目前要求真 probe 已知方形像素、無展示旋轉與 Rec.709 原片；方向或色彩不能從保存的 DAR 推測。");
        }
      }
    }
    const nativeFloatingVideoFrames = nativeFloatingResidentRoute ? prepareNativeFloatingVideoFrames(nativeProject) : undefined;
    residentAcesPreview = buildGpuEngineVideoPreviewGraph(nativeProject, 0, nativeMotionPaint, nativeFloatingVideoFrames);
    if (residentAcesPreview) assertFormalOriginalBindingsV1(nativeProject, residentAcesPreview);
    if ((nativePaintResidentRoute || nativeFloatingResidentRoute) && !residentAcesPreview) {
      throw new Error("Native paint 正式輸出未通過共同 resident graph／資源／video coverage admission；不可改走 ASS 或純色輸出。");
    }
  }
  // This perspective/alpha graph runs on the CPU. On the measured Windows
  // 1080×1920 three-plane path, x264 avoids the NVENC probe and transfer cost.
  const preferGpuEncoder = options.preferGpu !== false
    && !(hasFloatingVideoFrame && process.platform === "win32" && !sceneLinear && !isHdrOutput(project));
  if (options.preferGpu !== false && !preferGpuEncoder) noteRenderEncoder({ code: "cpu_graph_route", detail: "floating video frames composite on the CPU; x264 avoids the NVENC transfer" });
  const encoder: VideoEncoder = workingPrecomposition16 ? "ffv1" : preserveHighBitDepthAlpha ? "prores_ks" : sceneLinear && isHdrOutput(project)
    ? "libx265"
    : await chooseEncoder(ffmpegPath, preferGpuEncoder, timeoutMs, isHdrOutput(project), { width: project.width, height: project.height });
  // 2.5D and particles exist only in the native engine graph: never fall through to the flat FFmpeg composite.
  if ((project.scene25d?.enabled || project.particleSimulation?.enabled) && !(residentAcesPreview && !preserveHighBitDepthAlpha && !sceneLinear)) {
    const scenePlan = scene25dExportPlanV1(project, { gpuCompositorPath: options.gpuCompositorPath, resolveUri: uri => resolveMediaPath(uri, options.assetBase), alphaIntermediate: preserveHighBitDepthAlpha });
    if (scenePlan.kind === "refuse") throw scenePlan.error;
    const route = long ? "30 分鐘以上的長片輸出" : undefined;
    if (scenePlan.kind !== "native-image-engine" || route) {
      throw route ? scene25dRefusalV1(project, "scene25dColorRoute", "particlesColorRoute", { route }) : scene25dRefusalV1(project, "scene25dCombination", "particlesCombination");
    }
    return renderScene25dImageEngineProjectV1(project, scenePlan.preview, outputPath, plan, options, encoder, timeoutMs, {
      runProcess,
      renderAudioBed: (audioProject, audioPlan, audioOutput, audioFfmpegPath, audioTimeoutMs) => renderAudioBed(audioProject, audioPlan, audioOutput, audioFfmpegPath, audioTimeoutMs, ffprobePath),
      probeMedia, encoderArgs, finite,
    });
  }
  if (sceneLinear) {
    if (preserveHighBitDepthAlpha) throw new Error("Scene-linear 預合成／Alpha 主檔目前必須先輸出 OpenEXR；不可提早套用 SDR Output Transform。");
    if (long) {
      const run = dispatchLongRouteV1(long, { kind: "scene-linear", project, plan, encoder, alphaDelivery });
      return long.providers.chunkedSceneLinear!({ project, outputPath, plan, options, encoder, timeoutMs, run, chunkHook: renderLongChunkIntermediateV1 });
    }
    return renderSceneLinearAces2DisplayProject(project, outputPath, plan, options, encoder, timeoutMs);
  }
  if (residentAcesPreview && !preserveHighBitDepthAlpha) {
    const longRun = long ? dispatchLongRouteV1(long, { kind: "resident", project, plan, encoder, alphaDelivery }) : undefined;
    stage("frames");
    return renderResidentSceneLinearAces2VideoProject(project, residentAcesPreview, outputPath, plan,
      longRun ? { ...options, residentStreamVersion: long!.decision!.residentStreamVersion, longRun, residentStreamV3: long!.providers.residentStreamV3 } : options, encoder, timeoutMs, {
      runProcess,
      // Frames come first, then the audio bed, the encode and the final probe.
      renderAudioBed: async (audioProject, audioPlan, audioOutput, audioFfmpegPath, audioTimeoutMs) => {
        stage("audio", audioPlan.duration);
        await renderAudioBed(audioProject, audioPlan, audioOutput, audioFfmpegPath, audioTimeoutMs, ffprobePath);
        stage("encode", audioPlan.duration);
      },
      probeMedia: (path, probePath) => { stage("verify"); return probeMedia(path, probePath); },
      encoderArgs, finite,
    });
  }
  let planner = hasFloatingVideoFrame ? "editkin-floating-video-frame-ffmpeg/v1" : hasMotionCompositionV2 ? "typescript-motion-composition-v2-ass-frame-receipt/v2"
    : hasMotionDesignV3 ? "typescript-motion-design-v3-ass/v3" : "typescript-fallback";
  // The native engine declines matte transitions (TIMELINE_TRANSITION_NATIVE_MATTE_DECLINED): such a project renders
  // exactly as the software route, without the native core. Dissolve/dip pairs compile as the versioned
  // timeline_transition_v1 graph the core accepts; the video is the same FFmpeg composite on both routes.
  const nativeCoreReady = !timelineTransitionNativeDeclineV1(project) && await nativeCoreAvailable(options.nativeCorePath);
  if (nativeCoreReady && !hasMotionCompositionV2 && !hasMotionDesignV3 && !hasFloatingVideoFrame) {
    await compileNativeEngineGraph(buildEngineRenderGraph(project, project.timelineTransitions?.length ? { nativeTimelineTransitionVersion: 1 } : {}), options.nativeCorePath!);
    const native = await createNativePlan(project, options.nativeCorePath!);
    const expectedFrames = Math.round(plan.duration * project.fps);
    if (native.durationFrames !== expectedFrames) throw new Error(`Rust/TypeScript render plan 不一致：${native.durationFrames} / ${expectedFrames}`);
    planner = native.engine;
  }
  if (project.unifiedLayerOrderV1) planner += "+unified-layer-order/v1";
  if (long) {
    const run = dispatchLongRouteV1(long, { kind: "composite", project, plan, encoder, alphaDelivery });
    if (run.route === "ffmpeg-chunked") return long.providers.chunkedComposite!({ project, outputPath, plan, options, encoder, timeoutMs, run, chunkHook: renderLongChunkIntermediateV1 });
  }

  const requested = resolve(outputPath);
  await assertRenderDiskSpace(exportDiskRequirements(requested, estimateEncodedOutputBytes(planShape(plan), encoder),
    estimateNativeEffectWorkBytes(plan) + (preserveHighBitDepthAlpha ? 0 : estimateNativeAudioWorkBytes(plan.duration))));
  await mkdir(dirname(requested), { recursive: true });
  const workspace = await createRenderWorkDirectory("editkin-render-");
  const temporaryOutput = join(dirname(requested), `.${basename(requested)}.${process.pid}.rendering.${workingPrecomposition16 ? "mkv" : preserveHighBitDepthAlpha ? "mov" : "mp4"}`);
  const audioStageCleanup = createNativeAudioStageParentCleanupV1(workspace, async () => {
    await rm(temporaryOutput, { force: true });
    await removeRenderWorkDirectory(workspace);
  });
  return audioStageCleanup.run(async () => {
    stage("audio");
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
          pendingCloseParent: audioStageCleanup,
        })
      : undefined;
    if (nativeAudio) planner = `${planner}+hao-core-native-audio-dag/v1`;
    stage("effects");
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
    const physicalLayouts = await prepareMotionPhysicalLayouts(postMaterializationProject, options.fontRoot);
    // Both ASS outputs belong to this render. Separate line buffers share one
    // actual work/event/UTF-8 counter, including dynamic background paths.
    const aggregateBudget = new AssMotionBudget();
    let assPath: string | undefined;
    if (!postMaterializationProject.unifiedLayerOrderV1 && (postMaterializationProject.captions.length > 0 || postMaterializationProject.motionGraphics.length > 0)) {
      assPath = join(workspace, "captions.ass");
      await writeFile(assPath, writeAssContent(postMaterializationProject, postMaterializationProject.captionStyle, { ...assFonts, physicalLayouts, requirePhysicalGlyphs: true, aggregateBudget }), "utf8");
    }
    stage("encode", plan.duration);
    await renderComposite(ffmpegPath, ffprobePath, temporaryOutput, postMaterializationProject, plan, assPath, encoder, timeoutMs, assFonts.fontRoot, options.colorRoot, options.assetBase, options.autoRotoCacheRoot, preserveHighBitDepthAlpha, nativeAudio?.outputPath, assFonts.bundledFaces, { physicalLayouts, requirePhysicalGlyphs: true, aggregateBudget });
    stage("verify");
    const outputProbe = await probeMedia(temporaryOutput, ffprobePath);
    if (!outputProbe.hasVideo || !outputProbe.hasAudio || Math.abs(outputProbe.duration - plan.duration) > Math.max(0.15, 2 / project.fps)) {
      throw new Error(`輸出 QA 失敗：duration=${outputProbe.duration}, expected=${plan.duration}`);
    }
    if (alphaDelivery) assertHighBitDepthAlphaOutputProbe(outputProbe);
    const alphaDeliveryReceipt = alphaDelivery
      ? await buildHighBitDepthAlphaDeliveryReceipt(temporaryOutput, outputProbe, alphaCapability!)
      : undefined;
    await publishRenderOutput(temporaryOutput, requested);
    const { stdout } = await runProcess(ffmpegPath, ["-version"], 10_000);
    return { outputPath: requested, duration: outputProbe.duration, encoder, planner: alphaDelivery ? `${planner}+prores4444-alpha-delivery/v1` : planner, ffmpegVersion: stdout.split(/\r?\n/)[0] ?? "unknown", nativeEffects, nativeAudio: nativeAudio?.receipt, alphaDelivery: alphaDeliveryReceipt };
  });
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

function withMaterializedCompositions(project: EditProject, paths: ReadonlyMap<string, string>, lossless: ReadonlySet<string> = new Set()): EditProject {
  return {
    ...structuredClone(project),
    assets: project.assets.filter(asset => !asset.compositionId || paths.has(asset.compositionId)).map((asset) => asset.compositionId ? lossless.has(asset.compositionId) ? aces16PrecompositionAssetV1(asset, paths.get(asset.compositionId) ?? asset.uri) : {
      ...structuredClone(asset),
      uri: paths.get(asset.compositionId) ?? asset.uri,
      compositionId: undefined,
    } : structuredClone(asset)),
    compositions: [],
  };
}

/**
 * Export deadline scales with the rendered seconds (no fixed cap), watched encoders are stopped when they make no
 * progress for `stallTimeoutMs`, work files go to the output's drive and free space is checked before encoding.
 */
export async function renderProject(project: EditProject, outputPath: string, options: RenderOptions = {}): Promise<RenderResult> {
  // Authored clip speeds and speed curves are baked through the shared source-clock cache first and rendered like any
  // other clip (timeRemapExportV1, leases released afterwards). A project without one takes the exact previous path.
  return withTimeRemapExportV1(project, outputPath, options, rendered => renderMaterializedProject(rendered, outputPath, options));
}

async function renderMaterializedProject(project: EditProject, outputPath: string, options: RenderOptions): Promise<RenderResult> {
  assertUnifiedLayerFormalExportAdmissionV1(project, options);
  // Fail closed on features the export would silently drop or render differently from the preview (AREA_B §4 #1).
  assertExportFeaturesRenderableV1(project, options);
  // SHORT (< 30 min, decision Q-L2) renders keep the exact legacy path; LONG renders use the bounded long-render core.
  const renderClass = classifyRenderV1(project, options.longRender);
  if (renderClass.class === "long") return renderLongProjectV1(project, outputPath, options, renderClass);
  return withRenderLifetime({ signal: options.signal, timeoutMs: options.timeoutMs, workSeconds: renderWorkSeconds(project), stallMs: options.stallTimeoutMs },
    () => withRenderWorkRoot(outputPath, options.workRoot, () => renderProjectWithinLifetime(project, outputPath, options)));
}

/** LONG (>= 30 min) render: one lifetime, then the long-render runner (work root, journal, guard v2, `.part` publish). */
function renderLongProjectV1(project: EditProject, outputPath: string, options: RenderOptions, classification: LongRenderClassificationV1): Promise<RenderResult> {
  const policy = resolveLongRenderPolicyV1(options.longRender?.policy);
  return withRenderLifetime({ signal: options.signal, timeoutMs: options.timeoutMs, workSeconds: renderWorkSeconds(project), stallMs: options.stallTimeoutMs },
    () => runLongRenderV1({ project, outputPath, options, classification, policy,
      renderContent: (snapshot, partPath, dispatch) => renderProjectContent(snapshot, partPath, options, dispatch) }));
}

async function renderProjectWithinLifetime(project: EditProject, outputPath: string, options: RenderOptions): Promise<RenderResult> {
  assertRenderActive();
  const snapshot = structuredClone(project);
  const projectContentSha256 = createHash("sha256").update(renderReviewContentJson(snapshot)).digest("hex");
  const result = await renderProjectContent(snapshot, outputPath, options);
  reportRenderStage("verify");
  try {
    return { ...result, artifactIdentity: await collectRenderArtifactIdentity(result.outputPath, projectContentSha256, options.ffprobePath, undefined, { durationSeconds: result.duration }) };
  } catch (error) {
    const diagnostic = `影片已產生並保留於 ${result.outputPath}，但輸出身分未驗證：${error instanceof Error ? error.message : String(error)}`;
    if (error instanceof PendingNativeCloseError) { error.message = diagnostic; throw error; }
    throw new Error(diagnostic);
  }
}

async function renderProjectContent(project: EditProject, outputPath: string, options: RenderOptions, long?: LongDispatchStateV1): Promise<RenderResult> {
  assertRenderActive();
  validateProject(project);
  const prepassProject = selectReferencedCompositionsForRenderV1(project);
  if (project.scene3d?.enabled || prepassProject.compositions.length > 0) {
    // Pre-passes fill the work drive before the final route's own check; refuse early instead of mid-render.
    const finalEncoder = options.deliveryProfile === HIGH_BIT_DEPTH_ALPHA_PROFILE ? "prores_ks" : isHdrOutput(project) ? "libx265" : "libx264";
    await assertRenderDiskSpace(exportDiskRequirements(outputPath,
      estimateEncodedOutputBytes({ width: project.width, height: project.height, fps: project.fps, durationSeconds: projectDuration(project) }, finalEncoder),
      estimatePrepassWorkBytes(prepassProject)));
  }
  if (project.scene3d?.enabled) {
    const workspace = await createRenderWorkDirectory("editkin-mesh3d-");
    try {
      const path = join(workspace, "mesh-scene.mp4");
      // The mesh pass has its own process timers; give it the remaining export budget rather than a fixed 3 minutes.
      reportRenderStage("scene3d");
      if (options.preferGpu !== false) noteRenderEncoder({ code: "mesh3d_cpu_route", detail: "the 3D scene pass feeds a CPU composite" });
      const receipt = await renderMesh3dVideo(project, path, { ...options, timeoutMs: options.timeoutMs ?? renderLifetimeRemainingMs() });
      const result = await renderResolvedProject(materializeMesh3dProject(project, path, receipt.durationSeconds), outputPath, { ...options, preferGpu: false }, false, long);
      return { ...result, planner: `${result.planner}+${receipt.executor}`, mesh3dPipeline: receipt };
    } finally { await removeRenderWorkDirectory(workspace); }
  }
  if (options.deliveryProfile === HIGH_BIT_DEPTH_ALPHA_PROFILE) assertHighBitDepthAlphaDeliveryProject(project, outputPath);
  if (project.compositions.length === 0) return renderResolvedProject(project, outputPath, options, false, long);
  if (prepassProject.compositions.length === 0) return renderResolvedProject(withMaterializedCompositions(project, new Map()), outputPath, options, false, long);
  const workspace = await createRenderWorkDirectory("editkin-precomp-");
  const materialized = new Map<string, string>();
  const lossless = new Set<string>();
  try {
    const compositions = new Map(project.compositions.map((composition) => [composition.id, composition] as const));
    const order = compositionMaterializationOrder(prepassProject);
    for (const [index, compositionId] of order.entries()) {
      assertRenderActive();
      reportRenderPart(index + 1, order.length);
      const composition = compositions.get(compositionId)!;
      const nested = projectFromComposition(project, composition);
      const resolvedNested = withMaterializedCompositions(nested, materialized, lossless);
      const path = join(workspace, `${compositionId.replace(/[^a-z0-9._-]/gi, "_")}.${usesAces16PrecompositionV1(resolvedNested.colorManagement) ? "mkv" : "mov"}`);
      await renderResolvedProject(resolvedNested, path, { ...options, preferGpu: false }, true);
      materialized.set(compositionId, path);
      if (usesAces16PrecompositionV1(resolvedNested.colorManagement)) lossless.add(compositionId);
    }
    reportRenderPart();
    return await renderResolvedProject(withMaterializedCompositions(project, materialized, lossless), outputPath, options, false, long);
  } finally {
    await removeRenderWorkDirectory(workspace);
  }
}

/** WP-B compatibility hook; preparation and display output now share the B2 implementation. */
export async function renderLongChunkIntermediateV1(request: LongChunkIntermediateRequestV1): Promise<LongChunkIntermediateResultV1> {
  return renderLongChunkIntermediateV2(request);
}
export { renderLongChunkRawV1 } from "./longCompositeChunkV2";
