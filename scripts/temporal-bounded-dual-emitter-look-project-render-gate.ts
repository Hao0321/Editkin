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
  addSecondExactOverlay,
  addTwoKeyframeAnimatedOverlay,
  extractFrames,
  materializeCase,
  projectWithTemporalLook,
  type TemporalLookRuntimeBase,
} from "./temporalLookProjectRenderBaselines";

const root = resolve(import.meta.dirname, "..");
const evidenceRoot = resolve(root, "../../.rd/benchmarks/editkin-temporal-bounded-dual-emitter-look-project-render");
const baseline = process.argv.includes("--baseline");
const selfTest = process.argv.includes("--self-test");
const reportPath = join(evidenceRoot, baseline ? "baseline-report.json" : "report.json");
const compositor = resolve(root, "native/bin/win32-x64/editkin-gpu-compositor.exe");
const combinedContract = "decoded-temporal-resource-governed-look/v1";
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

type MatrixCase = { id: string; animated: boolean; partial: boolean; adjustments: 1 | 2 };
const matrix: MatrixCase[] = [false, true].flatMap((animated) =>
  [false, true].flatMap((partial) =>
    ([1, 2] as const).map((adjustments) => ({
      id: (animated ? "animated" : "static") + "-" + (partial ? "partial" : "exact") + "-" + adjustments + "-adjustment",
      animated, partial, adjustments,
    }))));

function addSecondParticleEmitter(project: EditProject): EditProject {
  if (!project.particleSimulation) throw new Error("dual-emitter fixture requires particle simulation");
  project.particleSimulation.additionalEmitters = [{
    id: "cool-trail", timeline: { start: 6 / 30, duration: 5 / 30 }, seed: 90210,
    ratePerSecond: 54, lifetimeSeconds: .72, maxParticles: 32,
    emitterPosition: [.32, .68], initialVelocity: [-34, -62], gravity: [0, 74],
    radiusPixels: 2.75, color: [.12, .68, 1, .88],
  }];
  return project;
}

function candidateProject(spec: MatrixCase): EditProject {
  let project = addParticleLook(projectWithTemporalLook({ overlay: true }));
  if (spec.animated) project = addTwoKeyframeAnimatedOverlay(project);
  if (spec.adjustments === 2) project = addSecondAdjustment(project);
  project = addSecondParticleEmitter(project);
  if (spec.partial) {
    const overlay = project.tracks.find((track) => track.id === "track-overlay")!.clips[0];
    overlay.timelineStart = .2;
    overlay.duration = .6;
  }
  return project;
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
  if (report.schema !== "editkin.temporal-bounded-dual-emitter-look-project-render-gate/v1" || report.status !== "GREEN") throw new Error("bounded dual-emitter gate is not GREEN");
  if (report.matrixCaseCount !== 8 || report.cases?.length !== 8 || report.matrixCoverage?.join() !== matrix.map((item) => item.id).join()) throw new Error("bounded dual-emitter matrix is incomplete");
  for (const item of report.cases ?? []) {
    const expected = matrix.find((candidate) => candidate.id === item.id);
    if (!expected || item.combinedContract !== combinedContract
      || item.particleContract !== "decoded-temporal-multi-particle-overlay/v1"
      || item.compositeContract !== "decoded-temporal-video-overlay/v1"
      || item.adjustmentContract !== (expected.adjustments === 2 ? "decoded-temporal-pre-typography-multi-adjustment/v1" : "decoded-temporal-pre-typography-adjustment/v1")
      || item.animationContract !== (expected.animated ? "decoded-temporal-video-overlay-transform-animation/v1" : undefined)
      || item.overlayKeyframeCount !== (expected.animated ? 2 : 0)
      || item.overlayRangeStartFrame !== (expected.partial ? 6 : 0)
      || item.overlayRangeDurationFrames !== (expected.partial ? 9 : 15)
      || item.overlayFullyMaterialized !== !expected.partial
      || item.compositeFramesWithReceipt !== (expected.partial ? 9 : 15)
      || item.adjustmentPasses !== (expected.adjustments === 2 ? 15 : 9)
      || item.adjustmentMinimumBaseLayerCount !== (expected.partial ? 1 : 2)
      || item.adjustmentMaximumBaseLayerCount !== 4
      || item.frameCount !== 15 || item.losslessPixelDifferences !== 0
      || item.framesWithActiveParticles !== 7 || item.totalParticleEmitterPasses !== 11
      || item.minimumActiveEmitterCount !== 1 || item.maximumActiveEmitterCount !== 2 || item.particleCeiling !== 80
      || item.singleColourCaptions !== true || item.productPathCpuPixelCopies !== 0 || item.verificationReadback !== true
      || item.retainedAudioClipCount !== 2 || !item.planSuppressionValid || !item.projectSuppressionValid || !item.sourceProjectImmutable) {
      throw new Error("bounded dual-emitter case is incomplete: " + item.id);
    }
  }
  if (report.secondEmitterChangedPixels < 100 || report.secondEmitterHighDeltaPixels < 50) throw new Error("second emitter is not independently visible");
  if (report.rejectedNegativeControls?.join() !== "fifth-emitter,third-adjustment,third-keyframe,non-overlapping-overlay,particle-outside-temporal,particle-budget,overlay-effect,second-video-overlay") throw new Error("bounded dual-emitter negatives are incomplete");
  for (const identity of [report.executableSha256, report.firstIntermediateSha256, report.lastIntermediateSha256]) {
    if (!/^[a-f0-9]{64}$/.test(identity)) throw new Error("bounded dual-emitter identity is incomplete");
  }
}

