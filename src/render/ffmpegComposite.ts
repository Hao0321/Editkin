import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import type { EditProject, MediaAsset, OpenExrImageSequence, TimelineClip, TrackMatteMode } from "../domain/types";
import { acesOutputFilter, primaryExposureFilter, primaryToneFilters } from "../color/primaryGrade";
import { DEFAULT_COLOR_MANAGEMENT } from "../domain/types";
import { chromaKeyFfmpegFilter } from "../domain/chromaKey";
import { compileClipAlphaPlan, ffmpegRationalRate, pixelMatteOperation, type ClipAlphaPlan } from "../domain/clipAlphaPlan";
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
import { buildClipMaskAlphaFilters } from "./maskFilters";
import { materializeNativeEffectSegments, projectAfterNativeEffectMaterialization, type NativeEffectRenderReceipt } from "../plugins/nativeEffectRender";
import { buildAces2DisplayVideoRenderRequest, containsSceneLinearMedia, type NativeAces2OutputTransform } from "./aces2SdrVideo";
import { buildGpuEngineVideoPreviewGraph, type GpuEngineVideoPreviewGraph } from "./gpuCompositor";
import type { ResidentSceneLinearVideoSequenceReceipt } from "./residentSceneLinearVideoSequence";
import { renderResidentSceneLinearAces2VideoProject } from "./residentSceneLinearVideoProject";
import { verifyFrozenRotoMatte } from "./autoRotoMatteIntegrity";
import {
  animationTimeValue,
  colorExpression,
  composedTransformExpressions,
  escapeExpression,
  ffmpegBlendMode,
  ffmpegBlendNeutral,
  finite,
  hasPrimaryToneAdjustment,
  sourceAlphaNormalizationFilters,
} from "./ffmpegExpressions";
import type { MediaProbe, VideoEncoder } from "./ffmpegTypes";
import { masterAudioFilter, probeMedia, resolveMediaPath, runProcess } from "./ffmpegMedia";
import { compositePixelContract, highBitDepthAlphaEncoderArgs } from "./highBitDepthAlphaDelivery";
import { outputColorMetadataArgs } from "./outputColorMetadata";
import { compositorSourceColorPlan } from "./sourceColorFilters";
import { hasLinearWhiteBalance } from "../color/linearWhiteBalance";
import { whiteBalanceAssetWithMetadata } from "./sourceLinearWhiteBalance";
import { assertStaticSourceWhiteBalance } from "./linearWhiteBalanceSupport";
import { compositeFrameClock } from "./compositeFrameClock";
import { pixelMatteSamplingFilters } from "./pixelMatteSampling";

export function encoderArgs(encoder: VideoEncoder): string[] {
  if (encoder === "prores_ks") return highBitDepthAlphaEncoderArgs();
  if (encoder === "h264_nvenc") return ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "19", "-b:v", "0"];
  if (encoder === "h264_videotoolbox") return ["-c:v", "h264_videotoolbox", "-realtime", "1", "-b:v", "8M", "-maxrate", "12M", "-bufsize", "16M"];
  if (encoder === "hevc_nvenc") return ["-c:v", "hevc_nvenc", "-profile:v", "main10", "-preset", "p5", "-rc", "vbr", "-cq", "19", "-b:v", "0"];
  if (encoder === "hevc_videotoolbox") return ["-c:v", "hevc_videotoolbox", "-profile:v", "main10", "-realtime", "1", "-b:v", "14M", "-maxrate", "22M", "-bufsize", "28M"];
  if (encoder === "libx265") return ["-c:v", "libx265", "-preset", "fast", "-crf", "18", "-tag:v", "hvc1"];
  return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18"];
}

export function isHdrOutput(project: EditProject): boolean {
  const output = project.colorManagement?.outputTransform;
  return project.colorManagement?.mode === "aces2" && (output === "rec2100_hlg_1000" || output === "rec2100_pq_1000");
}

export async function chooseEncoder(ffmpegPath: string, preferGpu: boolean, timeoutMs: number, hdr: boolean): Promise<VideoEncoder> {
  if (!preferGpu) return hdr ? "libx265" : "libx264";
  const hardwareEncoder: VideoEncoder | undefined = process.platform === "win32"
    ? (hdr ? "hevc_nvenc" : "h264_nvenc")
    : process.platform === "darwin" ? (hdr ? "hevc_videotoolbox" : "h264_videotoolbox") : undefined;
  if (!hardwareEncoder) return hdr ? "libx265" : "libx264";
  try {
    await runProcess(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=640x360:d=0.1",
      "-frames:v", "1", "-vf", hdr ? "format=p010le" : "format=yuv420p", "-c:v", hardwareEncoder, ...(hdr ? ["-profile:v", "main10"] : []), "-f", "null", "-",
    ], Math.min(timeoutMs, 20_000));
    return hardwareEncoder;
  } catch {
    return hdr ? "libx265" : "libx264";
  }
}

