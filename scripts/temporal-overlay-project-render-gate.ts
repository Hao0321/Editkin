import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { PNG } from "pngjs";
import { createDemoProject } from "../src/domain/demo";
import { createTransformMotionBlurInstance } from "../src/domain/transformMotionBlur";
import type { EditProject, TimelineClip } from "../src/domain/types";
import { materializeNativeEffectSegments } from "../src/plugins/nativeEffectRender";
import { buildGpuEngineVideoPreviewGraph } from "../src/render/gpuCompositor";
import { buildRenderPlan } from "../src/render/planner";

const root = resolve(import.meta.dirname, "..");
const evidenceRoot = resolve(root, "../../.rd/benchmarks/editkin-temporal-overlay-project-render");
const reportPath = join(evidenceRoot, "report.json");
const selfTest = process.argv.includes("--self-test");
const positional = process.argv.find((value, index) => index > 1 && !value.startsWith("--"));
const compositor = resolve(positional ?? join(root, "native/bin/win32-x64/editkin-gpu-compositor.exe"));
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

function assertGreen(report: Record<string, any>) {
  if (report.schema !== "editkin.temporal-overlay-project-render-gate/v1" || report.status !== "GREEN") throw new Error("temporal-overlay project render is not GREEN");
  if (report.executionMode !== "resident-gpu-shader-sequence/v1" || report.frameCount !== 15 || report.losslessPixelDifferences !== 0) throw new Error("temporal-overlay intermediate was not lossless");
  if (report.motionContract !== "decoded-temporal-shutter-accumulation/v1" || report.compositeContract !== "decoded-temporal-video-overlay/v1" || report.compositeLayerCount !== 2) throw new Error("formal temporal-overlay contracts are incomplete");
  if (report.temporalFramesWithReceipt !== 15 || report.compositeFramesWithReceipt !== 15 || report.maximumDistinctDecodedTimestampCount < 2 || report.residentFrameRingSize < 8) throw new Error("formal temporal/composite receipts are incomplete");
  if (report.overlayChangedPixels < 500 || report.overlayHighDeltaPixels < 100 || report.firstFrameSha256 === report.lastFrameSha256) throw new Error("formal overlay or animation evidence is incomplete");
  if (!report.overlaySegmentSuppressed || !report.materializedClipReset || report.retainedAudioClipCount !== 2 || report.productPathCpuPixelCopies !== 0 || report.verificationReadback !== true) throw new Error("formal RenderPlan convergence is incomplete");
  if (report.partialCompositeFramesWithReceipt !== 9 || !report.partialOverlayTailPreserved) throw new Error("partial overlay timeline was not split and preserved");
  if (report.programCount !== 0 || report.rejectedNegativeControls?.length !== 3) throw new Error("formal fail-closed evidence is incomplete");
  for (const value of [report.executableSha256, report.stackSha256, report.intermediateSha256, report.firstFrameSha256, report.lastFrameSha256]) if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("formal identity is incomplete");
}

function syntheticSelfTest() {
  const report = { schema: "editkin.temporal-overlay-project-render-gate/v1", status: "GREEN", executionMode: "resident-gpu-shader-sequence/v1", frameCount: 15, losslessPixelDifferences: 0, motionContract: "decoded-temporal-shutter-accumulation/v1", compositeContract: "decoded-temporal-video-overlay/v1", compositeLayerCount: 2, temporalFramesWithReceipt: 15, compositeFramesWithReceipt: 15, maximumDistinctDecodedTimestampCount: 2, residentFrameRingSize: 8, overlayChangedPixels: 1000, overlayHighDeltaPixels: 500, overlaySegmentSuppressed: true, materializedClipReset: true, retainedAudioClipCount: 2, productPathCpuPixelCopies: 0, verificationReadback: true, partialCompositeFramesWithReceipt: 9, partialOverlayTailPreserved: true, programCount: 0, rejectedNegativeControls: ["missing-runtime", "temporal-second", "two-temporal"], executableSha256: "a".repeat(64), stackSha256: "b".repeat(64), intermediateSha256: "c".repeat(64), firstFrameSha256: "d".repeat(64), lastFrameSha256: "e".repeat(64) };
  assertGreen(report);
  let calibratedNegatives = 0;
  for (const candidate of [{ ...report, status: "BLOCK" }, { ...report, losslessPixelDifferences: 1 }, { ...report, compositeFramesWithReceipt: 14 }, { ...report, overlayChangedPixels: 0 }, { ...report, overlaySegmentSuppressed: false }]) {
    let rejected = false; try { assertGreen(candidate); } catch { rejected = true; calibratedNegatives += 1; }
    if (!rejected) throw new Error("temporal-overlay evaluator accepted a calibrated negative");
  }
  process.stdout.write(`${JSON.stringify({ status: "GREEN", evaluator: report.schema, calibratedNegatives })}\n`);
}