function syntheticSelfTest(): void {
  const cases = matrix.map((spec) => ({
    ...spec, combinedContract, particleContract: "decoded-temporal-multi-particle-overlay/v1",
    compositeContract: "decoded-temporal-video-overlay/v1",
    adjustmentContract: spec.adjustments === 2 ? "decoded-temporal-pre-typography-multi-adjustment/v1" : "decoded-temporal-pre-typography-adjustment/v1",
    animationContract: spec.animated ? "decoded-temporal-video-overlay-transform-animation/v1" : undefined,
    overlayKeyframeCount: spec.animated ? 2 : 0, overlayRangeStartFrame: spec.partial ? 6 : 0,
    overlayRangeDurationFrames: spec.partial ? 9 : 15, overlayFullyMaterialized: !spec.partial,
    compositeFramesWithReceipt: spec.partial ? 9 : 15, adjustmentPasses: spec.adjustments === 2 ? 15 : 9,
    adjustmentMinimumBaseLayerCount: spec.partial ? 1 : 2, adjustmentMaximumBaseLayerCount: 4,
    frameCount: 15, losslessPixelDifferences: 0, framesWithActiveParticles: 7, totalParticleEmitterPasses: 11,
    minimumActiveEmitterCount: 1, maximumActiveEmitterCount: 2, particleCeiling: 80, singleColourCaptions: true,
    productPathCpuPixelCopies: 0, verificationReadback: true, retainedAudioClipCount: 2,
    planSuppressionValid: true, projectSuppressionValid: true, sourceProjectImmutable: true,
  }));
  const report = {
    schema: "editkin.temporal-bounded-dual-emitter-look-project-render-gate/v1", status: "GREEN",
    matrixCaseCount: 8, matrixCoverage: matrix.map((item) => item.id), cases,
    secondEmitterChangedPixels: 200, secondEmitterHighDeltaPixels: 100,
    rejectedNegativeControls: ["fifth-emitter", "third-adjustment", "third-keyframe", "non-overlapping-overlay", "particle-outside-temporal", "particle-budget", "overlay-effect", "second-video-overlay"],
    executableSha256: "a".repeat(64), firstIntermediateSha256: "b".repeat(64), lastIntermediateSha256: "c".repeat(64),
  };
  assertGreen(report);
  const negatives = [
    { ...report, status: "BLOCK" },
    { ...report, matrixCaseCount: 7 },
    { ...report, cases: cases.slice(1) },
    { ...report, cases: cases.map((item, index) => index ? item : { ...item, losslessPixelDifferences: 1 }) },
    { ...report, cases: cases.map((item, index) => index ? item : { ...item, overlayFullyMaterialized: !item.overlayFullyMaterialized }) },
    { ...report, secondEmitterChangedPixels: 0 },
    { ...report, rejectedNegativeControls: report.rejectedNegativeControls.slice(0, -1) },
    { ...report, executableSha256: "bad" },
  ];
  let calibratedNegatives = 0;
  for (const candidate of negatives) {
    let rejected = false;
    try { assertGreen(candidate); } catch { rejected = true; calibratedNegatives += 1; }
    if (!rejected) throw new Error("bounded dual-emitter evaluator accepted a calibrated negative");
  }
  process.stdout.write(JSON.stringify({ status: "GREEN", evaluator: report.schema, calibratedNegatives }) + "\n");
}

