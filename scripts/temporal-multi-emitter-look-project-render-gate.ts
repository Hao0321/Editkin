import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PNG } from "pngjs";
import type { EditProject } from "../src/domain/types";
import { materializeNativeEffectSegments, projectAfterNativeEffectMaterialization } from "../src/plugins/nativeEffectRender";
import { buildGpuEngineVideoPreviewGraph } from "../src/render/gpuCompositor";
import { buildRenderPlan } from "../src/render/planner";
import {
  addParticleLook,
  addSecondAdjustment,
  addTwoKeyframeAnimatedOverlay,
  extractFrames,
  materializeCase,
  projectWithTemporalLook,
} from "./temporalLookProjectRenderBaselines";

const root = resolve(import.meta.dirname, "..");
const staticMode = process.argv.includes("--static");
const evidenceRoot = resolve(root, staticMode
  ? "../../.rd/benchmarks/editkin-temporal-static-multi-emitter-look-project-render"
  : "../../.rd/benchmarks/editkin-temporal-multi-emitter-look-project-render");
const baseline = process.argv.includes("--baseline");
const selfTest = process.argv.includes("--self-test");
const reportPath = join(evidenceRoot, baseline ? "baseline-report.json" : "report.json");
const compositor = resolve(root, "native/bin/win32-x64/editkin-gpu-compositor.exe");
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

function addSecondParticleEmitter(project: EditProject): EditProject {
  if (!project.particleSimulation) throw new Error("dual-emitter fixture requires particle simulation");
  project.particleSimulation.additionalEmitters = [{
    id: "cool-trail",
    timeline: { start: 6 / 30, duration: 5 / 30 },
    seed: 90210,
    ratePerSecond: 54,
    lifetimeSeconds: .72,
    maxParticles: 32,
    emitterPosition: [.32, .68],
    initialVelocity: [-34, -62],
    gravity: [0, 74],
    radiusPixels: 2.75,
    color: [.12, .68, 1, .88],
  }];
  return project;
}

function candidateProject(): EditProject {
  return addSecondParticleEmitter(addSecondAdjustment(addTwoKeyframeAnimatedOverlay(addParticleLook(projectWithTemporalLook({ overlay: true })))));
}

function staticCandidateProject(): EditProject {
  return addSecondParticleEmitter(addParticleLook(projectWithTemporalLook({ overlay: true })));
}

function pixelDifference(left: Buffer, right: Buffer): { changed: number; high: number } {
  const a = PNG.sync.read(left);
  const b = PNG.sync.read(right);
  if (a.width !== b.width || a.height !== b.height) throw new Error("pixel oracle dimensions differ");
  let changed = 0;
  let high = 0;
  for (let pixel = 0; pixel < a.width * a.height; pixel += 1) {
    let delta = 0;
    for (let channel = 0; channel < 4; channel += 1) delta += Math.abs(a.data[pixel * 4 + channel] - b.data[pixel * 4 + channel]);
    if (delta > 8) changed += 1;
    if (delta > 32) high += 1;
  }
  return { changed, high };
}

