import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { PNG } from "pngjs";
import { createDemoProject } from "../src/domain/demo";
import { createTransformMotionBlurInstance } from "../src/domain/transformMotionBlur";
import { DEFAULT_PARTICLE_SIMULATION, type EditProject } from "../src/domain/types";
import { materializeNativeEffectSegments, projectAfterNativeEffectMaterialization } from "../src/plugins/nativeEffectRender";
import { buildGpuEngineVideoPreviewGraph } from "../src/render/gpuCompositor";
import { buildRenderPlan } from "../src/render/planner";
import type { TemporalLookBaselineOptions } from "./temporalLookProjectRenderBaselines";
import {
  addAnimatedOverlay, addParticleLook, addSecondAdjustment, addSecondExactOverlay, addTwoKeyframeAnimatedOverlay,
  changedStats, extractFrames, materializeCase, projectWithTemporalLook,
} from "./temporalLookProjectRenderBaselines";

const root = resolve(import.meta.dirname, "..");
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

export async function runTemporalLookBaseline(options: TemporalLookBaselineOptions): Promise<boolean> {
  const { temporary, reportPath, compositor, runtimeBase, baseline, overlayBaseline, partialOverlayBaseline, multiOverlayBaseline, multiAdjustmentBaseline, particleLookBaseline, particleMultiAdjustmentBaseline, particleOverlayBaseline, particleOverlayMultiAdjustmentBaseline, particlePartialOverlayBaseline, particlePartialOverlayMultiAdjustmentBaseline, particleAnimatedOverlayBaseline, particleAnimatedOverlayTwoKeyframeBaseline, particleAnimatedOverlayMultiAdjustmentBaseline } = options;
    if (particleAnimatedOverlayBaseline || particleAnimatedOverlayTwoKeyframeBaseline || particleAnimatedOverlayMultiAdjustmentBaseline) {
      const multiAdjustment = particleAnimatedOverlayMultiAdjustmentBaseline;
      const twoKeyframes = particleAnimatedOverlayTwoKeyframeBaseline || multiAdjustment;
      const animatedProject = (twoKeyframes ? addTwoKeyframeAnimatedOverlay : addAnimatedOverlay)(addParticleLook(projectWithTemporalLook({ overlay: true })));
      const project = multiAdjustment ? addSecondAdjustment(animatedProject) : animatedProject;
      const expectedContract = multiAdjustment
        ? "decoded-temporal-animated-video-overlay-particle-typography-multi-adjustment/v1"
        : twoKeyframes
        ? "decoded-temporal-two-keyframe-video-overlay-particle-typography-adjustment/v1"
        : "decoded-temporal-animated-video-overlay-particle-typography-adjustment/v1";
      const expectedKeyframeCount = twoKeyframes ? 2 : 1;
      const sourceSnapshot = JSON.stringify(project);
      const plan = buildRenderPlan(project, (uri) => uri);
      const graph = buildGpuEngineVideoPreviewGraph(project, 0)?.graph;
      let receipt: Awaited<ReturnType<typeof materializeNativeEffectSegments>>;
      let rejection = "";
      try {
        receipt = await materializeNativeEffectSegments(project, plan, { ...runtimeBase, workspace: join(temporary, "particle-animated-overlay-baseline") });
      } catch (error) {
        rejection = String(error);
      }
      const worker = receipt?.clips[0]?.instances[0]?.worker as { lookContract?: string; particleContract?: string; compositeContract?: string; overlayAnimationContract?: string; adjustmentContract?: string } | undefined;
      const filteredProject = projectAfterNativeEffectMaterialization(project, receipt);
      const report = {
        schema: multiAdjustment ? "editkin.temporal-particle-animated-overlay-multi-adjustment-look-baseline/v1" : twoKeyframes ? "editkin.temporal-particle-animated-overlay-two-keyframe-look-baseline/v1" : "editkin.temporal-particle-animated-overlay-look-baseline/v1", measuredAt: new Date().toISOString(), status: "BLOCK",
        expectedContract,
        expectedKeyframeCount,
        expectedAnimationContract: "decoded-temporal-video-overlay-transform-animation/v1",
        expectedParticleContract: "decoded-temporal-particle-overlay/v1",
        expectedCompositeContract: "decoded-temporal-video-overlay/v1",
        expectedAdjustmentContract: multiAdjustment ? "decoded-temporal-pre-typography-multi-adjustment/v1" : "decoded-temporal-pre-typography-adjustment/v1",
        graphBuilt: Boolean(graph),
        combinedReceipt: worker?.lookContract === expectedContract,
        animationReceipt: worker?.overlayAnimationContract === "decoded-temporal-video-overlay-transform-animation/v1",
        particleReceipt: worker?.particleContract === "decoded-temporal-particle-overlay/v1",
        compositeReceipt: worker?.compositeContract === "decoded-temporal-video-overlay/v1",
        adjustmentReceipt: worker?.adjustmentContract === (multiAdjustment ? "decoded-temporal-pre-typography-multi-adjustment/v1" : "decoded-temporal-pre-typography-adjustment/v1"),
        overlayPlanStillActive: plan.videoLayers.some((layer) => layer.trackId === "track-overlay" && layer.segments.some((segment) => segment.kind === "clip" && segment.clip.id === "clip-overlay")),
        adjustmentPlanStillActive: plan.videoLayers.some((layer) => layer.segments.some((segment) => segment.kind === "clip" && segment.clip.id === "adjustment-grade")),
        secondAdjustmentPlanStillActive: !multiAdjustment || plan.videoLayers.some((layer) => layer.segments.some((segment) => segment.kind === "clip" && segment.clip.id === "adjustment-finish")),
        captionPlanStillActive: plan.captions.some((cue) => cue.id === "caption-single-colour"),
        particleProjectStillActive: filteredProject.particleSimulation?.enabled === true,
        overlayProjectStillActive: filteredProject.tracks.some((track) => track.clips.some((clip) => clip.id === "clip-overlay" && clip.keyframes.length === expectedKeyframeCount)),
        secondAdjustmentProjectStillActive: !multiAdjustment || filteredProject.tracks.some((track) => track.clips.some((clip) => clip.id === "adjustment-finish")),
        sourceProjectImmutable: JSON.stringify(project) === sourceSnapshot,
        rejection,
        compositorSha256: sha256(await readFile(compositor)),
      };
      if (report.graphBuilt || report.combinedReceipt || report.animationReceipt || report.particleReceipt || report.compositeReceipt || report.adjustmentReceipt
        || !report.overlayPlanStillActive || !report.adjustmentPlanStillActive || !report.secondAdjustmentPlanStillActive || !report.captionPlanStillActive
        || !report.particleProjectStillActive || !report.overlayProjectStillActive || !report.secondAdjustmentProjectStillActive || !report.sourceProjectImmutable) {
        throw new Error(`temporal particle animated-overlay RED baseline did not expose the closed-world gap: ${JSON.stringify(report)}`);
      }
      await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); return true;
    }
    if (particlePartialOverlayMultiAdjustmentBaseline) {
      const project = addSecondAdjustment(addParticleLook(projectWithTemporalLook({ overlay: true })));
      const overlay = project.tracks.find((track) => track.id === "track-overlay")!.clips[0];
      overlay.timelineStart = .2;
      overlay.duration = .6;
      const sourceSnapshot = JSON.stringify(project);
      const plan = buildRenderPlan(project, (uri) => uri);
      const graph = buildGpuEngineVideoPreviewGraph(project, 0)?.graph;
      let receipt: Awaited<ReturnType<typeof materializeNativeEffectSegments>>;
      let rejection = "";
      try {
        receipt = await materializeNativeEffectSegments(project, plan, { ...runtimeBase, workspace: join(temporary, "particle-partial-overlay-multi-adjustment-baseline") });
      } catch (error) {
        rejection = String(error);
      }
      const worker = receipt?.clips[0]?.instances[0]?.worker as { lookContract?: string; particleContract?: string; compositeContract?: string; adjustmentContract?: string } | undefined;
      const filteredProject = projectAfterNativeEffectMaterialization(project, receipt);
      const activeAdjustmentClipIds = plan.videoLayers.flatMap((layer) => layer.segments
        .flatMap((segment) => segment.kind === "clip" && segment.clip.layer?.role === "adjustment" ? [segment.clip.id] : []));
      const report = {
        schema: "editkin.temporal-particle-partial-overlay-multi-adjustment-look-baseline/v1", measuredAt: new Date().toISOString(), status: "BLOCK",
        expectedContract: "decoded-temporal-partial-video-overlay-particle-typography-multi-adjustment/v1",
        expectedParticleContract: "decoded-temporal-particle-overlay/v1",
        expectedCompositeContract: "decoded-temporal-video-overlay/v1",
        expectedAdjustmentContract: "decoded-temporal-pre-typography-multi-adjustment/v1",
        graphBuilt: Boolean(graph),
        combinedReceipt: worker?.lookContract === "decoded-temporal-partial-video-overlay-particle-typography-multi-adjustment/v1",
        particleReceipt: worker?.particleContract === "decoded-temporal-particle-overlay/v1",
        compositeReceipt: worker?.compositeContract === "decoded-temporal-video-overlay/v1",
        multiAdjustmentReceipt: worker?.adjustmentContract === "decoded-temporal-pre-typography-multi-adjustment/v1",
        activeAdjustmentClipIds,
        overlayPlanStillActive: plan.videoLayers.some((layer) => layer.trackId === "track-overlay" && layer.segments.some((segment) => segment.kind === "clip" && segment.clip.id === "clip-overlay")),
        captionPlanStillActive: plan.captions.some((cue) => cue.id === "caption-single-colour"),
        particleProjectStillActive: filteredProject.particleSimulation?.enabled === true,
        overlayProjectStillActive: filteredProject.tracks.some((track) => track.clips.some((clip) => clip.id === "clip-overlay")),
        sourceProjectImmutable: JSON.stringify(project) === sourceSnapshot,
        rejection,
        compositorSha256: sha256(await readFile(compositor)),
      };
      if (report.graphBuilt || report.combinedReceipt || report.particleReceipt || report.compositeReceipt || report.multiAdjustmentReceipt
        || report.activeAdjustmentClipIds.join() !== "adjustment-grade,adjustment-finish" || !report.overlayPlanStillActive || !report.captionPlanStillActive
        || !report.particleProjectStillActive || !report.overlayProjectStillActive || !report.sourceProjectImmutable) {
        throw new Error(`temporal particle partial-overlay multi-adjustment RED baseline did not expose the closed-world gap: ${JSON.stringify(report)}`);
      }
      await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); return true;
    }
    if (particleOverlayMultiAdjustmentBaseline) {
      const project = addSecondAdjustment(addParticleLook(projectWithTemporalLook({ overlay: true })));
      const sourceSnapshot = JSON.stringify(project);
      const plan = buildRenderPlan(project, (uri) => uri);
      const graph = buildGpuEngineVideoPreviewGraph(project, 0)?.graph;
      let receipt: Awaited<ReturnType<typeof materializeNativeEffectSegments>>;
      let rejection = "";
      try {
        receipt = await materializeNativeEffectSegments(project, plan, { ...runtimeBase, workspace: join(temporary, "particle-overlay-multi-adjustment-baseline") });
      } catch (error) {
        rejection = String(error);
      }
      const worker = receipt?.clips[0]?.instances[0]?.worker as { lookContract?: string; particleContract?: string; compositeContract?: string; adjustmentContract?: string } | undefined;
      const filteredProject = projectAfterNativeEffectMaterialization(project, receipt);
      const activeAdjustmentClipIds = plan.videoLayers.flatMap((layer) => layer.segments
        .flatMap((segment) => segment.kind === "clip" && segment.clip.layer?.role === "adjustment" ? [segment.clip.id] : []));
      const report = {
        schema: "editkin.temporal-particle-overlay-multi-adjustment-look-baseline/v1", measuredAt: new Date().toISOString(), status: "BLOCK",
        expectedContract: "decoded-temporal-video-overlay-particle-typography-multi-adjustment/v1",
        expectedParticleContract: "decoded-temporal-particle-overlay/v1",
        expectedCompositeContract: "decoded-temporal-video-overlay/v1",
        expectedAdjustmentContract: "decoded-temporal-pre-typography-multi-adjustment/v1",
        graphBuilt: Boolean(graph),
        combinedReceipt: worker?.lookContract === "decoded-temporal-video-overlay-particle-typography-multi-adjustment/v1",
        particleReceipt: worker?.particleContract === "decoded-temporal-particle-overlay/v1",
        compositeReceipt: worker?.compositeContract === "decoded-temporal-video-overlay/v1",
        multiAdjustmentReceipt: worker?.adjustmentContract === "decoded-temporal-pre-typography-multi-adjustment/v1",
        activeAdjustmentClipIds,
        overlayPlanStillActive: plan.videoLayers.some((layer) => layer.trackId === "track-overlay" && layer.segments.some((segment) => segment.kind === "clip" && segment.clip.id === "clip-overlay")),
        captionPlanStillActive: plan.captions.some((cue) => cue.id === "caption-single-colour"),
        particleProjectStillActive: filteredProject.particleSimulation?.enabled === true,
        overlayProjectStillActive: filteredProject.tracks.some((track) => track.clips.some((clip) => clip.id === "clip-overlay")),
        sourceProjectImmutable: JSON.stringify(project) === sourceSnapshot,
        rejection,
        compositorSha256: sha256(await readFile(compositor)),
      };
      if (report.graphBuilt || report.combinedReceipt || report.particleReceipt || report.compositeReceipt || report.multiAdjustmentReceipt
        || report.activeAdjustmentClipIds.join() !== "adjustment-grade,adjustment-finish" || !report.overlayPlanStillActive || !report.captionPlanStillActive
        || !report.particleProjectStillActive || !report.overlayProjectStillActive || !report.sourceProjectImmutable) {
        throw new Error(`temporal particle-overlay multi-adjustment RED baseline did not expose the closed-world gap: ${JSON.stringify(report)}`);
      }
      await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); return true;
    }
    if (particlePartialOverlayBaseline) {
      const project = addParticleLook(projectWithTemporalLook({ overlay: true }));
      const overlay = project.tracks.find((track) => track.id === "track-overlay")!.clips[0];
      overlay.timelineStart = .2;
      overlay.duration = .6;
      const sourceSnapshot = JSON.stringify(project);
      const plan = buildRenderPlan(project, (uri) => uri);
      const graph = buildGpuEngineVideoPreviewGraph(project, 0)?.graph;
      let receipt: Awaited<ReturnType<typeof materializeNativeEffectSegments>>;
      let rejection = "";
      try {
        receipt = await materializeNativeEffectSegments(project, plan, { ...runtimeBase, workspace: join(temporary, "particle-partial-overlay-baseline") });
      } catch (error) {
        rejection = String(error);
      }
      const worker = receipt?.clips[0]?.instances[0]?.worker as { lookContract?: string; particleContract?: string; compositeContract?: string; adjustmentContract?: string } | undefined;
      const filteredProject = projectAfterNativeEffectMaterialization(project, receipt);
      const overlaySegments = plan.videoLayers.find((layer) => layer.trackId === "track-overlay")?.segments ?? [];
      const framesInside = (kind: "gap" | "clip", start: number, end: number) => Math.round(overlaySegments.filter((segment) => segment.kind === kind)
        .reduce((sum, segment) => sum + Math.max(0, Math.min(segment.start + segment.duration, end) - Math.max(segment.start, start)), 0) * project.fps);
      const report = {
        schema: "editkin.temporal-particle-partial-overlay-look-baseline/v1", measuredAt: new Date().toISOString(), status: "BLOCK",
        expectedContract: "decoded-temporal-partial-video-overlay-particle-typography-adjustment/v1",
        expectedParticleContract: "decoded-temporal-particle-overlay/v1",
        expectedCompositeContract: "decoded-temporal-video-overlay/v1",
        expectedAdjustmentContract: "decoded-temporal-pre-typography-adjustment/v1",
        graphBuilt: Boolean(graph),
        combinedReceipt: worker?.lookContract === "decoded-temporal-partial-video-overlay-particle-typography-adjustment/v1",
        particleReceipt: worker?.particleContract === "decoded-temporal-particle-overlay/v1",
        compositeReceipt: worker?.compositeContract === "decoded-temporal-video-overlay/v1",
        adjustmentReceipt: worker?.adjustmentContract === "decoded-temporal-pre-typography-adjustment/v1",
        overlayGapFrames: framesInside("gap", .2, .5),
        overlayTailFrames: framesInside("clip", .5, .8),
        captionPlanStillActive: plan.captions.some((cue) => cue.id === "caption-single-colour"),
        adjustmentPlanStillActive: plan.videoLayers.some((layer) => layer.segments.some((segment) => segment.kind === "clip" && segment.clip.id === "adjustment-grade")),
        particleProjectStillActive: filteredProject.particleSimulation?.enabled === true,
        overlayProjectStillActive: filteredProject.tracks.some((track) => track.clips.some((clip) => clip.id === "clip-overlay")),
        sourceProjectImmutable: JSON.stringify(project) === sourceSnapshot,
        rejection,
        compositorSha256: sha256(await readFile(compositor)),
      };
      if (report.graphBuilt || report.combinedReceipt || report.particleReceipt || report.compositeReceipt || report.adjustmentReceipt
        || report.overlayGapFrames !== 0 || report.overlayTailFrames !== 9 || !report.captionPlanStillActive || !report.adjustmentPlanStillActive
        || !report.particleProjectStillActive || !report.overlayProjectStillActive || !report.sourceProjectImmutable) {
        throw new Error(`temporal particle partial-overlay RED baseline did not expose the closed-world gap: ${JSON.stringify(report)}`);
      }
      await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); return true;
    }
    if (particleOverlayBaseline) {
      const project = addParticleLook(projectWithTemporalLook({ overlay: true }));
      const sourceSnapshot = JSON.stringify(project);
      const plan = buildRenderPlan(project, (uri) => uri);
      const graph = buildGpuEngineVideoPreviewGraph(project, 0)?.graph;
      let receipt: Awaited<ReturnType<typeof materializeNativeEffectSegments>>;
      let rejection = "";
      try {
        receipt = await materializeNativeEffectSegments(project, plan, { ...runtimeBase, workspace: join(temporary, "particle-overlay-baseline") });
      } catch (error) {
        rejection = String(error);
      }
      const worker = receipt?.clips[0]?.instances[0]?.worker as { lookContract?: string; particleContract?: string; compositeContract?: string; adjustmentContract?: string } | undefined;
      const filteredProject = projectAfterNativeEffectMaterialization(project, receipt);
      const report = {
        schema: "editkin.temporal-particle-overlay-look-baseline/v1", measuredAt: new Date().toISOString(), status: "BLOCK",
        expectedContract: "decoded-temporal-video-overlay-particle-typography-adjustment/v1",
        expectedParticleContract: "decoded-temporal-particle-overlay/v1",
        expectedCompositeContract: "decoded-temporal-video-overlay/v1",
        expectedAdjustmentContract: "decoded-temporal-pre-typography-adjustment/v1",
        graphBuilt: Boolean(graph),
        combinedReceipt: worker?.lookContract === "decoded-temporal-video-overlay-particle-typography-adjustment/v1",
        particleReceipt: worker?.particleContract === "decoded-temporal-particle-overlay/v1",
        compositeReceipt: worker?.compositeContract === "decoded-temporal-video-overlay/v1",
        adjustmentReceipt: worker?.adjustmentContract === "decoded-temporal-pre-typography-adjustment/v1",
        overlayPlanStillActive: plan.videoLayers.some((layer) => layer.trackId === "track-overlay" && layer.segments.some((segment) => segment.kind === "clip" && segment.clip.id === "clip-overlay")),
        adjustmentPlanStillActive: plan.videoLayers.some((layer) => layer.segments.some((segment) => segment.kind === "clip" && segment.clip.id === "adjustment-grade")),
        captionPlanStillActive: plan.captions.some((cue) => cue.id === "caption-single-colour"),
        particleProjectStillActive: filteredProject.particleSimulation?.enabled === true,
        overlayProjectStillActive: filteredProject.tracks.some((track) => track.clips.some((clip) => clip.id === "clip-overlay")),
        sourceProjectImmutable: JSON.stringify(project) === sourceSnapshot,
        rejection,
        compositorSha256: sha256(await readFile(compositor)),
      };
      if (report.graphBuilt || report.combinedReceipt || report.particleReceipt || report.compositeReceipt || report.adjustmentReceipt
        || !report.overlayPlanStillActive || !report.adjustmentPlanStillActive || !report.captionPlanStillActive
        || !report.particleProjectStillActive || !report.overlayProjectStillActive || !report.sourceProjectImmutable) {
        throw new Error(`temporal particle-overlay RED baseline did not expose the closed-world gap: ${JSON.stringify(report)}`);
      }
      await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); return true;
    }
    if (particleMultiAdjustmentBaseline) {
      const project = addSecondAdjustment(addParticleLook(projectWithTemporalLook()));
      const sourceSnapshot = JSON.stringify(project);
      const plan = buildRenderPlan(project, (uri) => uri);
      const graph = buildGpuEngineVideoPreviewGraph(project, 0)?.graph;
      let receipt: Awaited<ReturnType<typeof materializeNativeEffectSegments>>;
      let rejection = "";
      try {
        receipt = await materializeNativeEffectSegments(project, plan, { ...runtimeBase, workspace: join(temporary, "particle-multi-adjustment-baseline") });
      } catch (error) {
        rejection = String(error);
      }
      const worker = receipt?.clips[0]?.instances[0]?.worker as { lookContract?: string; particleContract?: string; adjustmentContract?: string } | undefined;
      const filteredProject = projectAfterNativeEffectMaterialization(project, receipt);
      const activeAdjustmentClipIds = plan.videoLayers.flatMap((layer) => layer.segments
        .flatMap((segment) => segment.kind === "clip" && segment.clip.layer?.role === "adjustment" ? [segment.clip.id] : []));
      const report = {
        schema: "editkin.temporal-particle-multi-adjustment-look-baseline/v1", measuredAt: new Date().toISOString(), status: "BLOCK",
        expectedContract: "decoded-temporal-particle-typography-multi-adjustment/v1",
        expectedParticleContract: "decoded-temporal-particle-overlay/v1",
        expectedAdjustmentContract: "decoded-temporal-pre-typography-multi-adjustment/v1",
        graphBuilt: Boolean(graph),
        combinedReceipt: worker?.lookContract === "decoded-temporal-particle-typography-multi-adjustment/v1",
        particleReceipt: worker?.particleContract === "decoded-temporal-particle-overlay/v1",
        multiAdjustmentReceipt: worker?.adjustmentContract === "decoded-temporal-pre-typography-multi-adjustment/v1",
        activeAdjustmentClipIds,
        particleProjectStillActive: filteredProject.particleSimulation?.enabled === true,
        captionPlanStillActive: plan.captions.some((cue) => cue.id === "caption-single-colour"),
        sourceProjectImmutable: JSON.stringify(project) === sourceSnapshot,
        rejection,
        compositorSha256: sha256(await readFile(compositor)),
      };
      if (report.graphBuilt || report.combinedReceipt || report.particleReceipt || report.multiAdjustmentReceipt
        || report.activeAdjustmentClipIds.join() !== "adjustment-grade,adjustment-finish" || !report.particleProjectStillActive
        || !report.captionPlanStillActive || !report.sourceProjectImmutable) {
        throw new Error(`temporal particle multi-adjustment RED baseline did not expose the closed-world gap: ${JSON.stringify(report)}`);
      }
      await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); return true;
    }
    if (particleLookBaseline) {
      const project = addParticleLook(projectWithTemporalLook());
      const sourceSnapshot = JSON.stringify(project);
      const plan = buildRenderPlan(project, (uri) => uri);
      const graph = buildGpuEngineVideoPreviewGraph(project, 0)?.graph;
      let receipt: Awaited<ReturnType<typeof materializeNativeEffectSegments>>;
      let rejection = "";
      try {
        receipt = await materializeNativeEffectSegments(project, plan, { ...runtimeBase, workspace: join(temporary, "particle-look-baseline") });
      } catch (error) {
        rejection = String(error);
      }
      const worker = receipt?.clips[0]?.instances[0]?.worker as { lookContract?: string; particleContract?: string } | undefined;
      const filteredProject = projectAfterNativeEffectMaterialization(project, receipt);
      const report = {
        schema: "editkin.temporal-particle-look-baseline/v1", measuredAt: new Date().toISOString(), status: "BLOCK",
        expectedContract: "decoded-temporal-particle-typography-adjustment/v1",
        expectedParticleContract: "decoded-temporal-particle-overlay/v1",
        graphBuilt: Boolean(graph),
        combinedReceipt: worker?.lookContract === "decoded-temporal-particle-typography-adjustment/v1",
        particleReceipt: worker?.particleContract === "decoded-temporal-particle-overlay/v1",
        particleProjectStillActive: filteredProject.particleSimulation?.enabled === true,
        captionPlanStillActive: plan.captions.some((cue) => cue.id === "caption-single-colour"),
        adjustmentPlanStillActive: plan.videoLayers.some((layer) => layer.segments.some((segment) => segment.kind === "clip" && segment.clip.id === "adjustment-grade")),
        sourceProjectImmutable: JSON.stringify(project) === sourceSnapshot,
        rejection,
        compositorSha256: sha256(await readFile(compositor)),
      };
      if (report.graphBuilt || report.combinedReceipt || report.particleReceipt || !report.particleProjectStillActive
        || !report.sourceProjectImmutable) {
        throw new Error(`temporal particle look RED baseline did not expose the closed-world gap: ${JSON.stringify(report)}`);
      }
      await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); return true;
    }
    if (multiAdjustmentBaseline) {
      const project = addSecondAdjustment(projectWithTemporalLook());
      const plan = buildRenderPlan(project, (uri) => uri);
      const graph = buildGpuEngineVideoPreviewGraph(project, 0)?.graph;
      let receipt: Awaited<ReturnType<typeof materializeNativeEffectSegments>>;
      let rejection = "";
      try {
        receipt = await materializeNativeEffectSegments(project, plan, { ...runtimeBase, workspace: join(temporary, "multi-adjustment-baseline") });
      } catch (error) {
        rejection = String(error);
      }
      const worker = receipt?.clips[0]?.instances[0]?.worker as { lookContract?: string } | undefined;
      const activeAdjustmentClipIds = plan.videoLayers.flatMap((layer) => layer.segments
        .flatMap((segment) => segment.kind === "clip" && segment.clip.layer?.role === "adjustment" ? [segment.clip.id] : []));
      const report = {
        schema: "editkin.temporal-look-multi-adjustment-baseline/v1", measuredAt: new Date().toISOString(), status: "BLOCK",
        expectedContract: "decoded-temporal-typography-multi-adjustment/v1",
        expectedAdjustmentClipIds: ["adjustment-grade", "adjustment-finish"],
        graphBuilt: Boolean(graph),
        combinedReceipt: worker?.lookContract === "decoded-temporal-typography-multi-adjustment/v1",
        activeAdjustmentClipIds,
        captionPlanStillActive: plan.captions.some((cue) => cue.id === "caption-single-colour"),
        currentEnvelopeDidNotPromote: receipt === undefined || worker?.lookContract !== "decoded-temporal-typography-multi-adjustment/v1",
        rejection,
        compositorSha256: sha256(await readFile(compositor)),
      };
      if (report.graphBuilt || report.combinedReceipt || report.activeAdjustmentClipIds.join() !== "adjustment-grade,adjustment-finish"
        || !report.captionPlanStillActive || !report.currentEnvelopeDidNotPromote) {
        throw new Error(`temporal multi-adjustment look RED baseline did not expose the closed-world gap: ${JSON.stringify(report)}`);
      }
      await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); return true;
    }
    if (multiOverlayBaseline) {
      const project = addSecondExactOverlay(projectWithTemporalLook({ overlay: true }));
      const plan = buildRenderPlan(project, (uri) => uri);
      let receipt: Awaited<ReturnType<typeof materializeNativeEffectSegments>>;
      let rejection = "";
      try {
        receipt = await materializeNativeEffectSegments(project, plan, { ...runtimeBase, workspace: join(temporary, "multi-overlay-baseline") });
      } catch (error) {
        rejection = String(error);
      }
      const worker = receipt?.clips[0]?.instances[0]?.worker as { lookContract?: string } | undefined;
      const activeOverlayClipIds = plan.videoLayers
        .filter((layer) => layer.trackId === "track-overlay" || layer.trackId === "track-overlay-two")
        .flatMap((layer) => layer.segments.filter((segment) => segment.kind === "clip").map((segment) => segment.clip.id));
      const report = {
        schema: "editkin.temporal-look-multi-overlay-baseline/v1", measuredAt: new Date().toISOString(), status: "BLOCK",
        expectedContract: "decoded-temporal-multi-video-overlay-typography-adjustment/v1",
        expectedOverlayClipIds: ["clip-overlay", "clip-overlay-two"],
        combinedReceipt: worker?.lookContract === "decoded-temporal-multi-video-overlay-typography-adjustment/v1",
        activeOverlayClipIds,
        captionPlanStillActive: plan.captions.some((cue) => cue.id === "caption-single-colour"),
        adjustmentPlanStillActive: plan.videoLayers.some((layer) => layer.segments.some((segment) => segment.kind === "clip" && segment.clip.id === "adjustment-grade")),
        currentEnvelopeDidNotPromote: receipt === undefined || worker?.lookContract !== "decoded-temporal-multi-video-overlay-typography-adjustment/v1",
        explicitRejection: /at most one independent video overlay|最多 4 個|正式輸出/.test(rejection),
        rejection,
        compositorSha256: sha256(await readFile(compositor)),
      };
      if (report.combinedReceipt || report.activeOverlayClipIds.join() !== "clip-overlay,clip-overlay-two"
        || !report.captionPlanStillActive || !report.adjustmentPlanStillActive || !report.currentEnvelopeDidNotPromote) {
        throw new Error(`temporal multi-overlay look RED baseline did not expose the closed-world gap: ${JSON.stringify(report)}`);
      }
      await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); return true;
    }
    if (partialOverlayBaseline) {
      const project = projectWithTemporalLook({ overlay: true });
      const overlay = project.tracks.find((track) => track.id === "track-overlay")!.clips[0];
      overlay.timelineStart = .2;
      overlay.duration = .6;
      const plan = buildRenderPlan(project, (uri) => uri);
      const receipt = await materializeNativeEffectSegments(project, plan, { ...runtimeBase, workspace: join(temporary, "partial-overlay-baseline") });
      const worker = receipt?.clips[0]?.instances[0]?.worker as { lookContract?: string } | undefined;
      const overlaySegments = plan.videoLayers.find((layer) => layer.trackId === "track-overlay")?.segments ?? [];
      const framesInside = (kind: "gap" | "clip", start: number, end: number) => Math.round(overlaySegments.filter((segment) => segment.kind === kind)
        .reduce((sum, segment) => sum + Math.max(0, Math.min(segment.start + segment.duration, end) - Math.max(segment.start, start)), 0) * project.fps);
      const report = {
        schema: "editkin.temporal-look-partial-overlay-baseline/v1", measuredAt: new Date().toISOString(), status: "BLOCK",
        expectedContract: "decoded-temporal-partial-video-overlay-typography-adjustment/v1",
        overlapStartFrame: 6, overlapEndFrame: 15, expectedOverlapFrames: 9,
        combinedReceipt: worker?.lookContract === "decoded-temporal-partial-video-overlay-typography-adjustment/v1",
        overlayGapFrames: framesInside("gap", .2, .5),
        overlayTailFrames: framesInside("clip", .5, .8),
        captionPlanStillActive: plan.captions.some((cue) => cue.id === "caption-single-colour"),
        adjustmentPlanStillActive: plan.videoLayers.some((layer) => layer.segments.some((segment) => segment.kind === "clip" && segment.clip.id === "adjustment-grade")),
        compositorSha256: sha256(await readFile(compositor)),
      };
      if (report.combinedReceipt || report.overlayGapFrames !== 0 || report.overlayTailFrames !== 9 || !report.captionPlanStillActive || !report.adjustmentPlanStillActive) {
        throw new Error(`temporal partial-overlay look RED baseline did not expose the interval-convergence gap: ${JSON.stringify(report)}`);
      }
      await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); return true;
    }
    if (overlayBaseline) {
      const project = projectWithTemporalLook({ overlay: true });
      const graph = buildGpuEngineVideoPreviewGraph(project, 0)?.graph;
      let materializationError = "";
      let combinedReceipt = false;
      let overlaySegmentSuppressed = false;
      try {
        const materialized = await materializeCase(project, join(temporary, "overlay-baseline"), runtimeBase);
        const worker = materialized.clip.instances[0]?.worker as { lookContract?: string } | undefined;
        combinedReceipt = worker?.lookContract === "decoded-temporal-video-overlay-typography-adjustment/v1";
        overlaySegmentSuppressed = materialized.plan.videoLayers.find((layer) => layer.trackId === "track-overlay")?.segments.every((segment) => segment.kind === "gap") === true;
      } catch (error) {
        materializationError = String(error);
      }
      const report = {
        schema: "editkin.temporal-look-overlay-baseline/v1", measuredAt: new Date().toISOString(), status: "BLOCK",
        expectedContract: "decoded-temporal-video-overlay-typography-adjustment/v1",
        graphVideoNodeCount: graph?.nodes.filter((node) => node.kind === "source").length ?? 0,
        graphContainsAdjustment: graph?.nodes.some((node) => node.kind === "adjustment") === true,
        graphContainsCaption: graph?.nodes.some((node) => node.kind === "caption") === true,
        graphContainsMotionGraphic: graph?.nodes.some((node) => node.kind === "motion_graphic") === true,
        combinedReceipt,
        overlaySegmentSuppressed,
        materializationError,
        compositorSha256: sha256(await readFile(compositor)),
      };
      if (report.graphVideoNodeCount !== 2 || !report.graphContainsAdjustment || !report.graphContainsCaption || !report.graphContainsMotionGraphic
        || report.combinedReceipt || report.overlaySegmentSuppressed) throw new Error(`temporal look overlay RED baseline did not expose the formal convergence gap: ${JSON.stringify(report)}`);
      await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); return true;
    }
    if (baseline) {
      const project = projectWithTemporalLook();
      const graph = buildGpuEngineVideoPreviewGraph(project, 0)?.graph;
      let nativeLoadError = "";
      try { await materializeCase(project, join(temporary, "mixed"), runtimeBase); } catch (error) { nativeLoadError = String(error); }
      const report = {
        schema: "editkin.temporal-look-project-render-baseline/v1", measuredAt: new Date().toISOString(), status: "BLOCK", expectedContract: "decoded-temporal-typography-adjustment/v1",
        graphContainsAdjustment: graph?.nodes.some((node) => node.kind === "adjustment") === true,
        graphContainsCaption: graph?.nodes.some((node) => node.kind === "caption") === true,
        graphContainsMotionGraphic: graph?.nodes.some((node) => node.kind === "motion_graphic") === true,
        nativeLoadRejected: /unsupported common video node kind: adjustment/.test(nativeLoadError),
        nativeLoadError,
        compositorSha256: sha256(await readFile(compositor)),
      };
      if (!report.graphContainsAdjustment || !report.graphContainsCaption || !report.graphContainsMotionGraphic || !report.nativeLoadRejected) throw new Error("temporal look RED baseline did not expose the native topology gap");
      await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); return true;
    }
  return false;
}