async function runBaseline(temporary: string, runtimeBase: TemporalLookRuntimeBase): Promise<void> {
  const cases = [];
  for (const spec of matrix) {
    const project = candidateProject(spec);
    const snapshot = JSON.stringify(project);
    const plan = buildRenderPlan(project, (uri) => uri);
    const graph = buildGpuEngineVideoPreviewGraph(project, 0)?.graph;
    let receipt: Awaited<ReturnType<typeof materializeNativeEffectSegments>>;
    let rejection = "";
    try { receipt = await materializeNativeEffectSegments(project, plan, { ...runtimeBase, workspace: join(temporary, spec.id) }); }
    catch (error) { rejection = String(error); }
    const worker = receipt?.clips[0]?.instances[0]?.worker as { lookContract?: string; particleContract?: string } | undefined;
    cases.push({
      id: spec.id, graphBuilt: Boolean(graph), combinedReceipt: worker?.lookContract === combinedContract,
      particleReceipt: worker?.particleContract === "decoded-temporal-multi-particle-overlay/v1",
      planStillActive: plan.captions.length > 0 && plan.videoLayers.some((layer) => layer.segments.some((segment) => segment.kind === "clip" && segment.clip.id === "adjustment-grade")),
      particleProjectStillActive: projectAfterNativeEffectMaterialization(project, receipt).particleSimulation?.additionalEmitters?.length === 1,
      sourceProjectImmutable: JSON.stringify(project) === snapshot, rejection,
    });
  }
  const report = {
    schema: "editkin.temporal-bounded-dual-emitter-look-project-render-baseline/v1", measuredAt: new Date().toISOString(), status: "BLOCK",
    expectedContract: combinedContract, matrixCaseCount: cases.length, cases, compositorSha256: sha256(await readFile(compositor)),
  };
  const legacyAccepted = new Set(["static-exact-1-adjustment", "animated-exact-2-adjustment"]);
  const acceptedValid = cases.filter((item) => legacyAccepted.has(item.id)).every((item) =>
    item.graphBuilt && !item.combinedReceipt && item.particleReceipt && !item.planStillActive
    && !item.particleProjectStillActive && item.sourceProjectImmutable);
  const gapsValid = cases.filter((item) => !legacyAccepted.has(item.id)).every((item) =>
    !item.graphBuilt && !item.combinedReceipt && !item.particleReceipt && item.planStillActive
    && item.particleProjectStillActive && item.sourceProjectImmutable);
  if (!acceptedValid || !gapsValid || cases.some((item) => item.combinedReceipt)) {
    throw new Error("bounded dual-emitter RED baseline did not expose all matrix gaps: " + JSON.stringify(report));
  }
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

function segmentFrames(plan: Awaited<ReturnType<typeof materializeCase>>["plan"], kind: "gap" | "clip", start: number, end: number): number {
  const segments = plan.videoLayers.find((layer) => layer.trackId === "track-overlay")?.segments ?? [];
  return Math.round(segments.filter((segment) => segment.kind === kind)
    .reduce((sum, segment) => sum + Math.max(0, Math.min(segment.start + segment.duration, end) - Math.max(segment.start, start)), 0) * 30);
}

async function runGate(temporary: string, runtimeBase: TemporalLookRuntimeBase): Promise<void> {
  const results: Array<Record<string, any>> = [];
  for (const spec of matrix) {
    const project = candidateProject(spec);
    const sourceSnapshot = JSON.stringify(project);
    const workspace = join(temporary, spec.id);
    const materialized = await materializeCase(project, workspace, runtimeBase);
    const extracted = join(temporary, spec.id + "-extracted");
    await extractFrames(runtimeBase.ffmpegPath, materialized.intermediate.assetPath, extracted);
    let losslessPixelDifferences = 0;
    for (let frame = 0; frame < materialized.clip.frameCount; frame += 1) {
      const name = "frame-" + String(frame).padStart(8, "0") + ".png";
      losslessPixelDifferences += pixelDifference(
        await readFile(join(workspace, "clip-demo-0-gpu-temporal-look-frames", name)),
        await readFile(join(extracted, name)),
      ).changed;
    }
    const gpu = materialized.clip.gpu!;
    const worker = materialized.clip.instances[0].worker as Record<string, any>;
    const filtered = projectAfterNativeEffectMaterialization(project, materialized.receipt);
    const filteredOverlay = filtered.tracks.find((track) => track.id === "track-overlay")?.clips ?? [];
    const exactSuppressed = !materialized.plan.videoLayers.some((layer) => layer.segments.some((segment) => segment.kind === "clip" && segment.clip.id === "clip-overlay"))
      && filteredOverlay.length === 0;
    const partialSuppressed = segmentFrames(materialized.plan, "gap", .2, .5) === 9
      && segmentFrames(materialized.plan, "clip", .5, .8) === 9
      && filteredOverlay.length === 1 && Math.abs(filteredOverlay[0].timelineStart - .5) <= 1e-6
      && Math.abs(filteredOverlay[0].sourceStart - .5) <= 1e-6 && Math.abs(filteredOverlay[0].duration - .3) <= 1e-6;
    results.push({
      ...spec, combinedContract: worker.lookContract, particleContract: worker.particleContract,
      compositeContract: worker.compositeContract, adjustmentContract: worker.adjustmentContract,
      animationContract: worker.overlayAnimationContract,
      overlayKeyframeCount: worker.overlayAnimationKeyframeCounts?.["clip-overlay"] ?? 0,
      overlayRangeStartFrame: gpu.composite?.timelineRanges[0]?.timelineStartFrame,
      overlayRangeDurationFrames: gpu.composite?.timelineRanges[0]?.durationFrames,
      overlayFullyMaterialized: gpu.composite?.timelineRanges[0]?.fullyMaterialized,
      compositeFramesWithReceipt: gpu.composite?.framesWithReceipt,
      adjustmentPasses: gpu.adjustment?.totalAdjustmentPasses,
      adjustmentMinimumBaseLayerCount: gpu.adjustment?.minimumBaseLayerCount,
      adjustmentMaximumBaseLayerCount: gpu.adjustment?.maximumBaseLayerCount,
      frameCount: materialized.clip.frameCount, losslessPixelDifferences,
      framesWithActiveParticles: gpu.particle?.framesWithActiveParticles,
      totalParticleEmitterPasses: gpu.particle?.totalParticleEmitterPasses,
      minimumActiveEmitterCount: gpu.particle?.minimumActiveEmitterCount,
      maximumActiveEmitterCount: gpu.particle?.maximumActiveEmitterCount,
      particleCeiling: gpu.particle?.particleCeiling, singleColourCaptions: gpu.typography?.singleColourCaptions,
      productPathCpuPixelCopies: gpu.productPathCpuPixelCopies, verificationReadback: gpu.verificationReadback,
      retainedAudioClipCount: materialized.plan.audioClips.length,
      planSuppressionValid: materialized.plan.captions.length === 0
        && !materialized.plan.videoLayers.some((layer) => layer.segments.some((segment) => segment.kind === "clip" && ["adjustment-grade", "adjustment-finish"].includes(segment.clip.id)))
        && (spec.partial ? partialSuppressed : exactSuppressed),
      projectSuppressionValid: filtered.particleSimulation === undefined && filtered.captions.length === 0 && filtered.motionGraphics.length === 0
        && !filtered.tracks.some((track) => track.clips.some((clip) => ["adjustment-grade", "adjustment-finish"].includes(clip.id)))
        && (spec.partial ? partialSuppressed : exactSuppressed),
      sourceProjectImmutable: JSON.stringify(project) === sourceSnapshot,
      executableSha256: gpu.executableSha256,
      intermediateSha256: materialized.clip.intermediateSha256,
    });
  }
  const representative = matrix.find((item) => item.animated && item.partial && item.adjustments === 1)!;
  const dualWorkspace = join(temporary, representative.id);
  const singleProject = candidateProject(representative);
  singleProject.particleSimulation!.additionalEmitters = [];
  await materializeCase(singleProject, join(temporary, "single-emitter-reference"), runtimeBase);
  const comparisonFrame = "frame-00000007.png";
  const secondEmitter = pixelDifference(
    await readFile(join(dualWorkspace, "clip-demo-0-gpu-temporal-look-frames", comparisonFrame)),
    await readFile(join(temporary, "single-emitter-reference", "clip-demo-0-gpu-temporal-look-frames", comparisonFrame)),
  );
  const rejectedNegativeControls: string[] = [];
  const reject = (name: string, project: EditProject) => { if (!buildGpuEngineVideoPreviewGraph(project, 0)) rejectedNegativeControls.push(name); };
  const negativeBase = () => candidateProject(representative);
  const fifthEmitter = negativeBase();
  const emitterTemplate = fifthEmitter.particleSimulation!.additionalEmitters![0];
  fifthEmitter.particleSimulation!.additionalEmitters!.push(
    { ...structuredClone(emitterTemplate), id: "third", seed: 90211 },
    { ...structuredClone(emitterTemplate), id: "fourth", seed: 90212 },
    { ...structuredClone(emitterTemplate), id: "fifth", seed: 90213 },
  );
  reject("fifth-emitter", fifthEmitter);
  const thirdAdjustment = candidateProject({ ...representative, adjustments: 2 }); const finish = thirdAdjustment.tracks.find((track) => track.id === "track-adjustment-finish")!.clips[0]; thirdAdjustment.tracks.push({ id: "track-third-adjustment", name: "Third adjustment", kind: "video", locked: false, muted: false, clips: [{ ...structuredClone(finish), id: "third-adjustment", trackId: "track-third-adjustment" }] }); reject("third-adjustment", thirdAdjustment);
  const thirdKeyframe = negativeBase(); const animated = thirdKeyframe.tracks.find((track) => track.id === "track-overlay")!.clips[0]; animated.keyframes.push({ ...structuredClone(animated.keyframes[1]), id: "third-key", time: 14 / 30 }); reject("third-keyframe", thirdKeyframe);
  const nonOverlapping = negativeBase(); const outside = nonOverlapping.tracks.find((track) => track.id === "track-overlay")!.clips[0]; outside.timelineStart = .6; outside.duration = .5; reject("non-overlapping-overlay", nonOverlapping);
  const particleOutside = negativeBase(); particleOutside.particleSimulation!.additionalEmitters![0].timeline = { start: .45, duration: .2 }; reject("particle-outside-temporal", particleOutside);
  const overBudget = negativeBase(); overBudget.particleSimulation!.additionalEmitters![0].maxParticles = 160; reject("particle-budget", overBudget);
  const overlayEffect = negativeBase(); overlayEffect.tracks.find((track) => track.id === "track-overlay")!.clips[0].creative!.effectPresetIds = ["unsafe"]; reject("overlay-effect", overlayEffect);
  reject("second-video-overlay", addSecondExactOverlay(negativeBase()));
  const report = {
    schema: "editkin.temporal-bounded-dual-emitter-look-project-render-gate/v1", measuredAt: new Date().toISOString(), status: "GREEN",
    matrixCaseCount: results.length, matrixCoverage: matrix.map((item) => item.id), cases: results,
    secondEmitterChangedPixels: secondEmitter.changed, secondEmitterHighDeltaPixels: secondEmitter.high,
    rejectedNegativeControls, executableSha256: results[0].executableSha256,
    firstIntermediateSha256: results[0].intermediateSha256, lastIntermediateSha256: results.at(-1)?.intermediateSha256,
  };
  assertGreen(report);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

async function main(): Promise<void> {
  if (selfTest) return syntheticSelfTest();
  const temporary = await mkdtemp(join(tmpdir(), "editkin-bounded-dual-emitter-"));
  try {
    const runtimeBase: TemporalLookRuntimeBase = {
      ffmpegPath: resolve(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe"),
      nativeCorePath: resolve(root, "native/bin/win32-x64/hao-core.exe"),
      gpuCompositorPath: compositor, pluginRoots: [], fontRoot: resolve(root, "public/fonts"), timeoutMs: 120_000,
    };
    if (baseline) return await runBaseline(temporary, runtimeBase);
    await runGate(temporary, runtimeBase);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

await main();
