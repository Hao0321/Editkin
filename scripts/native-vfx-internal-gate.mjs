import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { computeBuildReceipt } from "./lib/build-input-identity.mjs";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "../..");
const benchmarkRoot = join(repoRoot, ".rd/benchmarks");
const outputRoot = join(appRoot, ".rd/benchmarks/editkin-native-vfx-internal");
const outputPath = join(outputRoot, "report.json");
const sha256 = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const exactStrings = (actual, expected) => Array.isArray(actual) && actual.join() === expected.join();
const sameSet = (actual, expected) => Array.isArray(actual) && [...actual].sort().join() === [...expected].sort().join();
const identitiesMatch = (left, right) => left?.files === right?.files && left?.bytes === right?.bytes && left?.sha256 === right?.sha256;
const zeroPixelDelta = (delta) => delta?.changedPixels === 0 && delta.changedPixelRatio === 0 && delta.maximumChannelDifference === 0;
const controls = {
  native: ["particle-ceiling", "z-motion", "multiple-emitter", "disabled-emitter"],
  single: ["ceiling", "z-motion", "fifth-emitter", "disabled", "missing-timeline"],
  multi: ["ceiling", "z-motion", "fifth-emitter", "aggregate-budget", "disabled", "missing-timeline"],
  spatial: ["zero-angle", "one-sample", "too-many-samples", "static", "opacity", "stack", "outer-effect"],
  temporal: ["unknown-source-sampling", "second-layer-temporal", "two-temporal", "insufficient-budget"],
  formalBlur: ["missing-runtime", "invalid-samples", "invalid-shutter", "opacity-animation", "mixed-runtime", "outer-effect"],
  formalParticle: ["nine-temporal-samples", "particle-budget", "pq-input"],
  dof: ["focus-at-near", "focus-at-far", "zero-aperture", "zero-radius", "oversized-radius", "ninth-plane", "translucent-plane", "effect-mix", "particle-mix", "pq-input"],
  lens: ["zero-time", "duplicate-frame", "end-frame", "focus-at-near", "focus-at-far", "zero-aperture", "oversized-radius", "seventeenth-keyframe", "unknown-easing"],
};
const reportPaths = {
  timeline: join(benchmarkRoot, "editkin-particle-vfx-timeline/report.json"),
  authoredMulti: join(benchmarkRoot, "editkin-multi-emitter-particle-vfx/report.json"),
  native: join(benchmarkRoot, "editkin-native-particle-simulation/report.json"),
  formalNative: join(benchmarkRoot, "editkin-native-particle-project-render/report.json"),
  single: join(benchmarkRoot, "editkin-common-engine-video-particle/report.json"),
  multi: join(benchmarkRoot, "editkin-common-engine-video-multi-particle/report.json"),
  seek: join(benchmarkRoot, "editkin-vfx-seek-snapshot/report.json"),
  formalParticleBaseline: join(benchmarkRoot, "editkin-resident-scene-linear-temporal-particle-project-render/baseline-report.json"),
  formalParticle: join(benchmarkRoot, "editkin-resident-scene-linear-temporal-particle-project-render/report.json"),
  spatialBaseline: join(benchmarkRoot, "editkin-common-engine-video-transform-motion-blur/baseline-report.json"),
  spatial: join(benchmarkRoot, "editkin-common-engine-video-transform-motion-blur/report.json"),
  temporalBaseline: join(benchmarkRoot, "editkin-common-engine-video-decoded-temporal-motion-blur/baseline-report.json"),
  temporal: join(benchmarkRoot, "editkin-common-engine-video-decoded-temporal-motion-blur/report.json"),
  formalBlur: join(benchmarkRoot, "editkin-transform-motion-blur-project-render/report.json"),
  dof: join(benchmarkRoot, "editkin-resident-25d-depth-of-field-video-project-render/report.json"),
  lens: join(benchmarkRoot, "editkin-resident-25d-animated-depth-of-field-video-project-render/report.json"),
  smoke: join(benchmarkRoot, "editkin-tauri-cdp-smoke.json"),
  manifest: join(appRoot, ".release-input-manifest.json"),
};

