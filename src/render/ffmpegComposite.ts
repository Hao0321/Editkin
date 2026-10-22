import { encoderProbeCanvasV1, encoderProbeFiltersV1, type EncoderProbeCanvasV1 } from "./encoderProbeCanvasV1";
import { prepareUnifiedLayerAssFilesV1, type PreparedUnifiedCompositeOperationV1 } from "./unifiedLayerAssFilesV1";
import { secondaryHslSourceNodesV1 } from "../domain/secondaryHslV1Nodes";
import { clipMirrorFilters } from "../domain/clipMirrors";
import { clipAudioEnvelopeFilter } from "./clipAudioEnvelopeFilters";
import { createHash, randomUUID } from "node:crypto";
import { assertRenderActive } from "./renderLifetime";
import { PendingNativeCloseError } from "../shared/pendingNativeClose";
import { compositeChunkAssClockV1, compositeChunkOutputPlanV1, type CompositeChunkOutputV1 } from "./compositeChunkOutputV1";
import { runRawVideoProcessV1 } from "./rawVideoProcessV1";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ColorManagementSettings, EditProject, MediaAsset, OpenExrImageSequence, TimelineClip, TrackMatteMode } from "../domain/types";
import { acesOutputFilter, primaryExposureFilter, primaryToneFilters, resolveAcesInput } from "../color/primaryGrade";
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
import { buildAssFilter, writeAssContent, type MotionAssOptions } from "./captionAss";
import { buildClipMaskAlphaFilters } from "./maskFilters";
import { appendFixedWindowMaskInputsV3, prepareFixedWindowMaskPlanesV3, type PreparedFixedWindowMaskPlanesV3 } from "./fixedWindowMaskRasterV3";
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
import { FFMPEG_PROGRESS_ARGS } from "./mediaProcess";
import { createRenderWorkDirectory, removeRenderWorkDirectory } from "./renderWorkspace";
import { highBitDepthAlphaEncoderArgs } from "./highBitDepthAlphaDelivery";
import { acesCompositeWorkingPixelsV1, aces16BlendFilterV1, aces16OverlayGraphV1, aces16OverOpaqueGraphV1, aces16PositionedLayerGraphV1, usesOpaqueAces16V1 } from "./acesOpaque16V1";
import { aces16ClipImageGraphV1, aces16ImageFilterChainsV1, aces16SurfaceFilterV1 } from "./aces16ImageFiltersV1";
import { aces16AlphaMultiplyV1, aces16AlphaPlaneJoinV1 } from "./aces16AlphaPlanesV1";
import { aces16AlphaOverGraphV1 } from "./aces16AlphaCompositeV1";
import { aces16PrecompositionEncoderArgsV1, aces16PrecompositionMetadataArgsV1 } from "./aces16PrecompositionV1";
import { outputColorMetadataArgs } from "./outputColorMetadata";
import { compositorSourceColorPlan } from "./sourceColorFilters";
import { hasLinearWhiteBalance } from "../color/linearWhiteBalance";
import { whiteBalanceAssetWithMetadata } from "./sourceLinearWhiteBalance";
import { assertStaticSourceWhiteBalance } from "./linearWhiteBalanceSupport";
import { compositeFrameClock } from "./compositeFrameClock";
import { floatingFrameBackdropLavfi, floatingFrameFfmpegFilters } from "../motion/floatingVideoFrame";
import { assertMediaAssetDisplayGeometry } from "./mediaDisplayGeometry";
import { pixelMatteSamplingFilters } from "./pixelMatteSampling";
import { animatedGeometryCanvas, fixedAnimatedAffineFilters } from "./animatedGeometryCanvas";
import { gradeWorkingSpace, resolveColorGradeV2, type GradeWorkingSpace, type ResolvedFinishingV2 } from "../color/gradeV2";
import { bakeResolvedGradeLut, ffmpegRenderCubeText } from "../color/gradeLutBake";
import { ffmpegFilterPath, gradeV2LutFilters, gradeV2SpatialChains } from "../color/gradeV2Ffmpeg";
import { parseCubeLut, serializeCube3d, type CubeLut, type ParsedCube } from "../color/cubeLut";
import { colorLutLibraryRoot, resolveColorLut } from "../application/creativeLibrary";
import { ACES_SDR_OUTPUT_LUT, acesDisplayInverseFor, usesAcesDisplayReconstruction } from "../color/acesDisplayInverse";
import { proofStillSourceFiltersV1, verifyProofStillCompositeSourcesV1 } from "./proofStillRouteV1";
import { sha256File } from "../plugins/nativeEffectGpuHelpers";

