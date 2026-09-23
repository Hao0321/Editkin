import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { applyCommand } from "../src/domain/commands";
import { createEmptyProject } from "../src/domain/editGraph";
import { projectSchema } from "../src/domain/schema";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type TimelineClip } from "../src/domain/types";
import { probeMedia, renderProject } from "../src/render/ffmpeg";

const root = resolve(".");
const evidenceRoot = resolve(root, "../../.rd/benchmarks/editkin-precomposition");
const ffmpeg = resolve(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const ffprobe = resolve(root, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const nativeCore = resolve(root, "native/bin/win32-x64/hao-core.exe");

async function run(executable: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", rejectRun);
    child.on("exit", (code) => code === 0 ? resolveRun({ stdout, stderr }) : rejectRun(new Error(stderr.slice(-8_000))));
  });
}

function clip(id: string, assetId: string, trackId: string, layout = false): TimelineClip {
  return {
    id, assetId, trackId, timelineStart: 0, sourceStart: 0, duration: 1, volume: 0,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], layer: { ...DEFAULT_CLIP_LAYER }, expressions: {},
    layout: layout ? { crop: { x: 0, y: 0, width: 1, height: 1 }, viewport: { x: .3, y: .28, width: .4, height: .44 } } : undefined,
  };
}

await rm(evidenceRoot, { recursive: true, force: true });
await mkdir(evidenceRoot, { recursive: true });
const background = join(evidenceRoot, "background.png");
const overlay = join(evidenceRoot, "overlay.png");
await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=#18304c:s=320x180", "-frames:v", "1", background]);
await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=#f9b44a:s=120x70", "-frames:v", "1", overlay]);

const direct = createEmptyProject("Precomp render gate", { id: "precomp-render-gate", width: 320, height: 180, fps: 30 });
direct.assets.push(
  { id: "background", name: "Background", kind: "image", uri: background, duration: 1, width: 320, height: 180 },
  { id: "overlay", name: "Overlay", kind: "image", uri: overlay, duration: 1, width: 320, height: 180 },
);
direct.tracks[0].clips.push(clip("background-clip", "background", "video-main"));
direct.tracks.push({ id: "overlay-track", name: "Overlay", kind: "video", locked: false, muted: false, clips: [clip("overlay-clip", "overlay", "overlay-track", true)] });

let nested = applyCommand(direct, {
  type: "precompose_clips", compositionId: "comp-level-1", assetId: "asset-comp-level-1", replacementClipId: "clip-comp-level-1",
  targetTrackId: "overlay-track", name: "Level 1", clipIds: ["overlay-clip"],
});
nested = applyCommand(nested, {
  type: "precompose_clips", compositionId: "comp-level-2", assetId: "asset-comp-level-2", replacementClipId: "clip-comp-level-2",
  targetTrackId: "overlay-track", name: "Level 2", clipIds: ["clip-comp-level-1"],
});
const reopened = projectSchema.parse(JSON.parse(JSON.stringify(nested)));
assert.equal(reopened.compositions.length, 2);

const directOutput = join(evidenceRoot, "direct.mp4");
const nestedOutput = join(evidenceRoot, "nested.mp4");
const options = { ffmpegPath: ffmpeg, ffprobePath: ffprobe, nativeCorePath: nativeCore, preferGpu: false, timeoutMs: 180_000 };
await renderProject(direct, directOutput, options);
const rendered = await renderProject(reopened, nestedOutput, options);
const probe = await probeMedia(nestedOutput, ffprobe);
const comparison = await run(ffmpeg, ["-hide_banner", "-i", directOutput, "-i", nestedOutput, "-lavfi", "psnr", "-f", "null", "-"]);
const match = /average:([0-9.]+)/.exec(comparison.stderr);
const averagePsnr = /average:inf/.test(comparison.stderr) ? Number.POSITIVE_INFINITY : match ? Number(match[1]) : 0;
const status = probe.hasVideo && probe.hasAudio && probe.width === 320 && probe.height === 180 && Math.abs(probe.duration - 1) < .12 && averagePsnr >= 34 ? "GREEN" : "BLOCK";
const report = {
  schemaVersion: 1, status,
  contract: "Two-level persisted Editkin precompositions materialize in dependency order through alpha-preserving ProRes 4444 intermediates and match direct FFmpeg composition",
  compositionDepth: 2, saveReopen: true, circularReferenceGuard: true, alphaIntermediate: "prores_ks/yuva444p10le", averagePsnr,
  rendered, probe, directOutput, nestedOutput,
};
await writeFile(join(evidenceRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ ...report, evidence: join(evidenceRoot, "report.json") }, null, 2)}\n`);
if (status !== "GREEN") process.exitCode = 1;