function particleReceipt(report, emitters, ceiling, expectedControls) {
  return report.status === "GREEN" && report.directExecution === true
    && report.vfxSimulation?.dimension === "screen_space_2d" && report.vfxSimulation?.emitterCount === emitters
    && report.vfxSimulation?.executor === "wgpu-resident-video-particle-overlay/v1"
    && report.vfxSimulation?.particleCeiling === ceiling && report.vfxSimulation?.seedMode === "fixed_u32_hash_per_birth"
    && report.vfxSimulation?.simulationContract === "screen_space_analytic_particles/v1"
    && report.vfxSimulation?.timeSource === "rational_node_local_frame" && report.sameFrameDeterministic === true
    && report.timeEvolves === true && report.localClockReset === true && report.inactiveFramesSuppressParticleWrites === true
    && report.activeEmitterReceipts?.length === emitters
    && report.activeEmitterReceipts.every((item) => item.executor === "wgpu-resident-video-particle-overlay/v1"
      && item.cpuPixelUploads === 0 && item.cpuPixelReadbacks === 0 && item.snapshotCache?.schema === "editkin.resident-particle-seek-snapshot/v1"
      && item.snapshotCache?.capacity === 2 && item.snapshotCache?.cpuPixelCopies === 0)
    && report.cpuPixelUploads === 0 && report.productPathCpuPixelCopies === 0 && report.presentedFrames === 60
    && report.presentP95Ms <= 20 && exactStrings(report.rejectedNegativeControls, expectedControls)
    && report.releaseFences?.pendingFenceCount === 0;
}

