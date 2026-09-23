import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PNG } from "pngjs";
import type { EditProject, ParticleEmitterSettings } from "../src/domain/types";
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
const evidenceRoot = resolve(root, "../../.rd/benchmarks/editkin-temporal-resource-governed-look-project-render");
const baseline = process.argv.includes("--baseline");
const selfTest = process.argv.includes("--self-test");
const reportPath = join(evidenceRoot, baseline ? "baseline-report.json" : "report.json");
const compositor = resolve(root, "native/bin/win32-x64/editkin-gpu-compositor.exe");
const combinedContract = "decoded-temporal-resource-governed-look/v1";
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

type MatrixCase = {
  id: string;
  emitters: 1 | 2 | 3 | 4;
  overlay: boolean;
  animated: boolean;
  partial: boolean;
  adjustments: 0 | 1 | 2;
  typography: boolean;
};

const matrix: MatrixCase[] = [
  { id: "one-minimal", emitters: 1, overlay: false, animated: false, partial: false, adjustments: 0, typography: false },
  { id: "one-typography", emitters: 1, overlay: false, animated: false, partial: false, adjustments: 0, typography: true },
  { id: "two-static-exact-one-adjustment", emitters: 2, overlay: true, animated: false, partial: false, adjustments: 1, typography: true },
  { id: "two-animated-partial-two-adjustments", emitters: 2, overlay: true, animated: true, partial: true, adjustments: 2, typography: true },
  { id: "three-static-partial-minimal", emitters: 3, overlay: true, animated: false, partial: true, adjustments: 0, typography: false },
  { id: "three-animated-exact-one-adjustment", emitters: 3, overlay: true, animated: true, partial: false, adjustments: 1, typography: true },
  { id: "four-no-overlay-two-adjustments", emitters: 4, overlay: false, animated: false, partial: false, adjustments: 2, typography: false },
  { id: "four-animated-partial-two-adjustments", emitters: 4, overlay: true, animated: true, partial: true, adjustments: 2, typography: true },
];

const additionalEmitters: ParticleEmitterSettings[] = [
  {
    id: "cool-trail", timeline: { start: 6 / 30, duration: 5 / 30 }, seed: 90210,
    ratePerSecond: 54, lifetimeSeconds: .72, maxParticles: 32,
    emitterPosition: [.32, .68], initialVelocity: [-34, -62], gravity: [0, 74], radiusPixels: 2.75, color: [.12, .68, 1, .88],
  },
  {
    id: "warm-spark", timeline: { start: 7 / 30, duration: 4 / 30 }, seed: 90211,
    ratePerSecond: 48, lifetimeSeconds: .62, maxParticles: 32,
    emitterPosition: [.68, .64], initialVelocity: [28, -70], gravity: [0, 82], radiusPixels: 2.4, color: [1, .42, .12, .9],
  },
  {
    id: "violet-pop", timeline: { start: 8 / 30, duration: 3 / 30 }, seed: 90212,
    ratePerSecond: 42, lifetimeSeconds: .54, maxParticles: 32,
    emitterPosition: [.52, .42], initialVelocity: [8, -58], gravity: [0, 68], radiusPixels: 2.2, color: [.72, .24, 1, .9],
  },
];

function candidateProject(spec: MatrixCase): EditProject {
  let project = addParticleLook(projectWithTemporalLook({
    overlay: spec.overlay,
    adjustment: spec.adjustments > 0,
    typography: spec.typography,
  }));
  if (spec.adjustments === 2) project = addSecondAdjustment(project);
  if (spec.animated) project = addTwoKeyframeAnimatedOverlay(project);
  if (spec.partial) {
    const overlay = project.tracks.find((track) => track.id === "track-overlay")!.clips[0];
    overlay.timelineStart = .2;
    overlay.duration = .6;
  }
  project.particleSimulation!.additionalEmitters = structuredClone(additionalEmitters.slice(0, spec.emitters - 1));
  return project;
}

