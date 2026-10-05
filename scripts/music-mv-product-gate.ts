import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { applyCommand } from "../src/domain/commands";
import { createEmptyProject, migrateProject, validateProject } from "../src/domain/editGraph";
import { projectSchema } from "../src/domain/schema";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type TimelineClip } from "../src/domain/types";
import { compileMusicVideoDraft } from "../src/application/musicVideoDraftCompiler";
import { probeMedia, renderProject } from "../src/render/ffmpeg";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const useRealFootage = process.argv.includes("--real-footage");
const evidence = join(root, ".rd/benchmarks/jpop-mv-motion-20260928", useRealFootage ? "product-real-footage" : "product");
const ffmpegPath = join(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const ffprobePath = join(root, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const source = join(root, "public/demo-source.mp4");
const song = join(evidence, "synthetic-tone.wav");
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

async function videoFrames(path: string): Promise<number> {
  const { stdout } = await run(ffprobePath, ["-v", "error", "-select_streams", "v:0", "-count_frames",
    "-show_entries", "stream=nb_read_frames", "-of", "default=nw=1:nk=1", path], { timeout: 60_000 });
  return Number(stdout.trim());
}

async function decode(path: string): Promise<void> {
  await run(ffmpegPath, ["-v", "error", "-xerror", "-i", path, "-f", "null", "-"], { timeout: 90_000 });
}

await mkdir(evidence, { recursive: true });
await run(ffmpegPath, ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=6",
  "-af", "volume=0.15", "-ac", "2", song], { timeout: 30_000 });
const realAssets = useRealFootage
  ? (JSON.parse(await readFile(join(root, ".rd/benchmarks/personal-autocut-stable-20260923/pottery/project.editkin.json"), "utf8"))
    .assets as Array<{ kind: string; uri: string; duration: number; width: number; height: number; color?: { interpretation: "hlg" } }>).filter(asset => asset.kind === "video").slice(0, 3)
  : [];
if (useRealFootage) assert.equal(realAssets.length, 3);
let project = createEmptyProject("Music MV native technical fixture", { id: "jpop-mv-motion-gate",
  width: useRealFootage ? 360 : 640, height: useRealFootage ? 640 : 360, fps: 30 });
project = applyCommand(project, { type: "import_asset", asset: { id: "song", name: "Synthetic tone", kind: "audio", uri: song, duration: 6 } });
if (useRealFootage) {
  for (const [index, asset] of realAssets.entries()) {
    project = applyCommand(project, { type: "import_asset", asset: {
      id: `shots-${index}`, name: `Real footage ${index + 1}`, kind: "video", uri: asset.uri,
      duration: asset.duration, width: asset.width, height: asset.height, color: asset.color,
    } });
  }
} else {
  project = applyCommand(project, { type: "import_asset", asset: { id: "shots", name: "Demo footage", kind: "video", uri: source,
    duration: 12, width: 960, height: 540, color: { interpretation: "rec709" } } });
}
const songClip: TimelineClip = { id: "song-bed", assetId: "song", trackId: "audio-main", timelineStart: 0, sourceStart: 0,
  duration: 6, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], layer: { ...DEFAULT_CLIP_LAYER } };