function evaluate(reports, delivery) {
  const { timeline, authoredMulti, native, formalNative, single, multi, seek, formalParticleBaseline, formalParticle,
    spatialBaseline, spatial, temporalBaseline, temporal, formalBlur, dof, lens } = reports;
  return {
    authoredTimelineAndMultiEmitter: timeline.schema === "editkin.particle-vfx-timeline-gate/v1" && timeline.status === "GREEN"
      && timeline.pluginTimeParameters === true && timeline.persistedTimelineRange === true && timeline.exactFrameRange === true
      && exactStrings(timeline.boundedNegativeControls, ["zero-duration", "past-project-end"])
      && timeline.timeline?.timelineStartFrame === 18 && timeline.timeline?.sourceStartFrame === 0 && timeline.timeline?.durationFrames === 24
      && authoredMulti.schema === "editkin.multi-emitter-particle-vfx-gate/v1" && authoredMulti.status === "GREEN"
      && authoredMulti.persistedEmitterCount === 2 && authoredMulti.nativeNodeCount === 2 && authoredMulti.previewEmitterCount === 2
      && authoredMulti.pluginEmitterCount === 2 && authoredMulti.pluginProjectScoped === true && authoredMulti.totalParticleCeiling === 112
      && exactStrings(authoredMulti.calibratedNegativeControls, ["fifth-emitter", "aggregate-particle-budget", "duplicate-emitter-id"]),
    nativeDeterministicSimulationAndFormalProject: native.schema === "editkin.native-particle-simulation-gate/v1"
      && native.status === "GREEN" && native.baselineRejected === true && native.simulationContract === "screen_space_analytic_particles/v1"
      && native.executor === "wgpu-bounded-particle-compute/v1" && native.emitterCount === 1 && native.particleCeiling === 64
      && native.directExecution === true && native.cpuGpuMaxChannelError === 0 && native.previewExportMaxChannelError === 0
      && native.repeatDeterministic === true && native.timeEvolves === true && native.distinctResidentFrameHashes >= 30
      && native.residentFrames === 30 && native.residentP95Ms <= 20 && sameSet(native.requiredNodeIds, ["particles", "output"])
      && sameSet(native.executedNodeIds, ["particles", "output"]) && native.blockedNodeIds?.length === 0 && native.ignoredNodeIds?.length === 0
      && exactStrings(native.rejectedNegativeControls, controls.native)
      && formalNative.schema === "editkin.native-particle-project-render-gate/v1" && formalNative.status === "GREEN"
      && formalNative.persistedProjectRoundTrip === true && formalNative.previewContract === true && formalNative.graphSchema === "editkin.engine-graph/v1"
      && formalNative.vfxSimulation?.executor === "wgpu-bounded-particle-compute/v1" && formalNative.vfxSimulation?.emitterCount === 1
      && formalNative.vfxSimulation?.particleCeiling === 64 && formalNative.cpuGpuOutputParity === true && sha256(formalNative.outputSha256),
    residentSingleEmitter: single.schema === "editkin.common-engine-video-particle-gate/v1"
      && particleReceipt(single, 1, 64, controls.single) && zeroPixelDelta(single.repeatedFrameDifference)
      && single.nextFrameDifference?.changedPixels > 500 && single.gpuTextureWrites >= 4,
    residentDualEmitter: multi.schema === "editkin.common-engine-video-multi-particle-gate/v1"
      && particleReceipt(multi, 2, 112, controls.multi) && zeroPixelDelta(multi.repeatedFrameDifference)
      && multi.nextFrameDifference?.changedPixels > 800 && multi.gpuTextureWrites >= 8 && multi.intervals?.length === 2,
    deterministicSeekSnapshots: seek.schema === "editkin.vfx-seek-snapshot-gate/v1" && seek.status === "GREEN"
      && seek.randomAccessPixelExact === true && seek.snapshotCapacity === 2 && seek.cacheHits >= 1 && seek.cacheMisses >= 4
      && seek.evictionDeterministic === true && seek.computeTextureWrites === 4 && seek.snapshotCopies === 4
      && seek.hitComputeWriteDelta === 0 && seek.cpuPixelUploads === 0 && seek.productPathCpuPixelCopies === 0
      && seek.particleSnapshotBytes === 460_800 && seek.outputHashes?.length === 5 && seek.outputHashes[0] === seek.outputHashes[2]
      && exactStrings(seek.rejectedNegativeControls, ["snapshot-budget"]) && /insufficient/.test(seek.snapshotBudgetObservedError)
      && seek.releaseFences?.pendingFenceCount === 0,
    formalTemporalParticleOutput: formalParticleBaseline.schema === "editkin.resident-scene-linear-temporal-particle-project-render-baseline/v1"
      && formalParticleBaseline.status === "BLOCK" && formalParticleBaseline.productRouteRejected === true
      && formalParticle.schema === "editkin.resident-scene-linear-temporal-particle-project-render-gate/v1"
      && formalParticle.status === "GREEN" && formalParticle.baselineProductRouteRejected === true
      && formalParticle.planner === "editkin-resident-video-scene-linear-aces2-formal-sequence/v1" && formalParticle.frameCount === 15
      && formalParticle.productPathCpuPixelCopies === 0 && formalParticle.verificationReadback === true
      && formalParticle.temporalExecutionMode === "decoded-temporal-shutter-scene-linear/v1"
      && formalParticle.temporalLayerCount === 1 && formalParticle.temporalFramesWithReceipt === 15 && formalParticle.temporalSampleCount === 8
      && formalParticle.particleExecutionMode === "wgpu-resident-video-particle-overlay/v1" && formalParticle.framesWithActiveParticles === 6
      && formalParticle.totalParticleEmitterPasses === 6 && formalParticle.maximumActiveParticleEmitterCount === 1
      && formalParticle.temporalChangedPixels > 80_000 && formalParticle.particleChangedPixels > 30_000
      && formalParticle.audioRetained === true && formalParticle.bt709Tagged === true
      && exactStrings(formalParticle.rejectedNegativeControls, controls.formalParticle),
    spatialTransformMotionBlur: spatialBaseline.schema === "editkin.common-engine-video-transform-motion-blur-gate/v1"
      && spatialBaseline.status === "BLOCK" && spatialBaseline.loadOk === true
      && spatial.schema === spatialBaseline.schema && spatial.status === "GREEN" && spatial.directExecution === true
      && spatial.motionBlur?.contract === "transform-shutter-accumulation/v1" && spatial.motionBlur?.shutterAngle === 360
      && spatial.motionBlur?.sampleCount === 8 && spatial.motionBlur?.sampleFrames?.length === 8 && spatial.motionBlur?.sampleTransforms?.length === 8
      && spatial.motionBlur?.samplesMatchOracle === true && spatial.repeatExact === true && spatial.repeatDelta?.changedPixels === 0
      && spatial.artifactDelta?.changedPixels > 40_000 && spatial.presentedFrames === 60 && spatial.presentP95Ms <= 20
      && spatial.productPathCpuPixelCopies === 0 && exactStrings(spatial.rejectedNegativeControls, controls.spatial)
      && spatial.releaseFences?.pendingFenceCount === 0,
    decodedTemporalMotionBlur: temporalBaseline.schema === "editkin.common-engine-video-decoded-temporal-motion-blur-gate/v1"
      && temporalBaseline.status === "BLOCK" && temporalBaseline.loadOk === true
      && temporal.schema === temporalBaseline.schema && temporal.status === "GREEN" && temporal.directExecution === true
      && temporal.motionBlur?.schema === "editkin.decoded-temporal-shutter-window/v1"
      && temporal.motionBlur?.contract === "decoded-temporal-shutter-accumulation/v1"
      && temporal.motionBlur?.sourceSampling === "decoded_temporal" && temporal.motionBlur?.sampleCount === 8
      && temporal.motionBlur?.cacheHitCount === 6 && temporal.motionBlur?.distinctDecodedTimestampCount === 2
      && temporal.motionBlur?.residentFrameRingSize === 8 && temporal.motionBlur?.residentBytes === 49_766_400
      && temporal.motionBlur?.decodePathCpuPixelCopies === 0 && temporal.motionBlur?.stagingCpuPixelReadbacks === 0
      && temporal.motionBlur?.productPathCpuPixelCopies === 0 && temporal.motionBlur?.targetsMatchOracle === true
      && temporal.motionBlur?.sampleReceipts?.length === 8 && temporal.motionBlur.sampleReceipts.every((item) => item.clockWithinTolerance === true)
      && temporal.repeatExact === true && temporal.temporalVsSpatialDelta?.changedPixels > 10_000
      && temporal.presentedFrames === 30 && temporal.presentP95Ms <= 20 && temporal.productPathCpuPixelCopies === 0
      && exactStrings(temporal.rejectedNegativeControls, controls.temporal) && temporal.releaseFences?.pendingFenceCount === 0,
    formalTemporalMotionBlurOutput: formalBlur.schema === "editkin.transform-motion-blur-project-render-gate/v1"
      && formalBlur.status === "GREEN" && formalBlur.executionMode === "resident-gpu-shader-sequence/v1" && formalBlur.frameCount === 15
      && formalBlur.losslessPixelDifferences === 0 && formalBlur.motionContract === "decoded-temporal-shutter-accumulation/v1"
      && formalBlur.sourceSampling === "decoded_temporal" && formalBlur.shutterAngle === 360 && formalBlur.sampleCount === 8
      && formalBlur.temporalFramesWithReceipt === 15 && formalBlur.maximumDistinctDecodedTimestampCount === 2
      && formalBlur.residentFrameRingSize === 8 && formalBlur.residentBytes === 49_766_400 && formalBlur.programCount === 0
      && formalBlur.noPluginInstallRequired === true && formalBlur.productPathCpuPixelCopies === 0 && formalBlur.verificationReadback === true
      && formalBlur.audioSourceRetained === true && formalBlur.materializedClipReset === true
      && exactStrings(formalBlur.rejectedNegativeControls, controls.formalBlur) && sha256(formalBlur.intermediateSha256),
    depthAwareLensPipeline: dof.schema === "editkin.resident-25d-depth-of-field-video-project-render-gate/v1"
      && dof.status === "GREEN" && dof.frozenRedBaseline === true && dof.frameCount === 12
      && dof.depthReceiptFrames === 12 && dof.depthOfFieldReceiptFrames === 12 && dof.compositeFullFramePassCount === 3
      && dof.depthOfField?.executionMode === "scene-linear-depth32f-gather-dof/v1" && dof.depthOfField?.executor === "wgpu-depth-aware-gather/v1"
      && dof.resourcePlan?.sceneDepthBytes === 2_073_600 && dof.resourcePlan?.requiredBytes === 51_840_000
      && dof.focusEvidence?.nearFocusRatio > 1.2 && dof.focusEvidence?.farFocusRatio > 1.2
      && dof.focusEvidence?.focusFlipPixels?.changed > 80_000 && dof.productPathCpuPixelCopies === 0
      && exactStrings(dof.rejectedNegativeControls, controls.dof)
      && lens.schema === "editkin.resident-25d-animated-depth-of-field-video-project-render-gate/v1"
      && lens.status === "GREEN" && lens.animatedFrameTransitions === 11 && lens.firstLens?.focusDistance === 3.25 && lens.lastLens?.focusDistance === 4.75
      && lens.endpointNearDelta?.changed === 0 && lens.endpointFarDelta?.changed === 0
      && lens.midpointNearDelta?.changed > 60_000 && lens.midpointFarDelta?.changed > 60_000
      && lens.resourcePlanStableAcrossControls === true && lens.productPathCpuPixelCopies === 0
      && exactStrings(lens.rejectedNegativeControls, controls.lens),
    sourceBoundDesktopDelivery: delivery.smokeGreen === true && delivery.identityExact === true
      && delivery.requiredJourneys === true && delivery.bridgeCoverage === true
      && delivery.executableInsideRepoEvidence === true && delivery.executableBytes > 1_000_000 && sha256(delivery.executableSha256),
  };
}

