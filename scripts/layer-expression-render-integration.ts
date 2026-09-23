import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createEmptyProject, validateProject } from "../src/domain/editGraph";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type TimelineClip } from "../src/domain/types";
import { probeMedia, renderProject } from "../src/render/ffmpeg";

const appRoot = resolve(".");
const evidenceRoot = resolve(appRoot, "../../.rd/benchmarks/editkin-layer-expression-render");
const ffmpeg = resolve(appRoot, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const ffprobe = resolve(appRoot, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const nativeCore = resolve(appRoot, "native/bin/win32-x64/hao-core.exe");
const source = resolve(appRoot, "public/demo-source.mp4");

function clip(id: string, trackId: string, sourceStart: number): TimelineClip {
  return {
    id, assetId: "source", trackId, timelineStart: 0, sourceStart, duration: 4, volume: trackId === "video-overlay" ? 0 : 1,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], layer: { ...DEFAULT_CLIP_LAYER }, expressions: {},
  };
}

function fixture(enhanced: boolean): EditProject {
  const project = createEmptyProject(enhanced ? "Layer expression" : "Layer baseline", { id: enhanced ? "layer-expression" : "layer-baseline", width: 640, height: 360, fps: 30 });
  project.assets.push({ id: "source", name: "source", kind: "video", uri: source, duration: 12, width: 960, height: 540 });
  project.tracks[0].clips.push(clip("background", "video-main", 0));
  project.tracks.push({ id: "video-overlay", name: "Overlay", kind: "video", locked: false, muted: false, clips: [clip("overlay", "video-overlay", 3)] });
  const overlay = project.tracks.find((track) => track.id === "video-overlay")!.clips[0];
  overlay.transform = { ...overlay.transform, scale: 0.62, x: 80, opacity: enhanced ? 0.8 : 0.35 };
  if (enhanced) {
    const background = project.tracks[0].clips[0];
    background.transform = { ...background.transform, scale: 0.96, rotation: 1.5, x: 6 };
    const matte = clip("matte-source", "video-matte", 6);
    matte.layer = { enabled: false, blendMode: "normal", role: "content" };
    matte.transform = { ...matte.transform, scale: 0.72, x: -40, rotation: -4 };
    project.tracks.push({ id: "video-matte", name: "Track Matte", kind: "video", locked: false, muted: false, clips: [matte] });
    const adjustment = clip("adjustment", "video-adjustment", 0);
    adjustment.layer = { enabled: true, blendMode: "normal", role: "adjustment" };
    adjustment.color = { ...adjustment.color, contrast: 1.18, saturation: 0.82, hue: 6 };
    project.tracks.push({ id: "video-adjustment", name: "Adjustment", kind: "video", locked: false, muted: false, clips: [adjustment] });
    overlay.layer = { enabled: true, blendMode: "screen", role: "content", parentClipId: "background", trackMatte: { sourceClipId: "matte-source", mode: "luma" } };
    overlay.expressions = {
      x: "hao.expression/v1:value + sin(time * 4) * 34",
      rotation: "hao.expression/v1:value + sin(time * 2) * 2",
      opacity: "hao.expression/v1:clamp(value * (0.72 + sin(time * 3) * 0.18), 0, 1)",
    };
  }
  return project;
}

async function run(executable: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(stderr.slice(-6_000))));
  });
}

const digest = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");

await rm(evidenceRoot, { recursive: true, force: true });
await mkdir(evidenceRoot, { recursive: true });
const baselinePath = resolve(evidenceRoot, "baseline.mp4");
const enhancedPath = resolve(evidenceRoot, "layer-expression.mp4");
const options = { ffmpegPath: ffmpeg, ffprobePath: ffprobe, nativeCorePath: nativeCore, preferGpu: false, timeoutMs: 120_000 };
const baseline = await renderProject(fixture(false), baselinePath, options);
const enhanced = await renderProject(fixture(true), enhancedPath, options);
const cyclic = fixture(true);
cyclic.tracks[0].clips[0].layer = { ...cyclic.tracks[0].clips[0].layer!, parentClipId: "overlay" };
let cycleRejected = false;
try { validateProject(cyclic); } catch (error) { cycleRejected = String(error).includes("循環"); }
const frames = [];
for (const time of [0.5, 1.5, 2.5]) {
  const plain = resolve(evidenceRoot, `baseline-${time}.png`);
  const layered = resolve(evidenceRoot, `layered-${time}.png`);
  await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(time), "-i", baselinePath, "-frames:v", "1", plain]);
  await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(time), "-i", enhancedPath, "-frames:v", "1", layered]);
  const baselineSha256 = await digest(plain);
  const enhancedSha256 = await digest(layered);
  frames.push({ time, baselineSha256, enhancedSha256, different: baselineSha256 !== enhancedSha256 });
}
const probe = await probeMedia(enhancedPath, ffprobe);
const report = {
  status: probe.hasVideo && probe.hasAudio && frames.every((frame) => frame.different) && cycleRejected ? "GREEN" : "BLOCK",
  contract: "EditGraph layer blend, parenting, luma track matte, adjustment layer and hao.expression/v1 materially affect actual FFmpeg output",
  baseline, enhanced, probe, frames, negativeControl: { cycleRejected },
};
await writeFile(resolve(evidenceRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
if (report.status !== "GREEN") process.exitCode = 1;
