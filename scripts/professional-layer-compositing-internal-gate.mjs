import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { computeBuildReceipt } from "./lib/build-input-identity.mjs";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "../..");
const benchmarkRoot = join(repoRoot, ".rd/benchmarks");
const outputRoot = join(appRoot, ".rd/benchmarks/editkin-professional-layer-compositing-internal");
const outputPath = join(outputRoot, "report.json");
const modeNames = ["normal", "add", "screen", "multiply", "overlay", "soft_light", "hard_light", "difference", "darken", "lighten", "color_dodge", "color_burn"];
const matteModeNames = ["alpha", "alpha_inverted", "luma", "luma_inverted"];
const reportPaths = {
  blend: join(benchmarkRoot, "editkin-common-engine-video-blend/report.json"),
  alpha: join(benchmarkRoot, "editkin-professional-alpha/report.json"),
  sceneLinear: join(benchmarkRoot, "editkin-scene-linear-alpha/report.json"),
  adjustment: join(benchmarkRoot, "editkin-common-engine-video-adjustment/report.json"),
  matte: join(benchmarkRoot, "editkin-common-engine-video-track-matte/report.json"),
  precomposition: join(benchmarkRoot, "editkin-common-engine-video-precomposition/report.json"),
  parenting: join(benchmarkRoot, "editkin-common-engine-video-parenting/report.json"),
  controller: join(benchmarkRoot, "editkin-common-engine-video-controller/report.json"),
  formalAdjustment: join(benchmarkRoot, "editkin-temporal-adjustment-project-render/report.json"),
  formalMatte: join(benchmarkRoot, "editkin-temporal-matte-project-render/report.json"),
  formalPrecomposition: join(benchmarkRoot, "editkin-precomposition/report.json"),
  formalBlend: join(benchmarkRoot, "editkin-blend-modes/report.json"),
  smoke: join(benchmarkRoot, "editkin-tauri-cdp-smoke.json"),
  manifest: join(appRoot, ".release-input-manifest.json"),
};

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const identitiesMatch = (left, right) => left?.files === right?.files && left?.bytes === right?.bytes && left?.sha256 === right?.sha256;
const exactNames = (items, names, key = "mode") => Array.isArray(items) && items.map((item) => item[key]).join() === names.join();
const exactStrings = (actual, expected) => Array.isArray(actual) && actual.join() === expected.join();
const sha256 = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const boundedFrames = (report, negatives, requireProductPathCopyReceipt = true) => report.status === "GREEN" && report.directExecution === true
  && report.presentedFrames >= 60 && report.presentP95Ms <= 33.34
  && (!requireProductPathCopyReceipt || report.productPathCpuPixelCopies === 0)
  && report.rejectedNegativeControls?.length === negatives && report.releaseFences?.pendingFenceCount === 0
  && report.bound?.backend === "Dx12" && report.bound?.bound === true && report.bound?.cpuPixelReadbacks === 0;

