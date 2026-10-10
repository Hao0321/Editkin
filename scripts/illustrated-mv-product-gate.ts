import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { applyCommand } from "../src/domain/commands";
import { createEmptyProject, migrateProject, validateProject } from "../src/domain/editGraph";
import { projectSchema } from "../src/domain/schema";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../src/domain/types";
import { compileIllustratedMusicVideo } from "../src/application/illustratedMusicVideoCompiler";
import { assertAutopilotProjectTimelineBinding, AUTOPILOT_PLAN_SCHEMA, parseAutopilotPlan } from "../src/application/autopilotPlan";
import { createAutopilotV4Fixture } from "../src/application/autopilotPlanFixture";
import { probeMedia, renderProject } from "../src/render/ffmpeg";

const root = resolve(import.meta.dirname, "..");
const out = join(root, ".rd/benchmarks/jpop-mv-motion-20260928/illustrated-mv");
const assets = join(out, "assets");
const ffmpegPath = join(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const ffprobePath = join(root, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const exec = promisify(execFile);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const evidenceVideoPath = join(assets, "rooftop-evidence-bt709.mp4");
await exec(ffmpegPath, ["-y", "-v", "error", "-loop", "1", "-i", join(assets, "rooftop-640.png"),
  "-t", "8", "-r", "30", "-an", "-vf", "format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv",
  "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
  "-c:v", "libx264", "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709", "-crf", "20", evidenceVideoPath], { timeout: 60_000 });

async function frames(file: string): Promise<number> {
  const result = await exec(ffprobePath, ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames",
    "-of", "default=nw=1:nk=1", file], { timeout: 60_000 });
  return Number(result.stdout.trim());
}

let project = createEmptyProject("Original illustrated MV animation prototype", {
  id: "illustrated-mv-20260928", width: 640, height: 360, fps: 30,
});
const art = [
  { id: "night", filename: "rooftop-640.png", alphaMode: "opaque" as const },
  { id: "dawn", filename: "rooftop-dawn-640.png", alphaMode: "opaque" as const },
  { id: "pose-wide", filename: "character-wide-640.png", alphaMode: "straight" as const },
  { id: "pose-close", filename: "character-close-640.png", alphaMode: "straight" as const },
  { id: "pose-chorus", filename: "character-chorus-640.png", alphaMode: "straight" as const },
  { id: "comet", filename: "foreground-comet-640.png", alphaMode: "straight" as const },
];
for (const asset of art) {
  project = applyCommand(project, { type: "import_asset", asset: {
    id: asset.id, name: asset.filename, kind: "image", uri: join(assets, asset.filename),
    duration: 8, width: 640, height: 360, alphaMode: asset.alphaMode, color: { interpretation: "rec709" },
    provenance: "OpenAI imagegen original art, 2026-09-28, demo asset master retained", rightsBasis: "user-directed project prototype",
    distributionScope: "local-prototype", redistributable: false,
  } });
}
project = applyCommand(project, { type: "import_asset", asset: {
  id: "night-evidence-video", name: "Original rooftop illustration analysis video", kind: "video", uri: evidenceVideoPath,
  duration: 8, width: 640, height: 360, color: { interpretation: "rec709" },
  provenance: "BT.709 analysis derivative of original rooftop-640.png", rightsBasis: "user-directed project prototype",
  distributionScope: "local-prototype", redistributable: false,
} });
project = applyCommand(project, { type: "import_asset", asset: {
  id: "song", name: "Original demo instrumental", kind: "audio", uri: join(assets, "demo-original-instrumental.wav"), duration: 8,
  provenance: "Editkin deterministic original test composition", rightsBasis: "original local prototype",
  distributionScope: "local-prototype", redistributable: false,
} });
project = applyCommand(project, { type: "add_clip", clip: {
  id: "song-bed", assetId: "song", trackId: "audio-main", timelineStart: 0, sourceStart: 0, duration: 8, volume: 1,
  transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
} });
project = applyCommand(project, { type: "add_track", track: {
  id: "art-evidence", name: "原始插畫分析參考", kind: "video", locked: false, muted: true, clips: [],
} });
project = applyCommand(project, { type: "add_clip", clip: {
  id: "night-evidence", assetId: "night-evidence-video", trackId: "art-evidence", timelineStart: 0, sourceStart: 0, duration: 8,
  volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
} });
await writeFile(join(out, "source.editkin.json"), JSON.stringify(project));
const draft = compileIllustratedMusicVideo(project, {
  musicClipId: "song-bed", backgroundTrackId: "video-main", characterTrackId: "mv-character", silhouetteTrackId: "mv-silhouette",
  sections: [
    { id: "intro", start: 0, end: 2, role: "intro", framing: "wide", backgroundAssetId: "night", characterAssetId: "pose-wide", musicEvidenceRef: "demo-audio:bar-1", silhouetteRevealFrames: 12, backgroundEffect: "night_depth" },
    { id: "verse", start: 2, end: 4, role: "verse", framing: "close", backgroundAssetId: "night", characterAssetId: "pose-close", musicEvidenceRef: "demo-audio:bar-2",
      entryTransition: "character_slide_left", transitionEvidenceRefs: ["scene:intro:exit", "scene:verse:entry"] },
    { id: "chorus-a", start: 4, end: 6, role: "chorus", framing: "wide", backgroundAssetId: "dawn", characterAssetId: "pose-chorus", musicEvidenceRef: "demo-audio:bar-3", backgroundEffect: "dawn_bloom",
      silhouetteRevealFrames: 12, beatAccentFrames: [15, 30, 45], beatAccentEvidenceRefs: ["demo-audio:4.5", "demo-audio:5.0", "demo-audio:5.5"],
      foregroundAccent: { assetId: "comet", startFrame: 12, durationFrames: 18, evidenceRef: "demo-audio:4.5:flourish" } },
    { id: "chorus-b", start: 6, end: 8, role: "chorus", framing: "close", backgroundAssetId: "dawn", characterAssetId: "pose-close", musicEvidenceRef: "demo-audio:bar-4", backgroundEffect: "dawn_bloom",
      beatAccentFrames: [15, 30, 45], beatAccentEvidenceRefs: ["demo-audio:6.5", "demo-audio:7.0", "demo-audio:7.5"],
      entryTransition: "character_slide_left", transitionEvidenceRefs: ["scene:chorus-a:exit", "scene:chorus-b:entry"] },
  ],
  wordCues: [
    { id: "star", text: "星屑", start: .4, end: 1.6, kind: "title", placement: "right", evidenceRef: "demo-brief:motif:stars" },
    { id: "pulse", text: "瞬間", start: 2.3, end: 3.5, kind: "title", placement: "right", evidenceRef: "demo-brief:motif:pulse" },
    { id: "now", text: "今", start: 3.5, end: 3.9, kind: "title", placement: "right", evidenceRef: "demo-brief:motif:moment" },
    { id: "light", text: "夜明け", start: 4.3, end: 5.6, kind: "title", placement: "right", tone: "ink", evidenceRef: "demo-brief:motif:dawn" },
    { id: "spark", text: "SPARK", start: 6.3, end: 7.6, kind: "title", placement: "right", tone: "ink", treatment: "impact", evidenceRef: "demo-brief:motif:spark" },
  ],
});
assert.equal(draft.mutationPerformed, false);
const fixturePlan = createAutopilotV4Fixture();
const schemaPlan = parseAutopilotPlan({ ...fixturePlan, commands: [fixturePlan.commands[0], ...draft.commands],
  editorial: { ...fixturePlan.editorial, graphics: draft.editorialGraphics } });
assert.equal(schemaPlan.schema, AUTOPILOT_PLAN_SCHEMA);
assertAutopilotProjectTimelineBinding(schemaPlan, project.fps);
const sourceSnapshot = JSON.stringify(project);
const cloneSource = () => projectSchema.parse(JSON.parse(sourceSnapshot));
const commandSnapshot = JSON.stringify(draft.commands);
const cloneCommands = () => JSON.parse(commandSnapshot) as typeof draft.commands;
const baselineCommands = cloneCommands().filter(command => command.type !== "add_keyframe" && command.type !== "add_motion_graphic" && command.type !== "set_clip_creative");
const baseline = validateProject(migrateProject(projectSchema.parse(JSON.parse(JSON.stringify(applyCommand(cloneSource(), { type: "batch", commands: baselineCommands }))))));
const candidate = validateProject(migrateProject(projectSchema.parse(JSON.parse(JSON.stringify(applyCommand(cloneSource(), { type: "batch", commands: cloneCommands() }))))));
await writeFile(join(out, "candidate.editkin.json"), JSON.stringify(candidate));
await writeFile(join(out, "draft.json"), JSON.stringify(draft, null, 2));
const options = { ffmpegPath, ffprobePath, fontRoot: join(root, "public/fonts"), preferGpu: false, timeoutMs: 240_000 };
const baselineOutput = join(out, "baseline.mp4");
const candidateOutput = join(out, "candidate.mp4");
const diagnostic: Record<string, number> = {};
if (process.argv.includes("--diagnose-performance")) {
  for (const [name, keep] of [
    ["motion-only", (type: string) => type !== "add_motion_graphic"],
    ["type-only", (type: string) => type !== "add_keyframe" && type !== "set_clip_creative"],
  ] as const) {
    const commands = cloneCommands().filter(command => keep(command.type));
    const variant = validateProject(migrateProject(projectSchema.parse(JSON.parse(JSON.stringify(applyCommand(cloneSource(), { type: "batch", commands }))))));
    const started = performance.now();
    await renderProject(variant, join(out, `${name}.mp4`), options);
    diagnostic[name] = Number(((performance.now() - started) / 1000).toFixed(3));
  }
}
const baselineStart = performance.now();
const baselineRender = await renderProject(baseline, baselineOutput, options);
const baselineSeconds = (performance.now() - baselineStart) / 1000;
const candidateStart = performance.now();
const candidateRender = await renderProject(candidate, candidateOutput, options);
const candidateSeconds = (performance.now() - candidateStart) / 1000;
await exec(ffmpegPath, ["-v", "error", "-xerror", "-i", candidateOutput, "-f", "null", "-"], { timeout: 90_000 });
const count = await frames(candidateOutput);
const probe = await probeMedia(candidateOutput, ffprobePath);
assert.equal(count, 240);
assert.equal(probe.hasAudio, true);
assert.equal(probe.hasVideo, true);
const pcmPath = join(out, "decoded-audio.f32le");
await exec(ffmpegPath, ["-y", "-v", "error", "-xerror", "-i", candidateOutput, "-vn", "-ac", "1", "-ar", "24000", "-f", "f32le", pcmPath], { timeout: 60_000 });
const pcm = await readFile(pcmPath);
const sampleRate = 24_000;
const rms = (time: number): number => {
  const first = Math.round(time * sampleRate);
  const length = Math.round(.045 * sampleRate);
  let energy = 0;
  for (let index = first; index < first + length; index++) energy += pcm.readFloatLE(index * 4) ** 2;
  return Math.sqrt(energy / length);
};
const beatEnergy = Array.from({ length: 15 }, (_, index) => {
  const beat = .5 + index * .5;
  return { at: beat, onBeat: rms(beat + .015), betweenBeats: rms(beat + .17) };
});
const audibleBeatCount = beatEnergy.filter(item => item.onBeat > item.betweenBeats * 1.1).length;
assert.ok(audibleBeatCount >= 12, `Decoded soundtrack missed expected beat transients: ${audibleBeatCount}/15`);
const sceneCutFrames = draft.sections.map(section => Math.round(section.start * project.fps));
assert.deepEqual(sceneCutFrames, [0, 60, 120, 180]);
assert.ok(draft.sections.flatMap(section => section.beatAccentFrames ?? []).length === 6);
const report = {
  schema: "editkin.illustrated-mv-native-gate/v1", status: "TECHNICAL_RENDER_GREEN_ART_REVIEW_REQUIRED",
  fixture: "original generated anime character/background/transparent foreground, three poses, two scenes, short silhouette reveals, directional slides, original synthesized 8s instrumental, decorative title motifs; no user song or verified lyrics",
  baseline: { seconds: Number(baselineSeconds.toFixed(3)), planner: baselineRender.planner, sha256: sha(await readFile(baselineOutput)) },
  candidate: { seconds: Number(candidateSeconds.toFixed(3)), frames: count, planner: candidateRender.planner,
    sha256: sha(await readFile(candidateOutput)), sceneCount: 4, poseCount: 3, backgroundCount: 2,
    foregroundCount: 1, wordCount: 5 },
  renderRatio: Number((candidateSeconds / baselineSeconds).toFixed(3)), peakMemoryMB: null, previewLatencyMs: null,
  rhythm: { decodedSoundtrackBeatTransients: audibleBeatCount, expectedBeatTransients: 15,
    beatPeriodFrames: 15, sceneCutFrames, editableActorBeatAccents: 6 },
  diagnostic: Object.keys(diagnostic).length ? diagnostic : undefined,
  installedDesktopTested: false, v4SchemaBindingTested: true, v4AuditApplyTested: false,
  humanArtReview: "REVIEW_REQUIRED", mobileReview: "REVIEW_REQUIRED",
};
await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
