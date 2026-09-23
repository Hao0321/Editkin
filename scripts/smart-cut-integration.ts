import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { analyzeSmartCut } from "../src/application/smartCut";
import { exportVideo } from "../src/application/exportVideo";
import { applyCommand } from "../src/domain/commands";
import { createEmptyProject } from "../src/domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../src/domain/types";
import { probeMedia } from "../src/render/ffmpeg";

function run(executable: string, args: string[], timeoutMs = 120_000): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("fixture command timeout")); }, timeoutMs);
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8_000); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error(stderr.trim() || `fixture command exit ${code}`));
    });
  });
}

async function main() {
  const root = resolve(import.meta.dirname, "..");
  const artifactRoot = resolve(root, "../../.rd/artifacts/smart-cut");
  const evidencePath = resolve(process.argv[2] ?? "../../.rd/benchmarks/editkin-smart-cut-integration-windows-x64-20260822.json");
  const ffmpeg = process.env.HAO_FFMPEG_PATH ?? resolve(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
  const ffprobe = process.env.HAO_FFPROBE_PATH ?? resolve(root, "vendor/ffmpeg/win32-x64/ffprobe.exe");
  const nativeCore = process.env.HAO_NATIVE_CORE_PATH ?? resolve(root, "native/bin/win32-x64/hao-core.exe");
  const source = resolve(artifactRoot, "smart-cut-speaking-fixture.mp4");
  const output = resolve(artifactRoot, "smart-cut-speaking-output.mp4");
  const cacheRoot = resolve(artifactRoot, "integration-cache");
  await mkdir(artifactRoot, { recursive: true });
  await rm(cacheRoot, { recursive: true, force: true });
  await run(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=0x315cf4:s=640x360:r=30:d=6",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=1",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=1.2",
    "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=1.8",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=1",
    "-filter_complex", "[1:a][2:a][3:a][4:a][5:a]concat=n=5:v=0:a=1[a]",
    "-map", "0:v", "-map", "[a]", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", source,
  ]);
  const coldStarted = performance.now();
  const analysis = await analyzeSmartCut({ sourcePath: source, sourceStart: 0, duration: 6, fps: 30 }, { ffmpegPath: ffmpeg, nativeCorePath: nativeCore, cacheRoot });
  const coldMs = performance.now() - coldStarted;
  const cacheStarted = performance.now();
  const cachedAnalysis = await analyzeSmartCut({ sourcePath: source, sourceStart: 0, duration: 6, fps: 30 }, { ffmpegPath: ffmpeg, nativeCorePath: nativeCore, cacheRoot });
  const cacheMs = performance.now() - cacheStarted;
  const project = createEmptyProject("Smart Cut integration", { id: "smart-cut-integration", width: 640, height: 360, fps: 30 });
  project.assets.push({ id: "source", name: "Speaking fixture", kind: "video", uri: source, duration: 6, width: 640, height: 360 });
  project.tracks[0].clips.push({
    id: "source-clip", assetId: "source", trackId: project.tracks[0].id, timelineStart: 0, sourceStart: 0, duration: 6,
    volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
  });
  const keepRanges = analysis.ranges.map((range) => ({ start: range.startFrame / analysis.fps, end: range.endFrame / analysis.fps }));
  const edited = applyCommand(project, {
    type: "smart_cut_clip", clipId: "source-clip", keepRanges,
    segmentIds: keepRanges.map((_, index) => index === 0 ? "source-clip" : `source-smart-${index}`),
  });
  const rendered = await exportVideo({
    project: edited,
    outputPath: output,
    options: { ffmpegPath: ffmpeg, ffprobePath: ffprobe, nativeCorePath: nativeCore, preferGpu: true, timeoutMs: 180_000 },
  });
  const probe = await probeMedia(output, ffprobe);
  const expectedDuration = analysis.ranges.reduce((sum, range) => sum + (range.endFrame - range.startFrame) / analysis.fps, 0);
  const assertions = {
    nativeDecisionEngine: analysis.engine === "hao-core-rust-0.4",
    coldThenCacheHit: analysis.cacheHit === false && cachedAnalysis.cacheHit === true,
    cacheAtLeastTenTimesFaster: cacheMs * 10 < coldMs,
    detectedThreeSilences: analysis.silenceCount === 3,
    removedMeaningfulPause: analysis.removedFrames >= 75 && analysis.removedFrames <= 95,
    editGraphSegmentCount: edited.tracks[0].clips.length === analysis.ranges.length && analysis.ranges.length === 2,
    gpuRender: rendered.encoder === "h264_nvenc",
    nativeRenderPlanner: rendered.planner === "hao-core-rust-0.4",
    outputDuration: Math.abs(probe.duration - expectedDuration) < 0.15 && probe.duration < 3.5,
    outputStreams: probe.hasVideo && probe.hasAudio && probe.width === 640 && probe.height === 360,
  };
  const payload = {
    status: Object.values(assertions).every(Boolean) ? "GREEN" : "BLOCK",
    dataset: { id: "editkin-speaking-silence-synthetic-v1", sourceBytes: (await stat(source)).size, sourceSha256: createHash("sha256").update(await readFile(source)).digest("hex") },
    analysis,
    cachedAnalysis,
    performance: { coldMs: Number(coldMs.toFixed(3)), cacheMs: Number(cacheMs.toFixed(3)), speedup: Number((coldMs / cacheMs).toFixed(2)) },
    expectedDuration,
    editedClipCount: edited.tracks[0].clips.length,
    rendered,
    probe,
    output: { bytes: (await stat(output)).size, sha256: createHash("sha256").update(await readFile(output)).digest("hex") },
    assertions,
  };
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (payload.status !== "GREEN") process.exitCode = 1;
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