function assertGreen(report: Record<string, any>): void {
  if (report.schema !== "editkin.temporal-multi-emitter-look-project-render-gate/v1" || report.status !== "GREEN") throw new Error("multi-emitter look gate is not GREEN");
  if (report.executionMode !== "resident-gpu-shader-sequence/v1" || report.frameCount !== 15 || report.losslessPixelDifferences !== 0) throw new Error("multi-emitter lossless sequence is incomplete");
  if (report.combinedContract !== "decoded-temporal-resource-governed-look/v1"
    || report.particleContract !== "decoded-temporal-multi-particle-overlay/v1"
    || report.animationContract !== "decoded-temporal-video-overlay-transform-animation/v1"
    || report.adjustmentContract !== "decoded-temporal-pre-typography-multi-adjustment/v1") throw new Error("multi-emitter contracts are incomplete");
  if (report.emitterNodeIds?.join() !== "vfx:particles,vfx:particles:cool-trail" || report.particleTimelineRanges?.length !== 2
    || report.framesWithActiveParticles !== 7 || report.totalParticleEmitterPasses !== 11
    || report.minimumActiveEmitterCount !== 1 || report.maximumActiveEmitterCount !== 2 || report.particleCeiling !== 80) throw new Error("multi-emitter receipts are incomplete");
  if (report.adjustmentMinimumBaseLayerCount !== 2 || report.adjustmentMaximumBaseLayerCount !== 4
    || report.adjustmentFramesWithReceipt !== 9 || report.adjustmentTotalPasses !== 15) throw new Error("multi-emitter adjustment ordering is incomplete");
  if (report.secondEmitterChangedPixels < 100 || report.secondEmitterHighDeltaPixels < 50) throw new Error("second emitter is not visible in decoded pixels");
  if (report.temporalFramesWithReceipt !== 15 || report.compositeFramesWithReceipt !== 15 || report.animationKeyframeCount !== 2
    || report.singleColourCaptions !== true || report.productPathCpuPixelCopies !== 0 || report.verificationReadback !== true) throw new Error("multi-emitter temporal evidence is incomplete");
  if (!report.planSuppressed || !report.projectSuppressed || !report.sourceProjectImmutable || report.retainedAudioClipCount !== 2) throw new Error("multi-emitter materialization suppression is incomplete");
  if (report.rejectedNegativeControls?.join() !== "fifth-emitter,non-overlapping-overlay,overlay-effect,particle-budget,third-keyframe,third-adjustment") throw new Error("multi-emitter negative controls are incomplete");
  for (const identity of [report.executableSha256, report.intermediateSha256, report.firstFrameSha256, report.lastFrameSha256]) {
    if (!/^[a-f0-9]{64}$/.test(identity)) throw new Error("multi-emitter identity is incomplete");
  }
}

function syntheticSelfTest(): void {
  const report = {
    schema: "editkin.temporal-multi-emitter-look-project-render-gate/v1", status: "GREEN", executionMode: "resident-gpu-shader-sequence/v1",
    frameCount: 15, losslessPixelDifferences: 0,
    combinedContract: "decoded-temporal-resource-governed-look/v1",
    particleContract: "decoded-temporal-multi-particle-overlay/v1", animationContract: "decoded-temporal-video-overlay-transform-animation/v1",
    adjustmentContract: "decoded-temporal-pre-typography-multi-adjustment/v1", emitterNodeIds: ["vfx:particles", "vfx:particles:cool-trail"],
    particleTimelineRanges: [{}, {}], framesWithActiveParticles: 7, totalParticleEmitterPasses: 11, minimumActiveEmitterCount: 1,
    maximumActiveEmitterCount: 2, particleCeiling: 80, adjustmentMinimumBaseLayerCount: 2, adjustmentMaximumBaseLayerCount: 4,
    adjustmentFramesWithReceipt: 9, adjustmentTotalPasses: 15, secondEmitterChangedPixels: 1800, secondEmitterHighDeltaPixels: 900,
    temporalFramesWithReceipt: 15, compositeFramesWithReceipt: 15, animationKeyframeCount: 2, singleColourCaptions: true,
    productPathCpuPixelCopies: 0, verificationReadback: true, planSuppressed: true, projectSuppressed: true, sourceProjectImmutable: true,
    retainedAudioClipCount: 2, rejectedNegativeControls: ["fifth-emitter", "non-overlapping-overlay", "overlay-effect", "particle-budget", "third-keyframe", "third-adjustment"],
    executableSha256: "a".repeat(64), intermediateSha256: "b".repeat(64), firstFrameSha256: "c".repeat(64), lastFrameSha256: "d".repeat(64),
  };
  assertGreen(report);
  let calibratedNegatives = 0;
  for (const candidate of [
    { ...report, status: "BLOCK" }, { ...report, losslessPixelDifferences: 1 }, { ...report, emitterNodeIds: ["vfx:particles"] },
    { ...report, totalParticleEmitterPasses: 10 }, { ...report, maximumActiveEmitterCount: 1 }, { ...report, adjustmentMaximumBaseLayerCount: 3 },
    { ...report, secondEmitterChangedPixels: 0 }, { ...report, singleColourCaptions: false }, { ...report, projectSuppressed: false },
    { ...report, rejectedNegativeControls: report.rejectedNegativeControls.slice(0, -1) },
  ]) {
    let rejected = false;
    try { assertGreen(candidate); } catch { rejected = true; calibratedNegatives += 1; }
    if (!rejected) throw new Error("multi-emitter evaluator accepted a calibrated negative");
  }
  process.stdout.write(`${JSON.stringify({ status: "GREEN", evaluator: report.schema, calibratedNegatives })}\n`);
}

