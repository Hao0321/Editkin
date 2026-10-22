import { isAbsolute } from "node:path";
import { DEFAULT_COLOR_MANAGEMENT, type EditProject, type MediaAsset, type TimelineClip } from "../domain/types";
import { findAsset, findClip } from "../domain/editGraph";
import { primaryExposureFilter, primaryToneFilters, resolveInputColorSpace } from "../color/primaryGrade";
import { hasLinearWhiteBalance } from "../color/linearWhiteBalance";
import type { ShotGradeFrameV1 } from "../color/shotGradeStatisticsV1";
import { compositorSourceColorPlan } from "../render/sourceColorFilters";
import { compositePixelContract } from "../render/highBitDepthAlphaDelivery";
import { colorExpression, escapeExpression, hasPrimaryToneAdjustment } from "../render/ffmpegExpressions";
import { lookColorTerms } from "../render/creativeFilters";
import { assertStaticSourceWhiteBalance } from "../render/linearWhiteBalanceSupport";
import { whiteBalanceAssetWithMetadata } from "../render/sourceLinearWhiteBalance";
import { mediaDisplayRotation, mediaProbeForDisplay, mediaSampleAspectRatio,
  assertMediaAssetDisplayGeometry, type DisplayRotationStream } from "../render/mediaDisplayGeometry";
import type { MediaProbe } from "../render/ffmpegContracts";
import { readBoundMaterialColorFrameV1 } from "./autoColorFrame";
import { colorBytesSha, colorDigest, colorFileSha, colorToolPaths } from "./materialColorSamplingRuntime";
import { verifyMaterialColorReceipt } from "./materialColorSamplingValidation";
import { sourceDisplayColorMetadata } from "./sourceDisplayMetadata";
import type { MaterialIntelligencePacket } from "./materialIntelligence";
import type { MaterialColorRuntime, MaterialColorReceipt } from "./materialColorSamplingTypes";

function reject(reason: string): never { throw Error("SHOT_GRADE_FRAME_INVALID: " + reason); }
const dimension = (v: unknown, max: number): v is number => Number.isSafeInteger(v) && (v as number) > 0 && (v as number) <= max;
function rectangle(value: {x:number;y:number;width:number;height:number}) {
  return value && [value.x,value.y,value.width,value.height].every(v => Number.isFinite(v) && v >= 0 && v <= 1)
    && value.width > 0 && value.height > 0 && value.x + value.width <= 1 && value.y + value.height <= 1;
}

/** Source-clock, local clip stage. Post-v2 effects, layout transforms, opacity,
 * other layers and final output are deliberately outside the measured stage.
 * Keep the source, primary and legacy-look order of compositorVideoFilters;
 * independent actual-FFmpeg tests compare its public graph with this prefix.
 */
