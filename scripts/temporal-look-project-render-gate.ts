import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PNG } from "pngjs";
import { materializeNativeEffectSegments, projectAfterNativeEffectMaterialization } from "../src/plugins/nativeEffectRender";
import { buildGpuEngineVideoPreviewGraph } from "../src/render/gpuCompositor";
import { buildRenderPlan } from "../src/render/planner";
import {
  addAnimatedOverlay,
  addParticleLook,
  addSecondAdjustment,
  addSecondExactOverlay,
  addTwoKeyframeAnimatedOverlay,
  changedStats,
  extractFrames,
  materializeCase,
  projectWithTemporalLook,
} from "./temporalLookProjectRenderBaselines";
import { runTemporalLookBaseline } from "./temporalLookBaselineRunner";
import { assertGreen, syntheticSelfTest } from "./temporalLookProjectEvaluator";
import { buildTemporalLookProjectReport } from "./temporalLookProjectReport";
import { temporalLookGateConfig } from "./temporalLookProjectConfig";

const {
  root, baseline, overlayBaseline, partialOverlayBaseline, multiOverlayBaseline, multiAdjustmentBaseline,
  particleLookBaseline, particleMultiAdjustmentBaseline, particleOverlayBaseline,
  particleOverlayMultiAdjustmentBaseline, particlePartialOverlayBaseline,
  particlePartialOverlayMultiAdjustmentBaseline, particleAnimatedOverlayBaseline,
  particleAnimatedOverlayTwoKeyframeBaseline, particleAnimatedOverlayMultiAdjustmentBaseline,
  selfTest, reportPath, compositor,
} = temporalLookGateConfig;

