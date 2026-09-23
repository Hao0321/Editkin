import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { applyCommand } from "../src/domain/commands";
import { createEmptyProject } from "../src/domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type MediaAsset } from "../src/domain/types";
import { buildNativeAutopilotCommand, planNativeAutopilotCreative } from "../src/application/nativeAutopilot";
import { planSemanticAutoEdit } from "../src/application/semanticAutoEdit";
import { renderProject } from "../src/render/ffmpeg";
import { createMotionGraphic } from "../src/motion/composition";
import { findMotionGraphicPreset } from "../src/creative/motionGraphicPresets";

const root = resolve(".");
const reportParent = resolve(root, ".rd/native-autopilot-render-integration");
await mkdir(reportParent, { recursive: true });
const reportRoot = await mkdtemp(resolve(reportParent, "run-"));
const ffmpegPath = resolve(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const ffprobePath = resolve(root, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const nativeCorePath = resolve(root, "native/bin/win32-x64/hao-core.exe");
const sourcePath = resolve(root, "public/demo-source.mp4");

async function run(executable: string, args: string[]) {
  return new Promise<void>((resolveRun, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolveRun() : reject(new Error(stderr)));
  });
}

const digest = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");

const portrait = process.argv.includes("--portrait");
const customCaption = process.argv.includes("--custom-caption");
if (process.argv.includes("--motion-proof")) throw new Error("Automatic artwork was rejected. Use --manual-motion-proof only for isolated engine regression, not aesthetic acceptance.");
const motionProof = process.argv.includes("--manual-motion-proof");
let project = createEmptyProject("原生自動成片整合", { id: "native-autopilot-render", width: portrait ? 360 : 640, height: portrait ? 640 : 360, fps: 30 });
if (customCaption) project = applyCommand(project, { type: "set_caption_style", patch: { alignment: 8, marginV: 24, fontSize: 40 } });
const source: MediaAsset = { id: "source", name: "demo-source.mp4", kind: "video", uri: sourcePath, duration: 12, width: 960, height: 540 };
const clip = { id: "source-clip", assetId: source.id, trackId: "video-main", timelineStart: 0, sourceStart: 0, duration: 12, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] };
project = applyCommand(project, { type: "batch", commands: [{ type: "import_asset", asset: source }, { type: "add_clip", clip }] });
const cues = motionProof ? [
  { start: 0.2, end: 1, text: "關鍵結果" },
  { start: 7, end: 8, text: "完整方法示範" },
  { start: 10, end: 11.4, text: "最後收束重點" },
] : [
  { start: 0.2, end: 2.5, text: "第一秒就說清楚關鍵結果！" },
  { start: 3.2, end: 6.4, text: "這是完整方法與畫面示範" },
  { start: 8.2, end: 11.4, text: "最後收束重點並給下一步" },
];
const cuts = [{ time: 3, score: 72, frame: 90 }, { time: 8, score: 81, frame: 240 }];
const planned = planSemanticAutoEdit({ duration: 12, fps: 30, cues, cuts, targetRatio: 0.78 });
const semantic = motionProof ? { ...planned, keepRanges: [{start:0,end:12}], keptDuration:12 } : planned;
const creative = planNativeAutopilotCreative({ duration: 12, width: 960, height: 540, cues, cuts, video: true, policy: { format: "longform", ownership: "automatic" } });
const music: MediaAsset = { id: "music", name: "demo music", kind: "audio", uri: sourcePath, duration: 12, role: "background-music", bpm: creative.rhythm.targetBpm };
const tracking = {
  engine: "hao-core-rust-motion-track-integration", analysisFps: 15, width: 640, height: 360,
  points: [0, 30, 60].map((frame) => ({ frame, time: frame / 15, rect: { ...creative.tracking.initialRect, x: creative.tracking.initialRect.x + frame / 6000 }, confidence: 0.92, status: "tracked" as const })),
  lostRatio: 0.04, analyzedSeconds: 4, elapsedMs: 4, cacheHit: false,
};
const built = buildNativeAutopilotCommand({ project, clip, transcript: { cues }, semantic, creative, musicAsset: music, musicSelectionId: "integration-music", trackingResult: tracking, idFactory: (kind, index) => `integration-${kind}-${index}` });
project = applyCommand(project, built.command);
if (motionProof) project = applyCommand(project, {type:"add_motion_graphic",graphic:createMotionGraphic("manual-engine-control","title","關鍵結果",1.1,3,undefined,findMotionGraphicPreset("v2-word-cascade").seed)});
const outputPath = resolve(reportRoot, "native-autopilot.mp4");
const result = await renderProject(project, outputPath, { ffmpegPath, ffprobePath, nativeCorePath, preferGpu: false, timeoutMs: 180_000 });
if (motionProof) {
  const graphic = project.motionGraphics.find(g => g.schema === "hao.motion-composition/v2");
  if (!graphic) throw new Error("Motion proof requires an actual v2 event, not skipped coverage");
  for (const [name,offset] of [["motion-first",.2],["motion-middle",1.5],["motion-tail",2.7]] as const) {
    await run(ffmpegPath,["-y","-v","error","-ss",String(graphic.timelineStart+offset),"-i",outputPath,"-frames:v","1",resolve(reportRoot,`${name}.png`)]);
  }
  await writeFile(resolve(reportRoot,"project.json"),JSON.stringify(project));
}
const sourceFrame = resolve(reportRoot, "source.png");
const outputFrame = resolve(reportRoot, "output.png");
await run(ffmpegPath, ["-y", "-hide_banner", "-loglevel", "error", "-ss", "1", "-i", sourcePath, "-frames:v", "1", sourceFrame]);
await run(ffmpegPath, ["-y", "-hide_banner", "-loglevel", "error", "-ss", "1", "-i", outputPath, "-frames:v", "1", outputFrame]);
for (const [name, time] of [["first", 1], ["middle", 6], ["tail", 10.5], ["graphic-gap", 7.2]] as const) {
  await run(ffmpegPath, ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(time), "-i", outputPath, "-frames:v", "1", resolve(reportRoot, `${name}.png`)]);
}
const musicClips = project.tracks.find((track) => track.id === "audio-auto-music")?.clips ?? [];
const checks = {
  editableCaptions: project.captions.length > 0,
  captionDesign: project.captionStyle.color === "#FFFFFF" && project.captionStyle.backgroundColor === "#000000" && project.captionStyle.translationColor === "#FFFFFF",
  rhythmReceipt: project.director.markers.some((marker) => marker.note.includes("rhythm=") && marker.note.includes(`${creative.rhythm.targetBpm} BPM`)),
  musicAndDucking: musicClips.some((item) => item.volume === 0.12) && musicClips.some((item) => item.volume === 0.25),
  creativeSegments: project.tracks.find((track) => track.id === "video-main")?.clips.every((item) => !item.creative?.lookPresetId && !item.creative?.effectPresetIds?.length) === true,
  transitions: project.tracks.find((track) => track.id === "video-main")?.clips.every((item) => !item.creative?.transitionIn && !item.creative?.transitionOut) === true,
  rejectedAutoArtworkBlocked: project.motionGraphics.length === (motionProof ? 1 : 0)
    && project.director.markers.some(marker => marker.note.includes("title:blocked-pending-art-review") && marker.note.includes("card:blocked-pending-art-review")),
  subtitleSafety: project.motionGraphics.every(graphic => project.captions.every(caption =>
    graphic.timelineStart >= caption.start + caption.duration + 1 / project.fps
    || graphic.timelineStart + graphic.duration <= caption.start - 1 / project.fps)),
  nativeTracking: project.motionTracks.length === 0 && built.trackingStatus === "disabled-no-semantic-evidence",
  aestheticReviewPending: project.aestheticSystem?.review.status === "REVIEW" && project.aestheticSystem.review.score === 0,
  motionV2: !motionProof || project.motionGraphics.some(g => g.schema === "hao.motion-composition/v2" && g.presetId === "v2-word-cascade"),
  renderedDifference: await digest(sourceFrame) !== await digest(outputFrame),
  outputBytes: (await stat(outputPath)).size > 20_000,
};
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), status: Object.values(checks).every(Boolean) ? "GREEN" : "BLOCK", aestheticAcceptance: "REJECTED_PENDING_ART_REVIEW", motionScope: motionProof ? "MANUALLY_ADDED_ENGINE_CONTROL_ONLY" : "AUTO_ARTWORK_DISABLED", engine: creative.engine, rhythm: creative.rhythm, checks, project: { clips: project.tracks.flatMap((track) => track.clips).length, captions: project.captions.length, motionGraphics: project.motionGraphics.length, motionTracks: project.motionTracks.length, directorReceipts: project.director.markers.length }, render: result, outputPath };
await writeFile(resolve(reportRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
if (report.status !== "GREEN") process.exitCode = 1;
