import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { computeBuildReceipt } from "./lib/build-input-identity.mjs";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "../..");
const benchmarkRoot = join(repoRoot, ".rd/benchmarks");
const outputRoot = join(appRoot, ".rd/benchmarks/editkin-advanced-tracking-internal");
const outputPath = join(outputRoot, "report.json");
const planarControls = [
  "perspective-pose", "occlusion-honesty", "first-reacquisition", "scene-cut-false-lock",
  "second-reacquisition", "quad-validity", "dataset-provenance", "frame-cardinality",
  "observation-identity", "latency",
];
const surfaceControls = ["empty", "order", "bounds", "status", "scale", "rotation", "quad-bounds", "quad-order", "quad-degenerate"];
const surfaceNodes = ["source:clip", "transform:clip", "color:clip", "motion-graphic:tracked-tag", "composite:1", "output:main"];
const reportPaths = {
  motion: join(benchmarkRoot, "editkin-motion-tracking-integration.json"),
  planar: join(benchmarkRoot, "editkin-planar-tracking/report.json"),
  planarBaseline: join(benchmarkRoot, "editkin-planar-tracking/baseline-report.json"),
  surface: join(benchmarkRoot, "editkin-tracked-motion-graphic/report.json"),
  surfaceBaseline: join(benchmarkRoot, "editkin-tracked-motion-graphic/quad-composed-baseline-report.json"),
  smoke: join(benchmarkRoot, "editkin-tauri-cdp-smoke.json"),
  manifest: join(appRoot, ".release-input-manifest.json"),
};

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha256 = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const exactStrings = (actual, expected) => Array.isArray(actual) && actual.join() === expected.join();
const sameSet = (actual, expected) => Array.isArray(actual) && [...actual].sort().join() === [...expected].sort().join();
const identitiesMatch = (left, right) => left?.files === right?.files && left?.bytes === right?.bytes && left?.sha256 === right?.sha256;
const finiteQuad = (quad) => Array.isArray(quad) && quad.length === 4
  && quad.every((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y)
    && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1);