function particleExpectation(count: number) {
  const durations = [6, 5, 4, 3].slice(0, count);
  return {
    frames: count === 1 ? 6 : 7,
    passes: durations.reduce((sum, duration) => sum + duration, 0),
    minimum: 1,
    maximum: count,
    ceiling: 48 + Math.max(0, count - 1) * 32,
  };
}

function adjustmentExpectation(spec: MatrixCase) {
  if (spec.adjustments === 0) return undefined;
  const particleRanges = [[4, 10], [6, 11], [7, 11], [8, 11]].slice(0, spec.emitters);
  const overlayRange = spec.overlay ? [spec.partial ? 6 : 0, 15] : undefined;
  const activeFrames = Array.from({ length: 15 }, (_, frame) => frame).filter((frame) => frame >= 3 && frame < 12);
  const baseCounts = activeFrames.map((frame) => 1
    + (overlayRange && frame >= overlayRange[0] && frame < overlayRange[1] ? 1 : 0)
    + particleRanges.filter(([start, end]) => frame >= start && frame < end).length);
  return {
    frames: 9,
    passes: spec.adjustments === 2 ? 15 : 9,
    minimumActive: 1,
    maximumActive: spec.adjustments,
    minimumBase: Math.min(...baseCounts),
    maximumBase: Math.max(...baseCounts),
  };
}

function pixelDifference(left: Buffer, right: Buffer): { changed: number; high: number } {
  const a = PNG.sync.read(left); const b = PNG.sync.read(right);
  if (a.width !== b.width || a.height !== b.height) throw new Error("pixel oracle dimensions differ");
  let changed = 0; let high = 0;
  for (let pixel = 0; pixel < a.width * a.height; pixel += 1) {
    let delta = 0;
    for (let channel = 0; channel < 4; channel += 1) delta += Math.abs(a.data[pixel * 4 + channel] - b.data[pixel * 4 + channel]);
    if (delta > 8) changed += 1;
    if (delta > 32) high += 1;
  }
  return { changed, high };
}

function assertGreen(report: Record<string, any>): void {
  if (report.schema !== "editkin.temporal-resource-governed-look-project-render-gate/v1" || report.status !== "GREEN") throw new Error("resource-governed look gate is not GREEN");
  if (report.matrixCaseCount !== matrix.length || report.cases?.length !== matrix.length || report.matrixCoverage?.join() !== matrix.map((item) => item.id).join()) throw new Error("resource-governed look matrix is incomplete");
  for (const item of report.cases ?? []) {
    const expected = matrix.find((candidate) => candidate.id === item.id);
    if (!expected) throw new Error("resource-governed look case is unknown: " + item.id);
    const particles = particleExpectation(expected.emitters);
    const adjustments = adjustmentExpectation(expected);
    if (item.combinedContract !== combinedContract
      || item.particleContract !== (expected.emitters === 1 ? "decoded-temporal-particle-overlay/v1" : "decoded-temporal-multi-particle-overlay/v1")
      || item.compositeContract !== (expected.overlay ? "decoded-temporal-video-overlay/v1" : undefined)
      || item.animationContract !== (expected.animated ? "decoded-temporal-video-overlay-transform-animation/v1" : undefined)
      || item.overlayRangeStartFrame !== (expected.overlay ? expected.partial ? 6 : 0 : undefined)
      || item.overlayRangeDurationFrames !== (expected.overlay ? expected.partial ? 9 : 15 : undefined)
      || item.compositeFramesWithReceipt !== (expected.overlay ? expected.partial ? 9 : 15 : undefined)
      || item.adjustmentPasses !== adjustments?.passes
      || item.adjustmentMinimumBaseLayerCount !== adjustments?.minimumBase
      || item.adjustmentMaximumBaseLayerCount !== adjustments?.maximumBase
      || item.typographyReceipt !== expected.typography
      || item.frameCount !== 15 || item.losslessPixelDifferences !== 0
      || item.framesWithActiveParticles !== particles.frames || item.totalParticleEmitterPasses !== particles.passes
      || item.minimumActiveEmitterCount !== particles.minimum || item.maximumActiveEmitterCount !== particles.maximum
      || item.particleCeiling !== particles.ceiling || item.productPathCpuPixelCopies !== 0 || item.verificationReadback !== true
      || item.retainedAudioClipCount !== (expected.overlay ? 2 : 1)
      || !item.planSuppressionValid || !item.projectSuppressionValid || !item.sourceProjectImmutable) {
      throw new Error("resource-governed look case is incomplete: " + item.id);
    }
  }
  if (report.fourthEmitterChangedPixels < 10 || report.fourthEmitterHighDeltaPixels < 5) throw new Error("fourth emitter is not independently visible");
  if (report.rejectedNegativeControls?.join() !== "fifth-emitter,third-adjustment,third-keyframe,non-overlapping-overlay,particle-outside-temporal,particle-budget,overlay-effect,second-video-overlay,content-after-adjustment,no-video-base") throw new Error("resource-governed look negatives are incomplete");
  for (const identity of [report.executableSha256, report.firstIntermediateSha256, report.lastIntermediateSha256]) {
    if (!/^[a-f0-9]{64}$/.test(identity)) throw new Error("resource-governed identity is incomplete");
  }
}