function validFixture() {
  const vfx = (emitters, ceiling, executor = "wgpu-resident-video-particle-overlay/v1") => ({ dimension: "screen_space_2d", emitterCount: emitters,
    executor, particleCeiling: ceiling, seedMode: "fixed_u32_hash_per_birth", simulationContract: "screen_space_analytic_particles/v1", timeSource: "rational_node_local_frame" });
  const particle = (schema, emitters, ceiling, expectedControls) => ({ schema, status: "GREEN", directExecution: true,
    vfxSimulation: vfx(emitters, ceiling), sameFrameDeterministic: true, timeEvolves: true, localClockReset: true,
    inactiveFramesSuppressParticleWrites: true, activeEmitterReceipts: Array.from({ length: emitters }, () => ({ executor: "wgpu-resident-video-particle-overlay/v1",
      cpuPixelUploads: 0, cpuPixelReadbacks: 0, snapshotCache: { schema: "editkin.resident-particle-seek-snapshot/v1", capacity: 2, cpuPixelCopies: 0 } })),
    cpuPixelUploads: 0, productPathCpuPixelCopies: 0, presentedFrames: 60, presentP95Ms: 10, rejectedNegativeControls: expectedControls,
    releaseFences: { pendingFenceCount: 0 }, repeatedFrameDifference: { changedPixels: 0, changedPixelRatio: 0, maximumChannelDifference: 0 },
    nextFrameDifference: { changedPixels: emitters === 1 ? 700 : 900 }, gpuTextureWrites: emitters === 1 ? 4 : 8, intervals: Array(emitters).fill({}) });
  const temporalMotion = { schema: "editkin.decoded-temporal-shutter-window/v1", contract: "decoded-temporal-shutter-accumulation/v1",
    sourceSampling: "decoded_temporal", sampleCount: 8, cacheHitCount: 6, distinctDecodedTimestampCount: 2, residentFrameRingSize: 8,
    residentBytes: 49_766_400, decodePathCpuPixelCopies: 0, stagingCpuPixelReadbacks: 0, productPathCpuPixelCopies: 0,
    targetsMatchOracle: true, sampleReceipts: Array(8).fill({ clockWithinTolerance: true }) };
  return { reports: {
    timeline: { schema: "editkin.particle-vfx-timeline-gate/v1", status: "GREEN", pluginTimeParameters: true, persistedTimelineRange: true,
      exactFrameRange: true, boundedNegativeControls: ["zero-duration", "past-project-end"], timeline: { timelineStartFrame: 18, sourceStartFrame: 0, durationFrames: 24 } },
    authoredMulti: { schema: "editkin.multi-emitter-particle-vfx-gate/v1", status: "GREEN", persistedEmitterCount: 2, nativeNodeCount: 2,
      previewEmitterCount: 2, pluginEmitterCount: 2, pluginProjectScoped: true, totalParticleCeiling: 112,
      calibratedNegativeControls: ["fifth-emitter", "aggregate-particle-budget", "duplicate-emitter-id"] },
    native: { schema: "editkin.native-particle-simulation-gate/v1", status: "GREEN", baselineRejected: true,
      simulationContract: "screen_space_analytic_particles/v1", executor: "wgpu-bounded-particle-compute/v1", emitterCount: 1, particleCeiling: 64,
      directExecution: true, cpuGpuMaxChannelError: 0, previewExportMaxChannelError: 0, repeatDeterministic: true, timeEvolves: true,
      distinctResidentFrameHashes: 34, residentFrames: 30, residentP95Ms: 1, requiredNodeIds: ["particles", "output"],
      executedNodeIds: ["output", "particles"], blockedNodeIds: [], ignoredNodeIds: [], rejectedNegativeControls: controls.native },
    formalNative: { schema: "editkin.native-particle-project-render-gate/v1", status: "GREEN", persistedProjectRoundTrip: true,
      previewContract: true, graphSchema: "editkin.engine-graph/v1", vfxSimulation: vfx(1, 64, "wgpu-bounded-particle-compute/v1"),
      cpuGpuOutputParity: true, outputSha256: "a".repeat(64) },
    single: particle("editkin.common-engine-video-particle-gate/v1", 1, 64, controls.single),
    multi: particle("editkin.common-engine-video-multi-particle-gate/v1", 2, 112, controls.multi),
    seek: { schema: "editkin.vfx-seek-snapshot-gate/v1", status: "GREEN", randomAccessPixelExact: true, snapshotCapacity: 2,
      cacheHits: 1, cacheMisses: 4, evictionDeterministic: true, computeTextureWrites: 4, snapshotCopies: 4, hitComputeWriteDelta: 0,
      cpuPixelUploads: 0, productPathCpuPixelCopies: 0, particleSnapshotBytes: 460_800, outputHashes: ["a", "b", "a", "c", "b"],
      rejectedNegativeControls: ["snapshot-budget"], snapshotBudgetObservedError: "insufficient budget", releaseFences: { pendingFenceCount: 0 } },
    formalParticleBaseline: { schema: "editkin.resident-scene-linear-temporal-particle-project-render-baseline/v1", status: "BLOCK", productRouteRejected: true },
    formalParticle: { schema: "editkin.resident-scene-linear-temporal-particle-project-render-gate/v1", status: "GREEN", baselineProductRouteRejected: true,
      planner: "editkin-resident-video-scene-linear-aces2-formal-sequence/v1", frameCount: 15, productPathCpuPixelCopies: 0, verificationReadback: true,
      temporalExecutionMode: "decoded-temporal-shutter-scene-linear/v1", temporalLayerCount: 1, temporalFramesWithReceipt: 15,
      temporalSampleCount: 8, particleExecutionMode: "wgpu-resident-video-particle-overlay/v1", framesWithActiveParticles: 6,
      totalParticleEmitterPasses: 6, maximumActiveParticleEmitterCount: 1, temporalChangedPixels: 90_000, particleChangedPixels: 36_000,
      audioRetained: true, bt709Tagged: true, rejectedNegativeControls: controls.formalParticle },
    spatialBaseline: { schema: "editkin.common-engine-video-transform-motion-blur-gate/v1", status: "BLOCK", loadOk: true },
    spatial: { schema: "editkin.common-engine-video-transform-motion-blur-gate/v1", status: "GREEN", directExecution: true,
      motionBlur: { contract: "transform-shutter-accumulation/v1", shutterAngle: 360, sampleCount: 8, sampleFrames: Array(8).fill(0),
        sampleTransforms: Array(8).fill([]), samplesMatchOracle: true }, repeatExact: true, repeatDelta: { changedPixels: 0 },
      artifactDelta: { changedPixels: 50_000 }, presentedFrames: 60, presentP95Ms: 10, productPathCpuPixelCopies: 0,
      rejectedNegativeControls: controls.spatial, releaseFences: { pendingFenceCount: 0 } },
    temporalBaseline: { schema: "editkin.common-engine-video-decoded-temporal-motion-blur-gate/v1", status: "BLOCK", loadOk: true },
    temporal: { schema: "editkin.common-engine-video-decoded-temporal-motion-blur-gate/v1", status: "GREEN", directExecution: true,
      motionBlur: temporalMotion, repeatExact: true, temporalVsSpatialDelta: { changedPixels: 12_000 }, presentedFrames: 30,
      presentP95Ms: 10, productPathCpuPixelCopies: 0, rejectedNegativeControls: controls.temporal, releaseFences: { pendingFenceCount: 0 } },
    formalBlur: { schema: "editkin.transform-motion-blur-project-render-gate/v1", status: "GREEN", executionMode: "resident-gpu-shader-sequence/v1",
      frameCount: 15, losslessPixelDifferences: 0, motionContract: "decoded-temporal-shutter-accumulation/v1", sourceSampling: "decoded_temporal",
      shutterAngle: 360, sampleCount: 8, temporalFramesWithReceipt: 15, maximumDistinctDecodedTimestampCount: 2, residentFrameRingSize: 8,
      residentBytes: 49_766_400, programCount: 0, noPluginInstallRequired: true, productPathCpuPixelCopies: 0, verificationReadback: true,
      audioSourceRetained: true, materializedClipReset: true, rejectedNegativeControls: controls.formalBlur, intermediateSha256: "b".repeat(64) },
    dof: { schema: "editkin.resident-25d-depth-of-field-video-project-render-gate/v1", status: "GREEN", frozenRedBaseline: true, frameCount: 12,
      depthReceiptFrames: 12, depthOfFieldReceiptFrames: 12, compositeFullFramePassCount: 3,
      depthOfField: { executionMode: "scene-linear-depth32f-gather-dof/v1", executor: "wgpu-depth-aware-gather/v1" },
      resourcePlan: { sceneDepthBytes: 2_073_600, requiredBytes: 51_840_000 }, focusEvidence: { nearFocusRatio: 1.3, farFocusRatio: 1.3,
        focusFlipPixels: { changed: 90_000 } }, productPathCpuPixelCopies: 0, rejectedNegativeControls: controls.dof },
    lens: { schema: "editkin.resident-25d-animated-depth-of-field-video-project-render-gate/v1", status: "GREEN", animatedFrameTransitions: 11,
      firstLens: { focusDistance: 3.25 }, lastLens: { focusDistance: 4.75 }, endpointNearDelta: { changed: 0 }, endpointFarDelta: { changed: 0 },
      midpointNearDelta: { changed: 70_000 }, midpointFarDelta: { changed: 70_000 }, resourcePlanStableAcrossControls: true,
      productPathCpuPixelCopies: 0, rejectedNegativeControls: controls.lens },
  }, delivery: { smokeGreen: true, identityExact: true, requiredJourneys: true, bridgeCoverage: true,
    executableInsideRepoEvidence: true, executableBytes: 5_000_000, executableSha256: "c".repeat(64) } };
}