function evaluate(reports, delivery) {
  const { motion, planar, planarBaseline, surface, surfaceBaseline } = reports;
  const metrics = planar.metrics ?? {};
  const baselineMetrics = planarBaseline.metrics ?? {};
  const rotation = motion.rotationScaleHoldout ?? {};
  const pixels = surface.sampleEvidence ?? {};
  return {
    regionTranslationAndCache: motion.schemaVersion === 3 && motion.status === "GREEN"
      && motion.engine === "hao-core-rust-motion-track-0.4-region-fallback"
      && motion.frames === 45 && motion.lostRatio <= .15 && motion.error <= .08 && motion.cacheHit === true,
    rotationScaleQuad: rotation.engine === "hao-core-rust-motion-track-0.4-planar"
      && rotation.frames === 45 && rotation.lostRatio <= .25 && rotation.expectedRotation === 32
      && rotation.rotationError <= 12 && rotation.expectedScale === 1.22 && rotation.scaleError <= .25
      && finiteQuad(rotation.finalQuad),
    planarPerspectiveSolve: planar.schema === "editkin.planar-tracking-gate/report/v2"
      && planar.evaluator === "editkin.planar-tracking-gate/v2" && planar.status === "GREEN" && planar.mode === "candidate"
      && planar.engine === "hao-core-rust-motion-track-0.4-planar" && planar.dataset?.frames === 105
      && planar.dataset?.width === 320 && planar.dataset?.height === 180 && planar.dataset?.fps === 15
      && metrics.frameCardinality === 105 && metrics.visibleFrames === 81 && metrics.poseSuccessRate >= .9
      && metrics.meanCornerErrorPx <= 7 && metrics.p95CornerErrorPx <= 12
      && metrics.perspectiveRatioMae <= .05 && metrics.projectiveFrameRatio >= .8
      && metrics.invalidQuadFrames === 0 && metrics.analysisMsPerFrame <= 50 && metrics.cacheHit === true,
    occlusionSceneCutReacquisition: metrics.occlusionTrackedFrames === 0 && metrics.occlusionLostFrames >= 6
      && metrics.firstReacquireFrames <= 6 && metrics.sceneCutTrackedFrames === 0 && metrics.sceneCutLostFrames >= 6
      && metrics.secondReacquireFrames <= 6,
    planarProvenanceAndControls: sha256(planar.dataset?.videoSha256) && sha256(planar.dataset?.annotationSha256)
      && sha256(planar.dataset?.rawSha256) && exactStrings(planar.requiredNegativeControls, planarControls)
      && exactStrings(planar.rejectedNegativeControls, planarControls)
      && planarBaseline.schema === planar.schema && planarBaseline.evaluator === planar.evaluator
      && planarBaseline.status === "BLOCK" && planarBaseline.mode === "baseline"
      && planarBaseline.engine === "hao-core-rust-motion-track-0.3"
      && planarBaseline.dataset?.videoSha256 === planar.dataset.videoSha256
      && planarBaseline.dataset?.annotationSha256 === planar.dataset.annotationSha256
      && planarBaseline.dataset?.rawSha256 === planar.dataset.rawSha256
      && metrics.poseSuccessRate > baselineMetrics.poseSuccessRate
      && metrics.p95CornerErrorPx < baselineMetrics.p95CornerErrorPx
      && metrics.analysisMsPerFrame < baselineMetrics.analysisMsPerFrame,
    residentSurfaceAttachment: surface.schema === "editkin.tracked-motion-graphic-gate/v6" && surface.status === "GREEN"
      && surface.productAdmissionSelected === true && surface.directExecution === true && surface.trackingReceipt === true
      && surface.trackingSampleCount === 90 && surface.graphicTextureUploads === 1
      && surface.trackerFrames === 45 && surface.trackerLostRatio <= .25 && surface.trackerTranslationError <= .08
      && surface.trackerRotationError <= 12 && surface.trackerScaleError <= .25
      && ["translationOracle", "transformReceiptOracle", "pixelMovementOracle", "pixelRotationOracle", "pixelScaleOracle",
        "quadTransportOracle", "quadReceiptOracle", "pixelPerspectiveOracle", "lostStateOracle", "safeAreaOracle"]
        .every((name) => surface[name] === true)
      && surface.presentedFrames >= 60 && surface.presentP95Ms <= 20 && surface.productPathCpuPixelCopies === 0
      && exactStrings(surface.rejectedNegativeControls, surfaceControls) && surface.releaseFences?.pendingFenceCount === 0,
    projectivePixelEvidence: finiteQuad(pixels.early?.expectedQuad) && finiteQuad(pixels.late?.expectedQuad)
      && finiteQuad(pixels.early?.projected?.destinationQuad) && finiteQuad(pixels.late?.projected?.destinationQuad)
      && finiteQuad(pixels.early?.receipt?.sampledDestinationQuad) && finiteQuad(pixels.late?.receipt?.sampledDestinationQuad)
      && pixels.early?.receipt?.trackingMode === "surface" && pixels.late?.receipt?.trackingMode === "surface"
      && pixels.early?.receipt?.trackingSampleCount === 90 && pixels.late?.receipt?.trackingSampleCount === 90
      && pixels.lost?.stats?.changed === 0
      && Math.abs(pixels.observedAngleDelta - pixels.expectedAngleDelta) <= 12
      && Math.abs(pixels.observedScaleRatio - pixels.expectedScaleRatio) <= .2
      && Math.abs(pixels.observedPixelAreaRatio - pixels.expectedProjectedAreaRatio) <= .15
      && Math.abs(pixels.observedPerspectiveRatio - pixels.expectedPerspectiveRatio) <= .1
      && sameSet(surface.requiredNodeIds, surfaceNodes) && sameSet(surface.executedNodeIds, surfaceNodes)
      && sha256(surface.artifacts?.sourceSha256) && sha256(surface.artifacts?.frame12Sha256)
      && sha256(surface.artifacts?.frame48Sha256) && sha256(surface.artifacts?.frame78Sha256),
    frozenAffineBaselineRejected: surfaceBaseline.schema === surface.schema && surfaceBaseline.status === "BLOCK"
      && surfaceBaseline.productAdmissionSelected === true && surfaceBaseline.directExecution === true
      && surfaceBaseline.quadTransportOracle === true && surfaceBaseline.pixelPerspectiveOracle === false
      && surfaceBaseline.artifacts?.sourceSha256 === surface.artifacts?.sourceSha256
      && surfaceBaseline.productPathCpuPixelCopies === 0 && surfaceBaseline.releaseFences?.pendingFenceCount === 0,
    sourceBoundDesktopDelivery: delivery.smokeGreen === true && delivery.identityExact === true
      && delivery.requiredJourneys === true && delivery.bridgeCoverage === true
      && delivery.executableInsideRepoEvidence === true && delivery.executableBytes > 1_000_000
      && sha256(delivery.executableSha256),
  };
}

