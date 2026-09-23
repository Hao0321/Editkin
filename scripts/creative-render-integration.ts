import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { captionStyleFromPreset } from "../src/creative/corePack";
import { createEmptyProject } from "../src/domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../src/domain/types";
import { renderProject } from "../src/render/ffmpeg";
import { createMotionGraphic } from "../src/motion/composition";

const appRoot = resolve(".");
const reportRoot = resolve(appRoot, "../../.rd/benchmarks/editkin-05-creative-render");
const ffmpeg = resolve(appRoot, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const ffprobe = resolve(appRoot, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const nativeCore = resolve(appRoot, "native/bin/win32-x64/hao-core.exe");
const source = resolve(appRoot, "public/demo-source.mp4");

function project(creative: boolean): EditProject {
  const value = createEmptyProject(creative ? "Creative" : "Baseline", { id: creative ? "creative" : "baseline", width: 640, height: 360, fps: 30 });
  value.assets.push({ id: "source", name: "source", kind: "video", uri: source, duration: 12, width: 960, height: 540 });
  value.tracks[0].clips.push(
    {
      id: "shot-a", assetId: "source", trackId: "video-main", timelineStart: 0, sourceStart: 0, duration: 2,
      volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
      creative: creative ? { lookPresetId: "ai_cobalt_crisp", effectPresetIds: ["scanline_focus"], transitionOut: { presetId: "prism_flash_cut", duration: 0.18 } } : undefined,
    },
    {
      id: "shot-b", assetId: "source", trackId: "video-main", timelineStart: 2, sourceStart: 2, duration: 2,
      volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
      creative: creative ? { lookPresetId: "night_neon_controlled", effectPresetIds: ["film_grain_soft"], transitionIn: { presetId: "luma_fade", duration: 0.4 } } : undefined,
    },
  );
  if (creative) {
    value.captions.push({ id: "caption", text: "Hao Creator Pack", start: 0.3, duration: 1.4 });
    value.captionStyle = captionStyleFromPreset("neon_signal");
  }
  return value;
}

async function run(executable: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(stderr.slice(-4_000))));
  });
}

async function digest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

await rm(reportRoot, { recursive: true, force: true });
await mkdir(reportRoot, { recursive: true });
const baselinePath = resolve(reportRoot, "baseline.mp4");
const creativePath = resolve(reportRoot, "creative.mp4");
const motionPath = resolve(reportRoot, "motion-composition.mp4");
const options = { ffmpegPath: ffmpeg, ffprobePath: ffprobe, nativeCorePath: nativeCore, preferGpu: false, timeoutMs: 120_000 };
const started = performance.now();
const baseline = await renderProject(project(false), baselinePath, options);
const creative = await renderProject(project(true), creativePath, options);
const motionProject = project(false);
motionProject.motionTracks.push({
  id: "track-subject", clipId: "shot-a", name: "Subject", engine: "fixture-manual", analysisFps: 10,
  initialRect: { x: 0.2, y: 0.25, width: 0.2, height: 0.3 }, lostRatio: 0, createdAt: "2026-08-22T00:00:00Z",
  points: [
    { frame: 0, time: 0, rect: { x: 0.2, y: 0.25, width: 0.2, height: 0.3 }, confidence: 1, status: "manual" },
    { frame: 15, time: 1.5, rect: { x: 0.45, y: 0.3, width: 0.2, height: 0.3 }, confidence: 0.9, status: "tracked" },
  ],
});
motionProject.motionGraphics.push(createMotionGraphic("tracked-label", "tag", "TRACKED", 0.2, 1.6, "track-subject"));
const motion = await renderProject(motionProject, motionPath, options);
const renderMs = performance.now() - started;
const frames = [1, 1.95, 2.1];
const evidence = [];
for (const time of frames) {
  const baselineFrame = resolve(reportRoot, `baseline-${time}.png`);
  const creativeFrame = resolve(reportRoot, `creative-${time}.png`);
  await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(time), "-i", baselinePath, "-frames:v", "1", baselineFrame]);
  await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(time), "-i", creativePath, "-frames:v", "1", creativeFrame]);
  const baselineSha256 = await digest(baselineFrame);
  const creativeSha256 = await digest(creativeFrame);
  evidence.push({ time, baselineSha256, creativeSha256, different: baselineSha256 !== creativeSha256 });
}
const baselineMotionFrame = resolve(reportRoot, "baseline-motion.png");
const motionFrame = resolve(reportRoot, "motion-frame.png");
await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-ss", "1", "-i", baselinePath, "-frames:v", "1", baselineMotionFrame]);
await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-ss", "1", "-i", motionPath, "-frames:v", "1", motionFrame]);
const motionEvidence = { time: 1, baselineSha256: await digest(baselineMotionFrame), motionSha256: await digest(motionFrame) };
const report = {
  status: evidence.every((item) => item.different) && motionEvidence.baselineSha256 !== motionEvidence.motionSha256 ? "GREEN" : "BLOCK",
  target: "Creator Pack and hao.motion-composition/v1 choices materially change actual FFmpeg output",
  renderMs: Number(renderMs.toFixed(2)),
  outputs: { baseline, creative, motion },
  evidence,
  motionEvidence: { ...motionEvidence, different: motionEvidence.baselineSha256 !== motionEvidence.motionSha256 },
};
await writeFile(resolve(reportRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
if (report.status !== "GREEN") process.exitCode = 1;