if (process.argv.includes("--self-test")) {
  const mutations = [
    ["authoring", (f) => { f.reports.authoredMulti.persistedEmitterCount = 1; }],
    ["native", (f) => { f.reports.native.repeatDeterministic = false; }],
    ["single", (f) => { f.reports.single.productPathCpuPixelCopies = 1; }],
    ["multi", (f) => { f.reports.multi.vfxSimulation.emitterCount = 1; }],
    ["seek", (f) => { f.reports.seek.outputHashes[2] = "different"; }],
    ["formal-particle", (f) => { f.reports.formalParticle.framesWithActiveParticles = 0; }],
    ["spatial-blur", (f) => { f.reports.spatial.motionBlur.samplesMatchOracle = false; }],
    ["temporal-blur", (f) => { f.reports.temporal.motionBlur.cacheHitCount = 0; }],
    ["formal-blur", (f) => { f.reports.formalBlur.losslessPixelDifferences = 1; }],
    ["dof", (f) => { f.reports.dof.focusEvidence.nearFocusRatio = 1; }],
    ["controls", (f) => { f.reports.multi.rejectedNegativeControls.pop(); }],
    ["delivery", (f) => { f.delivery.identityExact = false; }],
  ];
  const valid = validFixture();
  if (!Object.values(evaluate(valid.reports, valid.delivery)).every(Boolean)) throw new Error("native VFX evaluator rejected its valid fixture");
  for (const [name, mutate] of mutations) {
    const fixture = structuredClone(valid); mutate(fixture);
    if (Object.values(evaluate(fixture.reports, fixture.delivery)).every(Boolean)) throw new Error(`native VFX evaluator missed ${name}`);
  }
  process.stdout.write(`${JSON.stringify({ status: "GREEN", evaluatorMutationsRejected: mutations.length })}\n`);
  process.exit(0);
}