function validFixture() {
  const quad = [{ x: .2, y: .2 }, { x: .6, y: .2 }, { x: .6, y: .6 }, { x: .2, y: .6 }];
  const dataset = { videoSha256: "a".repeat(64), annotationSha256: "b".repeat(64), rawSha256: "c".repeat(64), frames: 105, width: 320, height: 180, fps: 15 };
  const metrics = { frameCardinality: 105, visibleFrames: 81, poseSuccessRate: .95, meanCornerErrorPx: 4, p95CornerErrorPx: 6,
    perspectiveRatioMae: .02, projectiveFrameRatio: .97, occlusionTrackedFrames: 0, occlusionLostFrames: 6,
    firstReacquireFrames: 2, sceneCutTrackedFrames: 0, sceneCutLostFrames: 6, secondReacquireFrames: 3,
    invalidQuadFrames: 0, analysisMsPerFrame: 7, cacheHit: true };
  const receipt = { trackingMode: "surface", trackingSampleCount: 90, sampledDestinationQuad: quad };
  return {
    reports: {
      motion: { schemaVersion: 3, status: "GREEN", engine: "hao-core-rust-motion-track-0.4-region-fallback", frames: 45,
        lostRatio: 0, error: .01, cacheHit: true, rotationScaleHoldout: { engine: "hao-core-rust-motion-track-0.4-planar",
          frames: 45, lostRatio: 0, expectedRotation: 32, rotationError: .6, expectedScale: 1.22, scaleError: .03, finalQuad: quad } },
      planar: { schema: "editkin.planar-tracking-gate/report/v2", evaluator: "editkin.planar-tracking-gate/v2", status: "GREEN",
        mode: "candidate", engine: "hao-core-rust-motion-track-0.4-planar", dataset, metrics,
        requiredNegativeControls: planarControls, rejectedNegativeControls: planarControls },
      planarBaseline: { schema: "editkin.planar-tracking-gate/report/v2", evaluator: "editkin.planar-tracking-gate/v2", status: "BLOCK",
        mode: "baseline", engine: "hao-core-rust-motion-track-0.3", dataset,
        metrics: { poseSuccessRate: .4, p95CornerErrorPx: 100, analysisMsPerFrame: 180 } },
      surface: { schema: "editkin.tracked-motion-graphic-gate/v6", status: "GREEN", productAdmissionSelected: true,
        directExecution: true, trackingReceipt: true, trackingSampleCount: 90, graphicTextureUploads: 1, trackerFrames: 45,
        trackerLostRatio: 0, trackerTranslationError: .02, trackerRotationError: .6, trackerScaleError: .03,
        translationOracle: true, transformReceiptOracle: true, pixelMovementOracle: true, pixelRotationOracle: true,
        pixelScaleOracle: true, quadTransportOracle: true, quadReceiptOracle: true, pixelPerspectiveOracle: true,
        lostStateOracle: true, safeAreaOracle: true, presentedFrames: 60, presentP95Ms: 14, productPathCpuPixelCopies: 0,
        rejectedNegativeControls: surfaceControls, releaseFences: { pendingFenceCount: 0 }, requiredNodeIds: surfaceNodes,
        executedNodeIds: [...surfaceNodes].reverse(), artifacts: { sourceSha256: "d".repeat(64), frame12Sha256: "e".repeat(64),
          frame48Sha256: "f".repeat(64), frame78Sha256: "1".repeat(64) }, sampleEvidence: {
          early: { expectedQuad: quad, projected: { destinationQuad: quad }, receipt },
          lost: { stats: { changed: 0 } }, late: { expectedQuad: quad, projected: { destinationQuad: quad }, receipt },
          expectedAngleDelta: 24, observedAngleDelta: 19, expectedScaleRatio: 1.16, observedScaleRatio: 1.06,
          expectedProjectedAreaRatio: 1.12, observedPixelAreaRatio: 1.13, expectedPerspectiveRatio: .82, observedPerspectiveRatio: .8,
        } },
      surfaceBaseline: { schema: "editkin.tracked-motion-graphic-gate/v6", status: "BLOCK", productAdmissionSelected: true,
        directExecution: true, quadTransportOracle: true, pixelPerspectiveOracle: false, productPathCpuPixelCopies: 0,
        releaseFences: { pendingFenceCount: 0 }, artifacts: { sourceSha256: "d".repeat(64) } },
    },
    delivery: { smokeGreen: true, identityExact: true, requiredJourneys: true, bridgeCoverage: true,
      executableInsideRepoEvidence: true, executableBytes: 5_000_000, executableSha256: "2".repeat(64) },
  };
}

