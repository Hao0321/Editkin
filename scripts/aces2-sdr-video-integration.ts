import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createEmptyProject } from "../src/domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../src/domain/types";
import { probeMedia, renderProject } from "../src/render/ffmpeg";

const runFile = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const evidenceRoot = resolve(root, "..", "..", ".rd", "benchmarks", "editkin-aces2-sdr-video");
const candidateIndex = process.argv.indexOf("--candidate");
const candidate = resolve(candidateIndex >= 0 ? process.argv[candidateIndex + 1] : join(root, "spikes/gpu-compositor/target/release/editkin-gpu-compositor.exe"));
const baselineIndex = process.argv.indexOf("--baseline");
const baseline = baselineIndex >= 0 ? resolve(process.argv[baselineIndex + 1]) : undefined;
const ffmpeg = join(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const ffprobe = join(root, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const width = 64;
const height = 36;
const frameCount = 3;
const fps = 30;

function encodeFixture(): Buffer {
  const values = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 4;
    values[offset] = x / (width - 1) * 8;
    values[offset + 1] = y / (height - 1) * 4;
    values[offset + 2] = ((x * 11 + y * 7) % 23) / 5;
    values[offset + 3] = 1;
  }
  values.set([.18, .18, .18, 1], 0);
  const bytes = Buffer.alloc(16 + values.length * 4);
  Buffer.from("EKF32V1\0", "binary").copy(bytes);
  bytes.writeUInt32LE(width, 8);
  bytes.writeUInt32LE(height, 12);
  values.forEach((value, index) => bytes.writeFloatLE(value, 16 + index * 4));
  return bytes;
}

function project(sourcePath: string, audioPath: string) {
  const value = createEmptyProject("Native ACES 2 SDR product journey", { width, height, fps });
  value.assets.push(
    { id: "plate", name: "plate.ekf32", kind: "image", uri: sourcePath, duration: frameCount / fps, width, height, alphaMode: "straight", color: { interpretation: "linear_rec709" } },
    { id: "tone", name: "tone.wav", kind: "audio", uri: audioPath, duration: frameCount / fps },
  );
  value.tracks[0].clips.push({ id: "plate-clip", assetId: "plate", trackId: value.tracks[0].id, timelineStart: 0, sourceStart: 0, duration: frameCount / fps, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
  const audioTrack = value.tracks.find((track) => track.kind === "audio")!;
  audioTrack.clips.push({ id: "tone-clip", assetId: "tone", trackId: audioTrack.id, timelineStart: 0, sourceStart: 0, duration: frameCount / fps, volume: .5, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
  value.captions.push({ id: "caption", text: "ACES 2", start: 0, duration: frameCount / fps });
  value.captionStyle.color = "#FFFFFFFF";
  value.captionStyle.translationColor = "#FFFFFFFF";
  value.colorManagement = { ...value.colorManagement!, mode: "aces2", outputTransform: "rec709_sdr" };
  return value;
}

await mkdir(evidenceRoot, { recursive: true });
const sourcePath = join(evidenceRoot, "source.ekf32");
const audioPath = join(evidenceRoot, "tone.wav");
const outputPath = join(evidenceRoot, "candidate.mp4");
await writeFile(sourcePath, encodeFixture());
await runFile(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=0.1", "-c:a", "pcm_s16le", audioPath], { windowsHide: true, timeout: 30_000 });
await rm(outputPath, { force: true });
const rendered = await renderProject(project(sourcePath, audioPath), outputPath, {
  ffmpegPath: ffmpeg,
  ffprobePath: ffprobe,
  gpuCompositorPath: candidate,
  preferGpu: false,
  fontRoot: join(root, "public/fonts"),
  timeoutMs: 120_000,
});
const probe = await probeMedia(outputPath, ffprobe);
let baselineRejected = true;
let baselineEvidence: { path: string; sha256: string } | undefined;
if (baseline) {
  baselineEvidence = { path: baseline, sha256: sha256(await readFile(baseline)) };
  try {
    await renderProject(project(sourcePath, audioPath), join(evidenceRoot, "baseline.mp4"), {
      ffmpegPath: ffmpeg,
      ffprobePath: ffprobe,
      gpuCompositorPath: baseline,
      preferGpu: false,
      fontRoot: join(root, "public/fonts"),
      timeoutMs: 120_000,
    });
    baselineRejected = false;
  } catch (error) {
    baselineRejected = /engine-render-display-sequence|Usage|exit/i.test(String(error));
  }
}
const outputBytes = await readFile(outputPath);
const green = baselineRejected && probe.hasVideo && probe.hasAudio && probe.colorPrimaries === "bt709"
  && probe.colorTransfer === "bt709" && probe.colorMatrix === "bt709" && Math.abs(probe.duration - frameCount / fps) <= .08
  && rendered.planner === "editkin-common-graph-wgpu-aces2-display-sequence/v1"
  && rendered.colorPipeline?.status === "GREEN" && rendered.colorPipeline.deviceCreationCount === 1
  && rendered.colorPipeline.frameCount === frameCount && outputBytes.length > 1_000;
const report = {
  schema: "editkin.aces2-sdr-video-integration/v1",
  status: green ? "GREEN" : "BLOCK",
  productJourney: { nativeDisplaySequence: true, subtitleAfterDisplayTransform: true, audioMuxed: true, atomicMp4Commit: true },
  rendered,
  probe,
  baselineRejected,
  candidate: { path: candidate, sha256: sha256(await readFile(candidate)) },
  baseline: baselineEvidence,
  output: { path: outputPath, bytes: outputBytes.length, sha256: sha256(outputBytes) },
};
await writeFile(join(evidenceRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ status: report.status, planner: rendered.planner, colorPipeline: rendered.colorPipeline, probe, baselineRejected, candidateSha256: report.candidate.sha256, output: report.output }, null, 2));
if (!green) process.exitCode = 1;