const entries = await Promise.all(Object.entries(reportPaths).map(async ([name, path]) => {
  const bytes = await readFile(path); return [name, { path, bytes, json: JSON.parse(bytes.toString("utf8")) }];
}));
const inputs = Object.fromEntries(entries);
const reports = Object.fromEntries(Object.keys(reportPaths).filter((name) => !["smoke", "manifest"].includes(name)).map((name) => [name, inputs[name].json]));
const smoke = inputs.smoke.json;
const manifest = inputs.manifest.json;
const executablePath = resolve(smoke.executable ?? "");
const executableBytes = await readFile(executablePath);
const stagedManifest = JSON.parse(await readFile(join(dirname(executablePath), "runtime/BUILD-MANIFEST.json"), "utf8"));
const currentReceipt = await computeBuildReceipt(appRoot);
const executableRelative = relative(repoRoot, executablePath);
const journeyNames = smoke.journeySteps?.map((step) => step.name) ?? [];
const nativeBridge = smoke.bridge?.gpuNativeParticleVfx;
const videoBridge = smoke.bridge?.gpuCommonVideoParticle;
const delivery = {
  smokeGreen: smoke.status === "GREEN" && smoke.isDesktop === true && smoke.buildManifest?.status === "GREEN",
  identityExact: identitiesMatch(smoke.buildManifest?.inputIdentity, manifest.inputIdentity)
    && identitiesMatch(currentReceipt.inputIdentity, manifest.inputIdentity) && identitiesMatch(currentReceipt.outputIdentity, manifest.outputIdentity)
    && identitiesMatch(stagedManifest.inputIdentity, manifest.inputIdentity) && identitiesMatch(stagedManifest.outputIdentity, manifest.outputIdentity),
  requiredJourneys: ["gpu-native-particle-vfx-bridge", "gpu-common-video-particle-bridge", "gpu-common-video-engine-bridge", "render"]
    .every((name) => journeyNames.includes(name)),
  bridgeCoverage: nativeBridge?.status === "GREEN" && nativeBridge.coverageComplete === true && nativeBridge.simulationComplete === true
    && nativeBridge.timeEvolves === true && nativeBridge.firstHash !== nativeBridge.secondHash
    && nativeBridge.loaded?.engineGraph?.directExecution === true && nativeBridge.loaded?.engineGraph?.blockedNodeIds?.length === 0
    && nativeBridge.loaded?.engineGraph?.ignoredNodeIds?.length === 0 && nativeBridge.loaded?.vfxSimulation?.emitterCount === 1
    && nativeBridge.loaded?.vfxSimulation?.executor === "wgpu-bounded-particle-compute/v1" && nativeBridge.released?.released === true
    && videoBridge?.status === "GREEN" && videoBridge.coverageComplete === true && videoBridge.simulationComplete === true
    && videoBridge.timeEvolves === true && videoBridge.seekSnapshotComplete === true && videoBridge.resourcePlanComplete === true
    && videoBridge.direct === true && videoBridge.loaded?.engineGraph?.directExecution === true && videoBridge.loaded?.particleCount === 2
    && videoBridge.loaded?.particleTexturesResident === 2 && videoBridge.loaded?.vfxSimulation?.emitterCount === 2
    && videoBridge.loaded?.vfxSimulation?.particleCeiling === 112 && videoBridge.loaded?.resourcePlan?.particleSnapshotCapacityPerEmitter === 2
    && videoBridge.loaded?.resourcePlan?.particleCount === 2 && videoBridge.released?.released === true
    && videoBridge.released?.fences?.pendingFenceCount === 0 && videoBridge.surfaceReleased?.released === true,
  executableInsideRepoEvidence: isAbsolute(executablePath) && executableRelative !== "" && executableRelative !== ".."
    && !executableRelative.startsWith(`..${sep}`) && executableRelative.split(sep).slice(0, 2).join("/") === ".rd/tmp",
  executableBytes: executableBytes.length,
  executableSha256: hash(executableBytes),
};
const checks = evaluate(reports, delivery);
const status = Object.values(checks).every(Boolean) ? "GREEN_INTERNAL_BOUNDED" : "FAIL";
const report = {
  schema: "editkin.native-vfx-internal-gate/v1", measuredAt: new Date().toISOString(), status,
  capabilityStatus: status === "GREEN_INTERNAL_BOUNDED" ? "verified" : "planned", checks,
  measurements: {
    authoredEmitterCount: reports.authoredMulti.persistedEmitterCount, particleCeiling: reports.authoredMulti.totalParticleCeiling,
    nativeResidentP95Ms: reports.native.residentP95Ms, singleEmitterP95Ms: reports.single.presentP95Ms,
    dualEmitterP95Ms: reports.multi.presentP95Ms, seekSnapshotBytes: reports.seek.particleSnapshotBytes,
    formalParticleFrames: reports.formalParticle.frameCount, spatialBlurP95Ms: reports.spatial.presentP95Ms,
    temporalBlurP95Ms: reports.temporal.presentP95Ms, temporalResidentBytes: reports.temporal.motionBlur?.residentBytes,
    depthAttachmentBytes: reports.dof.resourcePlan?.sceneDepthBytes,
    productPathCpuPixelCopies: Math.max(...[reports.single, reports.multi, reports.seek, reports.formalParticle, reports.spatial, reports.temporal, reports.formalBlur, reports.dof, reports.lens].map((item) => item.productPathCpuPixelCopies ?? 0)),
    executableBytes: delivery.executableBytes, executableSha256: delivery.executableSha256, buildInputIdentity: manifest.inputIdentity,
  },
  delivery,
  inputs: Object.fromEntries(await Promise.all(Object.entries(inputs).map(async ([name, input]) => [name, {
    path: input.path, bytes: (await stat(input.path)).size, sha256: hash(input.bytes),
  }]))),
  verifiedBoundary: "Windows/DX12 internal bounded VFX cell: one to four authored deterministic 2D analytic particle emitters (two exercised together); GPU-resident two-frame seek snapshots; resident Preview and 15-frame formal particle output; bounded spatial transform shutter and decoded-temporal eight-sample shutter with formal lossless sequence; plus one Depth32Float 17-tap DOF and bounded lens animation, all source-bound to the isolated Tauri desktop delivery.",
  remainingBlockers: ["arbitrary-effects-and-crossed-vfx-2_5d-graphs", "more-than-four-emitter-adaptive-scheduling", "stateful-particle-physics", "3d-collision-forces-and-fields", "diverse-bokeh-and-occlusion-models", "optical-flow-motion-vector-object-and-camera-blur", "fluid-and-cloth-simulation", "direct-encoder-surface-interop", "long-duration-device-recovery", "macos-metal-parity"],
  aggregateBoundary: "The umbrella native-vfx-simulation capability remains planned. This report verifies only the named Windows internal bounded cell and must not be represented as complete VFX, simulation, or After Effects parity.",
};
await mkdir(outputRoot, { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`NATIVE_VFX_INTERNAL status=${status} report=${outputPath}\n`);
if (status === "FAIL") process.exitCode = 1;