export function shotGradeFramePlanV1(project: EditProject, clip: TimelineClip, asset: MediaAsset,
  probe: MediaProbe, maximumDimension = 256, highBitDepth = false) {
  if (!dimension(project.width,8192) || !dimension(project.height,8192) || !dimension(maximumDimension,256)
    || typeof highBitDepth !== "boolean") reject("Invalid canvas/sampling bounds");
  const management = project.colorManagement ?? DEFAULT_COLOR_MANAGEMENT;
  if (management.mode !== "rec709" || management.outputTransform !== "rec709_sdr") reject("ACES working/output stage needs its actual transform adapter");
  if (clip.speed !== undefined || clip.timeRemap !== undefined) reject("Authored speed/time remap needs its shared source-clock adapter");
  if (project.timelineTransitions?.some(t => t.fromClipId === clip.id || t.toClipId === clip.id)) reject("Pair transition needs its transition-read source-clock adapter");
  if (asset.kind !== "video" || !probe.hasVideo || asset.imageSequence || asset.compositionId || asset.clipRetime
    || clip.floatingFrame || (clip.layer?.role ?? "content") !== "content") reject("Source context needs its frame-clock/stage adapter");
  if (clip.assetId !== asset.id || clip.keyframes.length || Object.keys(clip.expressions ?? {}).length
    || clip.creative?.transitionIn || clip.creative?.transitionOut) reject("Animated colour/transition stage is not measured by the static source adapter");
  if (clip.masks?.some(m => m.enabled) || clip.chromaKey?.enabled || clip.layer?.trackMatte) reject("Pre-grade alpha operations need the shared matte graph");
  const geometry = mediaProbeForDisplay(probe);
  if (!dimension(geometry.width,32768) || !dimension(geometry.height,32768)) reject("Missing upright source raster");
  if (asset.width !== undefined || asset.height !== undefined || asset.displayAspectRatio !== undefined) {
    assertMediaAssetDisplayGeometry(asset,probe);
  }
  assertStaticSourceWhiteBalance(clip,asset);
  const pixels = compositePixelContract(highBitDepth);
  const sourceAsset = hasLinearWhiteBalance(clip.color) ? whiteBalanceAssetWithMetadata(asset,{
    primaries:probe.colorPrimaries,transfer:probe.colorTransfer,matrix:probe.colorMatrix,range:probe.colorRange,
  }) : asset;
  const source = compositorSourceColorPlan(sourceAsset,project.width,project.height,pixels.rgba,pixels.grayMaximum,
    management,undefined,clip.color.exposure,clip.color);
  const layout = clip.layout;
  if (layout && (!rectangle(layout.crop) || !rectangle(layout.viewport))) reject("Invalid crop/viewport raster basis");
  const layerWidth = layout ? Math.max(2,Math.round(project.width * layout.viewport.width)) : project.width;
  const layerHeight = layout ? Math.max(2,Math.round(project.height * layout.viewport.height)) : project.height;
  const layoutFilters = layout ? [
    "format=gbrap16le", "premultiply=inplace=1",
    `crop=${Math.max(2,Math.round(project.width*layout.crop.width))}:${Math.max(2,Math.round(project.height*layout.crop.height))}:${Math.max(0,Math.round(project.width*layout.crop.x))}:${Math.max(0,Math.round(project.height*layout.crop.y))}`,
    `scale=${layerWidth}:${layerHeight}:flags=lanczos`, "unpremultiply=inplace=1",
  ] : [];
  const look = lookColorTerms(clip);
  const brightness = escapeExpression(`(${colorExpression(clip,"brightness")})+(${look.brightness})+(0)`);
  const contrast = escapeExpression(`(${colorExpression(clip,"contrast")})*(${look.contrast})`);
  const saturation = escapeExpression(`(${colorExpression(clip,"saturation")})*(${look.saturation})`);
  const hue = escapeExpression(`(${colorExpression(clip,"hue")})+(${look.hue})`);
  const eq = clip.color.brightness !== 0 || clip.color.contrast !== 1 || clip.color.saturation !== 1
    || look.brightness !== "0" || look.contrast !== "1" || look.saturation !== "1";
  const factor = Math.min(1,maximumDimension/Math.max(layerWidth,layerHeight));
  const width = Math.max(1,Math.floor(layerWidth*factor)), height = Math.max(1,Math.floor(layerHeight*factor));
  const resampled = width !== layerWidth || height !== layerHeight;
  const filters = [...source.filters,
    `pad=${project.width}:${project.height}:(ow-iw)/2:(oh-ih)/2:color=black@0`, "setsar=1", `format=${pixels.rgba}`,
    ...layoutFilters,
    ...(hasPrimaryToneAdjustment(clip.color) ? primaryToneFilters(clip.color) : []),
    ...(!source.exposureConsumed && clip.color.exposure !== 0 ? [primaryExposureFilter(clip.color.exposure)] : []),
    ...(eq ? [`eq=brightness='${brightness}':contrast='${contrast}':saturation='${saturation}':eval=frame`] : []),
    ...(clip.color.hue !== 0 || look.hue !== "0" ? [`hue=h='${hue}'`] : []),
    // This is also the gradeV2 LUT's actual integer input contract. Resolve it
    // before optional sampling; never silently negotiate FLOAT as source proof.
    `format=${pixels.rgba}`,
    ...(resampled ? [`scale=${width}:${height}:flags=area`, `format=${pixels.rgba}`] : []),
  ];
  return { filters, pixelFormat:pixels.rgba, format:highBitDepth ? "rgb16" as const : "rgb8" as const,
    stage:"clip_working_pre_v2" as const, workingSpace:"rec709_display" as const, width,height,
    exposureConsumed:source.exposureConsumed,
    geometry:{encodedWidth:geometry.encodedWidth!,encodedHeight:geometry.encodedHeight!,uprightWidth:geometry.width,uprightHeight:geometry.height,
      sampleAspectRatio:probe.sampleAspectRatio??null,displayRotationDegrees:probe.displayRotationDegrees??null,
      physicalDisplayAspectRatio:geometry.displayAspectRatio??null,projectWidth:project.width,projectHeight:project.height,
      crop:layout ? {...layout.crop} : null,viewport:layout ? {...layout.viewport} : null,layerWidth,layerHeight,
      roiBasis:"pre-grade-layer-raster-normalized" as const},
    sampling:{maximumDimension,resampled,order:"after-primary-and-legacy-look-before-v2" as const,
      pointwisePredictionIsFinalOutputProof:false as const},
    precision:{explicitRgba8Barrier:filters.includes("format=rgba"),readbackBits:highBitDepth ? 16 : 8,
      negotiatedIntermediatePrecisionMeasured:false as const,originalSourcePrecisionVerified:false as const},
    downstream:{postV2EffectsMeasured:false as const,otherLayersMeasured:false as const,finalOutputMeasured:false as const},
  };
}

