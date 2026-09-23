import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createEmptyProject } from "../src/domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../src/domain/types";
import { renderProject } from "../src/render/ffmpeg";

const root = resolve("../../.rd/benchmarks/editkin-music-render");
const ffmpeg = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe");
const ffprobe = resolve("vendor/ffmpeg/win32-x64/ffprobe.exe");
const nativeCore = resolve("native/bin/win32-x64/hao-core.exe");

function run(executable: string, args: string[]): Promise<string> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.once("error", rejectRun);
    child.once("close", (code) => code === 0 ? resolveRun(output) : rejectRun(new Error(output)));
  });
}

function meanVolume(log: string): number {
  const match = log.match(/mean_volume:\s*(-?[\d.]+)\s*dB/i);
  if (!match) throw new Error("volumedetect 沒有 mean_volume");
  return Number(match[1]);
}

await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
const voiceVideo = resolve(root, "voice.mp4");
const music = resolve(root, "music.m4a");
const output = resolve(root, "ducked.mp4");
await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=#111827:s=320x180:r=30:d=4", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=2", "-filter_complex", "[1:a]apad=pad_dur=2[a]", "-map", "0:v", "-map", "[a]", "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", voiceVideo]);
await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=4", "-c:a", "aac", "-b:a", "128k", music]);
const project = createEmptyProject("Music ducking", { id: "music-ducking", width: 320, height: 180, fps: 30 });
project.assets.push(
  { id: "voice", name: "voice", kind: "video", uri: voiceVideo, duration: 4, width: 320, height: 180 },
  { id: "music", name: "music", kind: "audio", uri: music, duration: 4, role: "background-music", bpm: 100 },
);
project.tracks[0].clips.push({ id: "voice-clip", assetId: "voice", trackId: "video-main", timelineStart: 0, sourceStart: 0, duration: 4, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
project.tracks.push({ id: "music-track", name: "配樂", kind: "audio", locked: false, muted: false, clips: [{ id: "music-clip", assetId: "music", trackId: "music-track", timelineStart: 0, sourceStart: 0, duration: 4, volume: 0.5, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }] });
const rendered = await renderProject(project, output, { ffmpegPath: ffmpeg, ffprobePath: ffprobe, nativeCorePath: nativeCore, preferGpu: false, timeoutMs: 120_000 });
const duringVoice = meanVolume(await run(ffmpeg, ["-hide_banner", "-ss", "0.6", "-t", "0.8", "-i", output, "-vn", "-af", "lowpass=f=300,volumedetect", "-f", "null", "-"]));
const afterVoice = meanVolume(await run(ffmpeg, ["-hide_banner", "-ss", "2.6", "-t", "0.8", "-i", output, "-vn", "-af", "lowpass=f=300,volumedetect", "-f", "null", "-"]));
const duckingDb = afterVoice - duringVoice;
const report = { schemaVersion: 1, status: duckingDb >= 3 ? "GREEN" : "BLOCK", engine: "ffmpeg-sidechaincompress", duringVoiceDb: duringVoice, afterVoiceDb: afterVoice, duckingDb, rendered };
await writeFile(resolve(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report)}\n`);
if (report.status !== "GREEN") process.exitCode = 1;