function assertStaticGreen(report: Record<string, any>): void {
  if (report.schema !== "editkin.temporal-static-multi-emitter-look-project-render-gate/v1" || report.status !== "GREEN") throw new Error("static multi-emitter look gate is not GREEN");
  if (report.executionMode !== "resident-gpu-shader-sequence/v1" || report.frameCount !== 15 || report.losslessPixelDifferences !== 0) throw new Error("static multi-emitter lossless sequence is incomplete");
  if (report.combinedContract !== "decoded-temporal-resource-governed-look/v1"
    || report.particleContract !== "decoded-temporal-multi-particle-overlay/v1"
    || report.compositeContract !== "decoded-temporal-video-overlay/v1"
    || report.adjustmentContract !== "decoded-temporal-pre-typography-adjustment/v1"
    || report.animationContract !== undefined) throw new Error("static multi-emitter contracts are incomplete");
  if (report.emitterNodeIds?.join() !== "vfx:particles,vfx:particles:cool-trail" || report.particleTimelineRanges?.length !== 2
    || report.framesWithActiveParticles !== 7 || report.totalParticleEmitterPasses !== 11
    || report.minimumActiveEmitterCount !== 1 || report.maximumActiveEmitterCount !== 2 || report.particleCeiling !== 80) throw new Error("static multi-emitter receipts are incomplete");
  if (report.adjustmentMinimumBaseLayerCount !== 2 || report.adjustmentMaximumBaseLayerCount !== 4
    || report.adjustmentFramesWithReceipt !== 9 || report.adjustmentTotalPasses !== 9) throw new Error("static multi-emitter adjustment ordering is incomplete");
  if (report.secondEmitterChangedPixels < 100 || report.secondEmitterHighDeltaPixels < 50) throw new Error("static second emitter is not visible in decoded pixels");
  if (report.temporalFramesWithReceipt !== 15 || report.compositeFramesWithReceipt !== 15 || report.overlayKeyframeCount !== 0
    || report.singleColourCaptions !== true || report.productPathCpuPixelCopies !== 0 || report.verificationReadback !== true) throw new Error("static multi-emitter temporal evidence is incomplete");
  if (!report.planSuppressed || !report.projectSuppressed || !report.sourceProjectImmutable || report.retainedAudioClipCount !== 2) throw new Error("static multi-emitter materialization suppression is incomplete");
  if (report.rejectedNegativeControls?.join() !== "fifth-emitter,non-overlapping-overlay,third-adjustment,third-keyframe,particle-budget,overlay-effect") throw new Error("static multi-emitter negative controls are incomplete");
  for (const identity of [report.executableSha256, report.intermediateSha256, report.firstFrameSha256, report.lastFrameSha256]) {
    if (!/^[a-f0-9]{64}$/.test(identity)) throw new Error("static multi-emitter identity is incomplete");
  }
}

