import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const appRoot = resolve(import.meta.dirname, "..");
const outputRoot = join(appRoot, ".rd/benchmarks/editkin-auto-roto-sam21-internal"); const outputPath = join(outputRoot, "report.json");
const paths = {
  pack: join(appRoot, ".rd/benchmarks/editkin-auto-roto-sam21-portable-pack-gate/report.json"),
  application: join(appRoot, ".rd/benchmarks/editkin-auto-roto-sam21-product-path/report.json"),
  formal: join(appRoot, ".rd/benchmarks/editkin-auto-roto-sam21-formal-parity/report.json"),
  davis: join(appRoot, ".rd/benchmarks/editkin-auto-roto-davis-hardcase/report.json"),
  synthetic: join(appRoot, ".rd/benchmarks/editkin-auto-roto-synthetic-hardcase/report.json"),
  fallback: join(appRoot, ".rd/benchmarks/editkin-auto-roto-non-nvidia-fallback/report.json"),
  service: join(appRoot, ".rd/benchmarks/editkin-auto-roto-sam21-service-bridge/report.json"),
  lifecycle: join(appRoot, ".rd/benchmarks/editkin-auto-roto-tauri-model-lifecycle/report.json"),
  delivery: join(appRoot, ".rd/benchmarks/editkin-auto-roto-sam21-delivery/report.json"),
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function evaluate(input) {
  const { pack, application, formal, davis, synthetic, fallback, service, lifecycle, delivery } = input;
  return {
    signedSelfContainedRuntime: pack.status === "GREEN" && pack.checks?.productionIdentity && pack.checks?.publisherTrust && pack.checks?.isolatedRuntime && pack.checks?.negativesCalibrated,
    realBidirectionalProductPath: application.status === "GREEN_PRODUCT_PATH" && application.checks?.realVideoMemoryEngine && application.checks?.fullBidirectionalSequence && application.checks?.measuredReceipt,
    frozenCacheTamperRecovery: application.checks?.cacheReplayBound && application.checks?.previewTamperRecomputed && application.checks?.sequenceTamperRecomputed && application.checks?.frameHashesBound,
    correctionPropagation: application.checks?.correctionAppliedAndChangedPixels && application.run?.changedBytes > 0,
    measuredCorrectionTurnaround: application.run?.correctedElapsedMs > 0 && application.run?.correctedElapsedMs <= 60_000,
    formalPreviewExportParity: formal.status === "GREEN_FORMAL_PARITY" && Object.values(formal.checks ?? {}).every(Boolean),
    diverseHairFingerHoldout: davis.status === "GREEN_DAVIS_HARDCASE" && davis.checks?.diverseTags && davis.aggregate?.jAndF >= 70 && synthetic.metrics?.thinDetailRecall >= .5,
    transparencyMotionBlurHoldout: synthetic.status === "GREEN_SYNTHETIC_HARDCASE" && synthetic.metrics?.translucentRecall >= .75 && synthetic.metrics?.motionBlurJ >= .55,
    occlusionReappearanceHoldout: synthetic.metrics?.occlusionLeakage <= .2 && synthetic.metrics?.reappearanceJ >= .7 && davis.checks?.lateQuartileJAndF,
    nativeFallbackWhenCudaUnavailable: fallback.status === "GREEN_NATIVE_FALLBACK" && Object.values(fallback.checks ?? {}).every(Boolean),
    rebuiltProductionService: service.status === "GREEN_PRODUCT_SERVICE_BRIDGE" && Object.values(service.checks ?? {}).every(Boolean),
    sameSignedModelAcrossGates: [application.model?.manifestSha256, davis.artifacts?.pack?.manifestSha256, synthetic.result?.model?.manifestSha256, service.model?.manifestSha256].every((value) => value === pack.identity?.manifestSha256),
    freshInstallCorruptRepair: lifecycle.status === "GREEN_TAURI_MODEL_LIFECYCLE" && Object.values(lifecycle.checks ?? {}).every(Boolean),
    optionalModelDelivery: delivery.status === "GREEN_OPTIONAL_MODEL_DELIVERY" && Object.values(delivery.checks ?? {}).every(Boolean),
  };
}

if (process.argv.includes("--self-test")) {
  const valid = {
    pack: { status: "GREEN", checks: { productionIdentity: true, publisherTrust: true, isolatedRuntime: true, negativesCalibrated: true } },
    application: { status: "GREEN_PRODUCT_PATH", checks: { realVideoMemoryEngine: true, fullBidirectionalSequence: true, measuredReceipt: true, cacheReplayBound: true, previewTamperRecomputed: true, sequenceTamperRecomputed: true, frameHashesBound: true, correctionAppliedAndChangedPixels: true }, run: { changedBytes: 1, correctedElapsedMs: 20_000 } },
    formal: { status: "GREEN_FORMAL_PARITY", checks: { parity: true } }, davis: { status: "GREEN_DAVIS_HARDCASE", checks: { diverseTags: true, lateQuartileJAndF: true }, aggregate: { jAndF: 90 } },
    synthetic: { status: "GREEN_SYNTHETIC_HARDCASE", metrics: { thinDetailRecall: .9, translucentRecall: .9, motionBlurJ: .8, occlusionLeakage: .01, reappearanceJ: .9 }, result: { model: { manifestSha256: "m" } } },
    fallback: { status: "GREEN_NATIVE_FALLBACK", checks: { fallback: true } }, service: { status: "GREEN_PRODUCT_SERVICE_BRIDGE", checks: { bridge: true }, model: { manifestSha256: "m" } },
    lifecycle: { status: "GREEN_TAURI_MODEL_LIFECYCLE", checks: { repair: true } }, delivery: { status: "GREEN_OPTIONAL_MODEL_DELIVERY", checks: { delivery: true } },
  };
  valid.pack.identity = { manifestSha256: "m" }; valid.application.model = { manifestSha256: "m" }; valid.davis.artifacts = { pack: { manifestSha256: "m" } };
  if (!Object.values(evaluate(valid)).every(Boolean)) throw new Error("internal evaluator rejected valid fixture");
  const mutations = [
    ["pack", (f) => { f.pack.status = "FAIL"; }], ["path", (f) => { f.application.status = "FAIL"; }], ["cache", (f) => { f.application.checks.sequenceTamperRecomputed = false; }],
    ["correction", (f) => { f.application.run.changedBytes = 0; }], ["turnaround", (f) => { f.application.run.correctedElapsedMs = 90_000; }], ["formal", (f) => { f.formal.status = "FAIL"; }],
    ["natural", (f) => { f.davis.aggregate.jAndF = 20; }], ["translucent", (f) => { f.synthetic.metrics.translucentRecall = 0; }], ["occlusion", (f) => { f.synthetic.metrics.occlusionLeakage = 1; }],
    ["fallback", (f) => { f.fallback.status = "FAIL"; }], ["service", (f) => { f.service.status = "FAIL"; }], ["model-drift", (f) => { f.davis.artifacts.pack.manifestSha256 = "other"; }], ["lifecycle", (f) => { f.lifecycle.status = "FAIL"; }], ["delivery", (f) => { f.delivery.status = "FAIL"; }],
  ];
  for (const [name, mutate] of mutations) { const fixture = structuredClone(valid); mutate(fixture); if (Object.values(evaluate(fixture)).every(Boolean)) throw new Error(`internal evaluator missed ${name}`); }
  process.stdout.write(`${JSON.stringify({ status: "GREEN", evaluatorMutationsRejected: mutations.length })}\n`); process.exit(0);
}

const entries = await Promise.all(Object.entries(paths).map(async ([name, path]) => { const bytes = await readFile(path); return [name, { value: JSON.parse(bytes), evidence: { path, bytes: (await stat(path)).size, sha256: sha256(bytes) } }]; }));
const reports = Object.fromEntries(entries); const input = Object.fromEntries(entries.map(([name, entry]) => [name, entry.value]));
const checks = evaluate(input); const status = Object.values(checks).every(Boolean) ? "GREEN_INTERNAL_PRODUCT" : "FAIL";
const report = {
  schema: "editkin.auto-roto-sam21-internal-gate/v3", status, capabilityStatus: status === "GREEN_INTERNAL_PRODUCT" ? "verified" : "planned", checks,
  measurements: {
    davisJAndF: input.davis.aggregate?.jAndF, davisJ: input.davis.aggregate?.j, davisF: input.davis.aggregate?.f,
    syntheticSupportJ: input.synthetic.metrics?.aggregateSupportJ, motionBlurJ: input.synthetic.metrics?.motionBlurJ, reappearanceJ: input.synthetic.metrics?.reappearanceJ,
    formalMeanError: input.formal.metrics?.meanCompositeError, formalP95Error: input.formal.metrics?.p95CompositeError,
    correctionSystemTurnaroundSeconds: input.application.run?.correctedElapsedMs / 1000, correctionChangedBytes: input.application.run?.changedBytes,
    propagationP95Ms: input.application.model?.runtime?.propagationP95Ms, peakReservedBytes: input.application.model?.runtime?.peakReservedBytes,
  },
  inputs: Object.fromEntries(Object.entries(reports).map(([name, entry]) => [name, entry.evidence])),
  remainingInternalBlockers: Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name),
  externalScopes: {
    publicRelease: "Public pack hosting/download transport, Authenticode/notarization and license acceptance remain external release operations.",
    macOsParity: "A native macOS runtime/device cell is not executed on this Windows host and remains parity scope.",
    opticalMatting: "The translucent test proves visible support tracking, not physical fractional-alpha reconstruction or foreground decontamination.",
  },
  claimBoundary: "Closes the Windows internal Auto Roto product cell across signed portable runtime, real model execution, natural and controlled hard cases, correction, frozen artifacts, formal export, CUDA-unavailable native fallback, delivered-app install/corruption/repair, and optional-pack delivery. It does not overclaim public signing, macOS parity, or optical matting.",
};
await mkdir(outputRoot, { recursive: true }); await writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
process.stdout.write(`AUTO_ROTO_SAM21_INTERNAL status=${status} capability=${report.capabilityStatus} report=${outputPath}\n`); if (status === "FAIL") process.exitCode = 1;