function measuredProbe(measured: MaterialColorReceipt, duration: number): {probe:MediaProbe;stream:Record<string,unknown>} {
  const raw = measured.probe?.metadata.stream;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) reject("Measured video stream unavailable");
  const stream = raw as Record<string,unknown>;
  if (stream.codec_type !== "video" || !dimension(stream.width,32768) || !dimension(stream.height,32768)) reject("Invalid measured stream raster");
  const text = (key:string) => typeof stream[key] === "string" ? stream[key] as string : undefined;
  return {stream,probe:{hasVideo:true,hasAudio:false,duration,
    width:stream.width as number,height:stream.height as number,encodedWidth:stream.width as number,encodedHeight:stream.height as number,
    sampleAspectRatio:mediaSampleAspectRatio(stream.sample_aspect_ratio),displayRotationDegrees:mediaDisplayRotation(stream as DisplayRotationStream),
    colorPrimaries:text("color_primaries"),colorTransfer:text("color_transfer"),colorMatrix:text("color_space"),
    colorRange:text("color_range"),pixelFormat:text("pix_fmt"),
  }};
}

/** FFmpeg planar G,B,R,A and packed RGBA are different layouts. Always retain
 * the alpha cohort; consumers must not treat invisible padding as source RGB.
 */
export function unpackShotGradeWorkingPixelsV1(bytes: Uint8Array, width:number, height:number, highBitDepth:boolean) {
  if (!(bytes instanceof Uint8Array) || !dimension(width,256) || !dimension(height,256) || typeof highBitDepth !== "boolean"
    || bytes.byteLength !== width*height*(highBitDepth ? 8 : 4)
    || (typeof SharedArrayBuffer !== "undefined" && bytes.buffer instanceof SharedArrayBuffer)
    || (bytes.buffer as ArrayBuffer & {resizable?:boolean}).resizable) reject("Invalid raw RGBA surface");
  const count = width*height, rgb = highBitDepth ? new Uint16Array(count*3) : new Uint8Array(count*3);
  const alpha = highBitDepth ? new Uint16Array(count) : new Uint8Array(count), maximum = highBitDepth ? 65535 : 255;
  const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  let allPixelsOpaque = true, zeroPixels = 0, partialPixels = 0;
  for (let i=0;i<count;i++) {
    if (highBitDepth) {
      rgb[i*3] = view.getUint16((count*2+i)*2,true);
      rgb[i*3+1] = view.getUint16(i*2,true); rgb[i*3+2] = view.getUint16((count+i)*2,true);
      alpha[i] = view.getUint16((count*3+i)*2,true);
    } else {
      for (let c=0;c<3;c++) rgb[i*3+c] = bytes[i*4+c]; alpha[i] = bytes[i*4+3];
    }
    if (alpha[i] !== maximum) allPixelsOpaque = false;
    if (alpha[i] === 0) zeroPixels++; else if (alpha[i] < maximum) partialPixels++;
  }
  return {rgb,alpha,allPixelsOpaque,alphaCohort:{totalPixels:count,maximum,zeroPixels,partialPixels,opaquePixels:count-zeroPixels-partialPixels}};
}

