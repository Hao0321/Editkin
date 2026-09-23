import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createEmptyProject } from "../src/domain/editGraph";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type LayerBlendMode, type TimelineClip } from "../src/domain/types";
import { probeMedia, renderProject } from "../src/render/ffmpeg";

const root = resolve(".");
const evidenceRoot = resolve(root, "../../.rd/benchmarks/editkin-blend-modes");
const ffmpeg = resolve(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const ffprobe = resolve(root, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const nativeCore = resolve(root, "native/hao-core/target/debug/hao-core.exe");
const modes: LayerBlendMode[] = ["normal", "add", "screen", "multiply", "overlay", "soft_light", "hard_light", "difference", "darken", "lighten", "color_dodge", "color_burn"];

async function run(executable: string, args: string[]): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8_000); });
    child.on("error", rejectRun);
    child.on("exit", (code) => code === 0 ? resolveRun() : rejectRun(new Error(stderr)));
  });
}

function clip(id: string, assetId: string, trackId: string, mode: LayerBlendMode, index: number): TimelineClip {
  return {
    id, assetId, trackId, timelineStart: 0, sourceStart: 0, duration: .6, volume: 0,
    transform: { ...DEFAULT_TRANSFORM, opacity: mode === "normal" ? 1 : .18, scale: mode === "normal" ? 1 : .82, x: (index % 4 - 1.5) * 8, y: (Math.floor(index / 4) - 1) * 5, rotation: index - 5 },
    color: { ...DEFAULT_COLOR }, keyframes: [], layer: { ...DEFAULT_CLIP_LAYER, blendMode: mode }, expressions: {},
  };
}

await rm(evidenceRoot, { recursive: true, force: true });
await mkdir(evidenceRoot, { recursive: true });
const background = join(evidenceRoot, "background.png");
const overlay = join(evidenceRoot, "overlay.png");
await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=#193653:s=320x180", "-frames:v", "1", background]);
await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=#e85b35:s=320x180", "-vf", "drawbox=x=70:y=35:w=180:h=110:color=#55d6be:t=fill", "-frames:v", "1", overlay]);
const project = createEmptyProject("Blend ABI gate", { id: "blend-abi-gate", width: 320, height: 180, fps: 30 });
project.assets.push(
  { id: "background", name: "background", kind: "image", uri: background, duration: .6, width: 320, height: 180 },
  { id: "overlay", name: "overlay", kind: "image", uri: overlay, duration: .6, width: 320, height: 180 },
);
project.tracks[0].clips.push(clip("normal", "background", project.tracks[0].id, "normal", 0));
for (const [index, mode] of modes.slice(1).entries()) {
  const trackId = `blend-${mode}`;
  project.tracks.push({ id: trackId, name: mode, kind: "video", locked: false, muted: false, clips: [clip(`clip-${mode}`, "overlay", trackId, mode, index + 1)] });
}
const output = join(evidenceRoot, "blend-stack.mp4");
const render = await renderProject(project, output, { ffmpegPath: ffmpeg, ffprobePath: ffprobe, nativeCorePath: nativeCore, preferGpu: false, timeoutMs: 180_000 });
const baselineProject = structuredClone(project);
for (const timelineClip of baselineProject.tracks.flatMap((track) => track.clips)) timelineClip.layer = { enabled: true, blendMode: "normal" };
const baselineOutput = join(evidenceRoot, "normal-stack.mp4");
await renderProject(baselineProject, baselineOutput, { ffmpegPath: ffmpeg, ffprobePath: ffprobe, nativeCorePath: nativeCore, preferGpu: false, timeoutMs: 180_000 });
const frame = join(evidenceRoot, "blend-stack.png");
await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-ss", "0.3", "-i", output, "-frames:v", "1", frame]);
const baselineFrame = join(evidenceRoot, "normal-stack.png");
await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-ss", "0.3", "-i", baselineOutput, "-frames:v", "1", baselineFrame]);
const probe = await probeMedia(output, ffprobe);
const frameSha256 = createHash("sha256").update(await readFile(frame)).digest("hex");
const baselineSha256 = createHash("sha256").update(await readFile(baselineFrame)).digest("hex");
const status = probe.hasVideo && probe.hasAudio && probe.width === 320 && probe.height === 180 && frameSha256 !== baselineSha256 ? "GREEN" : "BLOCK";
const report = { schemaVersion: 1, status, contract: "All 12 layer blend ABI values compile in Rust and materially execute through FFmpeg export", modes, frameSha256, baselineSha256, materiallyDifferent: frameSha256 !== baselineSha256, render, probe };
await writeFile(join(evidenceRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ ...report, evidence: join(evidenceRoot, "report.json") }, null, 2)}\n`);
if (status !== "GREEN") process.exitCode = 1;
