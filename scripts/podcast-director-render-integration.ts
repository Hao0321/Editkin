import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildPodcastDirectorCommand } from "../src/application/podcastDirector";
import { applyCommand } from "../src/domain/commands";
import { createEmptyProject } from "../src/domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type MotionTrack, type TimelineClip } from "../src/domain/types";
import { probeMedia, renderProject } from "../src/render/ffmpeg";

const appRoot = resolve(".");
const reportRoot = resolve(appRoot, "../../.rd/benchmarks/editkin-podcast-director-render");
const source = resolve(appRoot, "public/demo-source.mp4");
const ffmpeg = resolve(appRoot, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const ffprobe = resolve(appRoot, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const nativeCore = resolve(appRoot, "native/bin/win32-x64/hao-core.exe");

function baseProject(): { project: EditProject; clip: TimelineClip } {
  const project = createEmptyProject("Podcast Director Render", { id: "podcast-render", width: 640, height: 360, fps: 30 });
  project.editorialProfile = "podcast_on_camera";
  project.assets.push({ id: "source", name: "source", kind: "video", uri: source, duration: 12, width: 960, height: 540 });
  const clip: TimelineClip = { id: "source-clip", assetId: "source", trackId: "video-main", timelineStart: 0, sourceStart: 0, duration: 6, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] };
  project.tracks[0].clips.push(clip);
  return { project, clip };
}

function speaker(role: "host" | "guest", activeFrom: number, activeTo: number): MotionTrack {
  const rect = role === "host" ? { x: 0.08, y: 0.16, width: 0.28, height: 0.56 } : { x: 0.64, y: 0.16, width: 0.28, height: 0.56 };
  return { id: role, clipId: "source-clip", name: role, role, engine: "hao-core-rust-motion-track-0.2", analysisFps: 10, initialRect: rect, lostRatio: 0, createdAt: "2026-08-23T00:00:00.000Z",
    points: Array.from({ length: 60 }, (_, frame) => ({ frame, time: frame / 10, rect, confidence: 0.96, status: "tracked" as const, activity: frame / 10 >= activeFrom && frame / 10 < activeTo ? 0.09 : 0.003 })),
  };
}

function run(executable: string, args: string[]): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", rejectRun);
    child.on("exit", (code) => code === 0 ? resolveRun() : rejectRun(new Error(stderr.slice(-4_000))));
  });
}

async function digest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

await rm(reportRoot, { recursive: true, force: true });
await mkdir(reportRoot, { recursive: true });
const baseline = baseProject();
const directed = baseProject();
const host = speaker("host", 0, 2.5);
const guest = speaker("guest", 2.5, 5);
const built = buildPodcastDirectorCommand({ project: directed.project, clip: directed.clip, host, guest, cues: [{ start: 0, end: 5, text: "主持人與來賓的可編輯字幕" }], idFactory: (kind, index) => `${kind}-${index}` });
if (built.command.type !== "batch") throw new Error("podcast director did not return batch command");
const directedProject = applyCommand(directed.project, { type: "batch", commands: [{ type: "add_motion_track", track: host }, { type: "add_motion_track", track: guest }, ...built.command.commands] });
const options = { ffmpegPath: ffmpeg, ffprobePath: ffprobe, nativeCorePath: nativeCore, preferGpu: false, timeoutMs: 120_000 };
const baselinePath = resolve(reportRoot, "baseline.mp4");
const directedPath = resolve(reportRoot, "directed.mp4");
const [baselineResult, directedResult] = await Promise.all([renderProject(baseline.project, baselinePath, options), renderProject(directedProject, directedPath, options)]);
const baselineFrame = resolve(reportRoot, "baseline-split-window.png");
const directedFrame = resolve(reportRoot, "directed-split-window.png");
await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-ss", "5.5", "-i", baselinePath, "-frames:v", "1", baselineFrame]);
await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-ss", "5.5", "-i", directedPath, "-frames:v", "1", directedFrame]);
const [baselineSha256, directedSha256, probe] = await Promise.all([digest(baselineFrame), digest(directedFrame), probeMedia(directedPath, ffprobe)]);
const status = probe.hasVideo && probe.hasAudio && probe.width === 640 && probe.height === 360 && built.uncertainShots > 0 && baselineSha256 !== directedSha256 ? "GREEN" : "BLOCK";
const report = { schemaVersion: 1, status, engine: "editkin-podcast-visual-director-0.1", shots: built.shots, uncertainSplitShots: built.uncertainShots, previewRenderContract: "same EditGraph clip.layout", frameEvidence: { time: 5.5, baselineSha256, directedSha256, different: baselineSha256 !== directedSha256 }, probe, outputs: { baselineResult, directedResult } };
await writeFile(resolve(reportRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report));
if (status !== "GREEN") process.exitCode = 1;