function syntheticStaticSelfTest(): void {
  const report = {
    schema: "editkin.temporal-static-multi-emitter-look-project-render-gate/v1", status: "GREEN", executionMode: "resident-gpu-shader-sequence/v1",
    frameCount: 15, losslessPixelDifferences: 0,
    combinedContract: "decoded-temporal-resource-governed-look/v1",
    particleContract: "decoded-temporal-multi-particle-overlay/v1", compositeContract: "decoded-temporal-video-overlay/v1",
    adjustmentContract: "decoded-temporal-pre-typography-adjustment/v1", animationContract: undefined,
    emitterNodeIds: ["vfx:particles", "vfx:particles:cool-trail"], particleTimelineRanges: [{}, {}], framesWithActiveParticles: 7,
    totalParticleEmitterPasses: 11, minimumActiveEmitterCount: 1, maximumActiveEmitterCount: 2, particleCeiling: 80,
    adjustmentMinimumBaseLayerCount: 2, adjustmentMaximumBaseLayerCount: 4, adjustmentFramesWithReceipt: 9,
    adjustmentTotalPasses: 9, secondEmitterChangedPixels: 1800, secondEmitterHighDeltaPixels: 900,
    temporalFramesWithReceipt: 15, compositeFramesWithReceipt: 15, overlayKeyframeCount: 0, singleColourCaptions: true,
    productPathCpuPixelCopies: 0, verificationReadback: true, planSuppressed: true, projectSuppressed: true,
    sourceProjectImmutable: true, retainedAudioClipCount: 2,
    rejectedNegativeControls: ["fifth-emitter", "non-overlapping-overlay", "third-adjustment", "third-keyframe", "particle-budget", "overlay-effect"],
    executableSha256: "a".repeat(64), intermediateSha256: "b".repeat(64), firstFrameSha256: "c".repeat(64), lastFrameSha256: "d".repeat(64),
  };
  assertStaticGreen(report);
  let calibratedNegatives = 0;
  for (const candidate of [
    { ...report, status: "BLOCK" }, { ...report, losslessPixelDifferences: 1 }, { ...report, emitterNodeIds: ["vfx:particles"] },
    { ...report, totalParticleEmitterPasses: 10 }, { ...report, adjustmentTotalPasses: 18 }, { ...report, animationContract: "unexpected" },
    { ...report, secondEmitterChangedPixels: 0 }, { ...report, singleColourCaptions: false }, { ...report, projectSuppressed: false },
    { ...report, rejectedNegativeControls: report.rejectedNegativeControls.slice(0, -1) },
  ]) {
    let rejected = false;
    try { assertStaticGreen(candidate); } catch { rejected = true; calibratedNegatives += 1; }
    if (!rejected) throw new Error("static multi-emitter evaluator accepted a calibrated negative");
  }
  process.stdout.write(`${JSON.stringify({ status: "GREEN", evaluator: report.schema, calibratedNegatives })}\n`);
}