/** Actual pixels and source-clock evidence, not an authenticated grade decision.
 * A later evidence owner must verify current sealed material/semantics, loaded
 * new-code identity and the complete project before emitting any command.
 */
/** Explicit local source binding; no semantic or material-intelligence envelope. */
export interface ShotGradeWorkingSourceV1 {
  clipId: string; assetId: string; sourceSha256: string; sourceStart: number; duration: number;
  color?: MediaAsset["color"];
}

export async function readShotGradeWorkingSurfaceV1(inputMeasured:MaterialColorReceipt|undefined,inputSource:ShotGradeWorkingSourceV1,inputProject:EditProject,
  sampleIndex:number,sourcePath:string,runtime:MaterialColorRuntime,remainingMs:number,highBitDepth=false) {
  const started = performance.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0 || remainingMs > 120000 || !isAbsolute(sourcePath)) reject("Invalid source/budget");
  const budget = () => { runtime.signal?.throwIfAborted(); const ms = remainingMs-(performance.now()-started);
    if (ms <= 0) reject("Sampling time budget exceeded"); return ms; };
  budget();
  const source = structuredClone(inputSource), project = structuredClone(inputProject), measured = structuredClone(inputMeasured);
  verifyMaterialColorReceipt(measured);
  if (measured?.status !== "measured" || !measured.probe || !Number.isSafeInteger(sampleIndex)
    || sampleIndex < 0 || sampleIndex >= measured.mapping.length) reject("Invalid measured sample");
  const clip = findClip(project,source.clipId), asset = findAsset(project,source.assetId);
  if (clip.assetId !== asset.id || source.sourceSha256 !== measured.source.sha256
    || clip.sourceStart !== source.sourceStart || clip.duration !== source.duration
    || measured.source.start !== clip.sourceStart || measured.source.duration !== clip.duration) reject("Material/source window mismatch");
  const {probe,stream} = measuredProbe(measured,source.duration);
  const verifiedColor = sourceDisplayColorMetadata(stream,asset.color??source.color);
  if (verifiedColor.interpretation !== measured.normalization?.interpretation) reject("Source interpretation drift");
  const sourceAsset = {...asset,uri:sourcePath};
  const renderedSourceAsset = hasLinearWhiteBalance(clip.color) ? whiteBalanceAssetWithMetadata(sourceAsset,{
    primaries:probe.colorPrimaries,transfer:probe.colorTransfer,matrix:probe.colorMatrix,range:probe.colorRange,
  }) : sourceAsset;
  // Match the current formal renderer. Probe validation cannot silently repair
  // a project whose stored input transform is missing or contradicts its source.
  if (resolveInputColorSpace(renderedSourceAsset) !== verifiedColor.interpretation) reject("Rendered source interpretation mismatch");
  const plan = shotGradeFramePlanV1(project,clip,sourceAsset,probe,256,highBitDepth);
  const sourceBefore = await colorFileSha(sourcePath); budget();
  if (sourceBefore !== source.sourceSha256) reject("Source SHA mismatch");
  const executable = colorToolPaths(runtime).ffmpeg, toolBefore = await colorFileSha(executable); budget();
  const decoded = await readBoundMaterialColorFrameV1(measured,sampleIndex,plan.filters,plan.pixelFormat,sourcePath,runtime,budget());
  budget();
  if (decoded.width !== plan.width || decoded.height !== plan.height) reject("Decoded stage raster mismatch");
  const unpacked = unpackShotGradeWorkingPixelsV1(decoded.bytes,decoded.width,decoded.height,highBitDepth);
  const sourceAfter = await colorFileSha(sourcePath); budget();
  const toolAfter = await colorFileSha(executable); budget();
  if (sourceBefore !== sourceAfter || toolBefore !== toolAfter) reject("Source/tool drift during sampling");
  const frame:ShotGradeFrameV1 = {sampleId:decoded.sampleId,timeSeconds:decoded.timeSeconds,width:decoded.width,height:decoded.height,
    workingSpace:plan.workingSpace,stage:plan.stage,format:plan.format,pixels:unpacked.rgb};
  return {frame,alpha:unpacked.alpha,allPixelsOpaque:unpacked.allPixelsOpaque,alphaCohort:unpacked.alphaCohort,
    surface:{schema:"editkin.shot-grade-working-frame/v1" as const,
      scope:"actual-source-clock-local-clip-before-v2" as const,plan,
      source:{sha256:sourceBefore,beforeSha256:sourceBefore,afterSha256:sourceAfter,start:clip.sourceStart,duration:clip.duration},
      sourceClock:{sampleId:decoded.sampleId,pts:decoded.pts,timeBase:decoded.timeBase,timelineOrigin:measured.probe.timelineOrigin,
        decodedSourceTime:decoded.decodedTime,decodedRelativeTime:decoded.timeSeconds},
      hashes:{rawRgbaSha256:colorBytesSha(decoded.bytes),packedRgbSha256:colorBytesSha(new Uint8Array(unpacked.rgb.buffer)),
        packedAlphaSha256:colorBytesSha(new Uint8Array(unpacked.alpha.buffer))},
      tool:{role:"ffmpeg" as const,sha256:toolBefore},projectSnapshotSha256:colorDigest(project),
      measurementSha256:measured.receiptSha256,
      allPixelsOpaque:unpacked.allPixelsOpaque,alphaCohort:unpacked.alphaCohort,
      fullRgbRasterIncludesInvisiblePixels:unpacked.alphaCohort.zeroPixels > 0,
      statisticsCohortStatus:unpacked.allPixelsOpaque ? "opaque-all-pixels" as const : "requires-alpha-cohort-adapter" as const,
      implementationIdentityBound:false as const,decisionEvidenceBound:false as const,elapsedMs:performance.now()-started},
  };
}

/** Preserve the existing MCP material envelope and its independent semantic gates. */
export async function readShotGradeWorkingFrameV1(inputPacket:MaterialIntelligencePacket,inputProject:EditProject,
  sampleIndex:number,sourcePath:string,runtime:MaterialColorRuntime,remainingMs:number,highBitDepth=false) {
  const packet = structuredClone(inputPacket), source = packet.source;
  const value = await readShotGradeWorkingSurfaceV1(packet.analysis.color, {
    clipId:source.clipId,assetId:source.assetId,sourceSha256:source.sourceSha256,
    sourceStart:source.sourceStart,duration:source.duration,color:source.color,
  },inputProject,sampleIndex,sourcePath,runtime,remainingMs,highBitDepth);
  return {...value,surface:{...value.surface,materialId:packet.materialId}};
}