function projectWithTemporalOverlay(includeOverlay = true): EditProject {
  const project = createDemoProject(); project.width = 960; project.height = 540; project.fps = 30; project.captions = [];
  project.assets[0].uri = resolve(root, "public/demo-source.mp4"); project.assets[0].width = 960; project.assets[0].height = 540;
  const base = project.tracks[0].clips[0]; base.duration = .5; base.transform = { x: -180, y: 0, scale: .65, rotation: -6, opacity: 1 };
  base.keyframes = [{ id: "motion", time: 14 / 30, transform: { x: 180, y: 0, scale: .65, rotation: 6, opacity: 1 }, color: { ...base.color }, easing: "linear" }];
  const motion = createTransformMotionBlurInstance(); motion.parameters.shutter_angle = 360;
  base.creative = { effectPresetIds: [], nativeEffectInstances: [motion] };
  if (!includeOverlay) return project;
  const overlayAsset = { ...structuredClone(project.assets[0]), id: "asset-overlay" }; project.assets.push(overlayAsset);
  const overlay: TimelineClip = { ...structuredClone(base), id: "clip-overlay", trackId: "track-overlay", assetId: overlayAsset.id, sourceStart: .2, keyframes: [], transform: { x: 285, y: 145, scale: .32, rotation: 0, opacity: 1 }, creative: { effectPresetIds: [], nativeEffectInstances: [] } };
  project.tracks.push({ id: "track-overlay", name: "Overlay", kind: "video", locked: false, muted: false, clips: [overlay] });
  return project;
}

function projectWithPartialTemporalOverlay(): EditProject {
  const project = projectWithTemporalOverlay();
  const overlay = project.tracks.find((track) => track.id === "track-overlay")!.clips[0];
  overlay.timelineStart = .2; overlay.duration = .6;
  return project;
}

async function extractFrames(ffmpeg: string, input: string, outputDirectory: string) {
  await mkdir(outputDirectory, { recursive: true });
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", input, "-vsync", "0", "-start_number", "0", join(outputDirectory, "frame-%08d.png")], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = ""; child.stderr.on("data", (chunk) => { stderr += String(chunk); }); child.once("error", reject); child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(stderr)));
  });
}

function changedStats(left: Buffer, right: Buffer) {
  const a = PNG.sync.read(left); const b = PNG.sync.read(right); let changedPixels = 0; let highDeltaPixels = 0;
  for (let pixel = 0; pixel < a.width * a.height; pixel += 1) { let delta = 0; for (let channel = 0; channel < 4; channel += 1) delta += Math.abs(a.data[pixel * 4 + channel] - b.data[pixel * 4 + channel]); if (delta > 8) changedPixels += 1; if (delta > 32) highDeltaPixels += 1; }
  return { changedPixels, highDeltaPixels };
}

