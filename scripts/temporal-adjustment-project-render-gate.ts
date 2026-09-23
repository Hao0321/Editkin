import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PNG } from "pngjs";
import { createDemoProject } from "../src/domain/demo";
import { createTransformMotionBlurInstance } from "../src/domain/transformMotionBlur";
import type { EditProject } from "../src/domain/types";
import { materializeNativeEffectSegments, projectAfterNativeEffectMaterialization } from "../src/plugins/nativeEffectRender";
import { buildGpuEngineVideoPreviewGraph } from "../src/render/gpuCompositor";
import { buildRenderPlan } from "../src/render/planner";

const root = resolve(import.meta.dirname, "..");
const evidenceRoot = resolve(root, "../../.rd/benchmarks/editkin-temporal-adjustment-project-render");
const reportPath = join(evidenceRoot, "report.json");
const selfTest = process.argv.includes("--self-test");
const positional = process.argv.find((value, index) => index > 1 && !value.startsWith("--"));
const compositor = resolve(positional ?? join(root, "native/bin/win32-x64/editkin-gpu-compositor.exe"));
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

function assertGreen(report: Record<string, any>) {
  if (report.schema !== "editkin.temporal-adjustment-project-render-gate/v1" || report.status !== "GREEN") throw new Error("temporal adjustment project render is not GREEN");
  if (report.executionMode !== "resident-gpu-shader-sequence/v1" || report.frameCount !== 15 || report.losslessPixelDifferences !== 0) throw new Error("temporal adjustment intermediate was not lossless");
  if (report.motionContract !== "decoded-temporal-shutter-accumulation/v1" || report.adjustmentContract !== "decoded-temporal-trailing-adjustment/v1") throw new Error("formal temporal adjustment contracts are incomplete");
  if (report.temporalFramesWithReceipt !== 15 || report.maximumDistinctDecodedTimestampCount < 2 || report.residentFrameRingSize < 8) throw new Error("formal decoded temporal receipt is incomplete");
  if (report.adjustmentClipIds?.join() !== "adjustment-grade" || report.adjustmentNodeIds?.join() !== "color:adjustment-grade,adjustment:adjustment-grade") throw new Error("formal adjustment identity receipt is incomplete");
  if (report.adjustmentFramesWithReceipt !== 9 || report.adjustmentExecutionMode !== "trailing-full-frame/v1") throw new Error("formal adjustment timeline or pass receipt is incomplete");
  if (report.adjustmentChangedPixels < 1000 || report.adjustmentHighDeltaPixels < 500) throw new Error("formal adjustment artifact oracle is incomplete");
  if (!report.adjustmentPlanSuppressed || !report.adjustmentProjectSuppressed || !report.materializedClipReset || report.retainedAudioClipCount !== 1) throw new Error("formal adjustment materialization did not converge");
  if (report.productPathCpuPixelCopies !== 0 || report.verificationReadback !== true || report.programCount !== 0 || report.rejectedNegativeControls?.length !== 4) throw new Error("formal adjustment safety evidence is incomplete");
  for (const value of [report.executableSha256, report.stackSha256, report.intermediateSha256, report.firstFrameSha256, report.lastFrameSha256]) if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("formal adjustment identity is incomplete");
}

function syntheticSelfTest() {
  const report = {
    schema: "editkin.temporal-adjustment-project-render-gate/v1", status: "GREEN", executionMode: "resident-gpu-shader-sequence/v1",
    frameCount: 15, losslessPixelDifferences: 0, motionContract: "decoded-temporal-shutter-accumulation/v1", adjustmentContract: "decoded-temporal-trailing-adjustment/v1",
    temporalFramesWithReceipt: 15, maximumDistinctDecodedTimestampCount: 2, residentFrameRingSize: 8,
    adjustmentClipIds: ["adjustment-grade"], adjustmentNodeIds: ["color:adjustment-grade", "adjustment:adjustment-grade"],
    adjustmentFramesWithReceipt: 9, adjustmentExecutionMode: "trailing-full-frame/v1", adjustmentChangedPixels: 3000, adjustmentHighDeltaPixels: 2000,
    adjustmentPlanSuppressed: true, adjustmentProjectSuppressed: true, materializedClipReset: true, retainedAudioClipCount: 1,
    productPathCpuPixelCopies: 0, verificationReadback: true, programCount: 0,
    rejectedNegativeControls: ["missing-runtime", "outside-range", "stack", "targeted-fallback"],
    executableSha256: "a".repeat(64), stackSha256: "b".repeat(64), intermediateSha256: "c".repeat(64), firstFrameSha256: "d".repeat(64), lastFrameSha256: "e".repeat(64),
  };
  assertGreen(report); let calibratedNegatives = 0;
  for (const candidate of [{ ...report, status: "BLOCK" }, { ...report, losslessPixelDifferences: 1 }, { ...report, adjustmentFramesWithReceipt: 8 }, { ...report, adjustmentChangedPixels: 0 }, { ...report, adjustmentPlanSuppressed: false }, { ...report, productPathCpuPixelCopies: 1 }]) {
    let rejected = false; try { assertGreen(candidate); } catch { rejected = true; calibratedNegatives += 1; } if (!rejected) throw new Error("temporal adjustment evaluator accepted a calibrated negative");
  }
  process.stdout.write(`${JSON.stringify({ status: "GREEN", evaluator: report.schema, calibratedNegatives })}\n`);
}

