import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDemoProject } from "../src/domain/demo";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../src/domain/types";
import { renderProject, type RenderResult } from "../src/render/ffmpeg";

const appRoot = resolve(import.meta.dirname, "..");
const evidenceDirectory = resolve(appRoot, "../../.rd/benchmarks/editkin-final-audio-quality");
const output = resolve(evidenceDirectory, "encoded-output.mp4");
const videoOnlySource = resolve(evidenceDirectory, "video-only-source.mp4");
const videoOnlyOutput = resolve(evidenceDirectory, "video-only-output.mp4");
const silence = resolve(evidenceDirectory, "silence.m4a");
const music = resolve(evidenceDirectory, "music.m4a");
const reportPath = resolve(evidenceDirectory, "report.json");
const ffmpeg = resolve(appRoot, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const ffprobe = resolve(appRoot, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const nativeCore = resolve(appRoot, "native/bin/win32-x64/hao-core.exe");

function run(executable: string, args: string[], timeoutMs = 120_000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd: appRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let outputText = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${executable} timed out`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { outputText += String(chunk); });
    child.stderr.on("data", (chunk) => { outputText += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? resolvePromise(outputText) : reject(new Error(outputText));
    });
  });
}

type LoudnessMeasurement = {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  output_i: string;
  output_tp: string;
  output_lra: string;
  output_thresh: string;
  normalization_type: string;
  target_offset: string;
};

function parseLoudness(log: string): LoudnessMeasurement {
  const matches = [...log.matchAll(/\{\s*"input_i"[\s\S]*?"target_offset"\s*:\s*"[^"]+"\s*\}/g)];
  if (matches.length === 0) throw new Error("FFmpeg loudnorm did not emit a JSON measurement");
  return JSON.parse(matches.at(-1)![0]) as LoudnessMeasurement;
}

function finiteMeasurement(measurement: LoudnessMeasurement): boolean {
  return [
    measurement.input_i,
    measurement.input_tp,
    measurement.input_lra,
    measurement.input_thresh,
    measurement.target_offset,
  ].every((value) => Number.isFinite(Number(value)));
}

function nativeFinalReceiptFailures(rendered: RenderResult): string[] {
  const receipt = rendered.nativeAudio;
  const failures: string[] = [];
  if (!rendered.planner.includes("hao-core-native-audio-dag/v1")) failures.push("NATIVE_FINAL_AUDIO_BYPASSED");
  if (receipt?.schema !== "editkin.native-final-audio/v1" || receipt.status !== "GREEN") failures.push("NATIVE_FINAL_AUDIO_RECEIPT_INVALID");
  if (receipt?.stageSchema !== "editkin.native-audio-preview-stage/v2" || receipt.mixSchema !== "editkin.native-audio-preview-mix-receipt/v1") failures.push("NATIVE_FINAL_AUDIO_STAGE_INVALID");
  if (receipt?.decoderExecutor !== "ffmpeg-source-decode/v1" || receipt.mixExecutor !== "hao-core-native-dag/v1" || receipt.nativeGraphExecution !== true) failures.push("NATIVE_FINAL_AUDIO_EXECUTOR_INVALID");
  const expectedBinding = receipt ? createHash("sha256").update([
    receipt.schema,
    receipt.manifestSha256,
    receipt.outputSha256,
    String(receipt.outputBytes),
    String(receipt.durationSeconds),
    String(receipt.sourceCount),
    String(receipt.voiceClipCount),
    String(receipt.musicClipCount),
  ].join("\0")).digest("hex") : "";
  if (!/^[a-f0-9]{64}$/.test(receipt?.manifestSha256 ?? "") || !/^[a-f0-9]{64}$/.test(receipt?.outputSha256 ?? "")
    || !/^[a-f0-9]{64}$/.test(receipt?.bindingSha256 ?? "") || receipt?.bindingSha256 !== expectedBinding
    || !(receipt?.outputBytes && receipt.outputBytes > 0)) failures.push("NATIVE_FINAL_AUDIO_IDENTITY_INVALID");
  if (!Number.isFinite(receipt?.postLimitPeak) || receipt!.postLimitPeak > 10 ** (-3 / 20) + 1e-6 || receipt?.limiterCeilingDb !== -3) failures.push("NATIVE_FINAL_AUDIO_LIMITER_INVALID");
  return failures;
}

async function measure(path: string): Promise<LoudnessMeasurement> {
  return parseLoudness(await run(ffmpeg, [
    "-hide_banner",
    "-i", path,
    "-af", "loudnorm=I=-18:LRA=11:TP=-3:print_format=json",
    "-f", "null",
    "-",
  ]));
}

await rm(evidenceDirectory, { recursive: true, force: true });
await mkdir(evidenceDirectory, { recursive: true });
await run(ffmpeg, [
  "-y", "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", "sine=frequency=211:sample_rate=48000",
  "-af", "volume=0.12", "-t", "12", "-c:a", "aac", "-b:a", "192k", music,
]);
await run(ffmpeg, [
  "-y", "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", "color=c=0x152033:s=320x180:r=30",
  "-t", "12", "-an", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", videoOnlySource,
]);

const project = createDemoProject();
project.width = 960;
project.height = 540;
project.assets[0].uri = resolve(appRoot, "public/demo-source.mp4");
project.assets.push({ id: "final-audio-music", name: "Final audio music holdout", kind: "audio", uri: music, duration: 12, role: "background-music" });
project.tracks.push({
  id: "final-audio-music-track", name: "音樂驗收", kind: "audio", locked: false, muted: false,
  clips: [{
    id: "final-audio-music-clip", assetId: "final-audio-music", trackId: "final-audio-music-track",
    timelineStart: 0, sourceStart: 0, duration: 12, volume: 0.35,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
  }],
});
const rendered = await renderProject(project, output, {
  ffmpegPath: ffmpeg,
  ffprobePath: ffprobe,
  nativeCorePath: nativeCore,
  preferGpu: false,
  timeoutMs: 120_000,
});
assert.deepEqual(nativeFinalReceiptFailures(rendered), []);
assert.equal(rendered.nativeAudio?.sourceCount, 2);
assert.equal(rendered.nativeAudio?.voiceClipCount, 1);
assert.equal(rendered.nativeAudio?.musicClipCount, 1);
const bypassedNative = structuredClone(rendered);
bypassedNative.planner = bypassedNative.planner.replace("+hao-core-native-audio-dag/v1", "");
const tamperedNative = structuredClone(rendered);
tamperedNative.nativeAudio!.outputSha256 = "0".repeat(64);
const nativeBypassRejected = nativeFinalReceiptFailures(bypassedNative).includes("NATIVE_FINAL_AUDIO_BYPASSED");
const tamperedNativeReceiptRejected = nativeFinalReceiptFailures(tamperedNative).includes("NATIVE_FINAL_AUDIO_IDENTITY_INVALID");
assert.equal(nativeBypassRejected, true);
assert.equal(tamperedNativeReceiptRejected, true);

const videoOnlyProject = createDemoProject();
videoOnlyProject.width = 320;
videoOnlyProject.height = 180;
videoOnlyProject.assets[0].uri = videoOnlySource;
const videoOnlyRendered = await renderProject(videoOnlyProject, videoOnlyOutput, {
  ffmpegPath: ffmpeg,
  ffprobePath: ffprobe,
  nativeCorePath: nativeCore,
  preferGpu: false,
  timeoutMs: 120_000,
});
const videoOnlyProbe = JSON.parse(await run(ffprobe, [
  "-v", "error", "-show_entries", "stream=codec_type", "-of", "json", videoOnlyOutput,
]));
const audioLessMediaFallsBackSafely = videoOnlyRendered.nativeAudio === undefined
  && !videoOnlyRendered.planner.includes("hao-core-native-audio-dag/v1")
  && videoOnlyProbe.streams.some((stream: { codec_type: string }) => stream.codec_type === "video")
  && videoOnlyProbe.streams.some((stream: { codec_type: string }) => stream.codec_type === "audio");
assert.equal(audioLessMediaFallsBackSafely, true);

const probe = JSON.parse(await run(ffprobe, [
  "-v", "error",
  "-show_entries", "stream=index,codec_type,duration,start_time,sample_rate,channels,time_base,duration_ts",
  "-of", "json",
  output,
]));
const video = probe.streams.find((stream: { codec_type: string }) => stream.codec_type === "video");
const audio = probe.streams.find((stream: { codec_type: string }) => stream.codec_type === "audio");
assert.ok(video, "encoded output has no video stream");
assert.ok(audio, "encoded output has no audio stream");
const videoDuration = Number(video.duration);
const audioDuration = Number(audio.duration);
const avDurationDriftMs = Math.abs(videoDuration - audioDuration) * 1_000;
const avStartDriftMs = Math.abs(Number(video.start_time) - Number(audio.start_time)) * 1_000;

const loudness = await measure(output);
assert.equal(finiteMeasurement(loudness), true);
const integratedLufs = Number(loudness.input_i);
const truePeakDbtp = Number(loudness.input_tp);
const loudnessRangeLu = Number(loudness.input_lra);
const targetOffsetLu = Number(loudness.target_offset);
assert.ok(Math.abs(integratedLufs - (-18)) <= 0.5, `integrated loudness ${integratedLufs} LUFS`);
assert.ok(truePeakDbtp <= -2.8, `true peak ${truePeakDbtp} dBTP exceeds AAC tolerance`);
assert.ok(loudnessRangeLu <= 11.5, `loudness range ${loudnessRangeLu} LU exceeds target`);
assert.ok(Math.abs(targetOffsetLu) <= 0.5, `normalization residual ${targetOffsetLu} LU`);
assert.ok(avDurationDriftMs <= 20, `A/V duration drift ${avDurationDriftMs} ms`);
assert.ok(avStartDriftMs <= 1, `A/V start drift ${avStartDriftMs} ms`);
assert.equal(Number(audio.sample_rate), 48_000);
assert.equal(audio.channels, 2);

await run(ffmpeg, [
  "-y", "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
  "-t", "1", "-c:a", "aac", silence,
]);
const silenceMeasurement = await measure(silence);
const mathematicalSilenceRejected = !finiteMeasurement(silenceMeasurement);
assert.equal(mathematicalSilenceRejected, true);

const report = {
  schema: "editkin.final-encoded-audio-quality-gate/v3",
  decision: "GREEN",
  rendered,
  output,
  audio: {
    sampleRate: Number(audio.sample_rate),
    channels: audio.channels,
    integratedLufs,
    loudnessRangeLu,
    truePeakDbtp,
    targetOffsetLu,
  },
  synchronization: {
    videoDuration,
    audioDuration,
    avDurationDriftMs,
    avStartDriftMs,
  },
  negativeControls: {
    mathematicalSilenceRejected,
    nativeBypassRejected,
    tamperedNativeReceiptRejected,
    audioLessMediaFallsBackSafely,
  },
  thresholds: {
    integratedLufsTarget: -18,
    integratedToleranceLu: 0.5,
    truePeakCeilingDbtp: -2.8,
    loudnessRangeMaximumLu: 11.5,
    maximumDurationDriftMs: 20,
    maximumStartDriftMs: 1,
  },
  claimBoundary:
    "Proves one bounded non-scene-linear voice-plus-music final AAC output from the real Editkin render path is sourced from the hash-bound hao-core native audio DAG, meets the loudness plus short-fixture A/V synchronization contract, and a video-only source safely stays on the silence-capable fallback. Exports beyond 30 seconds or eight sources, scene-linear outputs, long-play drift/underrun and diverse real speech/music holdouts remain open.",
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report)}\n`);