interface CompositeInput {
  clip: TimelineClip;
  alphaPlan: ClipAlphaPlan;
  asset: MediaAsset;
  assetPath: string;
  inputIndex: number;
  probe: MediaProbe;
  matteInputIndex?: number;
}

/** rotate's rotw/roth take an angle, not an input dimension. Animated angles
 * need a time-independent diagonal canvas so their later frames cannot clip. */
function rotateWithUnclippedBounds(rotation: string): string {
  const radians = `(${rotation})*PI/180`;
  const animated = /\b(?:t|T|n|N)\b/.test(rotation);
  const outWidth = animated ? "ceil(hypot(iw,ih)/2)*2" : `ceil(rotw(${radians})/2)*2`;
  const outHeight = animated ? "ceil(hypot(iw,ih)/2)*2" : `ceil(roth(${radians})/2)*2`;
  return `rotate='${radians}':ow='${outWidth}':oh='${outHeight}':c=black@0`;
}

/** Resample associated color, not hidden RGB in transparent pixels. Use a
 * 16-bit working plane even for 8-bit delivery to limit round-trip loss. */
function alphaAwareGeometry(filters: string[]): string[] {
  return filters.length ? ["format=gbrap16le", "premultiply=inplace=1", ...filters, "unpremultiply=inplace=1"] : [];
}

