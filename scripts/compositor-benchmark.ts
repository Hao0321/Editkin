import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createEmptyProject } from "../src/domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../src/domain/types";
import { probeMedia, renderProject } from "../src/render/ffmpeg";

function sha256(path: string): Promise<string> {
  return readFile(path).then((bytes) => createHash("sha256").update(bytes).digest("hex"));
}

function samplePixel(ffmpeg: string, path: string, time: number, x: number, y: number): Promise<number[]> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-ss", String(time), "-i", path,
      "-vf", `crop=1:1:${x}:${y},format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "-",
    ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code) => code === 0
      ? resolvePromise([...Buffer.concat(chunks).subarray(0, 3)])
      : reject(new Error(`pixel sample failed ${code}: ${stderr}`)));
  });
}

function near(actual: number[], expected: number[], tolerance: number): boolean {
  return actual.length === 3 && actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance);
}

function colorDistance(left: number[], right: number[]): number {
  return left.reduce((sum, value, index) => sum + Math.abs(value - (right[index] ?? 0)), 0);
}

async function main() {
  const root = resolve(import.meta.dirname, "..");
  const ffmpeg = process.env.HAO_FFMPEG_PATH ?? "ffmpeg";
  const ffprobe = process.env.HAO_FFPROBE_PATH ?? "ffprobe";
  const basePath = resolve(root, "public/benchmarks/layer-base.mp4");
  const overlayPath = resolve(root, "public/benchmarks/layer-overlay.mp4");
  const outputPath = resolve(root, "reports/v03-compositor-benchmark.mp4");
  const evidencePath = resolve(process.argv[2] ?? "../../.rd/benchmarks/hao-editor-v03-compositor.json");
  const project = createEmptyProject("v0.3 compositor benchmark", { id: "v03-compositor", width: 640, height: 360, fps: 30 });
  project.assets.push(
    { id: "base", name: "Base blue", kind: "video", uri: basePath, duration: 4, width: 640, height: 360 },
    { id: "overlay", name: "Overlay red", kind: "video", uri: overlayPath, duration: 2, width: 320, height: 180 },
  );
  project.tracks[0].clips.push({
    id: "base-clip", assetId: "base", trackId: project.tracks[0].id,
    timelineStart: 0, sourceStart: 0, duration: 4, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
  });
  project.tracks.splice(1, 0, {
    id: "video-overlay", name: "Overlay", kind: "video", locked: false, muted: false,
    clips: [{
      id: "overlay-clip", assetId: "overlay", trackId: "video-overlay",
      timelineStart: 1, sourceStart: 0, duration: 2, volume: 0.5,
      transform: { ...DEFAULT_TRANSFORM, scale: 0.5, opacity: 0.75 },
      color: { ...DEFAULT_COLOR },
      keyframes: [
        { id: "move-start", time: 0.1, transform: { ...DEFAULT_TRANSFORM, x: -160, scale: 0.5, opacity: 0.25 }, color: { ...DEFAULT_COLOR, hue: 0 }, easing: "linear" },
        { id: "move-end", time: 1.9, transform: { ...DEFAULT_TRANSFORM, x: 160, scale: 0.5, opacity: 1 }, color: { ...DEFAULT_COLOR, hue: 120 }, easing: "linear" },
      ],
    }],
  });
  const dataset = {
    id: "hao-editor-compositor-solids-v1",
    inputs: [
      { path: "public/benchmarks/layer-base.mp4", bytes: (await readFile(basePath)).byteLength, sha256: await sha256(basePath) },
      { path: "public/benchmarks/layer-overlay.mp4", bytes: (await readFile(overlayPath)).byteLength, sha256: await sha256(overlayPath) },
    ],
  };
  const started = performance.now();
  let payload: Record<string, unknown>;
  try {
    const result = await renderProject(project, outputPath, {
      ffmpegPath: ffmpeg, ffprobePath: ffprobe,
      nativeCorePath: resolve(root, "native/bin/win32-x64/hao-core.exe"), preferGpu: true,
    });
    const probe = await probeMedia(outputPath, ffprobe);
    const corner = await samplePixel(ffmpeg, outputPath, 2, 20, 20);
    const center = await samplePixel(ffmpeg, outputPath, 2, 320, 180);
    const earlyLeft = await samplePixel(ffmpeg, outputPath, 1.15, 170, 180);
    const earlyRight = await samplePixel(ffmpeg, outputPath, 1.15, 470, 180);
    const lateLeft = await samplePixel(ffmpeg, outputPath, 2.85, 170, 180);
    const lateRight = await samplePixel(ffmpeg, outputPath, 2.85, 470, 180);
    const assertions = {
      duration: Math.abs(probe.duration - 4) < 0.15,
      dimensions: probe.width === 640 && probe.height === 360,
      streams: probe.hasVideo && probe.hasAudio,
      baseVisible: near(corner, [20, 58, 102], 28),
      overlayVisible: colorDistance(center, corner) > 120,
      keyframePosition: colorDistance(earlyLeft, earlyRight) > 50 && colorDistance(lateRight, lateLeft) > 150,
      keyframeOpacity: Math.max(...lateRight) > Math.max(...earlyLeft) + 50,
      gradingKeyframe: earlyLeft[0] > earlyRight[0] + 40 && lateRight[1] > lateLeft[1] + 80 && lateRight[1] > lateRight[0] + 80,
    };
    const green = Object.values(assertions).every(Boolean);
    payload = { status: green ? "GREEN" : "BLOCK", dataset, elapsedMs: Math.round(performance.now() - started), result, probe, pixels: { corner, center, earlyLeft, earlyRight, lateLeft, lateRight }, assertions };
  } catch (error) {
    payload = { status: "BLOCK", dataset, elapsedMs: Math.round(performance.now() - started), error: error instanceof Error ? error.message : String(error) };
  }
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(payload));
  if (payload.status !== "GREEN") process.exitCode = 1;
}

void main();