function projectWithTemporalAdjustment(includeAdjustment = true): EditProject {
  const project = createDemoProject(); project.width = 960; project.height = 540; project.fps = 30; project.captions = []; project.motionGraphics = [];
  project.assets[0].uri = resolve(root, "public/demo-source.mp4"); project.assets[0].width = 960; project.assets[0].height = 540;
  const base = project.tracks[0].clips[0]; base.duration = .5; base.transform = { x: -180, y: 0, scale: .65, rotation: -6, opacity: 1 };
  base.keyframes = [{ id: "motion", time: 14 / 30, transform: { x: 180, y: 0, scale: .65, rotation: 6, opacity: 1 }, color: { ...base.color }, easing: "linear" }];
  const motion = createTransformMotionBlurInstance(); motion.parameters.shutter_angle = 360; base.creative = { effectPresetIds: [], nativeEffectInstances: [motion] };
  if (!includeAdjustment) return project;
  const adjustment = structuredClone(base); adjustment.id = "adjustment-grade"; adjustment.trackId = "track-adjustment";
  adjustment.timelineStart = 3 / 30; adjustment.duration = 9 / 30; adjustment.sourceStart = 0; adjustment.keyframes = [];
  adjustment.layer = { enabled: true, blendMode: "normal", role: "adjustment" };
  adjustment.color = { ...adjustment.color, brightness: .04, contrast: 1.15, saturation: .8, exposure: .35, temperature: .2, tint: -.1, shadows: .15, highlights: -.1, blacks: .08, whites: -.04 };
  adjustment.creative = { effectPresetIds: [], nativeEffectInstances: [] };
  project.tracks.push({ id: "track-adjustment", name: "Adjustment", kind: "video", locked: false, muted: false, clips: [adjustment] });
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
  const a = PNG.sync.read(left); const b = PNG.sync.read(right); let adjustmentChangedPixels = 0; let adjustmentHighDeltaPixels = 0;
  for (let pixel = 0; pixel < a.width * a.height; pixel += 1) { let delta = 0; for (let channel = 0; channel < 4; channel += 1) delta += Math.abs(a.data[pixel * 4 + channel] - b.data[pixel * 4 + channel]); if (delta > 8) adjustmentChangedPixels += 1; if (delta > 32) adjustmentHighDeltaPixels += 1; }
  return { adjustmentChangedPixels, adjustmentHighDeltaPixels };
}