async function main() {
  if (selfTest) return syntheticSelfTest();
  const temporary = await mkdtemp(join(tmpdir(), "editkin-formal-temporal-overlay-"));
  try {
    const ffmpegPath = resolve(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
    const runtime = { ffmpegPath, nativeCorePath: resolve(root, "native/bin/win32-x64/hao-core.exe"), gpuCompositorPath: compositor, pluginRoots: [] as string[], workspace: join(temporary, "mixed"), timeoutMs: 120_000 };
    const project = projectWithTemporalOverlay(); const plan = buildRenderPlan(project, (uri) => uri);
    const receipt = await materializeNativeEffectSegments(project, plan, runtime); const clip = receipt?.clips[0];
    if (!clip?.gpu || clip.instances.length !== 1) throw new Error("formal temporal-overlay receipt missing");
    const worker = clip.instances[0].worker as { runtime?: string; compositeContract?: string };
    const intermediate = plan.videoLayers[0].segments.find((segment) => segment.kind === "clip"); if (!intermediate || intermediate.kind !== "clip") throw new Error("materialized temporal-overlay clip missing");
    const renderedDirectory = join(runtime.workspace, "clip-demo-0-gpu-temporal-overlay-frames");
    const extractedDirectory = join(temporary, "extracted"); await extractFrames(ffmpegPath, intermediate.assetPath, extractedDirectory);
    let losslessPixelDifferences = 0;
    for (let frame = 0; frame < clip.frameCount; frame += 1) { const name = `frame-${String(frame).padStart(8, "0")}.png`; const rendered = PNG.sync.read(await readFile(join(renderedDirectory, name))); const decoded = PNG.sync.read(await readFile(join(extractedDirectory, name))); for (let index = 0; index < rendered.data.length; index += 1) if (rendered.data[index] !== decoded.data[index]) losslessPixelDifferences += 1; }
    const controlProject = projectWithTemporalOverlay(false); const controlPlan = buildRenderPlan(controlProject, (uri) => uri);
    const controlRuntime = { ...runtime, workspace: join(temporary, "control") };
    await materializeNativeEffectSegments(controlProject, controlPlan, controlRuntime);
    const mixedFrame = await readFile(join(renderedDirectory, "frame-00000007.png")); const controlFrame = await readFile(join(controlRuntime.workspace, "clip-demo-0-gpu-frames/frame-00000007.png"));
    const overlayDelta = changedStats(controlFrame, mixedFrame);
    const partialProject = projectWithPartialTemporalOverlay(); const partialPlan = buildRenderPlan(partialProject, (uri) => uri);
    const partialRuntime = { ...runtime, workspace: join(temporary, "partial") };
    const partialReceipt = await materializeNativeEffectSegments(partialProject, partialPlan, partialRuntime);
    const partialOverlayLayer = partialPlan.videoLayers.find((layer) => layer.trackId === "track-overlay")!;
    const partialTail = partialOverlayLayer.segments.find((segment) => segment.kind === "clip" && Math.abs(segment.start - .5) <= 1e-6);
    const partialOverlayTailPreserved = partialTail?.kind === "clip" && Math.abs(partialTail.duration - .3) <= 1e-6
      && Math.abs(partialTail.clip.sourceStart - .5) <= 1e-6;
    const rejectedNegativeControls: string[] = [];
    try { await materializeNativeEffectSegments(projectWithTemporalOverlay(), buildRenderPlan(projectWithTemporalOverlay(), (uri) => uri), { ...runtime, gpuCompositorPath: undefined, workspace: join(temporary, "missing") }); } catch (error) { if (!/缺少 GPU compositor runtime/.test(String(error))) throw error; rejectedNegativeControls.push("missing-runtime"); }
    const temporalSecond = projectWithTemporalOverlay(); temporalSecond.tracks.reverse(); if (buildGpuEngineVideoPreviewGraph(temporalSecond, 0) === undefined) rejectedNegativeControls.push("temporal-second");
    const twoTemporal = projectWithTemporalOverlay(); twoTemporal.tracks.find((track) => track.id === "track-overlay")!.clips[0].creative = { effectPresetIds: [], nativeEffectInstances: [createTransformMotionBlurInstance()] }; if (buildGpuEngineVideoPreviewGraph(twoTemporal, 0) === undefined) rejectedNegativeControls.push("two-temporal");
    const overlayLayer = plan.videoLayers.find((layer) => layer.trackId === "track-overlay")!;
    const overlaySegmentSuppressed = overlayLayer.segments.some((segment) => segment.kind === "gap" && segment.start === 0 && segment.duration === .5)
      && !overlayLayer.segments.some((segment) => segment.kind === "clip" && segment.start < .5);
    const materializedClipReset = intermediate.clip.sourceStart === 0 && !intermediate.clip.keyframes.length && intermediate.clip.transform.x === 0 && intermediate.clip.creative?.nativeEffectInstances?.length === 0;
    const report = { schema: "editkin.temporal-overlay-project-render-gate/v1", measuredAt: new Date().toISOString(), status: "GREEN", executionMode: clip.executionMode, frameCount: clip.frameCount, losslessPixelDifferences, motionContract: worker.runtime, compositeContract: worker.compositeContract, compositeLayerCount: clip.gpu.composite?.layerCount, compositeExecutionMode: clip.gpu.composite?.executionMode, temporalFramesWithReceipt: clip.gpu.temporalSampling?.framesWithReceipt, compositeFramesWithReceipt: clip.gpu.composite?.framesWithReceipt, maximumDistinctDecodedTimestampCount: clip.gpu.temporalSampling?.maximumDistinctDecodedTimestampCount, residentFrameRingSize: clip.gpu.temporalSampling?.residentFrameRingSize, residentBytes: clip.gpu.temporalSampling?.residentBytes, ...overlayDelta, overlaySegmentSuppressed, materializedClipReset, retainedAudioClipCount: plan.audioClips.length, partialCompositeFramesWithReceipt: partialReceipt?.clips[0]?.gpu?.composite?.framesWithReceipt, partialOverlayTailPreserved, programCount: clip.gpu.programs.length, productPathCpuPixelCopies: clip.gpu.productPathCpuPixelCopies, verificationReadback: clip.gpu.verificationReadback, rejectedNegativeControls, executableSha256: clip.gpu.executableSha256, stackSha256: clip.gpu.stackSha256, intermediateSha256: clip.intermediateSha256, intermediateBytes: (await stat(intermediate.assetPath)).size, firstFrameSha256: clip.gpu.firstFrameSha256, lastFrameSha256: clip.gpu.lastFrameSha256, sourceSha256: sha256(await readFile(project.assets[0].uri)) };
    await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); assertGreen(report); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

await main();