async function runStaticBaseline(temporary: string, runtimeBase: any): Promise<void> {
  const project = staticCandidateProject();
  const snapshot = JSON.stringify(project);
  const plan = buildRenderPlan(project, (uri) => uri);
  const graph = buildGpuEngineVideoPreviewGraph(project, 0)?.graph;
  let receipt: Awaited<ReturnType<typeof materializeNativeEffectSegments>>;
  let rejection = "";
  try { receipt = await materializeNativeEffectSegments(project, plan, { ...runtimeBase, workspace: join(temporary, "static-baseline") }); }
  catch (error) { rejection = String(error); }
  const worker = receipt?.clips[0]?.instances[0]?.worker as { lookContract?: string; particleContract?: string } | undefined;
  const report = {
    schema: "editkin.temporal-static-multi-emitter-look-project-render-baseline/v1", measuredAt: new Date().toISOString(), status: "BLOCK",
    expectedContract: "decoded-temporal-video-overlay-multi-particle-typography-adjustment/v1",
    graphBuilt: Boolean(graph), combinedReceipt: worker?.lookContract === "decoded-temporal-video-overlay-multi-particle-typography-adjustment/v1",
    particleReceipt: worker?.particleContract === "decoded-temporal-multi-particle-overlay/v1",
    planStillActive: plan.captions.length > 0 && plan.videoLayers.some((layer) => layer.segments.some((segment) => segment.kind === "clip" && ["clip-overlay", "adjustment-grade"].includes(segment.clip.id))),
    particleProjectStillActive: projectAfterNativeEffectMaterialization(project, receipt).particleSimulation?.additionalEmitters?.length === 1,
    sourceProjectImmutable: JSON.stringify(project) === snapshot, rejection, compositorSha256: sha256(await readFile(compositor)),
  };
  if (report.graphBuilt || report.combinedReceipt || report.particleReceipt || !report.planStillActive || !report.particleProjectStillActive || !report.sourceProjectImmutable) {
    throw new Error(`static multi-emitter RED baseline did not expose the product gap: ${JSON.stringify(report)}`);
  }
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function runStaticGate(temporary: string, runtimeBase: any): Promise<void> {
  const project = staticCandidateProject();
  const sourceSnapshot = JSON.stringify(project);
  const dualWorkspace = join(temporary, "static-dual");
  const dual = await materializeCase(project, dualWorkspace, runtimeBase);
  const singleProject = structuredClone(project); singleProject.particleSimulation!.additionalEmitters = [];
  const single = await materializeCase(singleProject, join(temporary, "static-single"), runtimeBase);
  const extracted = join(temporary, "static-extracted");
  await extractFrames(runtimeBase.ffmpegPath, dual.intermediate.assetPath, extracted);
  let losslessPixelDifferences = 0;
  for (let frame = 0; frame < dual.clip.frameCount; frame += 1) {
    const name = `frame-${String(frame).padStart(8, "0")}.png`;
    const [resident, decoded] = await Promise.all([readFile(join(dualWorkspace, "clip-demo-0-gpu-temporal-look-frames", name)), readFile(join(extracted, name))]);
    losslessPixelDifferences += pixelDifference(resident, decoded).changed;
  }
  const comparisonFrame = "frame-00000007.png";
  const secondEmitterDelta = pixelDifference(
    await readFile(join(dualWorkspace, "clip-demo-0-gpu-temporal-look-frames", comparisonFrame)),
    await readFile(join(temporary, "static-single", "clip-demo-0-gpu-temporal-look-frames", comparisonFrame)),
  );
  const worker = dual.clip.instances[0].worker as Record<string, any>;
  const gpu = dual.clip.gpu!;
  const filtered = projectAfterNativeEffectMaterialization(project, dual.receipt);
  const rejectedNegativeControls: string[] = [];
  const rejectGraph = (name: string, candidate: EditProject) => { if (buildGpuEngineVideoPreviewGraph(candidate, 0) === undefined) rejectedNegativeControls.push(name); };
  const fifthEmitter = staticCandidateProject(); const emitterTemplate = fifthEmitter.particleSimulation!.additionalEmitters![0]; fifthEmitter.particleSimulation!.additionalEmitters!.push(
    { ...structuredClone(emitterTemplate), id: "third", seed: 90211 }, { ...structuredClone(emitterTemplate), id: "fourth", seed: 90212 }, { ...structuredClone(emitterTemplate), id: "fifth", seed: 90213 },
  ); rejectGraph("fifth-emitter", fifthEmitter);
  const nonOverlapping = staticCandidateProject(); const outside = nonOverlapping.tracks.find((track) => track.id === "track-overlay")!.clips[0]; outside.timelineStart = .6; outside.duration = .5; rejectGraph("non-overlapping-overlay", nonOverlapping);
  const thirdAdjustment = addSecondAdjustment(staticCandidateProject()); const finish = thirdAdjustment.tracks.find((track) => track.id === "track-adjustment-finish")!.clips[0]; const third = { ...structuredClone(finish), id: "adjustment-third", trackId: "track-adjustment-third" }; thirdAdjustment.tracks.push({ id: third.trackId, name: "Adjustment 3", kind: "video", locked: false, muted: false, clips: [third] }); rejectGraph("third-adjustment", thirdAdjustment);
  const thirdKeyframe = addTwoKeyframeAnimatedOverlay(staticCandidateProject()); const animated = thirdKeyframe.tracks.find((track) => track.id === "track-overlay")!.clips[0]; animated.keyframes.push({ ...structuredClone(animated.keyframes[1]), id: "third-key", time: 14 / 30 }); rejectGraph("third-keyframe", thirdKeyframe);
  const overBudget = staticCandidateProject(); overBudget.particleSimulation!.additionalEmitters![0].maxParticles = 160; rejectGraph("particle-budget", overBudget);
  const overlayEffect = staticCandidateProject(); overlayEffect.tracks.find((track) => track.id === "track-overlay")!.clips[0].creative!.effectPresetIds = ["unsafe-effect"]; rejectGraph("overlay-effect", overlayEffect);
  const report = {
    schema: "editkin.temporal-static-multi-emitter-look-project-render-gate/v1", measuredAt: new Date().toISOString(), status: "GREEN",
    executionMode: dual.clip.executionMode, frameCount: dual.clip.frameCount, losslessPixelDifferences,
    combinedContract: worker.lookContract, particleContract: worker.particleContract, compositeContract: worker.compositeContract,
    adjustmentContract: worker.adjustmentContract, animationContract: worker.overlayAnimationContract,
    emitterNodeIds: gpu.particle?.emitterNodeIds, particleTimelineRanges: gpu.particle?.timelineRanges,
    framesWithActiveParticles: gpu.particle?.framesWithActiveParticles, totalParticleEmitterPasses: gpu.particle?.totalParticleEmitterPasses,
    minimumActiveEmitterCount: gpu.particle?.minimumActiveEmitterCount, maximumActiveEmitterCount: gpu.particle?.maximumActiveEmitterCount,
    particleCeiling: gpu.particle?.particleCeiling, adjustmentMinimumBaseLayerCount: gpu.adjustment?.minimumBaseLayerCount,
    adjustmentMaximumBaseLayerCount: gpu.adjustment?.maximumBaseLayerCount, adjustmentFramesWithReceipt: gpu.adjustment?.framesWithActiveAdjustments,
    adjustmentTotalPasses: gpu.adjustment?.totalAdjustmentPasses, secondEmitterChangedPixels: secondEmitterDelta.changed,
    secondEmitterHighDeltaPixels: secondEmitterDelta.high, temporalFramesWithReceipt: gpu.temporalSampling?.framesWithReceipt,
    compositeFramesWithReceipt: gpu.composite?.framesWithReceipt, overlayKeyframeCount: worker.overlayAnimationKeyframeCounts?.["clip-overlay"] ?? 0,
    singleColourCaptions: gpu.typography?.singleColourCaptions, productPathCpuPixelCopies: gpu.productPathCpuPixelCopies,
    verificationReadback: gpu.verificationReadback,
    planSuppressed: dual.plan.captions.length === 0 && !dual.plan.videoLayers.some((layer) => layer.segments.some((segment) => segment.kind === "clip" && ["clip-overlay", "adjustment-grade"].includes(segment.clip.id))),
    projectSuppressed: filtered.particleSimulation === undefined && filtered.captions.length === 0 && filtered.motionGraphics.length === 0 && !filtered.tracks.some((track) => track.clips.some((clip) => ["clip-overlay", "adjustment-grade"].includes(clip.id))),
    sourceProjectImmutable: JSON.stringify(project) === sourceSnapshot, retainedAudioClipCount: dual.plan.audioClips.length,
    rejectedNegativeControls, executableSha256: gpu.executableSha256, intermediateSha256: dual.clip.intermediateSha256,
    firstFrameSha256: gpu.firstFrameSha256, lastFrameSha256: gpu.lastFrameSha256, singleEmitterReferenceSha256: single.clip.intermediateSha256,
  };
  assertStaticGreen(report);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function runBaseline(temporary: string, runtimeBase: any): Promise<void> {
  const project = candidateProject();
  const snapshot = JSON.stringify(project);
  const plan = buildRenderPlan(project, (uri) => uri);
  const graph = buildGpuEngineVideoPreviewGraph(project, 0)?.graph;
  let receipt: Awaited<ReturnType<typeof materializeNativeEffectSegments>>;
  let rejection = "";
  try { receipt = await materializeNativeEffectSegments(project, plan, { ...runtimeBase, workspace: join(temporary, "baseline") }); }
  catch (error) { rejection = String(error); }
  const worker = receipt?.clips[0]?.instances[0]?.worker as { lookContract?: string; particleContract?: string } | undefined;
  const report = {
    schema: "editkin.temporal-multi-emitter-look-project-render-baseline/v1", measuredAt: new Date().toISOString(), status: "BLOCK",
    expectedContract: "decoded-temporal-animated-video-overlay-multi-particle-typography-multi-adjustment/v1",
    graphBuilt: Boolean(graph), combinedReceipt: worker?.lookContract === "decoded-temporal-animated-video-overlay-multi-particle-typography-multi-adjustment/v1",
    particleReceipt: worker?.particleContract === "decoded-temporal-multi-particle-overlay/v1",
    planStillActive: plan.captions.length > 0 && plan.videoLayers.some((layer) => layer.segments.some((segment) => segment.kind === "clip" && ["clip-overlay", "adjustment-grade", "adjustment-finish"].includes(segment.clip.id))),
    particleProjectStillActive: projectAfterNativeEffectMaterialization(project, receipt).particleSimulation?.additionalEmitters?.length === 1,
    sourceProjectImmutable: JSON.stringify(project) === snapshot, rejection, compositorSha256: sha256(await readFile(compositor)),
  };
  if (report.graphBuilt || report.combinedReceipt || report.particleReceipt || !report.planStillActive || !report.particleProjectStillActive || !report.sourceProjectImmutable) {
    throw new Error(`multi-emitter RED baseline did not expose the product gap: ${JSON.stringify(report)}`);
  }
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function main(): Promise<void> {
  if (selfTest) return staticMode ? syntheticStaticSelfTest() : syntheticSelfTest();
  const temporary = await mkdtemp(join(tmpdir(), "editkin-temporal-multi-emitter-"));
  try {
    const runtimeBase = {
      ffmpegPath: resolve(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe"), nativeCorePath: resolve(root, "native/bin/win32-x64/hao-core.exe"),
      gpuCompositorPath: compositor, pluginRoots: [] as string[], fontRoot: resolve(root, "public/fonts"), timeoutMs: 120_000,
    };
    if (baseline) return await (staticMode ? runStaticBaseline(temporary, runtimeBase) : runBaseline(temporary, runtimeBase));
    if (staticMode) return await runStaticGate(temporary, runtimeBase);
    const project = candidateProject();
    const sourceSnapshot = JSON.stringify(project);
    const dualWorkspace = join(temporary, "dual");
    const dual = await materializeCase(project, dualWorkspace, runtimeBase);
    const singleProject = structuredClone(project); singleProject.particleSimulation!.additionalEmitters = [];
    const single = await materializeCase(singleProject, join(temporary, "single"), runtimeBase);
    const extracted = join(temporary, "extracted");
    await extractFrames(runtimeBase.ffmpegPath, dual.intermediate.assetPath, extracted);
    let losslessPixelDifferences = 0;
    for (let frame = 0; frame < dual.clip.frameCount; frame += 1) {
      const name = `frame-${String(frame).padStart(8, "0")}.png`;
      const [resident, decoded] = await Promise.all([readFile(join(dualWorkspace, "clip-demo-0-gpu-temporal-look-frames", name)), readFile(join(extracted, name))]);
      losslessPixelDifferences += pixelDifference(resident, decoded).changed;
    }
    const comparisonFrame = "frame-00000007.png";
    const secondEmitterDelta = pixelDifference(
      await readFile(join(dualWorkspace, "clip-demo-0-gpu-temporal-look-frames", comparisonFrame)),
      await readFile(join(temporary, "single", "clip-demo-0-gpu-temporal-look-frames", comparisonFrame)),
    );
    const worker = dual.clip.instances[0].worker as Record<string, any>;
    const gpu = dual.clip.gpu!;
    const filtered = projectAfterNativeEffectMaterialization(project, dual.receipt);
    const rejectedNegativeControls: string[] = [];
    const rejectGraph = (name: string, candidate: EditProject) => { if (buildGpuEngineVideoPreviewGraph(candidate, 0) === undefined) rejectedNegativeControls.push(name); };
    const fifthEmitter = candidateProject(); const emitterTemplate = fifthEmitter.particleSimulation!.additionalEmitters![0]; fifthEmitter.particleSimulation!.additionalEmitters!.push(
      { ...structuredClone(emitterTemplate), id: "third", seed: 90211 }, { ...structuredClone(emitterTemplate), id: "fourth", seed: 90212 }, { ...structuredClone(emitterTemplate), id: "fifth", seed: 90213 },
    ); rejectGraph("fifth-emitter", fifthEmitter);
    const nonOverlapping = candidateProject(); const outside = nonOverlapping.tracks.find((track) => track.id === "track-overlay")!.clips[0]; outside.timelineStart = .6; outside.duration = .5; rejectGraph("non-overlapping-overlay", nonOverlapping);
    const overlayEffect = candidateProject(); overlayEffect.tracks.find((track) => track.id === "track-overlay")!.clips[0].creative!.effectPresetIds = ["unsafe-effect"]; rejectGraph("overlay-effect", overlayEffect);
    const overBudget = candidateProject(); overBudget.particleSimulation!.additionalEmitters![0].maxParticles = 160; rejectGraph("particle-budget", overBudget);
    const thirdKeyframe = candidateProject(); const animated = thirdKeyframe.tracks.find((track) => track.id === "track-overlay")!.clips[0]; animated.keyframes.push({ ...structuredClone(animated.keyframes[1]), id: "third-key", time: 14 / 30 }); rejectGraph("third-keyframe", thirdKeyframe);
    const thirdAdjustment = candidateProject(); const finish = thirdAdjustment.tracks.find((track) => track.id === "track-adjustment-finish")!.clips[0]; const third = { ...structuredClone(finish), id: "adjustment-third", trackId: "track-adjustment-third" }; thirdAdjustment.tracks.push({ id: third.trackId, name: "Adjustment 3", kind: "video", locked: false, muted: false, clips: [third] }); rejectGraph("third-adjustment", thirdAdjustment);
    const report = {
      schema: "editkin.temporal-multi-emitter-look-project-render-gate/v1", measuredAt: new Date().toISOString(), status: "GREEN",
      executionMode: dual.clip.executionMode, frameCount: dual.clip.frameCount, losslessPixelDifferences,
      combinedContract: worker.lookContract, particleContract: worker.particleContract, animationContract: worker.overlayAnimationContract,
      adjustmentContract: worker.adjustmentContract, emitterNodeIds: gpu.particle?.emitterNodeIds, particleTimelineRanges: gpu.particle?.timelineRanges,
      framesWithActiveParticles: gpu.particle?.framesWithActiveParticles, totalParticleEmitterPasses: gpu.particle?.totalParticleEmitterPasses,
      minimumActiveEmitterCount: gpu.particle?.minimumActiveEmitterCount, maximumActiveEmitterCount: gpu.particle?.maximumActiveEmitterCount,
      particleCeiling: gpu.particle?.particleCeiling, adjustmentMinimumBaseLayerCount: gpu.adjustment?.minimumBaseLayerCount,
      adjustmentMaximumBaseLayerCount: gpu.adjustment?.maximumBaseLayerCount, adjustmentFramesWithReceipt: gpu.adjustment?.framesWithActiveAdjustments,
      adjustmentTotalPasses: gpu.adjustment?.totalAdjustmentPasses, secondEmitterChangedPixels: secondEmitterDelta.changed,
      secondEmitterHighDeltaPixels: secondEmitterDelta.high, temporalFramesWithReceipt: gpu.temporalSampling?.framesWithReceipt,
      compositeFramesWithReceipt: gpu.composite?.framesWithReceipt, animationKeyframeCount: worker.overlayAnimationKeyframeCounts?.["clip-overlay"],
      singleColourCaptions: gpu.typography?.singleColourCaptions, productPathCpuPixelCopies: gpu.productPathCpuPixelCopies,
      verificationReadback: gpu.verificationReadback,
      planSuppressed: dual.plan.captions.length === 0 && !dual.plan.videoLayers.some((layer) => layer.segments.some((segment) => segment.kind === "clip" && ["clip-overlay", "adjustment-grade", "adjustment-finish"].includes(segment.clip.id))),
      projectSuppressed: filtered.particleSimulation === undefined && filtered.captions.length === 0 && filtered.motionGraphics.length === 0 && !filtered.tracks.some((track) => track.clips.some((clip) => ["clip-overlay", "adjustment-grade", "adjustment-finish"].includes(clip.id))),
      sourceProjectImmutable: JSON.stringify(project) === sourceSnapshot, retainedAudioClipCount: dual.plan.audioClips.length,
      rejectedNegativeControls, executableSha256: gpu.executableSha256, intermediateSha256: dual.clip.intermediateSha256,
      firstFrameSha256: gpu.firstFrameSha256, lastFrameSha256: gpu.lastFrameSha256,
      singleEmitterReferenceSha256: single.clip.intermediateSha256,
    };
    assertGreen(report);
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

await main();