function evaluate(reports, delivery) {
  const { blend, alpha, sceneLinear, adjustment, matte, precomposition, parenting, controller,
    formalAdjustment, formalMatte, formalPrecomposition, formalBlend } = reports;
  return {
    blendModes: boundedFrames(blend, 6) && exactNames(blend.modeResults, modeNames)
      && blend.modeResults.every((item) => item.pixels === 518400 && item.maxChannelError <= 25
        && item.p95MaxChannelError <= 1 && item.withinThreeCodeValuesRatio >= .997),
    alphaPremultiplication: alpha.status === "GREEN" && exactStrings(alpha.modes, modeNames)
      && alpha.invalidAlphaRejected === true && alpha.verificationReadback === true
      && alpha.productPathCpuPixelCopiesClaimed === false && alpha.ffmpegExportParity?.maxChannelError <= 1
      && alpha.ffmpegExportParity?.p99ChannelError <= 1 && alpha.modeResults?.every((item) => item.directExecution === true
        && exactStrings(item.straightReceiptAlphaModes, ["opaque", "straight"])
        && exactStrings(item.premultipliedReceiptAlphaModes, ["opaque", "premultiplied"])
        && item.encodingPair?.maxChannelError <= 3 && item.encodingPair?.p99ChannelError <= 1),
    sceneLinear32f: sceneLinear.status === "GREEN" && exactStrings(sceneLinear.modes, modeNames)
      && sceneLinear.invalidPrecisionRejected === true && sceneLinear.malformedRejected === true
      && sceneLinear.preservesNegativeAndHdr === true && sceneLinear.extendedRangeBlendContract === "editkin.scene-linear-blend/v1"
      && sceneLinear.modeResults?.every((item) => exactStrings(item.artifactFormats, Array(4).fill("rgba32_float"))
        && item.extrema?.min < 0 && item.extrema?.max > 1
        && item.straightOracle?.maxAbsoluteError <= .001 && item.premultipliedOracle?.maxAbsoluteError <= .001),
    adjustmentLayer: boundedFrames(adjustment, 8, false) && adjustment.coverageComplete === true
      && adjustment.adjustmentCount === 1 && adjustment.adjustmentExecutionMode === "trailing-full-frame/v1"
      && adjustment.adjustmentPassCount === 1 && exactStrings(adjustment.requiredNodeIds, adjustment.executedNodeIds)
      && adjustment.timelineHandshake === true && adjustment.gradeHandshake === true && adjustment.effectHandshake === true
      && adjustment.inactivePresentHandshake === true && adjustment.preRangeIdentity === true
      && adjustment.postRangeIdentity === true && adjustment.activeArtifactChanged === true
      && adjustment.cpuOracleMaxChannelError <= 3 && adjustment.verificationReadbackIsolated === true
      && adjustment.presentDecodePathCpuPixelCopies === 0 && adjustment.presentStagingCpuPixelReadbacks === 0
      && adjustment.presentNativeSurfaceCpuPixelReadbacks === 0,
    trackMatte: boundedFrames(matte, 6) && exactNames(matte.modeResults, matteModeNames)
      && matte.resourcePlan?.matteCount === 1 && matte.resourcePlan?.maximumFullFramePassesPerPresent <= 3
      && matte.modeResults.every((item) => item.matteExecutionMode === "sampled-track-matte/v1"
        && item.mattePassCount === 1 && item.maxChannelError <= 3 && item.p99MaxChannelError <= 1),
    boundedPrecomposition: boundedFrames(precomposition, 6) && precomposition.precompositionCount === 2
      && precomposition.executedPrecompositionNodes === true && precomposition.differingBytes === 0
      && precomposition.precompositionArtifactSha256 === precomposition.directArtifactSha256
      && exactStrings(precomposition.precompositionNodeIds, ["precomp-outer", "precomp-inner"]),
    parenting: boundedFrames(parenting, 6) && parenting.compositeMode === "typed-parent-transform/v1"
      && parenting.parentCount === 1 && parenting.frameResults?.length === 3
      && parenting.frameResults.every((item) => item.transformOracleMaxError <= .0001
        && item.maxChannelError <= 3 && item.p99MaxChannelError <= 1),
    nullController: boundedFrames(controller, 5) && controller.compositeMode === "typed-controller-parent/v1"
      && controller.controllerCount === 1 && controller.parentCount === 1 && controller.resourceBytesDelta === 0
      && controller.frameResults?.length === 3 && controller.frameResults.every((item) => item.transformOracleMaxError <= .0001
        && item.maxChannelError <= 3 && item.p99MaxChannelError <= 1),
    formalAdjustmentOutput: formalAdjustment.status === "GREEN" && formalAdjustment.losslessPixelDifferences === 0
      && formalAdjustment.adjustmentContract === "decoded-temporal-trailing-adjustment/v1"
      && formalAdjustment.adjustmentFramesWithReceipt === 9 && formalAdjustment.adjustmentPlanSuppressed === true
      && formalAdjustment.adjustmentProjectSuppressed === true && formalAdjustment.productPathCpuPixelCopies === 0
      && formalAdjustment.rejectedNegativeControls?.length === 4 && sha256(formalAdjustment.intermediateSha256),
    formalMatteOutput: formalMatte.status === "GREEN" && formalMatte.losslessPixelDifferences === 0
      && formalMatte.matteContract === "decoded-temporal-track-matte/v1" && formalMatte.matteMode === "luma"
      && formalMatte.matteFramesWithReceipt === 9 && formalMatte.mattePlanSuppressed === true
      && formalMatte.matteProjectSuppressed === true && formalMatte.productPathCpuPixelCopies === 0
      && exactStrings(formalMatte.rejectedNegativeControls, ["missing-runtime", "coverage", "dual-temporal", "typography-mixture", "targeted-fallback"])
      && sha256(formalMatte.intermediateSha256),
    formalPrecompositionOutput: formalPrecomposition.status === "GREEN" && formalPrecomposition.compositionDepth === 2
      && formalPrecomposition.saveReopen === true && formalPrecomposition.circularReferenceGuard === true
      && formalPrecomposition.alphaIntermediate === "prores_ks/yuva444p10le" && formalPrecomposition.averagePsnr >= 50
      && formalPrecomposition.probe?.hasVideo === true && formalPrecomposition.probe?.hasAudio === true,
    formalBlendOutput: formalBlend.status === "GREEN" && exactStrings(formalBlend.modes, modeNames)
      && formalBlend.materiallyDifferent === true && formalBlend.probe?.bitsPerRawSample === 8
      && formalBlend.probe?.hasVideo === true && sha256(formalBlend.frameSha256) && sha256(formalBlend.baselineSha256),
    sourceBoundDelivery: delivery.smokeGreen === true && delivery.identityExact === true
      && delivery.requiredJourneys === true && delivery.bridgeCoverage === true
      && delivery.executableInsideRepoEvidence === true && delivery.executableBytes > 1_000_000
      && sha256(delivery.executableSha256),
  };
}