async function main() {
  if (selfTest) return syntheticSelfTest();
  const temporary = await mkdtemp(join(tmpdir(), "editkin-formal-temporal-adjustment-"));
  try {
    const ffmpegPath = resolve(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
    const runtime = { ffmpegPath, nativeCorePath: resolve(root, "native/bin/win32-x64/hao-core.exe"), gpuCompositorPath: compositor, pluginRoots: [] as string[], workspace: join(temporary, "mixed"), timeoutMs: 120_000 };
    const project = projectWithTemporalAdjustment(); const plan = buildRenderPlan(project, (uri) => uri);
    const receipt = await materializeNativeEffectSegments(project, plan, runtime); const clip = receipt?.clips[0];
    if (!clip?.gpu || clip.instances.length !== 1 || !clip.gpu.adjustment) throw new Error("formal temporal adjustment receipt missing");
    const worker = clip.instances[0].worker as { runtime?: string; adjustmentContract?: string };
    const intermediate = plan.videoLayers[0].segments.find((segment) => segment.kind === "clip"); if (!intermediate || intermediate.kind !== "clip") throw new Error("materialized temporal adjustment clip missing");
    const renderedDirectory = join(runtime.workspace, "clip-demo-0-gpu-temporal-adjustment-frames");
    const extractedDirectory = join(temporary, "extracted"); await extractFrames(ffmpegPath, intermediate.assetPath, extractedDirectory);
    let losslessPixelDifferences = 0;
    for (let frame = 0; frame < clip.frameCount; frame += 1) { const name = `frame-${String(frame).padStart(8, "0")}.png`; const rendered = PNG.sync.read(await readFile(join(renderedDirectory, name))); const decoded = PNG.sync.read(await readFile(join(extractedDirectory, name))); for (let index = 0; index < rendered.data.length; index += 1) if (rendered.data[index] !== decoded.data[index]) losslessPixelDifferences += 1; }
    const controlProject = projectWithTemporalAdjustment(false); const controlPlan = buildRenderPlan(controlProject, (uri) => uri); const controlRuntime = { ...runtime, workspace: join(temporary, "control") };
    await materializeNativeEffectSegments(controlProject, controlPlan, controlRuntime);
    const adjustmentDelta = changedStats(await readFile(join(controlRuntime.workspace, "clip-demo-0-gpu-frames/frame-00000007.png")), await readFile(join(renderedDirectory, "frame-00000007.png")));
    const rejectedNegativeControls: string[] = [];
    try { await materializeNativeEffectSegments(projectWithTemporalAdjustment(), buildRenderPlan(projectWithTemporalAdjustment(), (uri) => uri), { ...runtime, gpuCompositorPath: undefined, workspace: join(temporary, "missing-runtime") }); } catch (error) { if (!/缺少 GPU compositor runtime/.test(String(error))) throw error; rejectedNegativeControls.push("missing-runtime"); }
    const outside = projectWithTemporalAdjustment(); const outsideClip = outside.tracks.at(-1)!.clips[0]; outsideClip.timelineStart = 12 / 30; outsideClip.duration = 6 / 30; if (buildGpuEngineVideoPreviewGraph(outside, 0) === undefined) rejectedNegativeControls.push("outside-range");
    const stacked = projectWithTemporalAdjustment(); const second = structuredClone(stacked.tracks.at(-1)!.clips[0]); second.id = "adjustment-two"; stacked.tracks.push({ id: "track-adjustment-two", name: "Adjustment 2", kind: "video", locked: false, muted: false, clips: [second] }); if (buildGpuEngineVideoPreviewGraph(stacked, 0) === undefined) rejectedNegativeControls.push("stack");
    const targeted = projectWithTemporalAdjustment(); const targetedPlan = buildRenderPlan(targeted, (uri) => uri); const targetedReceipt = await materializeNativeEffectSegments(targeted, targetedPlan, { ...runtime, workspace: join(temporary, "targeted"), targetClipIds: new Set(["clip-demo"]) });
    if (!targetedReceipt?.clips[0].gpu?.adjustment && targetedPlan.videoLayers.at(-1)?.segments.some((segment) => segment.kind === "clip" && segment.clip.id === "adjustment-grade")) rejectedNegativeControls.push("targeted-fallback");
    const adjustment = clip.gpu.adjustment; const materializedClipReset = intermediate.clip.sourceStart === 0 && !intermediate.clip.keyframes.length && intermediate.clip.transform.x === 0 && intermediate.clip.creative?.nativeEffectInstances?.length === 0;
    const adjustmentPlanSuppressed = plan.videoLayers.at(-1)?.segments.every((segment) => segment.kind === "gap") ?? false;
    const filteredProject = projectAfterNativeEffectMaterialization(project, receipt);
    const report = {
      schema: "editkin.temporal-adjustment-project-render-gate/v1", measuredAt: new Date().toISOString(), status: "GREEN", executionMode: clip.executionMode,
      frameCount: clip.frameCount, losslessPixelDifferences, motionContract: worker.runtime, adjustmentContract: worker.adjustmentContract,
      temporalFramesWithReceipt: clip.gpu.temporalSampling?.framesWithReceipt, maximumDistinctDecodedTimestampCount: clip.gpu.temporalSampling?.maximumDistinctDecodedTimestampCount,
      residentFrameRingSize: clip.gpu.temporalSampling?.residentFrameRingSize, residentBytes: clip.gpu.temporalSampling?.residentBytes,
      adjustmentClipIds: adjustment.adjustmentClipIds, adjustmentNodeIds: adjustment.nodeIdsByClip["adjustment-grade"], adjustmentFramesWithReceipt: adjustment.framesWithActiveAdjustments,
      adjustmentExecutionMode: adjustment.executionMode, ...adjustmentDelta, adjustmentPlanSuppressed,
      adjustmentProjectSuppressed: !filteredProject.tracks.some((track) => track.clips.some((candidate) => candidate.id === "adjustment-grade")),
      materializedClipReset, retainedAudioClipCount: plan.audioClips.length, programCount: clip.gpu.programs.length,
      productPathCpuPixelCopies: clip.gpu.productPathCpuPixelCopies, verificationReadback: clip.gpu.verificationReadback,
      rejectedNegativeControls, executableSha256: clip.gpu.executableSha256, stackSha256: clip.gpu.stackSha256, intermediateSha256: clip.intermediateSha256,
      intermediateBytes: (await stat(intermediate.assetPath)).size, firstFrameSha256: clip.gpu.firstFrameSha256, lastFrameSha256: clip.gpu.lastFrameSha256,
      sourceSha256: sha256(await readFile(project.assets[0].uri)),
    };
    await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); assertGreen(report); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

await main();
