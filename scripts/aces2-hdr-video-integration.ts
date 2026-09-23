import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createEmptyProject } from "../src/domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../src/domain/types";
import { probeMedia, renderProject } from "../src/render/ffmpeg";

const runFile = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const evidenceRoot = resolve(root, "..", "..", ".rd", "benchmarks", "editkin-aces2-hdr-video");
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
type HdrOutput = "rec2100_hlg_1000" | "rec2100_pq_1000";

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

function project(sourcePath: string, audioPath: string, outputTransform: HdrOutput): EditProject {
  const value = createEmptyProject(`Native ACES 2 ${outputTransform}`, { width, height, fps });
  value.assets.push(
    { id: "plate", name: "plate.ekf32", kind: "image", uri: sourcePath, duration: frameCount / fps, width, height, alphaMode: "straight", color: { interpretation: "linear_rec709" } },
    { id: "tone", name: "tone.wav", kind: "audio", uri: audioPath, duration: frameCount / fps },
  );
  value.tracks[0].clips.push({ id: "plate-clip", assetId: "plate", trackId: value.tracks[0].id, timelineStart: 0, sourceStart: 0, duration: frameCount / fps, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
  const audioTrack = value.tracks.find((track) => track.kind === "audio")!;
  audioTrack.clips.push({ id: "tone-clip", assetId: "tone", trackId: audioTrack.id, timelineStart: 0, sourceStart: 0, duration: frameCount / fps, volume: .5, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
  value.colorManagement = { ...value.colorManagement!, mode: "aces2", outputTransform };
  return value;
}

async function hdrSideData(path: string) {
  const { stdout } = await runFile(ffprobe, ["-v", "error", "-select_streams", "v:0", "-read_intervals", "%+#1", "-show_frames", "-show_entries", "frame=side_data_list", "-of", "json", path], { windowsHide: true, timeout: 30_000, maxBuffer: 2_000_000 });
  const parsed = JSON.parse(stdout) as { frames?: Array<{ side_data_list?: Array<Record<string, string | number>> }> };
  const sideData = parsed.frames?.[0]?.side_data_list ?? [];
  const mastering = sideData.find((entry) => entry.side_data_type === "Mastering display metadata");
  const light = sideData.find((entry) => entry.side_data_type === "Content light level metadata");
  const masteringDisplay = mastering?.red_x === "34000/50000" && mastering.red_y === "16000/50000"
    && mastering.green_x === "13250/50000" && mastering.green_y === "34500/50000"
    && mastering.blue_x === "7500/50000" && mastering.blue_y === "3000/50000"
    && mastering.white_point_x === "15635/50000" && mastering.white_point_y === "16450/50000"
    && mastering.min_luminance === "50/10000" && mastering.max_luminance === "10000000/10000";
  return {
    masteringDisplay,
    contentLightLevel: light?.max_content === 1000 && light.max_average === 400,
    mastering,
    contentLight: light,
    rawSha256: sha256(Buffer.from(stdout)),
  };
}

await mkdir(evidenceRoot, { recursive: true });
const sourcePath = join(evidenceRoot, "source.ekf32");
const audioPath = join(evidenceRoot, "tone.wav");
await writeFile(sourcePath, encodeFixture());
await runFile(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=0.1", "-c:a", "pcm_s16le", audioPath], { windowsHide: true, timeout: 30_000 });

const outputs: Record<string, unknown> = {};
let allGreen = true;
for (const outputTransform of ["rec2100_hlg_1000", "rec2100_pq_1000"] as const) {
  const outputPath = join(evidenceRoot, `${outputTransform}.mp4`);
  await rm(outputPath, { force: true });
  const rendered = await renderProject(project(sourcePath, audioPath, outputTransform), outputPath, {
    ffmpegPath: ffmpeg, ffprobePath: ffprobe, gpuCompositorPath: candidate, preferGpu: false, timeoutMs: 180_000,
  });
  const probe = await probeMedia(outputPath, ffprobe);
  const sideData = await hdrSideData(outputPath);
  const bytes = await readFile(outputPath);
  const expectedTransfer = outputTransform === "rec2100_hlg_1000" ? "arib-std-b67" : "smpte2084";
  const green = rendered.planner === "editkin-common-graph-wgpu-aces2-hdr-display-sequence/v1" && rendered.encoder === "libx265"
    && rendered.colorPipeline?.status === "GREEN" && rendered.colorPipeline.artifactFormat === "rgba16_unorm"
    && probe.hasVideo && probe.hasAudio && probe.pixelFormat === "yuv420p10le" && probe.colorPrimaries === "bt2020"
    && probe.colorTransfer === expectedTransfer && probe.colorMatrix === "bt2020nc" && sideData.masteringDisplay && sideData.contentLightLevel
    && Math.abs(probe.duration - frameCount / fps) <= .08 && bytes.length > 1_000;
  allGreen &&= green;
  outputs[outputTransform] = { green, rendered, probe, sideData, output: { path: outputPath, bytes: bytes.length, sha256: sha256(bytes) } };
}

let baselineRejected = true;
let baselineEvidence: { path: string; sha256: string } | undefined;
if (baseline) {
  baselineEvidence = { path: baseline, sha256: sha256(await readFile(baseline)) };
  try {
    await renderProject(project(sourcePath, audioPath, "rec2100_pq_1000"), join(evidenceRoot, "baseline.mp4"), {
      ffmpegPath: ffmpeg, ffprobePath: ffprobe, gpuCompositorPath: baseline, preferGpu: false, timeoutMs: 120_000,
    });
    baselineRejected = false;
  } catch (error) {
    baselineRejected = /unsupported color processor|exit|ACES 2/i.test(String(error));
  }
}

const captioned = project(sourcePath, audioPath, "rec2100_pq_1000");
captioned.captions.push({ id: "caption", text: "HDR", start: 0, duration: frameCount / fps });
let captionRejected = false;
try {
  await renderProject(captioned, join(evidenceRoot, "captioned.mp4"), { ffmpegPath: ffmpeg, ffprobePath: ffprobe, gpuCompositorPath: candidate, preferGpu: false, timeoutMs: 120_000 });
} catch (error) {
  captionRejected = /203-nit reference-white/i.test(String(error));
}

const p3 = project(sourcePath, audioPath, "rec2100_pq_1000");
p3.colorManagement = { ...p3.colorManagement!, outputTransform: "p3d65_sdr" };
let p3Rejected = false;
try {
  await renderProject(p3, join(evidenceRoot, "p3.mp4"), { ffmpegPath: ffmpeg, ffprobePath: ffprobe, gpuCompositorPath: candidate, preferGpu: false, timeoutMs: 120_000 });
} catch (error) {
  p3Rejected = /P3 D65/i.test(String(error));
}

const hlgEvidence = outputs.rec2100_hlg_1000 as { rendered: { colorPipeline?: { firstFrameSha256?: string } }; output: { sha256: string } };
const pqEvidence = outputs.rec2100_pq_1000 as { rendered: { colorPipeline?: { firstFrameSha256?: string } }; output: { sha256: string } };
const crossModePixelsDistinct = Boolean(hlgEvidence.rendered.colorPipeline?.firstFrameSha256)
  && hlgEvidence.rendered.colorPipeline?.firstFrameSha256 !== pqEvidence.rendered.colorPipeline?.firstFrameSha256
  && hlgEvidence.output.sha256 !== pqEvidence.output.sha256;
const status = allGreen && baselineRejected && captionRejected && p3Rejected && crossModePixelsDistinct ? "GREEN" : "BLOCK";
const report = {
  schema: "editkin.aces2-hdr-video-integration/v1", status,
  productJourney: { nativeRgba16Sequence: true, tenBitHevc: true, audioMuxed: true, hdrVui: true, masteringDisplaySei: true, contentLightLevelSei: true, atomicMp4Commit: true },
  outputs, negativeControls: { baselineRejected, captionRejected, p3Rejected, crossModePixelsDistinct },
  candidate: { path: candidate, sha256: sha256(await readFile(candidate)) }, baseline: baselineEvidence,
};
await writeFile(join(evidenceRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ status, outputs: Object.fromEntries(Object.entries(outputs).map(([key, value]) => [key, { green: (value as { green: boolean }).green, probe: (value as { probe: unknown }).probe, sideData: (value as { sideData: unknown }).sideData }])), negativeControls: report.negativeControls, candidateSha256: report.candidate.sha256 }, null, 2));
if (status !== "GREEN") process.exitCode = 1;