function compositorVideoFilters(input: CompositeInput, outputLabel: string, plan: RenderPlan, project: EditProject, colorRoot?: string, preserveHighBitDepthAlpha = false): string[] {
  const { clip } = input;
  assertStaticSourceWhiteBalance(clip, input.asset);
  const pixels = compositePixelContract(preserveHighBitDepthAlpha);
  const look = lookColorTerms(clip);
  const composed = composedTransformExpressions(project, clip, `(t+${animationTimeValue(clip.timelineStart)})`, plan.fps);
  const composedOpacity = composedTransformExpressions(project, clip, `(T+${animationTimeValue(clip.timelineStart)})`, plan.fps);
  const scale = escapeExpression(`(${composed.scale})*(${transitionScaleExpression(clip, "t")})`);
  const rotation = escapeExpression(composed.rotation);
  const opacity = escapeExpression(`(${composedOpacity.opacity})*(${transitionOpacityExpression(clip, "T")})`);
  const brightness = escapeExpression(`(${colorExpression(clip, "brightness")})+(${look.brightness})+(${transitionBrightnessExpression(clip, "t")})`);
  const contrast = escapeExpression(`(${colorExpression(clip, "contrast")})*(${look.contrast})`);
  const saturation = escapeExpression(`(${colorExpression(clip, "saturation")})*(${look.saturation})`);
  const hue = escapeExpression(`(${colorExpression(clip, "hue")})+(${look.hue})`);
  const primary = hasPrimaryToneAdjustment(clip.color) ? primaryToneFilters(clip.color) : [];
  const sourceAsset = hasLinearWhiteBalance(clip.color) ? whiteBalanceAssetWithMetadata(input.asset, {
    primaries: input.probe.colorPrimaries, transfer: input.probe.colorTransfer,
    matrix: input.probe.colorMatrix, range: input.probe.colorRange,
  }) : input.asset;
  const sourceColorPlan = compositorSourceColorPlan(sourceAsset, plan.width, plan.height, pixels.rgba, pixels.grayMaximum,
    project.colorManagement ?? DEFAULT_COLOR_MANAGEMENT, colorRoot, clip.color.exposure, clip.color);
  const exposure = !sourceColorPlan.exposureConsumed && clip.color.exposure !== 0 ? primaryExposureFilter(clip.color.exposure) : undefined;
  const effects = effectFilters(clip);
  const pixelMatte = pixelMatteOperation(input.alphaPlan);
  const hasMasks = input.alphaPlan.operations.length > 0;
  const animated = clip.keyframes.length > 0 || Object.keys(clip.expressions ?? {}).length > 0;
  const eqNeeded = animated
    || clip.color.brightness !== 0 || clip.color.contrast !== 1 || clip.color.saturation !== 1
    || look.brightness !== "0" || look.contrast !== "1" || look.saturation !== "1"
    || transitionBrightnessExpression(clip) !== "0";
  const hueNeeded = animated || clip.color.hue !== 0 || look.hue !== "0";
  // Admission follows the composed channels, not the child's local flags.
  // Otherwise a default child loses inherited scale/rotation, while unrelated
  // position/color keyframes force a needless full-frame geometry round trip.
  const scaleNeeded = composed.scale !== "1" || transitionScaleExpression(clip) !== "1";
  const rotationNeeded = composed.rotation !== "0";
  const layoutFilters = clip.layout ? [
    `crop=${Math.max(2, Math.round(plan.width * clip.layout.crop.width))}:${Math.max(2, Math.round(plan.height * clip.layout.crop.height))}:${Math.max(0, Math.round(plan.width * clip.layout.crop.x))}:${Math.max(0, Math.round(plan.height * clip.layout.crop.y))}`,
    `scale=${Math.max(2, Math.round(plan.width * clip.layout.viewport.width))}:${Math.max(2, Math.round(plan.height * clip.layout.viewport.height))}:flags=lanczos`,
  ] : [];
  // Geometry acts on the already-masked RGBA layer once. Mask paths and frozen
  // matte pixels are authored on the fitted project canvas, not the cropped or
  // rotated destination. Keep the same post-alpha order for unmasked sources.
  const imageFilters = [
    ...alphaAwareGeometry(layoutFilters),
    ...primary,
    ...(exposure ? [exposure] : []),
    ...(eqNeeded ? [`eq=brightness='${brightness}':contrast='${contrast}':saturation='${saturation}':eval=frame`] : []),
    ...(hueNeeded ? [`hue=h='${hue}'`] : []),
    ...effects,
    ...alphaAwareGeometry([
      ...(scaleNeeded ? [`scale='iw*(${scale})':'ih*(${scale})':eval=frame`] : []),
      ...(rotationNeeded ? [rotateWithUnclippedBounds(rotation)] : []),
    ]),
    `format=${pixels.rgba}`,
  ];
  const filters = [
    `[${input.inputIndex}:v]${sourceColorPlan.filters.join(",")}`,
    ...(input.alphaPlan.keyer ? [chromaKeyFfmpegFilter(input.alphaPlan.keyer, preserveHighBitDepthAlpha ? "high16" : "compatibility8")].filter((filter): filter is string => Boolean(filter)) : []),
    `pad=${plan.width}:${plan.height}:(ow-iw)/2:(oh-ih)/2:color=black@0`,
    "setsar=1",
    `fps=${compositeFrameClock(plan.fps).rate}`,
    `trim=duration=${finite(clip.duration)}`,
    `format=${pixels.rgba}`,
  ];
  const opacityNeeded = composedOpacity.opacity !== "1" || transitionOpacityExpression(clip) !== "1";
  const finishFilters = [
    ...imageFilters,
    ...(opacityNeeded ? [`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(${opacity})'`] : []),
    `${compositeFrameClock(plan.fps, clip.timelineStart).timestampFilters}[${outputLabel}]`,
  ];
  if (!hasMasks) return [[...filters, ...finishFilters].join(",")];
  const sourceOutput = hasMasks ? `${outputLabel}source` : outputLabel;
  filters.push(`${compositeFrameClock(plan.fps).timestampFilters}[${sourceOutput}]`);
  if (pixelMatte && input.matteInputIndex === undefined) throw new Error(`Alpha plan ${input.alphaPlan.clipId} 缺少逐像素 Matte input`);

  const matteLabel = `${outputLabel}matte`;
  const mergedLabel = `${outputLabel}merged`;
  const matteFilters = pixelMatte ? [
    `[${input.matteInputIndex}:v]scale=${plan.width}:${plan.height}:force_original_aspect_ratio=decrease`,
    `format=${pixels.gray}`,
    `pad=${plan.width}:${plan.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    "setsar=1",
    ...pixelMatteSamplingFilters(input.alphaPlan.sampleRule.projectRate, pixelMatte.matte.sequence.frameCount, Math.round(clip.duration * plan.fps)),
    `format=${pixels.gray}`,
    `${compositeFrameClock(plan.fps).timestampFilters}[${matteLabel}]`,
  ] : [];
  const sourceColor = `${outputLabel}sourcecolor`;
  const sourceAlphaRgba = `${outputLabel}sourcealphargba`;
  const sourceAlpha = `${outputLabel}sourcealpha`;
  const combinedAlpha = `${outputLabel}combinedalpha`;
  const sourceRgb = `${outputLabel}sourcergb`;
  const output = [
    filters.join(","),
    ...(pixelMatte ? [matteFilters.join(",")] : []),
    `[${sourceOutput}]split=2[${sourceColor}][${sourceAlphaRgba}]`,
    `[${sourceAlphaRgba}]alphaextract[${sourceAlpha}]`,
    ...buildClipMaskAlphaFilters(input.alphaPlan, {
      sourceAlphaLabel: sourceAlpha, pixelMatteLabel: pixelMatte ? matteLabel : undefined,
      outputLabel: combinedAlpha, width: plan.width, height: plan.height, pixelMaximum: pixels.grayMaximum,
    }),
    `[${sourceColor}]format=${pixels.rgb}[${sourceRgb}]`,
    `[${sourceRgb}][${combinedAlpha}]alphamerge[${mergedLabel}]`,
  ];
  output.push(`[${mergedLabel}]${finishFilters.join(",")}`);
  return output;
}

function videoSegments(plan: RenderPlan): Array<Extract<RenderSegment, { kind: "clip" }>> {
  return plan.videoLayers.flatMap((layer) => layer.segments.filter((segment): segment is Extract<RenderSegment, { kind: "clip" }> => segment.kind === "clip"));
}

function adjustmentVideoFilters(clip: TimelineClip, inputLabel: string, outputLabel: string): string {
  const localTime = `(t-${animationTimeValue(clip.timelineStart)})`;
  const enable = `between(t,${finite(clip.timelineStart)},${finite(clip.timelineStart + clip.duration)})`;
  const look = lookColorTerms(clip);
  const brightness = escapeExpression(`(${colorExpression(clip, "brightness", localTime)})+(${look.brightness})`);
  const contrast = escapeExpression(`(${colorExpression(clip, "contrast", localTime)})*(${look.contrast})`);
  const saturation = escapeExpression(`(${colorExpression(clip, "saturation", localTime)})*(${look.saturation})`);
  const hue = escapeExpression(`(${colorExpression(clip, "hue", localTime)})+(${look.hue})`);
  return `[${inputLabel}]eq=brightness='${brightness}':contrast='${contrast}':saturation='${saturation}':eval=frame:enable='${enable}',hue=h='${hue}':enable='${enable}'[${outputLabel}]`;
}

function overlayPositionedFilter(baseLabel: string, inputLabel: string, outputLabel: string, clip: TimelineClip, plan: RenderPlan, project: EditProject, trackMatteSource = false): string {
  const composed = composedTransformExpressions(project, clip, "t", plan.fps);
  const x = escapeExpression(composed.x);
  const y = escapeExpression(composed.y);
  const transitionTime = clip.timelineStart === 0 ? "t" : `(t-${finite(clip.timelineStart)})`;
  const transitionX = escapeExpression(transitionXExpression(clip, plan.width, transitionTime));
  // overlay's w/h are configured link dimensions, not necessarily the current
  // AVFrame after an eval=frame scale. Derive the evolving extent so zoom keeps
  // the same center. Static geometry continues to use actual negotiated w/h.
  const localScale = trackMatteSource ? composed.scale : `(${composed.scale})*(${transitionScaleExpression(clip, transitionTime)})`;
  let extentWidth = "w", extentHeight = "h";
  if (/\b(?:t|T|n|N)\b/.test(localScale)) {
    const baseWidth = !trackMatteSource && clip.layout ? Math.max(2, Math.round(plan.width * clip.layout.viewport.width)) : plan.width;
    const baseHeight = !trackMatteSource && clip.layout ? Math.max(2, Math.round(plan.height * clip.layout.viewport.height)) : plan.height;
    const scaledWidth = `max(1,trunc(${baseWidth}*(${localScale})))`;
    const scaledHeight = `max(1,trunc(${baseHeight}*(${localScale})))`;
    const radians = `((${composed.rotation})*PI/180)`;
    if (/\b(?:t|T|n|N)\b/.test(composed.rotation)) {
      extentWidth = extentHeight = `ceil(hypot(${scaledWidth},${scaledHeight})/2)*2`;
    } else if (composed.rotation !== "0" || trackMatteSource) {
      extentWidth = `ceil((abs(${scaledWidth}*cos(${radians}))+abs(${scaledHeight}*sin(${radians})))/2)*2`;
      extentHeight = `ceil((abs(${scaledWidth}*sin(${radians}))+abs(${scaledHeight}*cos(${radians})))/2)*2`;
    } else { extentWidth = scaledWidth; extentHeight = scaledHeight; }
  }
  const baseX = escapeExpression(clip.layout ? `${finite(plan.width * (clip.layout.viewport.x + clip.layout.viewport.width / 2))}-(${extentWidth})/2` : `(W-(${extentWidth}))/2`);
  const baseY = escapeExpression(clip.layout ? `${finite(plan.height * (clip.layout.viewport.y + clip.layout.viewport.height / 2))}-(${extentHeight})/2` : `(H-(${extentHeight}))/2`);
  return `[${baseLabel}][${inputLabel}]overlay=x='${baseX}+(${x})+(${transitionX})':y='${baseY}+(${y})':eval=frame:eof_action=pass:repeatlast=0:format=auto[${outputLabel}]`;
}

function positionedLayerFilters(inputLabel: string, outputLabel: string, clip: TimelineClip, plan: RenderPlan, project: EditProject, preserveHighBitDepthAlpha = false, trackMatteSource = false): string[] {
  const baseLabel = `${outputLabel}base`;
  const pixels = compositePixelContract(preserveHighBitDepthAlpha);
  return [
    `color=c=black@0:s=${plan.width}x${plan.height}:r=${compositeFrameClock(plan.fps).rate}:d=${finite(plan.duration)},format=${pixels.rgba}[${baseLabel}]`,
    overlayPositionedFilter(baseLabel, inputLabel, outputLabel, clip, plan, project, trackMatteSource),
  ];
}

function trackMatteVideoFilters(input: CompositeInput, outputLabel: string, mode: TrackMatteMode, plan: RenderPlan, project: EditProject, preserveHighBitDepthAlpha = false): string[] {
  const clip = input.clip;
  const pixels = compositePixelContract(preserveHighBitDepthAlpha);
  const composed = composedTransformExpressions(project, clip, `(t+${animationTimeValue(clip.timelineStart)})`, plan.fps);
  const spatial = clip.keyframes.length > 0 || Object.keys(clip.expressions ?? {}).length > 0 || clip.transform.scale !== 1 || clip.transform.rotation !== 0 || clip.layer?.parentClipId;
  const rawLabel = `${outputLabel}raw`;
  const canvasLabel = `${outputLabel}canvas`;
  const filters = [[
    `[${input.inputIndex}:v]scale=${plan.width}:${plan.height}:force_original_aspect_ratio=decrease`,
    `format=${pixels.rgba}`,
    ...sourceAlphaNormalizationFilters(input.asset, pixels.grayMaximum),
    `pad=${plan.width}:${plan.height}:(ow-iw)/2:(oh-ih)/2:color=black@0`,
    "setsar=1",
    `fps=${compositeFrameClock(plan.fps).rate}`,
    `trim=duration=${finite(clip.duration)}`,
    ...(spatial ? [
      `scale='iw*(${escapeExpression(composed.scale)})':'ih*(${escapeExpression(composed.scale)})':eval=frame`,
      rotateWithUnclippedBounds(escapeExpression(composed.rotation)),
    ] : []),
    `${compositeFrameClock(plan.fps, clip.timelineStart).timestampFilters}[${rawLabel}]`,
  ].join(","), ...positionedLayerFilters(rawLabel, canvasLabel, clip, plan, project, preserveHighBitDepthAlpha, true)];
  filters.push(mode.startsWith("alpha") ? `[${canvasLabel}]alphaextract[${outputLabel}plane]` : `[${canvasLabel}]format=${pixels.gray}[${outputLabel}plane]`);
  filters.push(mode.endsWith("_inverted") ? `[${outputLabel}plane]negate[${outputLabel}]` : `[${outputLabel}plane]null[${outputLabel}]`);
  return filters;
}

async function addCompositeInput(
  args: string[],
  clip: TimelineClip,
  alphaPlan: ClipAlphaPlan,
  asset: MediaAsset,
  assetPath: string,
  ffprobePath: string,
  nextIndex: number,
): Promise<CompositeInput> {
  const probe = await probeMedia(assetPath, ffprobePath);
  if (/\.(png|jpe?g|webp|bmp)$/i.test(assetPath)) args.push("-loop", "1");
  else args.push("-ss", finite(clip.sourceStart));
  args.push("-t", finite(clip.duration), "-i", assetPath);
  return { clip, alphaPlan, asset, assetPath, inputIndex: nextIndex, probe };
}

export async function renderComposite(
  ffmpegPath: string,
  ffprobePath: string,
  output: string,
  project: EditProject,
  plan: RenderPlan,
  assPath: string | undefined,
  encoder: VideoEncoder,
  timeoutMs: number,
  fontRoot?: string,
  colorRoot?: string,
  assetBase?: string,
  autoRotoCacheRoot?: string,
  preserveHighBitDepthAlpha = false,
  nativeAudioPath?: string,
): Promise<void> {
  for (const segment of videoSegments(plan)) assertStaticSourceWhiteBalance(segment.clip, project.assets.find(asset => asset.id === segment.clip.assetId));
  const pixels = compositePixelContract(preserveHighBitDepthAlpha);
  const args = [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-t", finite(plan.duration), "-i", `color=c=${preserveHighBitDepthAlpha ? "black@0" : "black"}:s=${plan.width}x${plan.height}:r=${compositeFrameClock(plan.fps).rate}${preserveHighBitDepthAlpha ? `,format=${pixels.rgba}` : ""}`,
    "-f", "lavfi", "-t", finite(plan.duration), "-i", "anullsrc=r=48000:cl=stereo",
  ];
  const inputs: CompositeInput[] = [];
  const inputsByClip = new Map<string, CompositeInput>();
  const audioInputsByClip = new Map<string, CompositeInput>();
  const trackMatteInputsByTarget = new Map<string, CompositeInput>();
  let nextIndex = 2;
  for (const segment of videoSegments(plan)) {
    if (segment.clip.layer?.role === "adjustment" || segment.clip.layer?.role === "controller") continue;
    const asset = project.assets.find((candidate) => candidate.id === segment.clip.assetId);
    if (!asset) throw new Error(`找不到視訊素材：${segment.clip.assetId}`);
    const alphaPlan = compileClipAlphaPlan(project, segment.clip, "formal");
    const input = await addCompositeInput(args, segment.clip, alphaPlan, asset, segment.assetPath, ffprobePath, nextIndex);
    if (!input.probe.hasVideo) throw new Error(`視訊片段沒有 video stream：${input.assetPath}`);
    nextIndex += 1;
    const pixelMatte = pixelMatteOperation(alphaPlan);
    if (pixelMatte) {
      const matte = pixelMatte.matte.sequence;
      const verifiedMattePath = await verifyFrozenRotoMatte(
        matte,
        resolveMediaPath(matte.sequenceUri, assetBase),
        resolveMediaPath(matte.manifestUri, assetBase),
        autoRotoCacheRoot,
      );
      input.matteInputIndex = nextIndex;
      args.push("-f", "rawvideo", "-pixel_format", "gray", "-video_size", `${matte.width}x${matte.height}`, "-framerate", ffmpegRationalRate(pixelMatte.matte.sampleRate), "-i", verifiedMattePath);
      nextIndex += 1;
    }
    inputs.push(input);
    inputsByClip.set(input.clip.id, input);
    if (input.probe.hasAudio) audioInputsByClip.set(input.clip.id, input);
  }
  for (const target of videoSegments(plan).map((segment) => segment.clip).filter((clip) => (clip.layer?.role ?? "content") === "content" && clip.layer?.trackMatte)) {
    const source = project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === target.layer!.trackMatte!.sourceClipId);
    if (!source) throw new Error(`找不到 Track Matte 來源：${target.layer!.trackMatte!.sourceClipId}`);
    const asset = project.assets.find((candidate) => candidate.id === source.assetId);
    if (!asset) throw new Error(`找不到 Track Matte 素材：${source.assetId}`);
    const materializedSource = videoSegments(plan).find((segment) => segment.clip.id === source.id);
    const trackMatteClip = materializedSource?.clip ?? source;
    const matteInput = await addCompositeInput(
      args,
      trackMatteClip,
      compileClipAlphaPlan(project, trackMatteClip, "formal"),
      asset,
      materializedSource?.assetPath ?? resolveMediaPath(asset.uri, assetBase),
      ffprobePath,
      nextIndex,
    );
    if (!matteInput.probe.hasVideo) throw new Error(`Track Matte 來源沒有 video stream：${matteInput.assetPath}`);
    trackMatteInputsByTarget.set(target.id, matteInput);
    nextIndex += 1;
  }
  if (!nativeAudioPath) {
    for (const item of plan.audioClips) {
      if (audioInputsByClip.has(item.clip.id)) continue;
      const asset = project.assets.find((candidate) => candidate.id === item.clip.assetId);
      if (!asset) throw new Error(`找不到音訊素材：${item.clip.assetId}`);
      const input = await addCompositeInput(args, item.clip, compileClipAlphaPlan(project, item.clip, "formal"), asset, item.assetPath, ffprobePath, nextIndex);
      inputs.push(input);
      audioInputsByClip.set(input.clip.id, input);
      if (!inputsByClip.has(input.clip.id)) inputsByClip.set(input.clip.id, input);
      nextIndex += 1;
    }
  }
  const nativeAudioInputIndex = nativeAudioPath ? nextIndex : undefined;
  if (nativeAudioPath) {
    args.push("-f", "f32le", "-ar", "48000", "-ac", "2", "-i", nativeAudioPath);
    nextIndex += 1;
  }

  const filters: string[] = [`[0:v]fps=${compositeFrameClock(plan.fps).rate},format=${pixels.rgba}[composite0]`];
  let compositeIndex = 0;
  for (const segment of videoSegments(plan)) {
    if (segment.clip.layer?.role === "controller") continue;
    const input = inputsByClip.get(segment.clip.id);
    const clipLabel = `vclip${compositeIndex}`;
    const outputLabel = `composite${compositeIndex + 1}`;
    if (segment.clip.layer?.role === "adjustment") {
      filters.push(adjustmentVideoFilters(segment.clip, `composite${compositeIndex}`, outputLabel));
      compositeIndex += 1;
      continue;
    }
    if (!input?.probe.hasVideo) continue;
    filters.push(...compositorVideoFilters(input, clipLabel, plan, project, colorRoot, preserveHighBitDepthAlpha));
    let positionedLabel = clipLabel;
    let alreadyPositioned = false;
    const trackMatte = input.clip.layer?.trackMatte;
    if (trackMatte) {
      const matteInput = trackMatteInputsByTarget.get(input.clip.id);
      if (!matteInput) throw new Error(`Track Matte input 未建立：${input.clip.id}`);
      const targetCanvas = `${clipLabel}canvas`;
      const matteLabel = `${clipLabel}trackmatte`;
      filters.push(...positionedLayerFilters(clipLabel, targetCanvas, input.clip, plan, project, preserveHighBitDepthAlpha));
      filters.push(...trackMatteVideoFilters(matteInput, matteLabel, trackMatte.mode, plan, project, preserveHighBitDepthAlpha));
      filters.push(`[${targetCanvas}]split[${clipLabel}color][${clipLabel}alpha]`);
      filters.push(`[${clipLabel}alpha]alphaextract[${clipLabel}targetalpha]`);
      filters.push(`[${clipLabel}targetalpha][${matteLabel}]blend=all_mode=multiply[${clipLabel}combinedalpha]`);
      filters.push(`[${clipLabel}color]format=${pixels.rgb}[${clipLabel}rgb]`);
      positionedLabel = `${clipLabel}masked`;
      filters.push(`[${clipLabel}rgb][${clipLabel}combinedalpha]alphamerge[${positionedLabel}]`);
      alreadyPositioned = true;
    }
    const blendMode = input.clip.layer?.blendMode ?? "normal";
    if (blendMode === "normal") {
      if (alreadyPositioned) filters.push(`[composite${compositeIndex}][${positionedLabel}]overlay=x=0:y=0:eof_action=pass:repeatlast=0:format=auto[${outputLabel}]`);
      else filters.push(overlayPositionedFilter(`composite${compositeIndex}`, clipLabel, outputLabel, input.clip, plan, project));
    } else {
      const neutralLabel = `neutral${compositeIndex}`;
      const blendPositionedLabel = `positioned${compositeIndex}`;
      const neutral = ffmpegBlendNeutral(blendMode);
      const ffmpegMode = ffmpegBlendMode(blendMode);
      filters.push(`color=c=${neutral}:s=${plan.width}x${plan.height}:r=${compositeFrameClock(plan.fps).rate}:d=${finite(plan.duration)},format=${pixels.rgba}[${neutralLabel}]`);
      if (alreadyPositioned) filters.push(`[${neutralLabel}][${positionedLabel}]overlay=x=0:y=0:eof_action=pass:repeatlast=0:format=auto[${blendPositionedLabel}]`);
      else filters.push(overlayPositionedFilter(neutralLabel, clipLabel, blendPositionedLabel, input.clip, plan, project));
      filters.push(`[composite${compositeIndex}][${blendPositionedLabel}]blend=all_mode=${ffmpegMode}:shortest=0:repeatlast=0[${outputLabel}]`);
    }
    compositeIndex += 1;
  }
  const compositeLabel = `composite${compositeIndex}`;
  const outputTransform = preserveHighBitDepthAlpha ? "" : acesOutputFilter(project.colorManagement ?? DEFAULT_COLOR_MANAGEMENT, colorRoot);
  const displayLabel = outputTransform ? "displayout" : compositeLabel;
  if (outputTransform) filters.push(`[${compositeLabel}]format=gbrpf32le,${outputTransform}[${displayLabel}]`);
  const hdr = !preserveHighBitDepthAlpha && isHdrOutput(project);
  const pixelFormat = preserveHighBitDepthAlpha ? pixels.encodedPixelFormat : hdr ? "yuv420p10le" : "yuv420p";
  filters.push(assPath
    ? `[${displayLabel}]${buildAssFilter(assPath, fontRoot)},format=${pixelFormat}[vout]`
    : `[${displayLabel}]format=${pixelFormat}[vout]`);

  if (nativeAudioInputIndex !== undefined) {
    filters.push(masterAudioFilter(`[${nativeAudioInputIndex}:a]`, plan.duration));
  } else {
    filters.push(`[1:a]atrim=duration=${finite(plan.duration)},asetpts=PTS-STARTPTS[abase]`);
    const voiceLabels = ["[abase]"];
    const musicLabels: string[] = [];
    let audioIndex = 0;
    for (const item of plan.audioClips) {
      const input = audioInputsByClip.get(item.clip.id);
      if (!input?.probe.hasAudio) continue;
      const label = `aclip${audioIndex}`;
      const asset = project.assets.find((candidate) => candidate.id === item.clip.assetId);
      const music = asset?.role === "background-music";
      const fade = music ? Math.min(1.2, item.clip.duration / 5) : 0;
      const fadeFilter = music && fade > 0
        ? `,afade=t=in:st=0:d=${finite(fade)},afade=t=out:st=${finite(Math.max(0, item.clip.duration - fade))}:d=${finite(fade)}` : "";
      filters.push(
        `[${input.inputIndex}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${finite(item.clip.duration)},asetpts=PTS-STARTPTS${fadeFilter},adelay=${Math.round(item.clip.timelineStart * 1000)}:all=1,volume=${finite(item.clip.volume)}[${label}]`,
      );
      (music ? musicLabels : voiceLabels).push(`[${label}]`);
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
        // Do not drive sidechaincompress with the synthetic silent duration bed.
        // Its framesync EOF is scheduling-dependent and can erase the music tail.
        filters.push("[voicemix][musicbus]amix=inputs=2:duration=longest:normalize=0[premaster]");
      }
      filters.push(masterAudioFilter("[premaster]", plan.duration));
    } else if (voiceLabels.length > 1) {
      filters.push(masterAudioFilter("[voicemix]", plan.duration));
    } else {
      // FFmpeg loudnorm can emit NaN for mathematical silence; keep a valid
      // silent stereo track instead of allowing AAC encoding to fail.
      filters.push(`[voicemix]atrim=duration=${finite(plan.duration)},asetpts=PTS-STARTPTS[aout]`);
    }
  }
  args.push(
    "-filter_complex", filters.join(";"), "-map", "[vout]", "-map", "[aout]",
    ...encoderArgs(encoder), "-pix_fmt", pixelFormat,
    ...outputColorMetadataArgs(encoder, !preserveHighBitDepthAlpha && project.colorManagement?.mode === "aces2" ? project.colorManagement.outputTransform : "rec709_sdr"),
    "-c:a", preserveHighBitDepthAlpha ? "pcm_s24le" : "aac", ...(preserveHighBitDepthAlpha ? [] : ["-b:a", "192k"]), "-ar", "48000", "-ac", "2",
    "-t", finite(plan.duration), "-video_track_timescale", "90000", "-movflags", "+faststart", output,
  );
  await runProcess(ffmpegPath, args, timeoutMs);
}