function syntheticSelfTest(): void {
  const cases = matrix.map((spec) => {
    const particles = particleExpectation(spec.emitters); const adjustments = adjustmentExpectation(spec);
    return {
      ...spec, combinedContract, particleContract: spec.emitters === 1 ? "decoded-temporal-particle-overlay/v1" : "decoded-temporal-multi-particle-overlay/v1",
      compositeContract: spec.overlay ? "decoded-temporal-video-overlay/v1" : undefined,
      animationContract: spec.animated ? "decoded-temporal-video-overlay-transform-animation/v1" : undefined,
      overlayRangeStartFrame: spec.overlay ? spec.partial ? 6 : 0 : undefined,
      overlayRangeDurationFrames: spec.overlay ? spec.partial ? 9 : 15 : undefined,
      compositeFramesWithReceipt: spec.overlay ? spec.partial ? 9 : 15 : undefined,
      adjustmentPasses: adjustments?.passes, adjustmentMinimumBaseLayerCount: adjustments?.minimumBase,
      adjustmentMaximumBaseLayerCount: adjustments?.maximumBase, typographyReceipt: spec.typography,
      frameCount: 15, losslessPixelDifferences: 0, framesWithActiveParticles: particles.frames,
      totalParticleEmitterPasses: particles.passes, minimumActiveEmitterCount: particles.minimum,
      maximumActiveEmitterCount: particles.maximum, particleCeiling: particles.ceiling,
      productPathCpuPixelCopies: 0, verificationReadback: true, retainedAudioClipCount: spec.overlay ? 2 : 1,
      planSuppressionValid: true, projectSuppressionValid: true, sourceProjectImmutable: true,
    };
  });
  const report = {
    schema: "editkin.temporal-resource-governed-look-project-render-gate/v1", status: "GREEN",
    matrixCaseCount: matrix.length, matrixCoverage: matrix.map((item) => item.id), cases,
    fourthEmitterChangedPixels: 100, fourthEmitterHighDeltaPixels: 50,
    rejectedNegativeControls: ["fifth-emitter", "third-adjustment", "third-keyframe", "non-overlapping-overlay", "particle-outside-temporal", "particle-budget", "overlay-effect", "second-video-overlay", "content-after-adjustment", "no-video-base"],
    executableSha256: "a".repeat(64), firstIntermediateSha256: "b".repeat(64), lastIntermediateSha256: "c".repeat(64),
  };
  assertGreen(report);
  const negatives = [
    { ...report, status: "BLOCK" }, { ...report, matrixCaseCount: matrix.length - 1 },
    { ...report, cases: cases.slice(1) },
    { ...report, cases: cases.map((item, index) => index ? item : { ...item, losslessPixelDifferences: 1 }) },
    { ...report, cases: cases.map((item, index) => index ? item : { ...item, typographyReceipt: !item.typographyReceipt }) },
    { ...report, fourthEmitterChangedPixels: 0 },
    { ...report, rejectedNegativeControls: report.rejectedNegativeControls.slice(0, -1) },
    { ...report, executableSha256: "bad" },
  ];
  let calibratedNegatives = 0;
  for (const candidate of negatives) {
    let rejected = false;
    try { assertGreen(candidate); } catch { rejected = true; calibratedNegatives += 1; }
    if (!rejected) throw new Error("resource-governed evaluator accepted a calibrated negative");
  }
  process.stdout.write(JSON.stringify({ status: "GREEN", evaluator: report.schema, calibratedNegatives }) + "\n");
}