async function main() {
  if (selfTest) return syntheticSelfTest();
  const temporary = await mkdtemp(join(tmpdir(), "editkin-formal-temporal-look-"));
  try {
    const ffmpegPath = resolve(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
    const runtimeBase = { ffmpegPath, nativeCorePath: resolve(root, "native/bin/win32-x64/hao-core.exe"), gpuCompositorPath: compositor, pluginRoots: [] as string[], fontRoot: resolve(root, "public/fonts"), timeoutMs: 120_000 };
    if (await runTemporalLookBaseline({
      temporary, reportPath, compositor, runtimeBase, baseline, overlayBaseline, partialOverlayBaseline, multiOverlayBaseline,
      multiAdjustmentBaseline, particleLookBaseline, particleMultiAdjustmentBaseline, particleOverlayBaseline,
      particleOverlayMultiAdjustmentBaseline, particlePartialOverlayBaseline, particlePartialOverlayMultiAdjustmentBaseline,
      particleAnimatedOverlayBaseline, particleAnimatedOverlayTwoKeyframeBaseline, particleAnimatedOverlayMultiAdjustmentBaseline,
    })) return;
    const mixed = await materializeCase(projectWithTemporalLook(), join(temporary, "mixed"), runtimeBase);
    if (!mixed.clip.gpu?.typography || !mixed.clip.gpu.adjustment) throw new Error("formal temporal look combined receipt missing");
    const worker = mixed.clip.instances[0].worker as { runtime?: string; typographyContract?: string; adjustmentContract?: string; lookContract?: string };
    const renderedDirectory = join(temporary, "mixed/clip-demo-0-gpu-temporal-look-frames"); const extractedDirectory = join(temporary, "mixed-extracted"); await extractFrames(ffmpegPath, mixed.intermediate.assetPath, extractedDirectory);
    let losslessPixelDifferences = 0;
    for (let frame = 0; frame < mixed.clip.frameCount; frame += 1) { const name = `frame-${String(frame).padStart(8, "0")}.png`; const rendered = PNG.sync.read(await readFile(join(renderedDirectory, name))); const decoded = PNG.sync.read(await readFile(join(extractedDirectory, name))); for (let index = 0; index < rendered.data.length; index += 1) if (rendered.data[index] !== decoded.data[index]) losslessPixelDifferences += 1; }
    const typographyOnly = await materializeCase(projectWithTemporalLook({ typography: true, adjustment: false }), join(temporary, "typography"), runtimeBase); const typographyFrames = join(temporary, "typography-extracted"); await extractFrames(ffmpegPath, typographyOnly.intermediate.assetPath, typographyFrames);
    const adjustmentOnly = await materializeCase(projectWithTemporalLook({ typography: false, adjustment: true }), join(temporary, "adjustment"), runtimeBase); const adjustmentFrames = join(temporary, "adjustment-extracted"); await extractFrames(ffmpegPath, adjustmentOnly.intermediate.assetPath, adjustmentFrames);
    const mixedFrame = await readFile(join(extractedDirectory, "frame-00000007.png"));
    const typographyDelta = changedStats(await readFile(join(adjustmentFrames, "frame-00000007.png")), mixedFrame, "typography");
    const adjustmentDelta = changedStats(await readFile(join(typographyFrames, "frame-00000007.png")), mixedFrame, "adjustment");
    const multiAdjustmentMixed = await materializeCase(addSecondAdjustment(projectWithTemporalLook()), join(temporary, "multi-adjustment-mixed"), runtimeBase);
    if (!multiAdjustmentMixed.clip.gpu?.typography || !multiAdjustmentMixed.clip.gpu.adjustment) throw new Error("formal multi-adjustment temporal look combined receipt missing");
    const multiAdjustmentWorker = multiAdjustmentMixed.clip.instances[0].worker as { lookContract?: string; adjustmentContract?: string; adjustmentClipIds?: string[] };
    const multiAdjustmentRenderedDirectory = join(temporary, "multi-adjustment-mixed/clip-demo-0-gpu-temporal-look-frames");
    const multiAdjustmentExtractedDirectory = join(temporary, "multi-adjustment-mixed-extracted");
    await extractFrames(ffmpegPath, multiAdjustmentMixed.intermediate.assetPath, multiAdjustmentExtractedDirectory);
    let multiAdjustmentLosslessPixelDifferences = 0;
    for (let frame = 0; frame < multiAdjustmentMixed.clip.frameCount; frame += 1) {
      const name = `frame-${String(frame).padStart(8, "0")}.png`;
      const rendered = PNG.sync.read(await readFile(join(multiAdjustmentRenderedDirectory, name)));
      const decoded = PNG.sync.read(await readFile(join(multiAdjustmentExtractedDirectory, name)));
      for (let index = 0; index < rendered.data.length; index += 1) if (rendered.data[index] !== decoded.data[index]) multiAdjustmentLosslessPixelDifferences += 1;
    }
    const secondAdjustmentDelta = Object.fromEntries(Object.entries(changedStats(mixedFrame, await readFile(join(multiAdjustmentExtractedDirectory, "frame-00000007.png")), "adjustment"))
      .map(([key, value]) => [key.replace(/^adjustment/, "secondAdjustment"), value]));
    const multiAdjustmentPlanSuppressed = ["adjustment-grade", "adjustment-finish"].every((clipId) =>
      !multiAdjustmentMixed.plan.videoLayers.some((layer) => layer.segments.some((segment) => segment.kind === "clip" && segment.clip.id === clipId)));
    const multiAdjustmentSourceSnapshot = JSON.stringify(multiAdjustmentMixed.project);
    const multiAdjustmentFilteredProject = projectAfterNativeEffectMaterialization(multiAdjustmentMixed.project, multiAdjustmentMixed.receipt);
    const multiAdjustmentProjectSuppressed = !multiAdjustmentFilteredProject.tracks.some((track) => track.clips.some((clip) => clip.id === "adjustment-grade" || clip.id === "adjustment-finish"));
    const multiAdjustmentSourceProjectImmutable = JSON.stringify(multiAdjustmentMixed.project) === multiAdjustmentSourceSnapshot;
    const particleMixed = await materializeCase(addParticleLook(projectWithTemporalLook()), join(temporary, "particle-mixed"), runtimeBase);
    if (!particleMixed.clip.gpu?.particle || !particleMixed.clip.gpu.typography || !particleMixed.clip.gpu.adjustment) throw new Error("formal particle temporal look combined receipt missing");
    const particleWorker = particleMixed.clip.instances[0].worker as { lookContract?: string; particleContract?: string; particleNodeIds?: string[] };
    const particleRenderedDirectory = join(temporary, "particle-mixed/clip-demo-0-gpu-temporal-look-frames");
    const particleExtractedDirectory = join(temporary, "particle-mixed-extracted");
    await extractFrames(ffmpegPath, particleMixed.intermediate.assetPath, particleExtractedDirectory);
    let particleLosslessPixelDifferences = 0;
    for (let frame = 0; frame < particleMixed.clip.frameCount; frame += 1) {
      const name = `frame-${String(frame).padStart(8, "0")}.png`;
      const rendered = PNG.sync.read(await readFile(join(particleRenderedDirectory, name)));
      const decoded = PNG.sync.read(await readFile(join(particleExtractedDirectory, name)));
      for (let index = 0; index < rendered.data.length; index += 1) if (rendered.data[index] !== decoded.data[index]) particleLosslessPixelDifferences += 1;
    }
    const particleDelta = changedStats(mixedFrame, await readFile(join(particleExtractedDirectory, "frame-00000007.png")), "particle");
    const particlePlanSuppressed = particleMixed.plan.captions.length === 0
      && !particleMixed.plan.videoLayers.some((layer) => layer.segments.some((segment) => segment.kind === "clip" && segment.clip.id === "adjustment-grade"));
    const particleSourceSnapshot = JSON.stringify(particleMixed.project);
    const particleFilteredProject = projectAfterNativeEffectMaterialization(particleMixed.project, particleMixed.receipt);
    const particleProjectSuppressed = particleFilteredProject.particleSimulation === undefined
      && !particleFilteredProject.captions.length && !particleFilteredProject.motionGraphics.length
      && !particleFilteredProject.tracks.some((track) => track.clips.some((candidate) => candidate.id === "adjustment-grade"));
    const particleSourceProjectImmutable = JSON.stringify(particleMixed.project) === particleSourceSnapshot;
    const particleMultiAdjustmentMixed = await materializeCase(addSecondAdjustment(addParticleLook(projectWithTemporalLook())), join(temporary, "particle-multi-adjustment-mixed"), runtimeBase);
    if (!particleMultiAdjustmentMixed.clip.gpu?.particle || !particleMultiAdjustmentMixed.clip.gpu.typography || !particleMultiAdjustmentMixed.clip.gpu.adjustment) throw new Error("formal particle multi-adjustment temporal look combined receipt missing");
    const particleMultiAdjustmentWorker = particleMultiAdjustmentMixed.clip.instances[0].worker as { lookContract?: string; adjustmentContract?: string; adjustmentClipIds?: string[] };
    const particleMultiAdjustmentRenderedDirectory = join(temporary, "particle-multi-adjustment-mixed/clip-demo-0-gpu-temporal-look-frames");
    const particleMultiAdjustmentExtractedDirectory = join(temporary, "particle-multi-adjustment-mixed-extracted");
    await extractFrames(ffmpegPath, particleMultiAdjustmentMixed.intermediate.assetPath, particleMultiAdjustmentExtractedDirectory);
    let particleMultiAdjustmentLosslessPixelDifferences = 0;
    for (let frame = 0; frame < particleMultiAdjustmentMixed.clip.frameCount; frame += 1) {
      const name = `frame-${String(frame).padStart(8, "0")}.png`;
      const rendered = PNG.sync.read(await readFile(join(particleMultiAdjustmentRenderedDirectory, name)));
      const decoded = PNG.sync.read(await readFile(join(particleMultiAdjustmentExtractedDirectory, name)));
      for (let index = 0; index < rendered.data.length; index += 1) if (rendered.data[index] !== decoded.data[index]) particleMultiAdjustmentLosslessPixelDifferences += 1;
    }
    const particleSecondAdjustmentDelta = Object.fromEntries(Object.entries(changedStats(
      await readFile(join(particleExtractedDirectory, "frame-00000007.png")),
      await readFile(join(particleMultiAdjustmentExtractedDirectory, "frame-00000007.png")), "adjustment",
    )).map(([key, value]) => [key.replace(/^adjustment/, "particleSecondAdjustment"), value]));
    const particleMultiAdjustmentPlanSuppressed = particleMultiAdjustmentMixed.plan.captions.length === 0
      && ["adjustment-grade", "adjustment-finish"].every((clipId) => !particleMultiAdjustmentMixed.plan.videoLayers
        .some((layer) => layer.segments.some((segment) => segment.kind === "clip" && segment.clip.id === clipId)));
    const particleMultiAdjustmentSourceSnapshot = JSON.stringify(particleMultiAdjustmentMixed.project);
    const particleMultiAdjustmentFilteredProject = projectAfterNativeEffectMaterialization(particleMultiAdjustmentMixed.project, particleMultiAdjustmentMixed.receipt);
    const particleMultiAdjustmentProjectSuppressed = particleMultiAdjustmentFilteredProject.particleSimulation === undefined
      && !particleMultiAdjustmentFilteredProject.captions.length && !particleMultiAdjustmentFilteredProject.motionGraphics.length
      && !particleMultiAdjustmentFilteredProject.tracks.some((track) => track.clips.some((candidate) => candidate.id === "adjustment-grade" || candidate.id === "adjustment-finish"));
    const particleMultiAdjustmentSourceProjectImmutable = JSON.stringify(particleMultiAdjustmentMixed.project) === particleMultiAdjustmentSourceSnapshot;
    const overlayMixed = await materializeCase(projectWithTemporalLook({ overlay: true }), join(temporary, "overlay-mixed"), runtimeBase);
    if (!overlayMixed.clip.gpu?.composite || !overlayMixed.clip.gpu.typography || !overlayMixed.clip.gpu.adjustment) throw new Error("formal temporal overlay look combined receipt missing");
    const overlayWorker = overlayMixed.clip.instances[0].worker as { lookContract?: string; compositeContract?: string };
    const overlayRenderedDirectory = join(temporary, "overlay-mixed/clip-demo-0-gpu-temporal-look-frames");
    const overlayExtractedDirectory = join(temporary, "overlay-mixed-extracted");
    await extractFrames(ffmpegPath, overlayMixed.intermediate.assetPath, overlayExtractedDirectory);
    let overlayLosslessPixelDifferences = 0;
    for (let frame = 0; frame < overlayMixed.clip.frameCount; frame += 1) {
      const name = `frame-${String(frame).padStart(8, "0")}.png`;
      const rendered = PNG.sync.read(await readFile(join(overlayRenderedDirectory, name)));
      const decoded = PNG.sync.read(await readFile(join(overlayExtractedDirectory, name)));
      for (let index = 0; index < rendered.data.length; index += 1) if (rendered.data[index] !== decoded.data[index]) overlayLosslessPixelDifferences += 1;
    }
    const overlayFrame = await readFile(join(overlayExtractedDirectory, "frame-00000007.png"));
    const overlayDelta = changedStats(mixedFrame, overlayFrame, "overlay");
    const overlayPlanSuppressed = overlayMixed.plan.videoLayers.find((layer) => layer.trackId === "track-overlay")?.segments.every((segment) => segment.kind === "gap") === true;
    const overlaySourceSnapshot = JSON.stringify(overlayMixed.project);
    const overlayFilteredProject = projectAfterNativeEffectMaterialization(overlayMixed.project, overlayMixed.receipt);
    const overlayProjectSuppressed = !overlayFilteredProject.tracks.some((track) => track.clips.some((clip) => clip.id === "clip-overlay"));
    const overlaySourceProjectImmutable = JSON.stringify(overlayMixed.project) === overlaySourceSnapshot;
    const particleOverlayMixed = await materializeCase(addParticleLook(projectWithTemporalLook({ overlay: true })), join(temporary, "particle-overlay-mixed"), runtimeBase);
    if (!particleOverlayMixed.clip.gpu?.particle || !particleOverlayMixed.clip.gpu.composite
      || !particleOverlayMixed.clip.gpu.typography || !particleOverlayMixed.clip.gpu.adjustment) throw new Error("formal particle-overlay temporal look combined receipt missing");
    const particleOverlayWorker = particleOverlayMixed.clip.instances[0].worker as {
      lookContract?: string; particleContract?: string; compositeContract?: string; adjustmentContract?: string;
      overlayClipIds?: string[]; particleNodeIds?: string[];
    };
    const particleOverlayRenderedDirectory = join(temporary, "particle-overlay-mixed/clip-demo-0-gpu-temporal-look-frames");
    const particleOverlayExtractedDirectory = join(temporary, "particle-overlay-mixed-extracted");
    await extractFrames(ffmpegPath, particleOverlayMixed.intermediate.assetPath, particleOverlayExtractedDirectory);
    let particleOverlayLosslessPixelDifferences = 0;
    for (let frame = 0; frame < particleOverlayMixed.clip.frameCount; frame += 1) {
      const name = `frame-${String(frame).padStart(8, "0")}.png`;
      const rendered = PNG.sync.read(await readFile(join(particleOverlayRenderedDirectory, name)));
      const decoded = PNG.sync.read(await readFile(join(particleOverlayExtractedDirectory, name)));
      for (let index = 0; index < rendered.data.length; index += 1) if (rendered.data[index] !== decoded.data[index]) particleOverlayLosslessPixelDifferences += 1;
    }
    const particleOverlayFrame = await readFile(join(particleOverlayExtractedDirectory, "frame-00000007.png"));
    const particleOverlayParticleDelta = Object.fromEntries(Object.entries(changedStats(overlayFrame, particleOverlayFrame, "particle"))
      .map(([key, value]) => [key.replace(/^particle/, "particleOverlayParticle"), value]));
    const particleOverlayVideoDelta = Object.fromEntries(Object.entries(changedStats(
      await readFile(join(particleExtractedDirectory, "frame-00000007.png")), particleOverlayFrame, "overlay",
    )).map(([key, value]) => [key.replace(/^overlay/, "particleOverlayVideo"), value]));
    const particleOverlayPlanSuppressed = particleOverlayMixed.plan.captions.length === 0
      && particleOverlayMixed.plan.videoLayers.find((layer) => layer.trackId === "track-overlay")?.segments.every((segment) => segment.kind === "gap") === true
      && !particleOverlayMixed.plan.videoLayers.some((layer) => layer.segments.some((segment) => segment.kind === "clip" && segment.clip.id === "adjustment-grade"));
    const particleOverlaySourceSnapshot = JSON.stringify(particleOverlayMixed.project);
    const particleOverlayFilteredProject = projectAfterNativeEffectMaterialization(particleOverlayMixed.project, particleOverlayMixed.receipt);
    const particleOverlayProjectSuppressed = particleOverlayFilteredProject.particleSimulation === undefined
      && !particleOverlayFilteredProject.captions.length && !particleOverlayFilteredProject.motionGraphics.length
      && !particleOverlayFilteredProject.tracks.some((track) => track.clips.some((candidate) => candidate.id === "clip-overlay" || candidate.id === "adjustment-grade"));
    const particleOverlaySourceProjectImmutable = JSON.stringify(particleOverlayMixed.project) === particleOverlaySourceSnapshot;
    const particleAnimatedOverlayMixed = await materializeCase(
      addSecondAdjustment(addTwoKeyframeAnimatedOverlay(addParticleLook(projectWithTemporalLook({ overlay: true })))),
      join(temporary, "particle-animated-overlay-mixed"), runtimeBase,
    );
    if (!particleAnimatedOverlayMixed.clip.gpu?.particle || !particleAnimatedOverlayMixed.clip.gpu.composite
      || !particleAnimatedOverlayMixed.clip.gpu.typography || !particleAnimatedOverlayMixed.clip.gpu.adjustment) {
      throw new Error("formal particle animated-overlay temporal look combined receipt missing");
    }
    const particleAnimatedOverlayWorker = particleAnimatedOverlayMixed.clip.instances[0].worker as {
      lookContract?: string; particleContract?: string; compositeContract?: string; adjustmentContract?: string;
      overlayAnimationContract?: string; overlayAnimationClipIds?: string[]; overlayAnimationTransformNodeIds?: string[];
      overlayAnimationKeyframeCounts?: Record<string, number>;
    };
    const particleAnimatedOverlayRenderedDirectory = join(temporary, "particle-animated-overlay-mixed/clip-demo-0-gpu-temporal-look-frames");
    const particleAnimatedOverlayExtractedDirectory = join(temporary, "particle-animated-overlay-mixed-extracted");
    await extractFrames(ffmpegPath, particleAnimatedOverlayMixed.intermediate.assetPath, particleAnimatedOverlayExtractedDirectory);
    let particleAnimatedOverlayLosslessPixelDifferences = 0;
    for (let frame = 0; frame < particleAnimatedOverlayMixed.clip.frameCount; frame += 1) {
      const name = `frame-${String(frame).padStart(8, "0")}.png`;
      const rendered = PNG.sync.read(await readFile(join(particleAnimatedOverlayRenderedDirectory, name)));
      const decoded = PNG.sync.read(await readFile(join(particleAnimatedOverlayExtractedDirectory, name)));
      for (let index = 0; index < rendered.data.length; index += 1) if (rendered.data[index] !== decoded.data[index]) particleAnimatedOverlayLosslessPixelDifferences += 1;
    }
    const particleAnimatedOverlayPlanSuppressed = particleAnimatedOverlayMixed.plan.captions.length === 0
      && particleAnimatedOverlayMixed.plan.videoLayers.find((layer) => layer.trackId === "track-overlay")?.segments.every((segment) => segment.kind === "gap") === true
      && ["adjustment-grade", "adjustment-finish"].every((clipId) => !particleAnimatedOverlayMixed.plan.videoLayers
        .some((layer) => layer.segments.some((segment) => segment.kind === "clip" && segment.clip.id === clipId)));
    const particleAnimatedOverlaySourceSnapshot = JSON.stringify(particleAnimatedOverlayMixed.project);
    const particleAnimatedOverlayFilteredProject = projectAfterNativeEffectMaterialization(particleAnimatedOverlayMixed.project, particleAnimatedOverlayMixed.receipt);
    const particleAnimatedOverlayProjectSuppressed = particleAnimatedOverlayFilteredProject.particleSimulation === undefined
      && !particleAnimatedOverlayFilteredProject.captions.length && !particleAnimatedOverlayFilteredProject.motionGraphics.length
      && !particleAnimatedOverlayFilteredProject.tracks.some((track) => track.clips.some((candidate) =>
        candidate.id === "clip-overlay" || candidate.id === "adjustment-grade" || candidate.id === "adjustment-finish"));
    const particleAnimatedOverlaySourceProjectImmutable = JSON.stringify(particleAnimatedOverlayMixed.project) === particleAnimatedOverlaySourceSnapshot;
    const particleOverlayMultiAdjustmentMixed = await materializeCase(
      addSecondAdjustment(addParticleLook(projectWithTemporalLook({ overlay: true }))),
      join(temporary, "particle-overlay-multi-adjustment-mixed"), runtimeBase,
    );
    if (!particleOverlayMultiAdjustmentMixed.clip.gpu?.particle || !particleOverlayMultiAdjustmentMixed.clip.gpu.composite
      || !particleOverlayMultiAdjustmentMixed.clip.gpu.typography || !particleOverlayMultiAdjustmentMixed.clip.gpu.adjustment) {
      throw new Error("formal particle-overlay multi-adjustment temporal look combined receipt missing");
    }
    const particleOverlayMultiAdjustmentWorker = particleOverlayMultiAdjustmentMixed.clip.instances[0].worker as {
      lookContract?: string; particleContract?: string; compositeContract?: string; adjustmentContract?: string;
      overlayClipIds?: string[]; particleNodeIds?: string[];
    };
    const particleOverlayMultiAdjustmentRenderedDirectory = join(temporary, "particle-overlay-multi-adjustment-mixed/clip-demo-0-gpu-temporal-look-frames");
    const particleOverlayMultiAdjustmentExtractedDirectory = join(temporary, "particle-overlay-multi-adjustment-mixed-extracted");
    await extractFrames(ffmpegPath, particleOverlayMultiAdjustmentMixed.intermediate.assetPath, particleOverlayMultiAdjustmentExtractedDirectory);
    let particleOverlayMultiAdjustmentLosslessPixelDifferences = 0;
    for (let frame = 0; frame < particleOverlayMultiAdjustmentMixed.clip.frameCount; frame += 1) {
      const name = `frame-${String(frame).padStart(8, "0")}.png`;
      const rendered = PNG.sync.read(await readFile(join(particleOverlayMultiAdjustmentRenderedDirectory, name)));
      const decoded = PNG.sync.read(await readFile(join(particleOverlayMultiAdjustmentExtractedDirectory, name)));
      for (let index = 0; index < rendered.data.length; index += 1) if (rendered.data[index] !== decoded.data[index]) particleOverlayMultiAdjustmentLosslessPixelDifferences += 1;
    }
    const particleOverlaySecondAdjustmentDelta = Object.fromEntries(Object.entries(changedStats(
      particleOverlayFrame,
      await readFile(join(particleOverlayMultiAdjustmentExtractedDirectory, "frame-00000007.png")), "adjustment",
    )).map(([key, value]) => [key.replace(/^adjustment/, "particleOverlaySecondAdjustment"), value]));
    const particleAnimatedOverlayTransformDelta = Object.fromEntries(Object.entries(changedStats(
      await readFile(join(particleOverlayMultiAdjustmentExtractedDirectory, "frame-00000007.png")),
      await readFile(join(particleAnimatedOverlayExtractedDirectory, "frame-00000007.png")), "overlay",
    )).map(([key, value]) => [key.replace(/^overlay/, "particleAnimatedOverlayTransform"), value]));
    const particleOverlayMultiAdjustmentPlanSuppressed = particleOverlayMultiAdjustmentMixed.plan.captions.length === 0
      && particleOverlayMultiAdjustmentMixed.plan.videoLayers.find((layer) => layer.trackId === "track-overlay")?.segments.every((segment) => segment.kind === "gap") === true
      && ["adjustment-grade", "adjustment-finish"].every((clipId) => !particleOverlayMultiAdjustmentMixed.plan.videoLayers
        .some((layer) => layer.segments.some((segment) => segment.kind === "clip" && segment.clip.id === clipId)));
    const particleOverlayMultiAdjustmentSourceSnapshot = JSON.stringify(particleOverlayMultiAdjustmentMixed.project);
    const particleOverlayMultiAdjustmentFilteredProject = projectAfterNativeEffectMaterialization(
      particleOverlayMultiAdjustmentMixed.project, particleOverlayMultiAdjustmentMixed.receipt,
    );
    const particleOverlayMultiAdjustmentProjectSuppressed = particleOverlayMultiAdjustmentFilteredProject.particleSimulation === undefined
      && !particleOverlayMultiAdjustmentFilteredProject.captions.length && !particleOverlayMultiAdjustmentFilteredProject.motionGraphics.length
      && !particleOverlayMultiAdjustmentFilteredProject.tracks.some((track) => track.clips.some((candidate) =>
        candidate.id === "clip-overlay" || candidate.id === "adjustment-grade" || candidate.id === "adjustment-finish"));
    const particleOverlayMultiAdjustmentSourceProjectImmutable = JSON.stringify(particleOverlayMultiAdjustmentMixed.project) === particleOverlayMultiAdjustmentSourceSnapshot;
    const multiOverlayMixed = await materializeCase(addSecondExactOverlay(projectWithTemporalLook({ overlay: true })), join(temporary, "multi-overlay-mixed"), runtimeBase);
    if (!multiOverlayMixed.clip.gpu?.composite || !multiOverlayMixed.clip.gpu.typography || !multiOverlayMixed.clip.gpu.adjustment) throw new Error("formal multi-overlay temporal look combined receipt missing");
    const multiOverlayWorker = multiOverlayMixed.clip.instances[0].worker as { lookContract?: string; compositeContract?: string; overlayClipIds?: string[] };
    const multiOverlayRenderedDirectory = join(temporary, "multi-overlay-mixed/clip-demo-0-gpu-temporal-look-frames");
    const multiOverlayExtractedDirectory = join(temporary, "multi-overlay-mixed-extracted");
    await extractFrames(ffmpegPath, multiOverlayMixed.intermediate.assetPath, multiOverlayExtractedDirectory);
    let multiOverlayLosslessPixelDifferences = 0;
    for (let frame = 0; frame < multiOverlayMixed.clip.frameCount; frame += 1) {
      const name = `frame-${String(frame).padStart(8, "0")}.png`;
      const rendered = PNG.sync.read(await readFile(join(multiOverlayRenderedDirectory, name)));
      const decoded = PNG.sync.read(await readFile(join(multiOverlayExtractedDirectory, name)));
      for (let index = 0; index < rendered.data.length; index += 1) if (rendered.data[index] !== decoded.data[index]) multiOverlayLosslessPixelDifferences += 1;
    }
    const secondOverlayDelta = Object.fromEntries(Object.entries(changedStats(overlayFrame, await readFile(join(multiOverlayExtractedDirectory, "frame-00000007.png")), "overlay"))
      .map(([key, value]) => [key.replace(/^overlay/, "secondOverlay"), value]));
    const multiOverlayPlanSuppressed = ["track-overlay", "track-overlay-two"].every((trackId) => multiOverlayMixed.plan.videoLayers.find((layer) => layer.trackId === trackId)?.segments.every((segment) => segment.kind === "gap") === true);
    const multiOverlaySourceSnapshot = JSON.stringify(multiOverlayMixed.project);
    const multiOverlayFilteredProject = projectAfterNativeEffectMaterialization(multiOverlayMixed.project, multiOverlayMixed.receipt);
    const multiOverlayProjectSuppressed = !multiOverlayFilteredProject.tracks.some((track) => track.clips.some((clip) => clip.id === "clip-overlay" || clip.id === "clip-overlay-two"));
    const multiOverlaySourceProjectImmutable = JSON.stringify(multiOverlayMixed.project) === multiOverlaySourceSnapshot;
    const partialProject = projectWithTemporalLook({ overlay: true });
    const partialAuthoredOverlay = partialProject.tracks.find((track) => track.id === "track-overlay")!.clips[0];
    partialAuthoredOverlay.timelineStart = .2;
    partialAuthoredOverlay.duration = .6;
    const partialMixed = await materializeCase(partialProject, join(temporary, "partial-overlay"), runtimeBase);
    if (!partialMixed.clip.gpu?.composite || !partialMixed.clip.gpu.typography || !partialMixed.clip.gpu.adjustment) throw new Error("formal partial temporal overlay look combined receipt missing");
    const partialWorker = partialMixed.clip.instances[0].worker as { lookContract?: string; compositeContract?: string };
    const partialRenderedDirectory = join(temporary, "partial-overlay/clip-demo-0-gpu-temporal-look-frames");
    const partialExtractedDirectory = join(temporary, "partial-overlay-extracted");
    await extractFrames(ffmpegPath, partialMixed.intermediate.assetPath, partialExtractedDirectory);
    let partialOverlayLosslessPixelDifferences = 0;
    for (let frame = 0; frame < partialMixed.clip.frameCount; frame += 1) {
      const name = `frame-${String(frame).padStart(8, "0")}.png`;
      const rendered = PNG.sync.read(await readFile(join(partialRenderedDirectory, name)));
      const decoded = PNG.sync.read(await readFile(join(partialExtractedDirectory, name)));
      for (let index = 0; index < rendered.data.length; index += 1) if (rendered.data[index] !== decoded.data[index]) partialOverlayLosslessPixelDifferences += 1;
    }
    const partialOverlayDelta = changedStats(mixedFrame, await readFile(join(partialExtractedDirectory, "frame-00000007.png")), "overlay");
    const partialInactive = PNG.sync.read(await readFile(join(partialExtractedDirectory, "frame-00000004.png")));
    const oneVideoInactive = PNG.sync.read(await readFile(join(extractedDirectory, "frame-00000004.png")));
    let partialOverlayInactivePixelDifferences = 0;
    for (let index = 0; index < partialInactive.data.length; index += 1) if (partialInactive.data[index] !== oneVideoInactive.data[index]) partialOverlayInactivePixelDifferences += 1;
    const partialOverlaySegments = partialMixed.plan.videoLayers.find((layer) => layer.trackId === "track-overlay")?.segments ?? [];
    const segmentFramesInside = (kind: "gap" | "clip", start: number, end: number) => Math.round(partialOverlaySegments.filter((segment) => segment.kind === kind)
      .reduce((sum, segment) => sum + Math.max(0, Math.min(segment.start + segment.duration, end) - Math.max(segment.start, start)), 0) * partialProject.fps);
    const partialSourceSnapshot = JSON.stringify(partialMixed.project);
    const partialFilteredProject = projectAfterNativeEffectMaterialization(partialMixed.project, partialMixed.receipt);
    const partialOverlayProjectClips = partialFilteredProject.tracks.find((track) => track.id === "track-overlay")?.clips ?? [];
    const partialOverlayProjectTail = partialOverlayProjectClips.length === 1 ? {
      timelineStart: partialOverlayProjectClips[0].timelineStart,
      sourceStart: partialOverlayProjectClips[0].sourceStart,
      duration: partialOverlayProjectClips[0].duration,
    } : undefined;
    const particlePartialProject = addParticleLook(projectWithTemporalLook({ overlay: true }));
    const particlePartialAuthoredOverlay = particlePartialProject.tracks.find((track) => track.id === "track-overlay")!.clips[0];
    particlePartialAuthoredOverlay.timelineStart = .2;
    particlePartialAuthoredOverlay.duration = .6;
    const particlePartialMixed = await materializeCase(particlePartialProject, join(temporary, "particle-partial-overlay"), runtimeBase);
    if (!particlePartialMixed.clip.gpu?.particle || !particlePartialMixed.clip.gpu.composite
      || !particlePartialMixed.clip.gpu.typography || !particlePartialMixed.clip.gpu.adjustment) throw new Error("formal particle partial-overlay temporal look combined receipt missing");
    const particlePartialWorker = particlePartialMixed.clip.instances[0].worker as {
      lookContract?: string; particleContract?: string; compositeContract?: string; adjustmentContract?: string;
      overlayClipIds?: string[]; particleNodeIds?: string[];
    };
    const particlePartialRenderedDirectory = join(temporary, "particle-partial-overlay/clip-demo-0-gpu-temporal-look-frames");
    const particlePartialExtractedDirectory = join(temporary, "particle-partial-overlay-extracted");
    await extractFrames(ffmpegPath, particlePartialMixed.intermediate.assetPath, particlePartialExtractedDirectory);
    let particlePartialOverlayLosslessPixelDifferences = 0;
    for (let frame = 0; frame < particlePartialMixed.clip.frameCount; frame += 1) {
      const name = `frame-${String(frame).padStart(8, "0")}.png`;
      const rendered = PNG.sync.read(await readFile(join(particlePartialRenderedDirectory, name)));
      const decoded = PNG.sync.read(await readFile(join(particlePartialExtractedDirectory, name)));
      for (let index = 0; index < rendered.data.length; index += 1) if (rendered.data[index] !== decoded.data[index]) particlePartialOverlayLosslessPixelDifferences += 1;
    }
    const particlePartialFrame = await readFile(join(particlePartialExtractedDirectory, "frame-00000007.png"));
    const particlePartialOverlayParticleDelta = Object.fromEntries(Object.entries(changedStats(
      await readFile(join(partialExtractedDirectory, "frame-00000007.png")), particlePartialFrame, "particle",
    )).map(([key, value]) => [key.replace(/^particle/, "particlePartialOverlayParticle"), value]));
    const particlePartialOverlayVideoDelta = Object.fromEntries(Object.entries(changedStats(
      await readFile(join(particleExtractedDirectory, "frame-00000007.png")), particlePartialFrame, "overlay",
    )).map(([key, value]) => [key.replace(/^overlay/, "particlePartialOverlayVideo"), value]));
    const particlePartialInactive = PNG.sync.read(await readFile(join(particlePartialExtractedDirectory, "frame-00000004.png")));
    const particleOnlyInactive = PNG.sync.read(await readFile(join(particleExtractedDirectory, "frame-00000004.png")));
    let particlePartialOverlayInactivePixelDifferences = 0;
    for (let index = 0; index < particlePartialInactive.data.length; index += 1) if (particlePartialInactive.data[index] !== particleOnlyInactive.data[index]) particlePartialOverlayInactivePixelDifferences += 1;
    const particlePartialOverlaySegments = particlePartialMixed.plan.videoLayers.find((layer) => layer.trackId === "track-overlay")?.segments ?? [];
    const particlePartialSegmentFramesInside = (kind: "gap" | "clip", start: number, end: number) => Math.round(particlePartialOverlaySegments.filter((segment) => segment.kind === kind)
      .reduce((sum, segment) => sum + Math.max(0, Math.min(segment.start + segment.duration, end) - Math.max(segment.start, start)), 0) * particlePartialProject.fps);
    const particlePartialSourceSnapshot = JSON.stringify(particlePartialMixed.project);
    const particlePartialFilteredProject = projectAfterNativeEffectMaterialization(particlePartialMixed.project, particlePartialMixed.receipt);
    const particlePartialProjectClips = particlePartialFilteredProject.tracks.find((track) => track.id === "track-overlay")?.clips ?? [];
    const particlePartialOverlayProjectTail = particlePartialProjectClips.length === 1 ? {
      timelineStart: particlePartialProjectClips[0].timelineStart,
      sourceStart: particlePartialProjectClips[0].sourceStart,
      duration: particlePartialProjectClips[0].duration,
    } : undefined;
    const particlePartialOverlayPlanSuppressed = particlePartialMixed.plan.captions.length === 0
      && particlePartialSegmentFramesInside("gap", .2, .5) === 9 && particlePartialSegmentFramesInside("clip", .5, .8) === 9
      && !particlePartialMixed.plan.videoLayers.some((layer) => layer.segments.some((segment) => segment.kind === "clip" && segment.clip.id === "adjustment-grade"));
    const particlePartialOverlayProjectSuppressed = particlePartialFilteredProject.particleSimulation === undefined
      && !particlePartialFilteredProject.captions.length && !particlePartialFilteredProject.motionGraphics.length
      && !particlePartialFilteredProject.tracks.some((track) => track.clips.some((candidate) => candidate.id === "adjustment-grade"))
      && particlePartialProjectClips.length === 1;
    const particlePartialOverlaySourceProjectImmutable = JSON.stringify(particlePartialMixed.project) === particlePartialSourceSnapshot;
    const particlePartialOverlayMultiAdjustmentProject = addSecondAdjustment(addParticleLook(projectWithTemporalLook({ overlay: true })));
    const particlePartialOverlayMultiAdjustmentAuthoredOverlay = particlePartialOverlayMultiAdjustmentProject.tracks.find((track) => track.id === "track-overlay")!.clips[0];
    particlePartialOverlayMultiAdjustmentAuthoredOverlay.timelineStart = .2;
    particlePartialOverlayMultiAdjustmentAuthoredOverlay.duration = .6;
    const particlePartialOverlayMultiAdjustmentMixed = await materializeCase(
      particlePartialOverlayMultiAdjustmentProject, join(temporary, "particle-partial-overlay-multi-adjustment"), runtimeBase,
    );
    if (!particlePartialOverlayMultiAdjustmentMixed.clip.gpu?.particle || !particlePartialOverlayMultiAdjustmentMixed.clip.gpu.composite
      || !particlePartialOverlayMultiAdjustmentMixed.clip.gpu.typography || !particlePartialOverlayMultiAdjustmentMixed.clip.gpu.adjustment) {
      throw new Error("formal particle partial-overlay multi-adjustment temporal look combined receipt missing");
    }
    const particlePartialOverlayMultiAdjustmentWorker = particlePartialOverlayMultiAdjustmentMixed.clip.instances[0].worker as {
      lookContract?: string; particleContract?: string; compositeContract?: string; adjustmentContract?: string;
      overlayClipIds?: string[]; particleNodeIds?: string[];
    };
    const particlePartialOverlayMultiAdjustmentRenderedDirectory = join(temporary, "particle-partial-overlay-multi-adjustment/clip-demo-0-gpu-temporal-look-frames");
    const particlePartialOverlayMultiAdjustmentExtractedDirectory = join(temporary, "particle-partial-overlay-multi-adjustment-extracted");
    await extractFrames(ffmpegPath, particlePartialOverlayMultiAdjustmentMixed.intermediate.assetPath, particlePartialOverlayMultiAdjustmentExtractedDirectory);
    let particlePartialOverlayMultiAdjustmentLosslessPixelDifferences = 0;
    for (let frame = 0; frame < particlePartialOverlayMultiAdjustmentMixed.clip.frameCount; frame += 1) {
      const name = `frame-${String(frame).padStart(8, "0")}.png`;
      const rendered = PNG.sync.read(await readFile(join(particlePartialOverlayMultiAdjustmentRenderedDirectory, name)));
      const decoded = PNG.sync.read(await readFile(join(particlePartialOverlayMultiAdjustmentExtractedDirectory, name)));
      for (let index = 0; index < rendered.data.length; index += 1) if (rendered.data[index] !== decoded.data[index]) particlePartialOverlayMultiAdjustmentLosslessPixelDifferences += 1;
    }
    const particlePartialOverlaySecondAdjustmentDelta = Object.fromEntries(Object.entries(changedStats(
      particlePartialFrame,
      await readFile(join(particlePartialOverlayMultiAdjustmentExtractedDirectory, "frame-00000007.png")), "adjustment",
    )).map(([key, value]) => [key.replace(/^adjustment/, "particlePartialOverlaySecondAdjustment"), value]));
    const particlePartialOverlayMultiAdjustmentSegments = particlePartialOverlayMultiAdjustmentMixed.plan.videoLayers.find((layer) => layer.trackId === "track-overlay")?.segments ?? [];
    const particlePartialOverlayMultiAdjustmentSegmentFramesInside = (kind: "gap" | "clip", start: number, end: number) => Math.round(particlePartialOverlayMultiAdjustmentSegments.filter((segment) => segment.kind === kind)
      .reduce((sum, segment) => sum + Math.max(0, Math.min(segment.start + segment.duration, end) - Math.max(segment.start, start)), 0) * particlePartialOverlayMultiAdjustmentProject.fps);
    const particlePartialOverlayMultiAdjustmentSourceSnapshot = JSON.stringify(particlePartialOverlayMultiAdjustmentMixed.project);
    const particlePartialOverlayMultiAdjustmentFilteredProject = projectAfterNativeEffectMaterialization(
      particlePartialOverlayMultiAdjustmentMixed.project, particlePartialOverlayMultiAdjustmentMixed.receipt,
    );
    const particlePartialOverlayMultiAdjustmentProjectClips = particlePartialOverlayMultiAdjustmentFilteredProject.tracks.find((track) => track.id === "track-overlay")?.clips ?? [];
    const particlePartialOverlayMultiAdjustmentProjectTail = particlePartialOverlayMultiAdjustmentProjectClips.length === 1 ? {
      timelineStart: particlePartialOverlayMultiAdjustmentProjectClips[0].timelineStart,
      sourceStart: particlePartialOverlayMultiAdjustmentProjectClips[0].sourceStart,
      duration: particlePartialOverlayMultiAdjustmentProjectClips[0].duration,
    } : undefined;
    const particlePartialOverlayMultiAdjustmentPlanSuppressed = particlePartialOverlayMultiAdjustmentMixed.plan.captions.length === 0
      && particlePartialOverlayMultiAdjustmentSegmentFramesInside("gap", .2, .5) === 9
      && particlePartialOverlayMultiAdjustmentSegmentFramesInside("clip", .5, .8) === 9
      && ["adjustment-grade", "adjustment-finish"].every((clipId) => !particlePartialOverlayMultiAdjustmentMixed.plan.videoLayers
        .some((layer) => layer.segments.some((segment) => segment.kind === "clip" && segment.clip.id === clipId)));
    const particlePartialOverlayMultiAdjustmentProjectSuppressed = particlePartialOverlayMultiAdjustmentFilteredProject.particleSimulation === undefined
      && !particlePartialOverlayMultiAdjustmentFilteredProject.captions.length && !particlePartialOverlayMultiAdjustmentFilteredProject.motionGraphics.length
      && !particlePartialOverlayMultiAdjustmentFilteredProject.tracks.some((track) => track.clips.some((candidate) =>
        candidate.id === "adjustment-grade" || candidate.id === "adjustment-finish"))
      && particlePartialOverlayMultiAdjustmentProjectClips.length === 1;
    const particlePartialOverlayMultiAdjustmentSourceProjectImmutable = JSON.stringify(particlePartialOverlayMultiAdjustmentMixed.project) === particlePartialOverlayMultiAdjustmentSourceSnapshot;
    const rejectedNegativeControls: string[] = [];
    const negativeProject = () => projectWithTemporalLook();
    try { const project = negativeProject(); await materializeNativeEffectSegments(project, buildRenderPlan(project, (uri) => uri), { ...runtimeBase, gpuCompositorPath: undefined, workspace: join(temporary, "missing-runtime") }); } catch (error) { if (!/缺少 GPU compositor runtime/.test(String(error))) throw error; rejectedNegativeControls.push("missing-runtime"); }
    const translation = negativeProject(); translation.captions[0].translation = { text: "Second colour", language: "en" }; if (buildGpuEngineVideoPreviewGraph(translation, 0) === undefined) rejectedNegativeControls.push("translation");
    const outside = negativeProject(); outside.captions[0].start = .45; outside.captions[0].duration = .2; if (buildGpuEngineVideoPreviewGraph(outside, 0) === undefined) rejectedNegativeControls.push("outside-range");
    const stacked = addSecondAdjustment(negativeProject()); const third = structuredClone(stacked.tracks.at(-1)!.clips[0]); third.id = "adjustment-three"; third.trackId = "track-adjustment-three"; stacked.tracks.push({ id: third.trackId, name: "Adjustment 3", kind: "video", locked: false, muted: false, clips: [third] }); if (buildGpuEngineVideoPreviewGraph(stacked, 0) === undefined) rejectedNegativeControls.push("third-adjustment");
    const animatedPartial = projectWithTemporalLook({ overlay: true }); const animatedPartialClip = animatedPartial.tracks.find((track) => track.id === "track-overlay")!.clips[0]; animatedPartialClip.timelineStart = .2; animatedPartialClip.duration = .6;
    animatedPartialClip.keyframes = [{ id: "unsafe-overlay-animation", time: .3, transform: { ...animatedPartialClip.transform, opacity: .5 }, color: { ...animatedPartialClip.color }, easing: "linear" }];
    const animatedPartialPlan = buildRenderPlan(animatedPartial, (uri) => uri); const animatedPartialReceipt = await materializeNativeEffectSegments(animatedPartial, animatedPartialPlan, { ...runtimeBase, workspace: join(temporary, "animated-partial-overlay") });
    if ((animatedPartialReceipt?.clips[0].instances[0].worker as { lookContract?: string } | undefined)?.lookContract !== "decoded-temporal-partial-video-overlay-typography-adjustment/v1"
      && animatedPartialPlan.videoLayers.find((layer) => layer.trackId === "track-overlay")?.segments.some((segment) => segment.kind === "clip" && segment.start < .5 && segment.start + segment.duration > .2)) rejectedNegativeControls.push("animated-partial-overlay");
    const thirdOverlay = addSecondExactOverlay(projectWithTemporalLook({ overlay: true }));
    const thirdOverlaySource = thirdOverlay.tracks.find((track) => track.id === "track-overlay-two")!.clips[0];
    const thirdOverlayAsset = { ...structuredClone(thirdOverlay.assets.find((asset) => asset.id === thirdOverlaySource.assetId)!), id: "asset-overlay-three" };
    thirdOverlay.assets.push(thirdOverlayAsset);
    const thirdOverlayClip = { ...structuredClone(thirdOverlaySource), id: "clip-overlay-three", trackId: "track-overlay-three", assetId: thirdOverlayAsset.id };
    const thirdOverlayAdjustmentIndex = thirdOverlay.tracks.findIndex((track) => track.clips.some((candidate) => candidate.layer?.role === "adjustment"));
    thirdOverlay.tracks.splice(thirdOverlayAdjustmentIndex, 0, { id: "track-overlay-three", name: "Overlay 3", kind: "video", locked: false, muted: false, clips: [thirdOverlayClip] });
    if (buildGpuEngineVideoPreviewGraph(thirdOverlay, 0) === undefined) rejectedNegativeControls.push("third-overlay");
    const targeted = negativeProject(); const targetedPlan = buildRenderPlan(targeted, (uri) => uri); const targetedReceipt = await materializeNativeEffectSegments(targeted, targetedPlan, { ...runtimeBase, workspace: join(temporary, "targeted"), targetClipIds: new Set(["clip-demo"]) });
    if (!(targetedReceipt?.clips[0].gpu?.typography && targetedReceipt.clips[0].gpu?.adjustment) && targetedPlan.captions.length === 1 && targetedPlan.videoLayers.some((layer) => layer.segments.some((segment) => segment.kind === "clip" && segment.clip.id === "adjustment-grade"))) rejectedNegativeControls.push("targeted-fallback");
    const fifthParticle = addParticleLook(negativeProject());
    const { schema: _particleSchema, enabled: _particleEnabled, additionalEmitters: _particleAdditional, ...primaryParticle } = fifthParticle.particleSimulation!;
    fifthParticle.particleSimulation!.additionalEmitters = [1, 2, 3, 4].map((offset) => ({
      id: `extra-${offset}`, ...structuredClone(primaryParticle), seed: primaryParticle.seed + offset,
    }));
    if (buildGpuEngineVideoPreviewGraph(fifthParticle, 0) === undefined) rejectedNegativeControls.push("fifth-particle");
    const particleOutside = addParticleLook(negativeProject()); particleOutside.particleSimulation!.timeline = { start: 12 / 30, duration: 6 / 30 };
    if (buildGpuEngineVideoPreviewGraph(particleOutside, 0) === undefined) rejectedNegativeControls.push("particle-outside-range");
    const particleThirdAdjustment = addSecondAdjustment(addParticleLook(negativeProject()));
    const particleThird = structuredClone(particleThirdAdjustment.tracks.find((track) => track.id === "track-adjustment-finish")!.clips[0]);
    particleThird.id = "particle-adjustment-three"; particleThird.trackId = "track-particle-adjustment-three";
    particleThirdAdjustment.tracks.push({ id: particleThird.trackId, name: "Particle Adjustment 3", kind: "video", locked: false, muted: false, clips: [particleThird] });
    if (buildGpuEngineVideoPreviewGraph(particleThirdAdjustment, 0) === undefined) rejectedNegativeControls.push("particle-third-adjustment");
    const particlePartialVideoOverlayThirdAdjustment = addSecondAdjustment(addParticleLook(projectWithTemporalLook({ overlay: true })));
    const particlePartialVideoOverlayClip = particlePartialVideoOverlayThirdAdjustment.tracks.find((track) => track.id === "track-overlay")!.clips[0];
    particlePartialVideoOverlayClip.timelineStart = .2; particlePartialVideoOverlayClip.duration = .6;
    const particlePartialThird = structuredClone(particlePartialVideoOverlayThirdAdjustment.tracks.find((track) => track.id === "track-adjustment-finish")!.clips[0]);
    particlePartialThird.id = "particle-partial-adjustment-three"; particlePartialThird.trackId = "track-particle-partial-adjustment-three";
    particlePartialVideoOverlayThirdAdjustment.tracks.push({ id: particlePartialThird.trackId, name: "Particle Partial Adjustment 3", kind: "video", locked: false, muted: false, clips: [particlePartialThird] });
    if (buildGpuEngineVideoPreviewGraph(particlePartialVideoOverlayThirdAdjustment, 0) === undefined) rejectedNegativeControls.push("particle-partial-video-overlay-third-adjustment");
    const particleNonOverlappingVideoOverlay = addParticleLook(projectWithTemporalLook({ overlay: true }));
    const particleNonOverlappingOverlayClip = particleNonOverlappingVideoOverlay.tracks.find((track) => track.id === "track-overlay")!.clips[0];
    particleNonOverlappingOverlayClip.timelineStart = .6; particleNonOverlappingOverlayClip.duration = .3;
    if (buildGpuEngineVideoPreviewGraph(particleNonOverlappingVideoOverlay, 0) === undefined) rejectedNegativeControls.push("particle-non-overlapping-video-overlay");
    const particleBudget = addParticleLook(projectWithTemporalLook({ overlay: true }));
    particleBudget.particleSimulation!.maxParticles = 193;
    if (buildGpuEngineVideoPreviewGraph(particleBudget, 0) === undefined) rejectedNegativeControls.push("particle-budget");
    const particleThirdOverlayKeyframe = addTwoKeyframeAnimatedOverlay(addParticleLook(projectWithTemporalLook({ overlay: true })));
    const particleThirdOverlayKeyframeClip = particleThirdOverlayKeyframe.tracks.find((track) => track.id === "track-overlay")!.clips[0];
    particleThirdOverlayKeyframeClip.keyframes.push({
      id: "overlay-transform-third", time: 14 / 30,
      transform: { ...particleThirdOverlayKeyframeClip.transform, x: 40, y: 55, scale: .36, rotation: -3, opacity: .9 },
      color: { ...particleThirdOverlayKeyframeClip.color }, easing: "linear",
    });
    if (buildGpuEngineVideoPreviewGraph(particleThirdOverlayKeyframe, 0) === undefined) rejectedNegativeControls.push("particle-third-overlay-keyframe");
    const particleAnimatedOverlayThirdAdjustment = addSecondAdjustment(addTwoKeyframeAnimatedOverlay(addParticleLook(projectWithTemporalLook({ overlay: true }))));
    const animatedThirdAdjustment = structuredClone(particleAnimatedOverlayThirdAdjustment.tracks.find((track) => track.id === "track-adjustment-finish")!.clips[0]);
    animatedThirdAdjustment.id = "particle-animated-adjustment-three"; animatedThirdAdjustment.trackId = "track-particle-animated-adjustment-three";
    particleAnimatedOverlayThirdAdjustment.tracks.push({ id: animatedThirdAdjustment.trackId, name: "Animated Overlay Adjustment 3", kind: "video", locked: false, muted: false, clips: [animatedThirdAdjustment] });
    if (buildGpuEngineVideoPreviewGraph(particleAnimatedOverlayThirdAdjustment, 0) === undefined) rejectedNegativeControls.push("particle-animated-overlay-third-adjustment");
    const typography = mixed.clip.gpu.typography; const adjustment = mixed.clip.gpu.adjustment; const filteredProject = projectAfterNativeEffectMaterialization(mixed.project, mixed.receipt);
    const materializedClipReset = mixed.intermediate.clip.sourceStart === 0 && !mixed.intermediate.clip.keyframes.length && mixed.intermediate.clip.transform.x === 0 && mixed.intermediate.clip.creative?.nativeEffectInstances?.length === 0;
    const sourceSnapshot = JSON.stringify(mixed.project);
    const report = await buildTemporalLookProjectReport({
      adjustmentDelta, filteredProject, losslessPixelDifferences, materializedClipReset, mixed, multiAdjustmentLosslessPixelDifferences,
      multiAdjustmentMixed, multiAdjustmentPlanSuppressed, multiAdjustmentProjectSuppressed, multiAdjustmentSourceProjectImmutable, multiAdjustmentWorker, multiOverlayLosslessPixelDifferences,
      multiOverlayMixed, multiOverlayPlanSuppressed, multiOverlayProjectSuppressed, multiOverlaySourceProjectImmutable, multiOverlayWorker, overlayDelta,
      overlayLosslessPixelDifferences, overlayMixed, overlayPlanSuppressed, overlayProjectSuppressed, overlaySourceProjectImmutable, overlayWorker,
      partialFilteredProject, partialMixed, partialOverlayDelta, partialOverlayInactivePixelDifferences, partialOverlayLosslessPixelDifferences, partialOverlayProjectTail,
      partialSourceSnapshot, partialWorker, particleAnimatedOverlayLosslessPixelDifferences, particleAnimatedOverlayMixed, particleAnimatedOverlayPlanSuppressed, particleAnimatedOverlayProjectSuppressed,
      particleAnimatedOverlaySourceProjectImmutable, particleAnimatedOverlayTransformDelta, particleAnimatedOverlayWorker, particleDelta, particleLosslessPixelDifferences, particleMixed,
      particleMultiAdjustmentLosslessPixelDifferences, particleMultiAdjustmentMixed, particleMultiAdjustmentPlanSuppressed, particleMultiAdjustmentProjectSuppressed, particleMultiAdjustmentSourceProjectImmutable, particleMultiAdjustmentWorker,
      particleOverlayLosslessPixelDifferences, particleOverlayMixed, particleOverlayMultiAdjustmentLosslessPixelDifferences, particleOverlayMultiAdjustmentMixed, particleOverlayMultiAdjustmentPlanSuppressed, particleOverlayMultiAdjustmentProjectSuppressed,
      particleOverlayMultiAdjustmentSourceProjectImmutable, particleOverlayMultiAdjustmentWorker, particleOverlayParticleDelta, particleOverlayPlanSuppressed, particleOverlayProjectSuppressed, particleOverlaySecondAdjustmentDelta,
      particleOverlaySourceProjectImmutable, particleOverlayVideoDelta, particleOverlayWorker, particlePartialMixed, particlePartialOverlayInactivePixelDifferences, particlePartialOverlayLosslessPixelDifferences,
      particlePartialOverlayMultiAdjustmentLosslessPixelDifferences, particlePartialOverlayMultiAdjustmentMixed, particlePartialOverlayMultiAdjustmentPlanSuppressed, particlePartialOverlayMultiAdjustmentProjectSuppressed, particlePartialOverlayMultiAdjustmentProjectTail, particlePartialOverlayMultiAdjustmentSegmentFramesInside,
      particlePartialOverlayMultiAdjustmentSourceProjectImmutable, particlePartialOverlayMultiAdjustmentWorker, particlePartialOverlayParticleDelta, particlePartialOverlayPlanSuppressed, particlePartialOverlayProjectSuppressed, particlePartialOverlayProjectTail,
      particlePartialOverlaySecondAdjustmentDelta, particlePartialOverlaySourceProjectImmutable, particlePartialOverlayVideoDelta, particlePartialSegmentFramesInside, particlePartialWorker, particlePlanSuppressed,
      particleProjectSuppressed, particleSecondAdjustmentDelta, particleSourceProjectImmutable, particleWorker, rejectedNegativeControls, secondAdjustmentDelta,
      secondOverlayDelta, segmentFramesInside, sourceSnapshot, typographyDelta, worker,
      typography, adjustment,
    });
    await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); assertGreen(report); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

await main();