export function encoderArgs(encoder: VideoEncoder): string[] {
  if (encoder === "ffv1") return aces16PrecompositionEncoderArgsV1();
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

export async function chooseEncoder(ffmpegPath: string, preferGpu: boolean, timeoutMs: number, hdr: boolean, target?: EncoderProbeCanvasV1): Promise<VideoEncoder> {
  if (!preferGpu) return hdr ? "libx265" : "libx264";
  const hardwareEncoder: VideoEncoder | undefined = process.platform === "win32"
    ? (hdr ? "hevc_nvenc" : "h264_nvenc")
    : process.platform === "darwin" ? (hdr ? "hevc_videotoolbox" : "h264_videotoolbox") : undefined;
  if (!hardwareEncoder) return hdr ? "libx265" : "libx264";
  const canvas = encoderProbeCanvasV1(target);
  try {
    await runProcess(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=black:s=${canvas.width}x${canvas.height}:d=0.1`,
      "-frames:v", "1", "-vf", encoderProbeFiltersV1(canvas, hdr), "-c:v", hardwareEncoder, ...(hdr ? ["-profile:v", "main10"] : []), "-f", "null", "-",
    ], Math.min(timeoutMs, 20_000));
    return hardwareEncoder;
  } catch (error) {
    if (error instanceof PendingNativeCloseError) throw error;
    assertRenderActive();
    return hdr ? "libx265" : "libx264";
  }
}

import { assertTimelineTransitionVideoBoundsV2 } from "./timelineTransitionVideoBoundsV2";
import { assertTimelineTransitionProbeV1, timelineTransitionFloatingClockV1, timelineTransitionLocalTimeV1, timelineTransitionMattePaddingV1, timelineTransitionReadViewsV1, type TimelineTransitionReadViewV1 } from "./timelineTransitionReadV1";
import { timelineTransitionCompositeGraphV1, type TimelineTransitionMatteInputV1 } from "./timelineTransitionCompositeV1";
import { timelineTransitionMatteSourcesV1 } from "./timelineTransitionMatteV1";
import { prepareTimelineTransitionMatteLutsV1, type TimelineTransitionMatteLutsV1 } from "./timelineTransitionMatteNativeV1";

interface CompositeInput {
  transitionRead?: TimelineTransitionReadViewV1;
  clip: TimelineClip;
  alphaPlan: ClipAlphaPlan;
  asset: MediaAsset;
  assetPath: string;
  inputIndex: number;
  probe: MediaProbe;
  matteInputIndex?: number;
  fixedVectorInputIndexes?: ReadonlyMap<string, number>;
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

/** Per-clip Color Grade v2 export stage: one baked 65³ LUT file plus optional spatial finishing. */
export interface CompositeGradeStage {
  space: GradeWorkingSpace;
  lutPath?: string;
  finishing?: ResolvedFinishingV2;
  /**
   * ACES 2.0 SDR + display-referred source (phone Rec.709/sRGB/HLG/PQ): the inverse of the shipped
   * SDR output LUT, used as this clip's input transform instead of Camera Rec.709 / HLG-display.
   * HDR sources are first rendered to SDR exactly like the Rec.709 path. See color/acesDisplayInverse.
   */
  displayInverseLutPath?: string;
}

/**
 * Source colour plan of a reconstructed clip: the Rec.709 path's display-referred SDR rendering
 * (no-op for SDR, the verified BT.2100 display decode + Hable shoulder for HLG/PQ), then the
 * display-code → ACEScct inverse table in float.
 */
function displayReconstructionSourcePlan(asset: MediaAsset, plan: RenderPlan, project: EditProject, clip: TimelineClip, rgba: string, grayMaximum: number,
  colorRoot: string | undefined, inverseLutPath: string, sourceFit: "raw-source" | "canvas-contain"): { filters: string[]; exposureConsumed: boolean } {
  const management = project.colorManagement ?? DEFAULT_COLOR_MANAGEMENT;
  const display = compositorSourceColorPlan(asset, plan.width, plan.height, rgba, grayMaximum, { ...management, mode: "rec709", outputTransform: "rec709_sdr" },
    colorRoot, clip.color.exposure, clip.color, sourceFit);
  return { filters: [...display.filters, "format=gbrpf32le", `lut3d=file='${ffmpegFilterPath(inverseLutPath)}':interp=tetrahedral`], exposureConsumed: display.exposureConsumed };
}

export function compositorVideoFilters(input: CompositeInput, outputLabel: string, plan: RenderPlan, project: EditProject, colorRoot?: string, preserveHighBitDepthAlpha = false, grade?: CompositeGradeStage): string[] {
  const { clip } = input;
  const readView = input.transitionRead, readClip = readView?.readClip ?? clip;
  const pair16 = Boolean(plan.pairTransitions?.length) || plan.compositePrecision16 === true, use16 = usesOpaqueAces16V1(project.colorManagement) || pair16;
  const localTime = timelineTransitionLocalTimeV1(readView, "t"), alphaTime = timelineTransitionLocalTimeV1(readView, "T");
  assertStaticSourceWhiteBalance(clip, input.asset);
  const pixels = acesCompositeWorkingPixelsV1(project.colorManagement, preserveHighBitDepthAlpha || pair16);
  const look = lookColorTerms(clip);
  const composed = composedTransformExpressions(project, clip, `(t+${animationTimeValue(readClip.timelineStart)})`, plan.fps);
  const composedOpacity = composedTransformExpressions(project, clip, `(T+${animationTimeValue(readClip.timelineStart)})`, plan.fps);
  const scale = escapeExpression(`(${composed.scale})*(${transitionScaleExpression(clip, localTime)})`);
  const rotation = escapeExpression(composed.rotation);
  const opacity = escapeExpression(`(${composedOpacity.opacity})*(${transitionOpacityExpression(clip, alphaTime)})`);
  const brightness = escapeExpression(`(${colorExpression(clip, "brightness", localTime)})+(${look.brightness})+(${transitionBrightnessExpression(clip, localTime)})`);
  const contrast = escapeExpression(`(${colorExpression(clip, "contrast", localTime)})*(${look.contrast})`);
  const saturation = escapeExpression(`(${colorExpression(clip, "saturation", localTime)})*(${look.saturation})`);
  const hue = escapeExpression(`(${colorExpression(clip, "hue", localTime)})+(${look.hue})`);
  const primary = hasPrimaryToneAdjustment(clip.color) ? primaryToneFilters(clip.color) : [];
  const sourceAsset = hasLinearWhiteBalance(clip.color) ? whiteBalanceAssetWithMetadata(input.asset, {
    primaries: input.probe.colorPrimaries, transfer: input.probe.colorTransfer,
    matrix: input.probe.colorMatrix, range: input.probe.colorRange,
  }) : input.asset;
  const rawFloatingSource = Boolean(clip.floatingFrame);
  // Proof stills arrive already cropped in source pixels and resampled once to their viewport (proofStillRouteV1).
  const proofStillCrisp = clip.proofStill !== undefined;
  const floatingV2Context = clip.floatingFrame?.schema === "editkin.floating-video-frame/v2" ? {
    ...assertMediaAssetDisplayGeometry(input.asset, input.probe),
    durationFrames: Math.round(clip.duration * plan.fps),
  } : undefined;
  if (!clip.floatingFrame && input.asset.displayAspectRatio !== undefined) {
    // New ordinary/template layouts use an explicit upright physical DAR too.
    // Verify the actual current file before its square-pixel canvas conversion.
    assertMediaAssetDisplayGeometry(input.asset, input.probe);
  }
  const sourceColorPlan = grade?.displayInverseLutPath
    ? displayReconstructionSourcePlan(sourceAsset, plan, project, clip, pixels.rgba, pixels.grayMaximum, colorRoot, grade.displayInverseLutPath,
      rawFloatingSource || proofStillCrisp ? "raw-source" : "canvas-contain")
    : compositorSourceColorPlan(sourceAsset, plan.width, plan.height, pixels.rgba, pixels.grayMaximum,
      project.colorManagement ?? DEFAULT_COLOR_MANAGEMENT, colorRoot, clip.color.exposure, clip.color,
      rawFloatingSource || proofStillCrisp ? "raw-source" : "canvas-contain");
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
  const fixedAffineFilters = fixedAnimatedAffineFilters(project, clip, plan.width, plan.height, readView?.localTimeOffset);
  const layoutFilters = clip.layout && !proofStillCrisp ? [
    `crop=${Math.max(2, Math.round(plan.width * clip.layout.crop.width))}:${Math.max(2, Math.round(plan.height * clip.layout.crop.height))}:${Math.max(0, Math.round(plan.width * clip.layout.crop.x))}:${Math.max(0, Math.round(plan.height * clip.layout.crop.y))}`,
    `scale=${Math.max(2, Math.round(plan.width * clip.layout.viewport.width))}:${Math.max(2, Math.round(plan.height * clip.layout.viewport.height))}:flags=lanczos`,
  ] : [];
  // Geometry acts on the already-masked RGBA layer once. Mask paths and frozen
  // matte pixels are authored on the fitted project canvas, not the cropped or
  // rotated destination. Keep the same post-alpha order for unmasked sources.
  const preImage = [
    ...alphaAwareGeometry(layoutFilters),
    ...primary,
    ...(exposure ? [exposure] : []),
    ...(eqNeeded ? [`eq=brightness='${brightness}':contrast='${contrast}':saturation='${saturation}':eval=frame`] : []),
    ...(hueNeeded ? [`hue=h='${hue}'`] : []),
  ];
  const postImage = [
    ...effects,
    ...(clip.floatingFrame ? timelineTransitionFloatingClockV1(floatingFrameFfmpegFilters(clip.floatingFrame, plan.width, plan.height, plan.fps, floatingV2Context), readView, plan.fps) : []),
    ...clipMirrorFilters(composed),
    ...alphaAwareGeometry(fixedAffineFilters ?? [
      ...(scaleNeeded ? [`scale='iw*(${scale})':'ih*(${scale})':eval=frame`] : []),
      ...(rotationNeeded ? [rotateWithUnclippedBounds(rotation)] : []),
    ]),
    `format=${pixels.rgba}`,
  ];
  // Color Grade v2 sits after the primary grade and legacy look, before effects and
  // geometry. Without gradeV2 both lists below are empty and the chain is unchanged.
  const gradeLut = grade?.lutPath ? gradeV2LutFilters(grade.lutPath, pixels.grayMaximum === 65535) : [];
  const gradeFinishing = grade?.finishing;
  const imageFilters = gradeLut.length && !gradeFinishing
    ? [...preImage, ...gradeLut, `format=${pixels.rgba}`, ...postImage]
    : [...preImage, ...postImage];
  const filters = [
    // Proof stills only: exact source-pixel crop, solid redaction fills, one Lanczos resample to the viewport. Otherwise empty.
    `[${input.inputIndex}:v]${[...proofStillSourceFiltersV1(input, plan, pixels.rgba), ...sourceColorPlan.filters].join(",")}`,
    ...(input.alphaPlan.keyer ? [chromaKeyFfmpegFilter(input.alphaPlan.keyer, pixels.grayMaximum === 65535 ? "high16" : "compatibility8")].filter((filter): filter is string => Boolean(filter)) : []),
    ...(!rawFloatingSource ? [
      ...(proofStillCrisp ? [] : [`pad=${plan.width}:${plan.height}:(ow-iw)/2:(oh-ih)/2:color=black@0`]),
      "setsar=1",
    ] : []),
    `fps=${compositeFrameClock(plan.fps).rate}`,
    floatingV2Context ? `trim=end_frame=${readView?.readFrames ?? floatingV2Context.durationFrames}` : `trim=duration=${finite(readClip.duration)}`,
    // v2 expressions use local output N/on only after project-fps conversion,
    // trim and PTS rebasing. v1 and ordinary source chains remain unchanged.
    ...(floatingV2Context ? [compositeFrameClock(plan.fps).timestampFilters] : []),
    `format=${pixels.rgba}`,
  ];
  const opacityNeeded = composedOpacity.opacity !== "1" || transitionOpacityExpression(clip) !== "1";
  const finishTail = [
    ...(opacityNeeded ? [`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(${opacity})'`] : []),
    `${compositeFrameClock(plan.fps, readClip.timelineStart).timestampFilters}[${outputLabel}]`,
  ];
  const finishFilters = [...imageFilters, ...finishTail];
  // Spatial finishing needs split/blend branches: end the chain after the grade LUT,
  // run the finishing sub-graph, then continue with effects, geometry and timing.
  const gradedFinish = (head: string): string[] => {
    if (use16) return aces16ClipImageGraphV1({
      head, output: outputLabel, preImage, gradeLut, postImage, finishTail, finishing: gradeFinishing,
      space: grade?.space ?? gradeWorkingSpace(project.colorManagement), canvasHeight: plan.height,
    });
    const pre = `${outputLabel}gradepre`, post = `${outputLabel}gradepost`;
    const graded = [...preImage, ...gradeLut];
    const opening = head.endsWith("]") ? `${head}${graded.length ? graded.join(",") : "null"}` : [head, ...graded].join(",");
    return [
      `${opening}[${pre}]`,
      ...gradeV2SpatialChains(pre, post, gradeFinishing!, { space: grade!.space, canvasHeight: plan.height, labelPrefix: `${outputLabel}gradefx`, highBitDepth: preserveHighBitDepthAlpha }),
      `[${post}]${[`format=${pixels.rgba}`, ...postImage, ...finishTail].join(",")}`,
    ];
  };
  if (!hasMasks) return gradeFinishing || use16 ? gradedFinish(filters.join(",")) : [[...filters, ...finishFilters].join(",")];
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
    ...timelineTransitionMattePaddingV1(readView),
    `format=${pixels.gray}`,
    `${compositeFrameClock(plan.fps).timestampFilters}[${matteLabel}]`,
  ] : [];
  const vectorPlaneLabels = new Map<string, string>();
  const fixedVectorFilters = [...(input.fixedVectorInputIndexes ?? [])].map(([maskId, inputIndex], index) => {
    const label = `${outputLabel}fixedmask${index}`; vectorPlaneLabels.set(maskId, label);
    return `[${inputIndex}:v]format=${pixels.gray},setsar=1,${[...timelineTransitionMattePaddingV1(readView), compositeFrameClock(plan.fps).timestampFilters].join(",")}[${label}]`;
  });
  const sourceColor = `${outputLabel}sourcecolor`;
  const sourceAlphaRgba = `${outputLabel}sourcealphargba`;
  const sourceAlpha = `${outputLabel}sourcealpha`;
  const combinedAlpha = `${outputLabel}combinedalpha`;
  const sourceRgb = `${outputLabel}sourcergb`;
  const output = [
    use16 ? aces16SurfaceFilterV1(filters.join(",")) : filters.join(","),
    ...(pixelMatte ? [matteFilters.join(",")] : []),
    ...fixedVectorFilters,
    `[${sourceOutput}]split=2[${sourceColor}][${sourceAlphaRgba}]`,
    `[${sourceAlphaRgba}]alphaextract[${sourceAlpha}]`,
    ...buildClipMaskAlphaFilters(input.alphaPlan, {
      sourceAlphaLabel: sourceAlpha, pixelMatteLabel: pixelMatte ? matteLabel : undefined, vectorPlaneLabels,
      outputLabel: combinedAlpha, width: plan.width, height: plan.height, pixelMaximum: pixels.grayMaximum,
      localTimeOffset: readView?.localTimeOffset, originalDuration: clip.duration,
    }),
    `[${sourceColor}]format=${use16 ? pixels.rgba : pixels.rgb}[${sourceRgb}]`,
    use16 ? aces16AlphaPlaneJoinV1(sourceRgb, combinedAlpha, mergedLabel) : `[${sourceRgb}][${combinedAlpha}]alphamerge[${mergedLabel}]`,
  ];
  if (gradeFinishing || use16) output.push(...gradedFinish(`[${mergedLabel}]`));
  else output.push(`[${mergedLabel}]${finishFilters.join(",")}`);
  return output;
}

import { acesSdrOutputLutPathV1, usesAcesClipDisplayInverseV1 } from "../color/acesPhoneInputV1";

const acesOutputLuts = new Map<string, Promise<{ lut: CubeLut; inverseText?: string }>>();

/** The shipped ACES 2.0 SDR output LUT, parsed once per file version; its display inverse is cached on the parse. */
async function acesSdrOutputLut(colorRoot: string, management: ColorManagementSettings): Promise<{ lut: CubeLut; inverseText?: string }> {
  const path = join(colorRoot, acesSdrOutputLutPathV1(management));
  const info = await stat(path);
  const key = `${resolve(path)}:${info.size}:${info.mtimeMs}`;
  let pending = acesOutputLuts.get(key);
  if (!pending) {
    pending = readFile(path, "utf8").then(text => ({ lut: parseCubeLut(text) }));
    acesOutputLuts.set(key, pending);
    pending.catch(() => acesOutputLuts.delete(key));
  }
  return pending;
}

/** Writes this render's copy of the display inverse (identical bytes for one output LUT). */
async function writeAcesDisplayInverse(colorRoot: string | undefined, workDirectory: string, management: ColorManagementSettings): Promise<string> {
  if (!colorRoot) throw new Error("ACES 2.0 色彩資源未載入；不能用 Rec.709 假裝輸出。");
  const entry = await acesSdrOutputLut(colorRoot, management);
  if (entry.inverseText === undefined) {
    const inverse = acesDisplayInverseFor(entry.lut);
    entry.inverseText = serializeCube3d(inverse.values, inverse.size, "Editkin ACES 2.0 SDR display inverse (display code to ACEScct)");
  }
  const path = join(workDirectory, "aces-display-inverse.cube");
  await writeFile(path, entry.inverseText, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return path;
}

/**
 * Bakes each graded clip's non-spatial Color Grade v2 into one 65³ .cube (deduplicated by
 * its canonical key) inside a private work directory. Projects without gradeV2 return an
 * empty map and create nothing, so their filter graphs are untouched. In ACES 2.0 SDR projects
 * a graded display-referred clip also gets the display inverse as its input transform.
 */
export async function prepareCompositeGrades(project: EditProject, plan: RenderPlan, highBitDepth = false, colorRoot?: string): Promise<{ stages: Map<string, CompositeGradeStage>; workDirectory?: string }> {
  const management = project.colorManagement ?? DEFAULT_COLOR_MANAGEMENT;
  const graded = videoSegments(plan).map(segment => segment.clip).filter(clip => {
    const asset = project.assets.find(candidate => candidate.id === clip.assetId);
    return (clip.layer?.role ?? "content") !== "controller" && (clip.gradeV2 || (asset && usesAcesClipDisplayInverseV1(resolveAcesInput(asset), management, clip, hasLinearWhiteBalance(clip.color))));
  });
  if (!graded.length) return { stages: new Map() };
  const space = gradeWorkingSpace(management);
  const cubes = new Map<string, ParsedCube>();
  for (const clip of graded) {
    if ((clip.layer?.role ?? "content") === "adjustment") throw new Error(`Color Grade v2 尚不支援調整圖層：${clip.id}`);
    for (const node of secondaryHslSourceNodesV1(clip.gradeV2?.nodes ?? [])) {
      if (!node.lut || node.enabled === false || node.lut.strength <= 0 || (node.mix ?? 1) === 0 || cubes.has(node.lut.sha256)) continue;
      const resolved = await resolveColorLut(colorLutLibraryRoot(), node.lut.id, node.lut.sha256);
      if (resolved.entry.inputSpace !== space) throw new Error(`LUT ${node.lut.id} 需要 ${resolved.entry.inputSpace} 工作空間，專案目前是 ${space}；請改用對應色彩管理或另一個 LUT`);
      cubes.set(node.lut.sha256, resolved.cube);
    }
  }
  const stages = new Map<string, CompositeGradeStage>();
  const written = new Map<string, string>();
  let workDirectory: string | undefined;
  let displayInverseLutPath: string | undefined;
  try {
    for (const clip of graded) {
      const asset = project.assets.find(candidate => candidate.id === clip.assetId);
      // Linear white balance keeps its existing ACES refusal (compositorSourceColorPlan); log / ACEScct / EXR stay scene-referred.
      const reconstruct = asset !== undefined && usesAcesClipDisplayInverseV1(resolveAcesInput(asset), management, clip, hasLinearWhiteBalance(clip.color));
      if (reconstruct && !displayInverseLutPath) {
        workDirectory ??= await createRenderWorkDirectory("editkin-render-");
        displayInverseLutPath = await writeAcesDisplayInverse(colorRoot, workDirectory, management);
      }
      const resolved = resolveColorGradeV2(clip.gradeV2 ?? { schema: "editkin.color-grade/v2" }, space, ref => {
        const cube = cubes.get(ref.sha256);
        if (!cube) throw new Error(`Color Grade v2 LUT 未載入：${ref.id}`);
        return cube;
      });
      let lutPath: string | undefined;
      if (!resolved.identity) {
        const key = createHash("sha256").update(resolved.key).digest("hex");
        lutPath = written.get(key);
        if (!lutPath) {
          workDirectory ??= await createRenderWorkDirectory("editkin-render-");
          lutPath = join(workDirectory, `grade-${key.slice(0, 24)}.cube`);
          await writeFile(lutPath, ffmpegRenderCubeText(bakeResolvedGradeLut(resolved), `Editkin Color Grade v2 ${key.slice(0, 12)}`, highBitDepth), { encoding: "utf8", flag: "wx", mode: 0o600 });
          written.set(key, lutPath);
        }
      }
      if (lutPath || resolved.finishing || reconstruct) stages.set(clip.id, { space, ...(lutPath ? { lutPath } : {}), ...(resolved.finishing ? { finishing: resolved.finishing } : {}),
        ...(reconstruct ? { displayInverseLutPath } : {}) });
    }
  } catch (error) {
    if (workDirectory) await removeRenderWorkDirectory(workDirectory);
    throw error;
  }
  return { stages, ...(workDirectory ? { workDirectory } : {}) };
}

function videoSegments(plan: RenderPlan): Array<Extract<RenderSegment, { kind: "clip" }>> {
  return plan.videoLayers.flatMap((layer) => layer.segments.filter((segment): segment is Extract<RenderSegment, { kind: "clip" }> => segment.kind === "clip"));
}

function adjustmentVideoFilters(clip: TimelineClip, inputLabel: string, outputLabel: string, opaqueAces16 = false): string {
  const localTime = `(t-${animationTimeValue(clip.timelineStart)})`;
  const enable = `between(t,${finite(clip.timelineStart)},${finite(clip.timelineStart + clip.duration)})`;
  const look = lookColorTerms(clip);
  const brightness = escapeExpression(`(${colorExpression(clip, "brightness", localTime)})+(${look.brightness})`);
  const contrast = escapeExpression(`(${colorExpression(clip, "contrast", localTime)})*(${look.contrast})`);
  const saturation = escapeExpression(`(${colorExpression(clip, "saturation", localTime)})*(${look.saturation})`);
  const hue = escapeExpression(`(${colorExpression(clip, "hue", localTime)})+(${look.hue})`);
  if (opaqueAces16) return aces16ImageFilterChainsV1(inputLabel, outputLabel, [
    `eq=brightness='${brightness}':contrast='${contrast}':saturation='${saturation}':eval=frame:enable='${enable}'`,
    `hue=h='${hue}':enable='${enable}'`,
  ], `${outputLabel}adjust16`).join(";");
  return `[${inputLabel}]eq=brightness='${brightness}':contrast='${contrast}':saturation='${saturation}':eval=frame:enable='${enable}',hue=h='${hue}':enable='${enable}'[${outputLabel}]`;
}

export function overlayPositionedFilter(baseLabel: string, inputLabel: string, outputLabel: string, clip: TimelineClip, plan: RenderPlan, project: EditProject, trackMatteSource = false, preserveHighBitDepthAlpha = false): string {
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
  if (/\b(?:t|T|n|N)\b/.test(localScale) && (trackMatteSource || !animatedGeometryCanvas(project, clip, plan.width, plan.height))) {
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
  if (usesOpaqueAces16V1(project.colorManagement)) return aces16OverlayGraphV1(baseLabel, inputLabel, outputLabel, clip, plan, project, trackMatteSource, preserveHighBitDepthAlpha).join(";");
  return `[${baseLabel}][${inputLabel}]overlay=x='${baseX}+(${x})+(${transitionX})':y='${baseY}+(${y})':eval=frame:eof_action=pass:repeatlast=0:format=auto[${outputLabel}]`;
}

function positionedLayerFilters(inputLabel: string, outputLabel: string, clip: TimelineClip, plan: RenderPlan, project: EditProject, preserveHighBitDepthAlpha = false, trackMatteSource = false, forceWorking16 = false): string[] {
  if (usesOpaqueAces16V1(project.colorManagement) || forceWorking16) return aces16PositionedLayerGraphV1(inputLabel, outputLabel, clip, plan, project, trackMatteSource);
  const baseLabel = `${outputLabel}base`;
  const pixels = acesCompositeWorkingPixelsV1(project.colorManagement, preserveHighBitDepthAlpha);
  return [
    `color=c=black@0:s=${plan.width}x${plan.height}:r=${compositeFrameClock(plan.fps).rate}:d=${finite(plan.duration)},format=${pixels.rgba}[${baseLabel}]`,
    overlayPositionedFilter(baseLabel, inputLabel, outputLabel, clip, plan, project, trackMatteSource),
  ];
}

function trackMatteVideoFilters(input: CompositeInput, outputLabel: string, mode: TrackMatteMode, plan: RenderPlan, project: EditProject, preserveHighBitDepthAlpha = false, forceWorking16 = false): string[] {
  const clip = input.clip;
  const pixels = acesCompositeWorkingPixelsV1(project.colorManagement, preserveHighBitDepthAlpha);
  const composed = composedTransformExpressions(project, clip, `(t+${animationTimeValue(clip.timelineStart)})`, plan.fps);
  const spatial = clip.keyframes.length > 0 || Object.keys(clip.expressions ?? {}).length > 0 || clip.transform.scale !== 1 || clip.transform.rotation !== 0 || clip.layer?.parentClipId;
  const rawLabel = `${outputLabel}raw`;
  const canvasLabel = `${outputLabel}canvas`;
  const sourceFilters = [
    `[${input.inputIndex}:v]scale=${plan.width}:${plan.height}:force_original_aspect_ratio=decrease`,
    `format=${pixels.rgba}`,
    ...sourceAlphaNormalizationFilters(input.asset, pixels.grayMaximum),
    `pad=${plan.width}:${plan.height}:(ow-iw)/2:(oh-ih)/2:color=black@0`,
    "setsar=1",
    `fps=${compositeFrameClock(plan.fps).rate}`,
    `trim=duration=${finite(clip.duration)}`,
    ...clipMirrorFilters(composed),
    ...(spatial ? [
      `scale='iw*(${escapeExpression(composed.scale)})':'ih*(${escapeExpression(composed.scale)})':eval=frame`,
      rotateWithUnclippedBounds(escapeExpression(composed.rotation)),
    ] : []),
    `${compositeFrameClock(plan.fps, clip.timelineStart).timestampFilters}[${rawLabel}]`,
  ].join(",");
  const filters = [usesOpaqueAces16V1(project.colorManagement) || forceWorking16 ? aces16SurfaceFilterV1(sourceFilters) : sourceFilters,
    ...positionedLayerFilters(rawLabel, canvasLabel, clip, plan, project, preserveHighBitDepthAlpha, true, forceWorking16)];
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
  transitionRead?: TimelineTransitionReadViewV1,
): Promise<CompositeInput> {
  const probe = await probeMedia(assetPath, ffprobePath);
  const readClip = transitionRead?.readClip ?? clip;
  if (transitionRead) assertTimelineTransitionProbeV1(transitionRead, asset.kind === "image" ? "image" : "video", probe);
  if (transitionRead && asset.kind === "video") await assertTimelineTransitionVideoBoundsV2(transitionRead, assetPath, ffprobePath, probe);
  if (/\.(png|jpe?g|webp|bmp)$/i.test(assetPath)) args.push("-loop", "1");
  else args.push("-ss", finite(readClip.sourceStart));
  args.push("-t", finite(readClip.duration), "-i", assetPath);
  return { clip, alphaPlan, asset, assetPath, inputIndex: nextIndex, probe, ...(transitionRead ? { transitionRead } : {}) };
}

const FILTER_GRAPH_SCRIPT_THRESHOLD = 10_000;

/**
 * Compound animation expressions can exceed Windows' command-line limit, so long graphs go through
 * -filter_complex_script instead of being truncated. The script is created exclusively (0600) inside a fresh
 * mkdtemp directory (0700 on POSIX) in the export's work root (the OS temp directory outside an export) rather
 * than next to the export, and the directory is removed even when writing the script or rendering fails.
 */
export async function withFilterGraphArgs<T>(graph: string, run: (filterArgs: string[]) => Promise<T>): Promise<T> {
  if (graph.length <= FILTER_GRAPH_SCRIPT_THRESHOLD) return run(["-filter_complex", graph]);
  const directory = await createRenderWorkDirectory("editkin-filtergraph-");
  try {
    const scriptPath = join(directory, "filtergraph.txt");
    await writeFile(scriptPath, graph, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return await run(["-filter_complex_script", scriptPath]);
  } finally {
    await removeRenderWorkDirectory(directory);
  }
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
  assBundledFaces = false,
  motionAss: Pick<MotionAssOptions, "physicalLayouts" | "requirePhysicalGlyphs" | "aggregateBudget"> = {},
  outputOverride?: CompositeChunkOutputV1,
): Promise<void> {
  if (outputOverride) compositeChunkOutputPlanV1(project, plan.duration, encoder, preserveHighBitDepthAlpha, outputOverride);
  const pair16 = Boolean(plan.pairTransitions?.length) || plan.compositePrecision16 === true;
  await verifyProofStillCompositeSourcesV1(project, videoSegments(plan), sha256File);
  const grades = await prepareCompositeGrades(project, plan, acesCompositeWorkingPixelsV1(project.colorManagement, preserveHighBitDepthAlpha || pair16).grayMaximum === 65535, colorRoot);
  let fixedMasks: PreparedFixedWindowMaskPlanesV3 | undefined;
  let rawBackgroundWork: string | undefined;
  let orderedComposition: Awaited<ReturnType<typeof prepareUnifiedLayerAssFilesV1>>;
  let matteLuts: Awaited<ReturnType<typeof prepareTimelineTransitionMatteLutsV1>> | undefined;
  try {
    // Matte transitions: the kernel's LUT files for this project's working encoding, removed after the render.
    if (plan.pairTransitions?.some(pair => pair.transition.kernel === "matte")) matteLuts = await prepareTimelineTransitionMatteLutsV1(gradeWorkingSpace(project.colorManagement));
    orderedComposition = await prepareUnifiedLayerAssFilesV1(project, plan, outputOverride?.assProject ?? project,
      { ...motionAss, bundledFaces: assBundledFaces }, preserveHighBitDepthAlpha, outputOverride?.assProject ? outputOverride.startFrame ?? 0 : 0);
    fixedMasks = await prepareFixedWindowMaskPlanesV3(project, videoSegments(plan).map(segment => segment.clip), acesCompositeWorkingPixelsV1(project.colorManagement, preserveHighBitDepthAlpha || pair16).grayMaximum);
    if (!orderedComposition && outputOverride?.kind === "raw-video-v1" && (outputOverride.assProject ?? project).motionGraphics.some(graphic => graphic.compositeLayer === "background")) {
      rawBackgroundWork = await createRenderWorkDirectory("editkin-render-");
    }
    await renderCompositeGraph(ffmpegPath, ffprobePath, output, project, plan, assPath, encoder, timeoutMs, fontRoot, colorRoot, assetBase,
      autoRotoCacheRoot, preserveHighBitDepthAlpha, nativeAudioPath, assBundledFaces, motionAss, grades.stages, fixedMasks, outputOverride, rawBackgroundWork ? join(rawBackgroundWork, "background.ass") : undefined, orderedComposition?.operations, matteLuts?.luts);
  } finally {
    try {
    try {
      if (orderedComposition) await orderedComposition.dispose();
    } finally {
      if (rawBackgroundWork) await removeRenderWorkDirectory(rawBackgroundWork);
    }
    } finally {
    try {
      if (fixedMasks?.workDirectory) await removeRenderWorkDirectory(fixedMasks.workDirectory);
    } finally {
      try {
        if (grades.workDirectory) await removeRenderWorkDirectory(grades.workDirectory);
      } finally {
        if (matteLuts?.workDirectory) await removeRenderWorkDirectory(matteLuts.workDirectory);
      }
    }
    }
  }
}

async function renderCompositeGraph(
  ffmpegPath: string,
  ffprobePath: string,
  output: string,
  project: EditProject,
  plan: RenderPlan,
  assPath: string | undefined,
  encoder: VideoEncoder,
  timeoutMs: number,
  fontRoot: string | undefined,
  colorRoot: string | undefined,
  assetBase: string | undefined,
  autoRotoCacheRoot: string | undefined,
  preserveHighBitDepthAlpha: boolean,
  nativeAudioPath: string | undefined,
  assBundledFaces: boolean,
  motionAss: Pick<MotionAssOptions, "physicalLayouts" | "requirePhysicalGlyphs" | "aggregateBudget">,
  gradeStages: ReadonlyMap<string, CompositeGradeStage>,
  fixedMasks: PreparedFixedWindowMaskPlanesV3,
  outputOverride?: CompositeChunkOutputV1,
  rawBackgroundAssPath?: string,
  orderedComposition?: readonly PreparedUnifiedCompositeOperationV1[],
  matteLuts?: TimelineTransitionMatteLutsV1,
): Promise<void> {
  for (const segment of videoSegments(plan)) assertStaticSourceWhiteBalance(segment.clip, project.assets.find(asset => asset.id === segment.clip.assetId));
  const pair16 = Boolean(plan.pairTransitions?.length) || plan.compositePrecision16 === true;
  const readViews = plan.pairTransitions?.length ? timelineTransitionReadViewsV1(project, plan.pairTransitions!) : new Map<string, TimelineTransitionReadViewV1>();
  const pixels = acesCompositeWorkingPixelsV1(project.colorManagement, preserveHighBitDepthAlpha || pair16);
  const opaqueAces16 = usesOpaqueAces16V1(project.colorManagement);
  const floatingBackdrop = !preserveHighBitDepthAlpha && (videoSegments(plan).some(segment => Boolean(segment.clip.floatingFrame)) || outputOverride?.floatingBackdrop === true);
  const baseInput = floatingBackdrop
    ? floatingFrameBackdropLavfi(plan.width, plan.height, compositeFrameClock(plan.fps).rate, finite(plan.duration))
    : `color=c=${preserveHighBitDepthAlpha || orderedComposition ? "black@0" : "black"}:s=${plan.width}x${plan.height}:r=${compositeFrameClock(plan.fps).rate}${preserveHighBitDepthAlpha || orderedComposition ? `,format=${pixels.rgba}` : ""}`;
  const args = [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-t", finite(plan.duration), "-i", baseInput,
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
    const input = await addCompositeInput(args, segment.clip, alphaPlan, asset, segment.assetPath, ffprobePath, nextIndex, readViews.get(segment.clip.id));
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
    const fixedInputs = appendFixedWindowMaskInputsV3(args, fixedMasks.planesByClip.get(input.clip.id), nextIndex, compositeFrameClock(plan.fps).rate);
    nextIndex = fixedInputs.nextIndex; input.fixedVectorInputIndexes = fixedInputs.inputIndexes;
    inputs.push(input);
    inputsByClip.set(input.clip.id, input);
    if (input.probe.hasAudio && !input.transitionRead) audioInputsByClip.set(input.clip.id, input);
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
    nextIndex += 1;
    const fixedInputs = appendFixedWindowMaskInputsV3(args, fixedMasks.planesByClip.get(matteInput.clip.id), nextIndex, compositeFrameClock(plan.fps).rate);
    nextIndex = fixedInputs.nextIndex; matteInput.fixedVectorInputIndexes = fixedInputs.inputIndexes;
    trackMatteInputsByTarget.set(target.id, matteInput);
  }
  // Motion Library Phase 3: a matte pair reads its matte file and, when the item draws one, its overlay as a styled synthetic clip.
  const matteInputs = new Map<string, TimelineTransitionMatteInputV1>();
  for (const source of timelineTransitionMatteSourcesV1(project, plan.pairTransitions ?? [])) {
    const mattePath = resolveMediaPath(source.matteAsset.uri, assetBase);
    if (!(await probeMedia(mattePath, ffprobePath)).hasVideo) throw Error("TIMELINE_TRANSITION_MATTE_SOURCE_MISSING");
    args.push("-i", mattePath);
    if (!matteLuts) throw Error("TIMELINE_TRANSITION_MATTE_LUT_MISSING");
    matteInputs.set(source.transitionId, { matteInputIndex: nextIndex++, ...(source.overlayClip ? { overlayClip: source.overlayClip } : {}), luts: matteLuts });
    if (source.overlayClip && source.overlayAsset) inputsByClip.set(source.overlayClip.id, await addCompositeInput(args, source.overlayClip,
      compileClipAlphaPlan(project, source.overlayClip, "formal"), source.overlayAsset, resolveMediaPath(source.overlayAsset.uri, assetBase), ffprobePath, nextIndex++));
  }
  if (!nativeAudioPath) {
    for (const item of outputOverride?.kind === "raw-video-v1" ? [] : plan.audioClips) {
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

  // Background vectors are authored project data. Draw them before video,
  // rather than applying a full-canvas panel over the final media composite.
  const assProject = outputOverride?.assProject ?? project;
  const backgroundGraphics = orderedComposition ? [] : assProject.motionGraphics.filter(graphic => graphic.compositeLayer === "background");
  const backgroundAssPath = backgroundGraphics.length ? rawBackgroundAssPath ?? `${output}.${randomUUID()}.background.ass` : undefined;
  const backgroundFilter = backgroundAssPath ? `,${compositeChunkAssClockV1(buildAssFilter(backgroundAssPath, fontRoot), outputOverride, plan.fps)}` : "";
  const filters: string[] = [`[0:v]fps=${compositeFrameClock(plan.fps).rate},format=${pixels.rgba}${backgroundFilter}${(opaqueAces16 || pair16) && !preserveHighBitDepthAlpha ? ",format=gbrp16le,format=gbrap16le" : ""}[composite0]`];
  let compositeIndex = 0;
  if (plan.pairTransitions?.length) {
    const paired = timelineTransitionCompositeGraphV1(project, plan, videoSegments(plan).map(s => s.clip), (clip, label) => {
      const input = inputsByClip.get(clip.id);
      if (!input?.probe.hasVideo) throw Error("TIMELINE_TRANSITION_VIDEO_STREAM_MISSING");
      const raw = label + "raw", canvas = clip.layer?.trackMatte ? label + "canvas" : label;
      const prepared = compositorVideoFilters(input, raw, plan, project, colorRoot, preserveHighBitDepthAlpha, gradeStages.get(clip.id));
      prepared.push(...aces16PositionedLayerGraphV1(raw, canvas, clip, plan, project, false, input.transitionRead?.readClip.timelineStart));
      if (clip.layer?.trackMatte) {
        const provider = trackMatteInputsByTarget.get(clip.id);
        if (!provider) throw Error("TIMELINE_TRANSITION_TRACK_MATTE_MISSING");
        const matte = label + "matte", color = label + "color", alpha = label + "alpha", combined = label + "combined";
        prepared.push(...trackMatteVideoFilters(provider, matte, clip.layer.trackMatte.mode, plan, project, true, true));
        prepared.push(`[${canvas}]split[${color}][${alpha}rgba]`, `[${alpha}rgba]alphaextract[${alpha}]`);
        prepared.push(aces16AlphaMultiplyV1(alpha, matte, combined), aces16AlphaPlaneJoinV1(color, combined, label));
      }
      return prepared;
    }, (clip, input, output) => [adjustmentVideoFilters(clip, input, output, true)], matteInputs);
    filters.push(...paired.filters); compositeIndex = paired.compositeCount;
  } else for (const operation of orderedComposition ?? videoSegments(plan).map(segment => ({ kind: "clip" as const, segment }))) {
    if (operation.kind === "ass") {
      const filter = compositeChunkAssClockV1(buildAssFilter(operation.assPath, fontRoot), outputOverride, plan.fps);
      filters.push(`[composite${compositeIndex}]${filter}[composite${compositeIndex + 1}]`);
      compositeIndex += 1;
      continue;
    }
    const segment = operation.segment;
    if (segment.clip.layer?.role === "controller") continue;
    const input = inputsByClip.get(segment.clip.id);
    const clipLabel = `vclip${compositeIndex}`;
    const outputLabel = `composite${compositeIndex + 1}`;
    if (segment.clip.layer?.role === "adjustment") {
      filters.push(adjustmentVideoFilters(segment.clip, `composite${compositeIndex}`, outputLabel, opaqueAces16));
      compositeIndex += 1;
      continue;
    }
    if (!input?.probe.hasVideo) continue;
    filters.push(...compositorVideoFilters(input, clipLabel, plan, project, colorRoot, preserveHighBitDepthAlpha, gradeStages.get(input.clip.id)));
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
      filters.push(opaqueAces16 ? aces16AlphaMultiplyV1(`${clipLabel}targetalpha`, matteLabel, `${clipLabel}combinedalpha`)
        : `[${clipLabel}targetalpha][${matteLabel}]blend=all_mode=multiply[${clipLabel}combinedalpha]`);
      filters.push(`[${clipLabel}color]format=${opaqueAces16 ? pixels.rgba : pixels.rgb}[${clipLabel}rgb]`);
      positionedLabel = `${clipLabel}masked`;
      filters.push(opaqueAces16 ? aces16AlphaPlaneJoinV1(`${clipLabel}rgb`, `${clipLabel}combinedalpha`, positionedLabel)
        : `[${clipLabel}rgb][${clipLabel}combinedalpha]alphamerge[${positionedLabel}]`);
      alreadyPositioned = true;
    }
    const blendMode = input.clip.layer?.blendMode ?? "normal";
    if (blendMode === "normal") {
      if (alreadyPositioned && opaqueAces16) filters.push(...(preserveHighBitDepthAlpha ? aces16AlphaOverGraphV1(`composite${compositeIndex}`, positionedLabel, outputLabel) : aces16OverOpaqueGraphV1(`composite${compositeIndex}`, positionedLabel, outputLabel)));
      else if (alreadyPositioned) filters.push(`[composite${compositeIndex}][${positionedLabel}]overlay=x=0:y=0:eof_action=pass:repeatlast=0:format=auto[${outputLabel}]`);
      else filters.push(overlayPositionedFilter(`composite${compositeIndex}`, clipLabel, outputLabel, input.clip, plan, project, false, preserveHighBitDepthAlpha));
    } else if (opaqueAces16 && preserveHighBitDepthAlpha) {
      if (!alreadyPositioned) {
        positionedLabel = `${clipLabel}straightCanvas`;
        filters.push(...positionedLayerFilters(clipLabel, positionedLabel, input.clip, plan, project, true));
      }
      filters.push(...aces16AlphaOverGraphV1(`composite${compositeIndex}`, positionedLabel, outputLabel, ffmpegBlendMode(blendMode)));
    } else {
      const neutralLabel = `neutral${compositeIndex}`;
      const blendPositionedLabel = `positioned${compositeIndex}`;
      const neutral = ffmpegBlendNeutral(blendMode);
      const ffmpegMode = ffmpegBlendMode(blendMode);
      filters.push(`color=c=${neutral}:s=${plan.width}x${plan.height}:r=${compositeFrameClock(plan.fps).rate}:d=${finite(plan.duration)},format=${pixels.rgba}[${neutralLabel}]`);
      if (alreadyPositioned && opaqueAces16) filters.push(...aces16OverOpaqueGraphV1(neutralLabel, positionedLabel, blendPositionedLabel));
      else if (alreadyPositioned) filters.push(`[${neutralLabel}][${positionedLabel}]overlay=x=0:y=0:eof_action=pass:repeatlast=0:format=auto[${blendPositionedLabel}]`);
      else filters.push(overlayPositionedFilter(neutralLabel, clipLabel, blendPositionedLabel, input.clip, plan, project));
      if (opaqueAces16) filters.push(aces16BlendFilterV1(`composite${compositeIndex}`, blendPositionedLabel, outputLabel, ffmpegMode));
      else filters.push(`[composite${compositeIndex}][${blendPositionedLabel}]blend=all_mode=${ffmpegMode}:shortest=0:repeatlast=0[${outputLabel}]`);
    }
    compositeIndex += 1;
  }
  let compositeLabel = `composite${compositeIndex}`;
  if (orderedComposition) {
    // The working canvas is transparent: an adjustment below all picture layers must not grade the delivery background.
    filters.push(`color=c=black:s=${plan.width}x${plan.height}:r=${compositeFrameClock(plan.fps).rate}:d=${finite(plan.duration)},format=${pixels.rgba}[unifiedDeliveryBackground]`);
    filters.push(`[unifiedDeliveryBackground][${compositeLabel}]overlay=x=0:y=0:eof_action=pass:repeatlast=0:format=auto[unifiedDeliveryComposite]`);
    compositeLabel = "unifiedDeliveryComposite";
  }
  const outputTransform = preserveHighBitDepthAlpha ? "" : acesOutputFilter(project.colorManagement ?? DEFAULT_COLOR_MANAGEMENT, colorRoot);
  const displayLabel = outputTransform ? "displayout" : compositeLabel;
  if (outputTransform) filters.push(`[${compositeLabel}]format=gbrpf32le,${outputTransform}[${displayLabel}]`);
  const hdr = !preserveHighBitDepthAlpha && isHdrOutput(project);
  const chunkOutput = outputOverride ? compositeChunkOutputPlanV1(project, plan.duration, encoder, preserveHighBitDepthAlpha, outputOverride) : undefined;
  const pixelFormat = preserveHighBitDepthAlpha ? encoder === "ffv1" ? "gbrap16le" : pixels.encodedPixelFormat : hdr ? "yuv420p10le" : "yuv420p";
  filters.push(assPath && !orderedComposition
    ? `[${displayLabel}]${compositeChunkAssClockV1(buildAssFilter(assPath, fontRoot), outputOverride, plan.fps)},format=${pixelFormat}${chunkOutput ? `,${chunkOutput.frameTagFilter}` : ""}[vout]`
    : `[${displayLabel}]format=${pixelFormat}${chunkOutput ? `,${chunkOutput.frameTagFilter}` : ""}[vout]`);

  if (outputOverride?.kind !== "raw-video-v1") {
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
      const fadeFilter = item.clip.audioEnvelope ? clipAudioEnvelopeFilter(item.clip, music) : music && fade > 0
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
  }
  const graph = filters.join(";");
  await withFilterGraphArgs(graph, async (filterArgs) => {
    if (outputOverride?.kind === "raw-video-v1") {
      args.push(...filterArgs, "-map", "[vout]", "-c:v", "rawvideo", "-pix_fmt", pixelFormat, ...chunkOutput!.metadataArgs,
        "-t", finite(plan.duration), "-f", "rawvideo", "pipe:1");
    } else {
    args.push(
      ...filterArgs, "-map", "[vout]", "-map", "[aout]",
      ...encoderArgs(encoder), "-pix_fmt", pixelFormat,
      ...(chunkOutput ? chunkOutput.metadataArgs : encoder === "ffv1" ? aces16PrecompositionMetadataArgsV1() : outputColorMetadataArgs(encoder, !preserveHighBitDepthAlpha && project.colorManagement?.mode === "aces2" ? project.colorManagement.outputTransform : "rec709_sdr")),
      "-c:a", preserveHighBitDepthAlpha ? "pcm_s24le" : "aac", ...(preserveHighBitDepthAlpha ? [] : ["-b:a", "192k"]), "-ar", "48000", "-ac", "2",
      "-t", finite(plan.duration), ...(encoder === "ffv1" ? [] : ["-video_track_timescale", "90000", "-movflags", "+faststart"]),
      // Stall evidence: -progress counts written packets, which the encoder's lookahead holds back for tens of frames, so a
      // slow filter graph looked stalled. One stdout line per frame entering the encoder (the output bytes do not change).
      "-stats_enc_pre:v", "pipe:1", "-stats_enc_pre_fmt:v", "encoder_input_frame={n}", ...FFMPEG_PROGRESS_ARGS, output,
    );
    }
    try {
      if (backgroundAssPath) await writeFile(backgroundAssPath, writeAssContent(assProject, assProject.captionStyle, { ...motionAss, bundledFaces: assBundledFaces, compositeLayer: "background" }), { encoding: "utf8", flag: "wx" });
      // No fixed encode cap: the export deadline scales with duration and a stalled encoder is stopped by the watchdog.
      if (outputOverride?.kind === "raw-video-v1") {
        await runRawVideoProcessV1({ executable: ffmpegPath, args, timeoutMs, frameBytes: chunkOutput!.frameBytes,
          expectedFrames: chunkOutput!.frameCount, sink: outputOverride.sink });
      } else await runProcess(ffmpegPath, args, timeoutMs, undefined, { ffmpegProgress: true, paths: [output] });
    } finally {
      if (backgroundAssPath) await rm(backgroundAssPath, { force: true });
    }
  });
}
