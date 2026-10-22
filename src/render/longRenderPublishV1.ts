// LONG-render publication (design C2; LV-05): the encoded output is written as a unique `.part` inside an owned
// staging directory beside the requested file, verified against the up-front identity plan, then committed with one
// rename (replace semantics: the previous output is untouched until that commit). Nothing is deleted first.
import { lstat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { runProcess } from "./ffmpegMedia";
import { publishRenderOutput } from "./renderLifetime";
import { LongRenderRefusalV1, type LongOutputIdentityPlanV1, type LongPublishReceiptV1, type LongRenderOwnerJournalHandleV1 } from "./longRenderContractsV1";

/** `<output dir>/.<name>.<runId>.editkin-long` (owned; journaled as output-staging-dir). */
export function longRenderOutputStagingDirectoryV1(requestedPath: string, runId: string): string {
  const requested = resolve(requestedPath);
  return join(dirname(requested), `.${basename(requested)}.${runId}.editkin-long`);
}

/** `<staging>/.<name>.<runId>.editkin-long.part.<ext>`. */
export function longRenderPartPathV1(requestedPath: string, runId: string): string {
  const requested = resolve(requestedPath);
  const extension = extname(requested).toLowerCase() === ".mov" ? ".mov" : ".mp4";
  return join(longRenderOutputStagingDirectoryV1(requested, runId), `.${basename(requested)}.${runId}.editkin-long.part${extension}`);
}

interface ProbeStream {
  codec_type?: string; codec_name?: string; width?: number; height?: number; pix_fmt?: string; r_frame_rate?: string; avg_frame_rate?: string;
  nb_frames?: string; duration?: string; duration_ts?: number; time_base?: string; sample_rate?: string; channels?: number;
  color_primaries?: string; color_transfer?: string; color_space?: string;
}

export async function probeLongPartV1(path: string, ffprobePath: string, timeoutMs = 120_000): Promise<LongPublishReceiptV1["probe"]> {
  const { stdout } = await runProcess(ffprobePath, ["-v", "error", "-show_entries",
    "stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate,avg_frame_rate,nb_frames,duration,duration_ts,time_base,sample_rate,channels,color_primaries,color_transfer,color_space",
    "-of", "json", path], timeoutMs, { completeStdoutMaxChars: 256 * 1024 });
  const streams = (JSON.parse(stdout) as { streams?: ProbeStream[] }).streams ?? [];
  const video = streams.find(stream => stream.codec_type === "video"), audio = streams.find(stream => stream.codec_type === "audio");
  if (!video) throw new LongRenderRefusalV1("LONG_RENDER_OUTPUT_QA", "the encoded output has no video stream", { path });
  const [timeNumerator, timeDenominator] = (audio?.time_base ?? "").split("/").map(Number);
  const audioSamples = audio && Number.isFinite(audio.duration_ts) && timeNumerator > 0 && timeDenominator > 0 && Number(audio.sample_rate) > 0
    ? Math.round(Number(audio.duration_ts) * timeNumerator / timeDenominator * Number(audio.sample_rate)) : undefined;
  return {
    width: Number(video.width), height: Number(video.height), frameRate: video.r_frame_rate ?? "", frames: Number(video.nb_frames),
    videoDurationSeconds: Number(video.duration), pixelFormat: video.pix_fmt ?? "",
    colorPrimaries: video.color_primaries, colorTransfer: video.color_transfer, colorMatrix: video.color_space,
    audioCodec: audio?.codec_name, audioSampleRate: audio ? Number(audio.sample_rate) : undefined, audioChannels: audio?.channels, audioSamples,
  };
}

/** Every identity check of the `.part` against the plan (C2 publish step 2). */
export function checkLongPartIdentityV1(probe: LongPublishReceiptV1["probe"], identity: LongOutputIdentityPlanV1): LongPublishReceiptV1["checks"] {
  const rate = `${identity.frameRate.numerator}/${identity.frameRate.denominator}`;
  const frameSeconds = identity.frameRate.denominator / identity.frameRate.numerator;
  const check = (name: string, ok: boolean, expected: unknown, actual: unknown) => ({ name, ok, expected, actual });
  return [
    check("width", probe.width === identity.width, identity.width, probe.width),
    check("height", probe.height === identity.height, identity.height, probe.height),
    check("frame rate", probe.frameRate === rate, rate, probe.frameRate),
    check("frame count (container) within one frame", Number.isSafeInteger(probe.frames) && Math.abs(probe.frames - identity.expectedFrames) <= 1, identity.expectedFrames, probe.frames),
    check("video duration within one frame", Number.isFinite(probe.videoDurationSeconds) && Math.abs(probe.videoDurationSeconds - identity.durationSeconds) <= frameSeconds + 1e-3, identity.durationSeconds, probe.videoDurationSeconds),
    check("pixel format", probe.pixelFormat === identity.pixelFormat, identity.pixelFormat, probe.pixelFormat),
    check("colour primaries", probe.colorPrimaries === identity.colorPrimaries, identity.colorPrimaries, probe.colorPrimaries),
    check("colour transfer", probe.colorTransfer === identity.colorTransfer, identity.colorTransfer, probe.colorTransfer),
    check("colour matrix", probe.colorMatrix === identity.colorMatrix, identity.colorMatrix, probe.colorMatrix),
    check("audio codec", probe.audioCodec === identity.audio.codec, identity.audio.codec, probe.audioCodec),
    check("audio sample rate", probe.audioSampleRate === identity.audio.sampleRate, identity.audio.sampleRate, probe.audioSampleRate),
    check("audio channels", probe.audioChannels === identity.audio.channels, identity.audio.channels, probe.audioChannels),
    check("audio samples within one AAC frame", probe.audioSamples !== undefined && Math.abs(probe.audioSamples - identity.audio.expectedSamples) <= 1024, identity.audio.expectedSamples, probe.audioSamples),
  ];
}

/** QA the `.part`, then commit it over the requested path with one rename; the journal records the move. */
export async function publishLongRenderOutputV1(input: { partPath: string; requestedPath: string; identity: LongOutputIdentityPlanV1; ffprobePath: string; journal?: LongRenderOwnerJournalHandleV1 }): Promise<LongPublishReceiptV1> {
  const info = await lstat(input.partPath);
  if (!info.isFile()) throw new LongRenderRefusalV1("LONG_RENDER_OUTPUT_QA", "the encoded output is not a regular file", { path: input.partPath });
  const probe = await probeLongPartV1(input.partPath, input.ffprobePath);
  const checks = checkLongPartIdentityV1(probe, input.identity);
  const failed = checks.filter(item => !item.ok);
  if (failed.length) throw new LongRenderRefusalV1("LONG_RENDER_OUTPUT_QA", `the encoded output does not match its identity plan: ${failed.map(item => `${item.name} expected ${JSON.stringify(item.expected)} got ${JSON.stringify(item.actual)}`).join("; ")}`,
    { path: input.partPath, failed });
  await publishRenderOutput(input.partPath, resolve(input.requestedPath));
  await input.journal?.recordRemoved(input.partPath, "published");
  return { schema: "editkin.long-render-publish/v1", partPath: input.partPath, requestedPath: resolve(input.requestedPath), bytes: info.size, probe, checks, committedAt: new Date().toISOString() };
}