function validFixture() {
  const bound = { backend: "Dx12", bound: true, cpuPixelReadbacks: 0 };
  const common = (negatives) => ({ status: "GREEN", directExecution: true, presentedFrames: 60, presentP95Ms: 8,
    productPathCpuPixelCopies: 0, rejectedNegativeControls: Array(negatives).fill("negative"),
    releaseFences: { pendingFenceCount: 0 }, bound });
  const modes = modeNames.map((mode) => ({ mode, pixels: 518400, maxChannelError: 1, p95MaxChannelError: 1, withinThreeCodeValuesRatio: 1 }));
  const frameResults = Array(3).fill({ transformOracleMaxError: 0, maxChannelError: 1, p99MaxChannelError: 0 });
  return {
    reports: {
      blend: { ...common(6), modeResults: modes },
      alpha: { status: "GREEN", modes: modeNames, invalidAlphaRejected: true, verificationReadback: true,
        productPathCpuPixelCopiesClaimed: false, ffmpegExportParity: { maxChannelError: 1, p99ChannelError: 1 },
        modeResults: modeNames.map(() => ({ directExecution: true, straightReceiptAlphaModes: ["opaque", "straight"],
          premultipliedReceiptAlphaModes: ["opaque", "premultiplied"], encodingPair: { maxChannelError: 1, p99ChannelError: 1 } })) },
      sceneLinear: { status: "GREEN", modes: modeNames, invalidPrecisionRejected: true, malformedRejected: true,
        preservesNegativeAndHdr: true, extendedRangeBlendContract: "editkin.scene-linear-blend/v1",
        modeResults: modeNames.map(() => ({ artifactFormats: Array(4).fill("rgba32_float"), extrema: { min: -.1, max: 2 },
          straightOracle: { maxAbsoluteError: .0001 }, premultipliedOracle: { maxAbsoluteError: .0001 } })) },
      adjustment: { ...common(8), coverageComplete: true, adjustmentCount: 1, adjustmentExecutionMode: "trailing-full-frame/v1",
        adjustmentPassCount: 1, requiredNodeIds: ["source", "output"], executedNodeIds: ["source", "output"], timelineHandshake: true,
        gradeHandshake: true, effectHandshake: true, inactivePresentHandshake: true, preRangeIdentity: true, postRangeIdentity: true,
        activeArtifactChanged: true, cpuOracleMaxChannelError: 1, verificationReadbackIsolated: true,
        presentDecodePathCpuPixelCopies: 0, presentStagingCpuPixelReadbacks: 0, presentNativeSurfaceCpuPixelReadbacks: 0 },
      matte: { ...common(6), resourcePlan: { matteCount: 1, maximumFullFramePassesPerPresent: 3 },
        modeResults: matteModeNames.map((mode) => ({ mode, matteExecutionMode: "sampled-track-matte/v1", mattePassCount: 1, maxChannelError: 1, p99MaxChannelError: 1 })) },
      precomposition: { ...common(6), precompositionCount: 2, executedPrecompositionNodes: true, differingBytes: 0,
        precompositionArtifactSha256: "a", directArtifactSha256: "a", precompositionNodeIds: ["precomp-outer", "precomp-inner"] },
      parenting: { ...common(6), compositeMode: "typed-parent-transform/v1", parentCount: 1, frameResults },
      controller: { ...common(5), compositeMode: "typed-controller-parent/v1", controllerCount: 1, parentCount: 1, resourceBytesDelta: 0, frameResults },
      formalAdjustment: { status: "GREEN", losslessPixelDifferences: 0, adjustmentContract: "decoded-temporal-trailing-adjustment/v1",
        adjustmentFramesWithReceipt: 9, adjustmentPlanSuppressed: true, adjustmentProjectSuppressed: true,
        productPathCpuPixelCopies: 0, rejectedNegativeControls: Array(4).fill("negative"), intermediateSha256: "a".repeat(64) },
      formalMatte: { status: "GREEN", losslessPixelDifferences: 0, matteContract: "decoded-temporal-track-matte/v1", matteMode: "luma",
        matteFramesWithReceipt: 9, mattePlanSuppressed: true, matteProjectSuppressed: true, productPathCpuPixelCopies: 0,
        rejectedNegativeControls: ["missing-runtime", "coverage", "dual-temporal", "typography-mixture", "targeted-fallback"], intermediateSha256: "b".repeat(64) },
      formalPrecomposition: { status: "GREEN", compositionDepth: 2, saveReopen: true, circularReferenceGuard: true,
        alphaIntermediate: "prores_ks/yuva444p10le", averagePsnr: 60, probe: { hasVideo: true, hasAudio: true } },
      formalBlend: { status: "GREEN", modes: modeNames, materiallyDifferent: true, probe: { bitsPerRawSample: 8, hasVideo: true },
        frameSha256: "c".repeat(64), baselineSha256: "d".repeat(64) },
    },
    delivery: { smokeGreen: true, identityExact: true, requiredJourneys: true, bridgeCoverage: true,
      executableInsideRepoEvidence: true, executableBytes: 5_000_000, executableSha256: "e".repeat(64) },
  };
}