if (process.argv.includes("--self-test")) {
  const mutations = [
    ["region-translation", (fixture) => { fixture.reports.motion.cacheHit = false; }],
    ["rotation-scale", (fixture) => { fixture.reports.motion.rotationScaleHoldout.rotationError = 20; }],
    ["planar-perspective", (fixture) => { fixture.reports.planar.metrics.projectiveFrameRatio = .5; }],
    ["occlusion-reacquisition", (fixture) => { fixture.reports.planar.metrics.sceneCutTrackedFrames = 1; }],
    ["planar-provenance", (fixture) => { fixture.reports.planar.dataset.videoSha256 = "bad"; }],
    ["planar-baseline", (fixture) => { fixture.reports.planarBaseline.status = "GREEN"; }],
    ["surface-attachment", (fixture) => { fixture.reports.surface.graphicTextureUploads = 2; }],
    ["projective-pixels", (fixture) => { fixture.reports.surface.sampleEvidence.observedPerspectiveRatio = .4; }],
    ["affine-baseline", (fixture) => { fixture.reports.surfaceBaseline.pixelPerspectiveOracle = true; }],
    ["delivery-identity", (fixture) => { fixture.delivery.identityExact = false; }],
    ["delivery-bridge", (fixture) => { fixture.delivery.bridgeCoverage = false; }],
  ];
  const valid = validFixture();
  if (!Object.values(evaluate(valid.reports, valid.delivery)).every(Boolean)) throw new Error("advanced tracking evaluator rejected its valid fixture");
  for (const [name, mutate] of mutations) {
    const fixture = structuredClone(valid); mutate(fixture);
    if (Object.values(evaluate(fixture.reports, fixture.delivery)).every(Boolean)) throw new Error(`advanced tracking evaluator missed ${name}`);
  }
  process.stdout.write(`${JSON.stringify({ status: "GREEN", evaluatorMutationsRejected: mutations.length })}\n`);
  process.exit(0);
}

