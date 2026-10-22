import type { EditProject } from "../domain/types";
import type { VideoEncoder } from "./ffmpegTypes";
import { LongRenderRefusalV1 } from "./longRenderContractsV1";
import { durationFrameCountV1, frameRateRationalV1 } from "./longRenderClockV1";
import { outputColorMetadataArgs } from "./outputColorMetadata";
import type { RawVideoSinkV1 } from "./rawVideoProcessV1";

/** Internal additive B2 seam. Absence always keeps the legacy graph, codec and metadata arguments. */
export interface CompositeChunkGraphContextV1 { workingPrecision16?: boolean; floatingBackdrop?: boolean }
export type CompositeChunkOutputV1 = ({ kind: "display-ffv1-v1" } | { kind: "raw-video-v1"; sink: RawVideoSinkV1 })
  & CompositeChunkGraphContextV1 & { assProject?: EditProject; startFrame?: number };

/** ASS keeps its original global centisecond quantization; only the surrounding frame PTS is translated. */
export function compositeChunkAssClockV1(filter: string, output: CompositeChunkOutputV1 | undefined, fps: number): string {
  if (!output?.assProject || !output.startFrame) return filter;
  if (!Number.isSafeInteger(output.startFrame) || output.startFrame < 0) throw Error("CHUNK_ASS_CLOCK_INVALID");
  const rate = frameRateRationalV1(fps), shift = `${output.startFrame}*${rate.denominator}/${rate.numerator}/TB`;
  return `setpts=PTS+${shift},${filter},setpts=PTS-${shift}`;
}

export function compositeChunkOutputPlanV1(project: EditProject, duration: number, encoder: VideoEncoder, preserveAlpha: boolean,
  output: CompositeChunkOutputV1) {
  const transform = project.colorManagement?.mode === "aces2" ? project.colorManagement.outputTransform : "rec709_sdr";
  if (encoder !== "ffv1" || preserveAlpha || transform === "p3d65_sdr"
    || !["display-ffv1-v1", "raw-video-v1"].includes(output.kind)) {
    throw new LongRenderRefusalV1("LONG_RENDER_ROUTE_NOT_AVAILABLE", "a display chunk output requires the non-alpha FFV1 graph and measured Rec.709/HLG/PQ metadata policy");
  }
  const hdr = transform === "rec2100_hlg_1000" || transform === "rec2100_pq_1000";
  const pixelFormat = hdr ? "yuv420p10le" as const : "yuv420p" as const;
  const frameBytes = project.width * project.height * (hdr ? 3 : 1.5);
  const frameRate = frameRateRationalV1(project.fps), frameCount = durationFrameCountV1(duration, frameRate);
  if (![project.width, project.height].every(n => Number.isSafeInteger(n) && n > 0 && n % 2 === 0)
    || !Number.isSafeInteger(frameBytes) || frameBytes > 256 * 1024 ** 2 || frameCount < 1
    || (output.kind === "raw-video-v1" && Math.abs(duration * frameRate.numerator / frameRate.denominator - frameCount) > 1e-6)) {
    throw new LongRenderRefusalV1("LONG_RENDER_OUTPUT_QA", "raw chunks require even dimensions, a bounded frame and frame-aligned duration");
  }
  // prores_ks selects only container/codec-independent display flags; no H.264/HEVC bitstream filter is valid for raw/FFV1.
  const metadataArgs = [...outputColorMetadataArgs("prores_ks", transform), "-color_range", "tv"];
  const tag = (name: string) => metadataArgs[metadataArgs.indexOf(name) + 1];
  // FFV1 inherits frame properties; output flags alone do not retain primaries/transfer in Matroska.
  const frameTagFilter = `setparams=range=tv:color_primaries=${tag("-color_primaries")}:color_trc=${tag("-color_trc")}:colorspace=${tag("-colorspace")}`;
  return { pixelFormat, frameBytes, frameRate, frameCount, metadataArgs, frameTagFilter };
}