if (process.argv.includes("--self-test")) {
  const mutations = [
    ["blend", (fixture) => { fixture.reports.blend.modeResults.pop(); }],
    ["alpha", (fixture) => { fixture.reports.alpha.invalidAlphaRejected = false; }],
    ["scene-linear", (fixture) => { fixture.reports.sceneLinear.modeResults[0].extrema.max = 1; }],
    ["adjustment", (fixture) => { fixture.reports.adjustment.presentDecodePathCpuPixelCopies = 1; }],
    ["matte", (fixture) => { fixture.reports.matte.modeResults[0].maxChannelError = 4; }],
    ["precomposition", (fixture) => { fixture.reports.precomposition.differingBytes = 1; }],
    ["parenting", (fixture) => { fixture.reports.parenting.frameResults[0].transformOracleMaxError = .1; }],
    ["controller", (fixture) => { fixture.reports.controller.resourceBytesDelta = 1; }],
    ["formal-adjustment", (fixture) => { fixture.reports.formalAdjustment.losslessPixelDifferences = 1; }],
    ["formal-matte", (fixture) => { fixture.reports.formalMatte.rejectedNegativeControls[2] = "stale-control"; }],
    ["formal-precomposition", (fixture) => { fixture.reports.formalPrecomposition.saveReopen = false; }],
    ["formal-blend", (fixture) => { fixture.reports.formalBlend.probe.bitsPerRawSample = 10; }],
    ["delivery-identity", (fixture) => { fixture.delivery.identityExact = false; }],
    ["delivery-journey", (fixture) => { fixture.delivery.requiredJourneys = false; }],
  ];
  const valid = validFixture();
  if (!Object.values(evaluate(valid.reports, valid.delivery)).every(Boolean)) throw new Error("professional compositing evaluator rejected its valid fixture");
  for (const [name, mutate] of mutations) {
    const fixture = structuredClone(valid); mutate(fixture);
    if (Object.values(evaluate(fixture.reports, fixture.delivery)).every(Boolean)) throw new Error(`professional compositing evaluator missed ${name}`);
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
const requiredJourneys = ["gpu-common-video-adjustment-bridge", "gpu-common-video-topology-bridge", "gpu-common-video-composite-bridge", "gpu-common-video-temporal-matte-bridge", "render"];
const topology = smoke.bridge?.gpuCommonVideoTopology;
const delivery = {
  smokeGreen: smoke.status === "GREEN" && smoke.isDesktop === true && smoke.buildManifest?.status === "GREEN",
  identityExact: identitiesMatch(smoke.buildManifest?.inputIdentity, manifest.inputIdentity)
    && identitiesMatch(currentReceipt.inputIdentity, manifest.inputIdentity)
    && identitiesMatch(currentReceipt.outputIdentity, manifest.outputIdentity)
    && identitiesMatch(stagedManifest.inputIdentity, manifest.inputIdentity)
    && identitiesMatch(stagedManifest.outputIdentity, manifest.outputIdentity),
  requiredJourneys: requiredJourneys.every((name) => journeyNames.includes(name)),
  bridgeCoverage: ["gpuCommonVideoAdjustment", "gpuCommonVideoComposite", "gpuCommonVideoTemporalMatte"]
    .every((name) => smoke.bridge?.[name]?.status === "GREEN" && smoke.bridge[name].coverageComplete === true)
    && topology?.status === "GREEN" && topology.malformedRejected === true
    && topology.parentCycleRejected === true && topology.parentGreen === true
    && topology.controllerCycleRejected === true && topology.controllerGreen === true
    && topology.matteLoaded?.compositeMode === "typed-track-matte/v1"
    && topology.precompLoaded?.compositeMode === "resolved-precomposition/v1"
    && topology.parentLoaded?.compositeMode === "typed-parent-transform/v1"
    && topology.controllerLoaded?.compositeMode === "typed-controller-parent/v1"
    && ["matteReleased", "precompReleased", "parentReleased", "controllerReleased", "surfaceReleased"]
      .every((name) => topology[name]?.released === true),
  executableInsideRepoEvidence: isAbsolute(executablePath) && executableRelative !== "" && executableRelative !== ".."
    && !executableRelative.startsWith(`..${sep}`) && executableRelative.split(sep).slice(0, 2).join("/") === ".rd/tmp",
  executableBytes: executableBytes.length,
  executableSha256: hash(executableBytes),
};
const checks = evaluate(reports, delivery);
const status = Object.values(checks).every(Boolean) ? "GREEN_INTERNAL_BOUNDED" : "FAIL";
const report = {
  schema: "editkin.professional-layer-compositing-internal-gate/v1",
  measuredAt: new Date().toISOString(),
  status,
  capabilityStatus: status === "GREEN_INTERNAL_BOUNDED" ? "verified" : "planned",
  checks,
  measurements: {
    blendModeCount: reports.blend.modeResults?.length,
    matteModeCount: reports.matte.modeResults?.length,
    sceneLinearWorstAbsoluteError: Math.max(...reports.sceneLinear.modeResults.flatMap((item) => [item.straightOracle.maxAbsoluteError, item.premultipliedOracle.maxAbsoluteError])),
    adjustmentP95Ms: reports.adjustment.presentP95Ms,
    matteP95Ms: reports.matte.presentP95Ms,
    precompositionP95Ms: reports.precomposition.presentP95Ms,
    parentingP95Ms: reports.parenting.presentP95Ms,
    controllerP95Ms: reports.controller.presentP95Ms,
    formalPrecompositionPsnr: reports.formalPrecomposition.averagePsnr,
    executableBytes: delivery.executableBytes,
    executableSha256: delivery.executableSha256,
    buildInputIdentity: manifest.inputIdentity,
  },
  delivery,
  inputs: Object.fromEntries(await Promise.all(Object.entries(inputs).map(async ([name, input]) => [name, {
    path: input.path, bytes: (await stat(input.path)).size, sha256: hash(input.bytes),
  }]))),
  verifiedBoundary: "Windows/DX12 internal bounded cell: 12 typed blend modes; straight and premultiplied alpha; scene-linear RGBA32F oracle; one trailing adjustment layer; alpha/luma and inverted track mattes; two-level precomposition; one-level parenting or null-controller parenting; bounded temporal matte/adjustment formal outputs; and exact source-bound isolated Tauri delivery.",
  remainingBlockers: [
    "arbitrary-depth-and-crossed-2_5d-vfx-graphs", "transparent-depth-ordering-and-volumetrics",
    "complete-scene-linear-hdr-blend-lighting-holdout", "16-bit-and-32f-file-delivery",
    "direct-encoder-surface-interop", "macos-metal-parity",
  ],
  aggregateBoundary: "The umbrella professional-layer-compositing capability remains planned. This report verifies only the named Windows internal bounded cell and must not be represented as full After Effects parity.",
};
await mkdir(outputRoot, { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`PROFESSIONAL_LAYER_COMPOSITING_INTERNAL status=${status} report=${outputPath}\n`);
if (status === "FAIL") process.exitCode = 1;