const entries = await Promise.all(Object.entries(reportPaths).map(async ([name, path]) => {
  const bytes = await readFile(path); return [name, { path, bytes, json: JSON.parse(bytes.toString("utf8")) }];
}));
const inputs = Object.fromEntries(entries);
const reports = Object.fromEntries(["motion", "planar", "planarBaseline", "surface", "surfaceBaseline"].map((name) => [name, inputs[name].json]));
const smoke = inputs.smoke.json;
const manifest = inputs.manifest.json;
const executablePath = resolve(smoke.executable ?? "");
const executableBytes = await readFile(executablePath);
const stagedManifest = JSON.parse(await readFile(join(dirname(executablePath), "runtime/BUILD-MANIFEST.json"), "utf8"));
const currentReceipt = await computeBuildReceipt(appRoot);
const executableRelative = relative(repoRoot, executablePath);
const journeyNames = smoke.journeySteps?.map((step) => step.name) ?? [];
const gpuBridge = smoke.bridge?.gpuCommonVideoMotionGraphic;
const delivery = {
  smokeGreen: smoke.status === "GREEN" && smoke.isDesktop === true && smoke.buildManifest?.status === "GREEN",
  identityExact: identitiesMatch(smoke.buildManifest?.inputIdentity, manifest.inputIdentity)
    && identitiesMatch(currentReceipt.inputIdentity, manifest.inputIdentity)
    && identitiesMatch(currentReceipt.outputIdentity, manifest.outputIdentity)
    && identitiesMatch(stagedManifest.inputIdentity, manifest.inputIdentity)
    && identitiesMatch(stagedManifest.outputIdentity, manifest.outputIdentity),
  requiredJourneys: ["motion-tracking", "planar-motion-tracking", "gpu-common-video-motion-graphic-bridge"]
    .every((name) => journeyNames.includes(name)),
  bridgeCoverage: smoke.bridge?.trackingEngine === "hao-core-rust-motion-track-0.4-region-fallback"
    && smoke.bridge?.trackingPoints >= 15 && smoke.bridge?.planarTrackingEngine === "hao-core-rust-motion-track-0.4-planar"
    && smoke.bridge?.planarTrackingPoints === 105 && smoke.bridge?.planarTrackingDiagnostics >= 60
    && smoke.bridge?.planarTrackingSceneCutFalseLocks === 0 && gpuBridge?.status === "GREEN"
    && gpuBridge.surfaceClosed === true && gpuBridge.sameQuad === true && gpuBridge.surfaceDirect === true
    && gpuBridge.quadRejected === true && gpuBridge.loaded?.engineGraph?.directExecution === true
    && gpuBridge.surfaceSessionReleased?.released === true && gpuBridge.surfaceSessionReleased?.fences?.pendingFenceCount === 0
    && gpuBridge.released?.released === true && gpuBridge.released?.fences?.pendingFenceCount === 0,
  executableInsideRepoEvidence: isAbsolute(executablePath) && executableRelative !== "" && executableRelative !== ".."
    && !executableRelative.startsWith(`..${sep}`) && executableRelative.split(sep).slice(0, 2).join("/") === ".rd/tmp",
  executableBytes: executableBytes.length,
  executableSha256: hash(executableBytes),
};
const checks = evaluate(reports, delivery);
const status = Object.values(checks).every(Boolean) ? "GREEN_INTERNAL_BOUNDED" : "FAIL";
const report = {
  schema: "editkin.advanced-tracking-internal-gate/v1",
  measuredAt: new Date().toISOString(),
  status,
  capabilityStatus: status === "GREEN_INTERNAL_BOUNDED" ? "verified" : "planned",
  checks,
  measurements: {
    regionFrames: reports.motion.frames, regionTranslationError: reports.motion.error,
    rotationErrorDegrees: reports.motion.rotationScaleHoldout?.rotationError,
    scaleError: reports.motion.rotationScaleHoldout?.scaleError,
    planarFrames: reports.planar.metrics?.frameCardinality, planarPoseSuccessRate: reports.planar.metrics?.poseSuccessRate,
    planarMeanCornerErrorPx: reports.planar.metrics?.meanCornerErrorPx,
    planarP95CornerErrorPx: reports.planar.metrics?.p95CornerErrorPx,
    planarPerspectiveRatioMae: reports.planar.metrics?.perspectiveRatioMae,
    planarProjectiveFrameRatio: reports.planar.metrics?.projectiveFrameRatio,
    planarAnalysisMsPerFrame: reports.planar.metrics?.analysisMsPerFrame,
    firstReacquireFrames: reports.planar.metrics?.firstReacquireFrames,
    secondReacquireFrames: reports.planar.metrics?.secondReacquireFrames,
    surfaceP95Ms: reports.surface.presentP95Ms,
    surfaceTrackingSamples: reports.surface.trackingSampleCount,
    productPathCpuPixelCopies: reports.surface.productPathCpuPixelCopies,
    executableBytes: delivery.executableBytes, executableSha256: delivery.executableSha256,
    buildInputIdentity: manifest.inputIdentity,
  },
  delivery,
  inputs: Object.fromEntries(await Promise.all(Object.entries(inputs).map(async ([name, input]) => [name, {
    path: input.path, bytes: (await stat(input.path)).size, sha256: hash(input.bytes),
  }]))),
  verifiedBoundary: "Windows internal bounded tracking cell: native region translation with cache; rotation/scale and four-corner output; deterministic 8-parameter planar homography on one frozen 105-frame H.264 fixture; explicit lost state across full occlusion and scene cut with bounded reacquisition; surface-quad transport into one resident GPU motion graphic; and exact source-bound isolated Tauri delivery.",
  remainingBlockers: [
    "dense-optical-flow-field", "camera-solve", "rolling-shutter-and-heavy-motion-blur",
    "shared-motion-vector-field", "real-competitor-footage-blind-corpus", "human-correction-time-benchmark",
    "formal-output-pixel-parity", "macos-metal-parity",
  ],
  aggregateBoundary: "The umbrella advanced-tracking-suite capability remains planned. This report verifies only the named Windows internal bounded cell and must not be represented as dense optical flow, camera tracking, broad-footage parity or full After Effects tracking parity.",
};
await mkdir(outputRoot, { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`ADVANCED_TRACKING_INTERNAL status=${status} report=${outputPath}\n`);
if (status === "FAIL") process.exitCode = 1;