async function runBaseline(temporary: string, runtimeBase: TemporalLookRuntimeBase): Promise<void> {
  const cases = [];
  for (const spec of matrix) {
    const project = candidateProject(spec); const snapshot = JSON.stringify(project);
    const plan = buildRenderPlan(project, (uri) => uri); const graph = buildGpuEngineVideoPreviewGraph(project, 0)?.graph;
    let receipt: Awaited<ReturnType<typeof materializeNativeEffectSegments>>; let rejection = "";
    try { receipt = await materializeNativeEffectSegments(project, plan, { ...runtimeBase, workspace: join(temporary, spec.id) }); }
    catch (error) { rejection = String(error); }
    const worker = receipt?.clips[0]?.instances[0]?.worker as { lookContract?: string } | undefined;
    cases.push({ id: spec.id, graphBuilt: Boolean(graph), oldContract: worker?.lookContract, newContract: worker?.lookContract === combinedContract, sourceProjectImmutable: JSON.stringify(project) === snapshot, rejection });
  }
  const oldAccepted = new Set(["two-static-exact-one-adjustment", "two-animated-partial-two-adjustments"]);
  if (!cases.filter((item) => oldAccepted.has(item.id)).every((item) => item.graphBuilt && typeof item.oldContract === "string" && !item.newContract && item.sourceProjectImmutable)
    || !cases.filter((item) => !oldAccepted.has(item.id)).every((item) => !item.graphBuilt && item.oldContract === undefined && !item.newContract && item.sourceProjectImmutable)) {
    throw new Error("resource-governed RED baseline did not expose the expected topology gaps: " + JSON.stringify(cases));
  }
  const report = {
    schema: "editkin.temporal-resource-governed-look-project-render-baseline/v1", measuredAt: new Date().toISOString(), status: "BLOCK",
    expectedContract: combinedContract, matrixCaseCount: cases.length, cases, compositorSha256: sha256(await readFile(compositor)),
  };
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
    const project = candidateProject(spec); const sourceSnapshot = JSON.stringify(project); const workspace = join(temporary, spec.id);
    const materialized = await materializeCase(project, workspace, runtimeBase);
    const extracted = join(temporary, spec.id + "-extracted");
    await extractFrames(runtimeBase.ffmpegPath, materialized.intermediate.assetPath, extracted);
    let losslessPixelDifferences = 0;
    for (let frame = 0; frame < materialized.clip.frameCount; frame += 1) {
      const name = "frame-" + String(frame).padStart(8, "0") + ".png";
      losslessPixelDifferences += pixelDifference(await readFile(join(workspace, "clip-demo-0-gpu-temporal-look-frames", name)), await readFile(join(extracted, name))).changed;
    }
    const gpu = materialized.clip.gpu!; const worker = materialized.clip.instances[0].worker as Record<string, any>;
    const filtered = projectAfterNativeEffectMaterialization(project, materialized.receipt);
    const filteredOverlay = filtered.tracks.find((track) => track.id === "track-overlay")?.clips ?? [];
    const exactSuppressed = !spec.overlay || spec.partial || (!materialized.plan.videoLayers.some((layer) => layer.segments.some((segment) => segment.kind === "clip" && segment.clip.id === "clip-overlay")) && filteredOverlay.length === 0);
    const partialSuppressed = !spec.overlay || !spec.partial || (segmentFrames(materialized.plan, "gap", .2, .5) === 9
      && segmentFrames(materialized.plan, "clip", .5, .8) === 9 && filteredOverlay.length === 1
      && Math.abs(filteredOverlay[0].timelineStart - .5) <= 1e-6 && Math.abs(filteredOverlay[0].sourceStart - .5) <= 1e-6 && Math.abs(filteredOverlay[0].duration - .3) <= 1e-6);
    results.push({
      ...spec, combinedContract: worker.lookContract, particleContract: worker.particleContract,
      compositeContract: worker.compositeContract, animationContract: worker.overlayAnimationContract,
      overlayRangeStartFrame: gpu.composite?.timelineRanges[0]?.timelineStartFrame,
      overlayRangeDurationFrames: gpu.composite?.timelineRanges[0]?.durationFrames,
      compositeFramesWithReceipt: gpu.composite?.framesWithReceipt,
      adjustmentPasses: gpu.adjustment?.totalAdjustmentPasses,
      adjustmentMinimumBaseLayerCount: gpu.adjustment?.minimumBaseLayerCount,
      adjustmentMaximumBaseLayerCount: gpu.adjustment?.maximumBaseLayerCount,
      typographyReceipt: Boolean(gpu.typography), frameCount: materialized.clip.frameCount, losslessPixelDifferences,
      framesWithActiveParticles: gpu.particle?.framesWithActiveParticles,
      totalParticleEmitterPasses: gpu.particle?.totalParticleEmitterPasses,
      minimumActiveEmitterCount: gpu.particle?.minimumActiveEmitterCount,
      maximumActiveEmitterCount: gpu.particle?.maximumActiveEmitterCount,
      particleCeiling: gpu.particle?.particleCeiling, productPathCpuPixelCopies: gpu.productPathCpuPixelCopies,
      verificationReadback: gpu.verificationReadback, retainedAudioClipCount: materialized.plan.audioClips.length,
      planSuppressionValid: materialized.plan.captions.length === 0
        && !materialized.plan.videoLayers.some((layer) => layer.segments.some((segment) => segment.kind === "clip" && ["adjustment-grade", "adjustment-finish"].includes(segment.clip.id)))
        && exactSuppressed && partialSuppressed,
      projectSuppressionValid: filtered.particleSimulation === undefined && filtered.captions.length === 0 && filtered.motionGraphics.length === 0
        && !filtered.tracks.some((track) => track.clips.some((clip) => ["adjustment-grade", "adjustment-finish"].includes(clip.id)))
        && exactSuppressed && partialSuppressed,
      sourceProjectImmutable: JSON.stringify(project) === sourceSnapshot,
      executableSha256: gpu.executableSha256, intermediateSha256: materialized.clip.intermediateSha256,
    });
  }
  const fourSpec = matrix.find((item) => item.id === "four-animated-partial-two-adjustments")!;
  const fourWorkspace = join(temporary, fourSpec.id); const threeProject = candidateProject({ ...fourSpec, emitters: 3 });
  await materializeCase(threeProject, join(temporary, "three-emitter-reference"), runtimeBase);
  const fourthEmitter = pixelDifference(
    await readFile(join(fourWorkspace, "clip-demo-0-gpu-temporal-look-frames", "frame-00000008.png")),
    await readFile(join(temporary, "three-emitter-reference", "clip-demo-0-gpu-temporal-look-frames", "frame-00000008.png")),
  );
  const rejectedNegativeControls: string[] = [];
  const reject = (name: string, project: EditProject) => { if (!buildGpuEngineVideoPreviewGraph(project, 0)) rejectedNegativeControls.push(name); };
  const negativeBase = () => candidateProject(fourSpec);
  const fifthEmitter = negativeBase(); fifthEmitter.particleSimulation!.additionalEmitters!.push({ ...structuredClone(additionalEmitters[2]), id: "fifth", seed: 90213 }); reject("fifth-emitter", fifthEmitter);
  const thirdAdjustment = negativeBase(); const finish = thirdAdjustment.tracks.find((track) => track.id === "track-adjustment-finish")!.clips[0]; thirdAdjustment.tracks.push({ id: "track-third-adjustment", name: "Third", kind: "video", locked: false, muted: false, clips: [{ ...structuredClone(finish), id: "third-adjustment", trackId: "track-third-adjustment" }] }); reject("third-adjustment", thirdAdjustment);
  const thirdKeyframe = negativeBase(); const animated = thirdKeyframe.tracks.find((track) => track.id === "track-overlay")!.clips[0]; animated.keyframes.push({ ...structuredClone(animated.keyframes[1]), id: "third-key", time: 14 / 30 }); reject("third-keyframe", thirdKeyframe);
  const nonOverlapping = negativeBase(); const outside = nonOverlapping.tracks.find((track) => track.id === "track-overlay")!.clips[0]; outside.timelineStart = .6; outside.duration = .5; reject("non-overlapping-overlay", nonOverlapping);
  const particleOutside = negativeBase(); particleOutside.particleSimulation!.additionalEmitters![0].timeline = { start: .45, duration: .2 }; reject("particle-outside-temporal", particleOutside);
  const overBudget = negativeBase(); overBudget.particleSimulation!.additionalEmitters![0].maxParticles = 160; reject("particle-budget", overBudget);
  const overlayEffect = negativeBase(); overlayEffect.tracks.find((track) => track.id === "track-overlay")!.clips[0].creative!.effectPresetIds = ["unsafe"]; reject("overlay-effect", overlayEffect);
  reject("second-video-overlay", addSecondExactOverlay(negativeBase()));
  const wrongOrder = negativeBase(); const adjustmentIndex = wrongOrder.tracks.findIndex((track) => track.id === "track-adjustment"); const [adjustmentTrack] = wrongOrder.tracks.splice(adjustmentIndex, 1); wrongOrder.tracks.splice(wrongOrder.tracks.findIndex((track) => track.id === "track-overlay"), 0, adjustmentTrack); reject("content-after-adjustment", wrongOrder);
  const noVideoBase = negativeBase(); noVideoBase.tracks = noVideoBase.tracks.filter((track) => track.id !== "video-main"); reject("no-video-base", noVideoBase);
  const report = {
    schema: "editkin.temporal-resource-governed-look-project-render-gate/v1", measuredAt: new Date().toISOString(), status: "GREEN",
    matrixCaseCount: results.length, matrixCoverage: matrix.map((item) => item.id), cases: results,
    fourthEmitterChangedPixels: fourthEmitter.changed, fourthEmitterHighDeltaPixels: fourthEmitter.high,
    rejectedNegativeControls, executableSha256: results[0].executableSha256,
    firstIntermediateSha256: results[0].intermediateSha256, lastIntermediateSha256: results.at(-1)?.intermediateSha256,
  };
  await mkdir(dirname(reportPath), { recursive: true });
  try {
    assertGreen(report);
  } catch (error) {
    await writeFile(reportPath, JSON.stringify({ ...report, status: "BLOCK", assertionError: String(error) }, null, 2) + "\n");
    throw error;
  }
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

async function main(): Promise<void> {
  if (selfTest) return syntheticSelfTest();
  const temporary = await mkdtemp(join(tmpdir(), "editkin-resource-governed-look-"));
  try {
    const runtimeBase: TemporalLookRuntimeBase = {
      ffmpegPath: resolve(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe"), nativeCorePath: resolve(root, "native/bin/win32-x64/hao-core.exe"),
      gpuCompositorPath: compositor, pluginRoots: [], fontRoot: resolve(root, "public/fonts"), timeoutMs: 120_000,
    };
    if (baseline) return await runBaseline(temporary, runtimeBase);
    await runGate(temporary, runtimeBase);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

await main();