project = applyCommand(project, { type: "add_clip", clip: songClip });
const compiled = compileMusicVideoDraft(project, {
  styleId: useRealFootage ? "paper_air" : "afterglow", musicClipId: "song-bed", targetTrackId: "video-main", beatTimes: [0, 2, 4, 6],
  candidates: [
    { shotId: "a", assetId: useRealFootage ? "shots-0" : "shots", sourceStart: 0, sourceEnd: 2, salience: .9, storyOrder: 1 },
    { shotId: "b", assetId: useRealFootage ? "shots-1" : "shots", sourceStart: useRealFootage ? 0 : 2, sourceEnd: useRealFootage ? 2 : 4, salience: .9, storyOrder: 2 },
    { shotId: "c", assetId: useRealFootage ? "shots-2" : "shots", sourceStart: useRealFootage ? 0 : 4, sourceEnd: useRealFootage ? 2 : 6, salience: .9, storyOrder: 3 },
  ],
  clipIds: ["mv-a", "mv-b", "mv-c"], cameraSafeShotIds: ["a"],
  lyricCues: [
    { id: "sample-1", text: "夜を越えて", start: .4, end: 1.6, evidenceRef: "synthetic-fixture:placeholder-1" },
    { id: "sample-2", text: "光のかけら", start: 2.3, end: 3.5, evidenceRef: "synthetic-fixture:placeholder-2" },
  ],
  transitionCues: [{ boundaryIndex: 1, fromShotId: "a", toShotId: "b", style: "soft",
    evidenceRefs: ["synthetic-fixture:shot-a", "synthetic-fixture:shot-b"] }],
});
assert.equal(compiled.mutationPerformed, false);
let baseline = applyCommand(project, { type: "batch", commands: compiled.commands.filter(command => command.type === "add_clip") });
let candidate = applyCommand(project, { type: "batch", commands: compiled.commands });
baseline = validateProject(migrateProject(projectSchema.parse(JSON.parse(JSON.stringify(baseline)))));
candidate = validateProject(migrateProject(projectSchema.parse(JSON.parse(JSON.stringify(candidate)))));
await writeFile(join(evidence, "candidate.editkin.json"), JSON.stringify(candidate));
const options = { ffmpegPath, ffprobePath, fontRoot: join(root, "public/fonts"), preferGpu: false, timeoutMs: 180_000 };
const baselineOutput = join(evidence, "baseline.mp4");
const candidateOutput = join(evidence, "candidate.mp4");
const beforeBaseline = performance.now();
const baselineRender = await renderProject(baseline, baselineOutput, options);
const baselineSeconds = (performance.now() - beforeBaseline) / 1000;
const beforeCandidate = performance.now();
const candidateRender = await renderProject(candidate, candidateOutput, options);
const candidateSeconds = (performance.now() - beforeCandidate) / 1000;
await Promise.all([decode(baselineOutput), decode(candidateOutput)]);
const [baselineFrames, candidateFrames, baselineProbe, candidateProbe] = await Promise.all([
  videoFrames(baselineOutput), videoFrames(candidateOutput),
  probeMedia(baselineOutput, ffprobePath), probeMedia(candidateOutput, ffprobePath),
]);
assert.equal(baselineFrames, 180);
assert.equal(candidateFrames, 180);
assert.equal(candidateProbe.hasAudio, true);
assert.equal(candidateProbe.hasVideo, true);
const report = {
  schema: "editkin.music-mv-native-product-gate/v1", status: "TECHNICAL_RENDER_GREEN_ART_REVIEW_REQUIRED",
  fixture: useRealFootage
    ? "synthetic tone, placeholder text, Hao's real pottery footage; not a real music video or lyric verification"
    : "synthetic tone, placeholder text, demo footage; not a real music video or lyric verification",
  baseline: { seconds: Number(baselineSeconds.toFixed(3)), frames: baselineFrames, planner: baselineRender.planner,
    sha256: sha(await readFile(baselineOutput)) },
  candidate: { seconds: Number(candidateSeconds.toFixed(3)), frames: candidateFrames, planner: candidateRender.planner,
    sha256: sha(await readFile(candidateOutput)), motionGraphics: candidate.motionGraphics.length,
    videoMuted: candidate.tracks.find(track => track.id === "video-main")!.clips.every(clip => clip.volume === 0) },
  renderRatio: Number((candidateSeconds / baselineSeconds).toFixed(3)),
  peakMemoryMB: null, previewLatencyMs: null, installedDesktopTested: false,
  humanArtReview: "REVIEW_REQUIRED", mobileReview: "REVIEW_REQUIRED",
};
await writeFile(join(evidence, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
