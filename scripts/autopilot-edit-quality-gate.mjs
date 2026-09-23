import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "../..");
const benchmarkRoot = join(repoRoot, ".rd/benchmarks");
const outputPath = resolve(appRoot, ".rd/benchmarks/editkin-autopilot-edit-quality/report.json");
const fixturePath = resolve(appRoot, "scripts/fixtures/autopilot-edit-quality-positive.fixture.json");
const REQUIRED_FAMILIES = ["smartCut", "captions", "motionGraphics", "transitions", "audio", "color", "qa"];
const DECODED_FAMILIES = new Set(["motionGraphics", "transitions", "audio", "color", "qa"]);
const SHA256 = /^[a-f0-9]{64}$/i;
const CONTROLLED_REPORT_PATH = resolve(appRoot, ".rd/benchmarks/editkin-autopilot-edit-quality-controlled-e2e/report.json");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const validSha256 = (value) => typeof value === "string" && SHA256.test(value);
const exactSet = (actual, expected) => Array.isArray(actual)
  && actual.length === expected.length
  && [...actual].sort().join("\n") === [...expected].sort().join("\n");

export function evaluateAutopilotEditQuality(evidence, options = {}) {
  const journey = evidence?.journey ?? {};
  const plan = journey.plan ?? {};
  const apply = journey.apply ?? {};
  const render = journey.render ?? {};
  const receipt = journey.qualityReceipt ?? {};
  const families = evidence?.families ?? {};
  const familyIds = Object.keys(families);
  const human = evidence?.humanEditorial ?? {};
  const checks = {
    schemaCurrent: evidence?.schema === "editkin.autopilot-edit-quality-evidence/v1",
    liveEvidenceNotFixture: options.allowFixture === true || evidence?.fixtureOnly === false,
    currentV4PlanRetained: plan.retainedEvidence === true && plan.schema === "hao.video-autopilot.edit-plan/v4"
      && validSha256(plan.sha256) && validSha256(plan.invocationBindingSha256),
    boundedSemanticDecision: Number.isInteger(plan.contextTokens) && Number.isInteger(plan.maximumContextTokens)
      && plan.contextTokens > 0 && plan.maximumContextTokens > 0 && plan.contextTokens <= plan.maximumContextTokens
      && Number.isInteger(plan.semanticReceiptCount) && plan.semanticReceiptCount > 0
      && validSha256(plan.semanticReceiptSha256) && validSha256(plan.auditReceiptSha256)
      && plan.auditAccepted === true && plan.secondPassRequired === true,
    atomicEditableApply: apply.retainedEvidence === true && apply.schema === "hao.video-autopilot.execution-receipt/v1"
      && apply.atomic === true && apply.projectRevisionAfter === apply.projectRevisionBefore + 1
      && apply.editableTimelineReopened === true && apply.singleAtomicBatchBoundary === true && apply.sourcePreserved === true
      && validSha256(apply.executionReceiptSha256),
    sourcePlanInvocationIdentity: validSha256(journey.sourceSha256) && validSha256(plan.invocationBindingSha256)
      && plan.sourceSha256 === journey.sourceSha256 && apply.sourceSha256 === journey.sourceSha256
      && render.sourceSha256 === journey.sourceSha256 && receipt.sourceSha256 === journey.sourceSha256
      && apply.planSha256 === plan.sha256 && render.planSha256 === plan.sha256 && receipt.planSha256 === plan.sha256
      && apply.invocationBindingSha256 === plan.invocationBindingSha256,
    decodedRetainedRender: render.retainedEvidence === true && render.schema === "editkin.autopilot-render-receipt/v1"
      && render.projectRevision === apply.projectRevisionAfter && validSha256(render.outputSha256)
      && Number.isInteger(render.bytes) && render.bytes > 20_000 && Number.isFinite(render.durationSeconds) && render.durationSeconds > 0
      && render.hasVideo === true && render.hasAudio === true && Number.isInteger(render.decodedFrameCount)
      && render.decodedFrameCount > 1 && Number.isInteger(render.uniqueTailFrames) && render.uniqueTailFrames >= 2
      && validSha256(render.decodedProbeSha256),
    decodedQualityReceiptBound: receipt.retainedEvidence === true
      && receipt.schema === "editkin.autopilot-decoded-quality-receipt/v1"
      && receipt.journeyId === journey.id && receipt.projectRevision === render.projectRevision
      && receipt.outputSha256 === render.outputSha256 && receipt.reviewState === "REVIEW_REQUIRED" && receipt.certified === false
      && validSha256(receipt.bindingSha256) && receipt.semanticReceiptSha256 === plan.semanticReceiptSha256
      && receipt.auditReceiptSha256 === plan.auditReceiptSha256
      && receipt.executionReceiptSha256 === apply.executionReceiptSha256
      && receipt.decodedProbeSha256 === render.decodedProbeSha256,
    familyClosedWorld: exactSet(familyIds, REQUIRED_FAMILIES),
    familyQualityMeasured: REQUIRED_FAMILIES.every((family) => {
      const item = families[family];
      const allowedLevel = DECODED_FAMILIES.has(family)
        ? item?.evidenceLevel === "decoded-artifact" || item?.evidenceLevel === "blind-holdout"
        : ["frozen-regression", "decoded-artifact", "blind-holdout"].includes(item?.evidenceLevel);
      return item?.state === "measured" && item?.status === "GREEN" && item?.evaluatorCalibrated === true
        && Number.isInteger(item?.negativeControlsRejected) && item.negativeControlsRejected > 0
        && validSha256(item?.reportSha256) && allowedLevel;
    }),
    familiesBoundToSameJourney: REQUIRED_FAMILIES.every((family) => families[family]?.sameJourney === true
      && families[family]?.journeyId === journey.id && families[family]?.bindingSha256 === receipt.bindingSha256),
    blindEditorialAcceptance: human.state === "measured" && human.blind === true
      && human.independentGroundTruth === true && human.datasetVisibility === "blind-holdout"
      && Number.isInteger(human.caseCount) && human.caseCount >= 2
      && Number.isInteger(human.reviewerCount) && human.reviewerCount >= 3
      && Number.isInteger(human.responseCount) && human.responseCount >= human.caseCount * human.reviewerCount
      && Number.isFinite(human.winRateExcludingTies) && human.winRateExcludingTies >= 0.5
      && human.severeErrorRate === 0 && Number.isFinite(human.meanScoreDelta) && human.meanScoreDelta >= 0
      && validSha256(human.reportSha256),
  };
  const failures = Object.entries(checks).filter(([, passed]) => !passed).map(([id]) => id);
  const engineeringFailures = failures.filter((id) => id !== "blindEditorialAcceptance");
  const qualityClaimMeasured = engineeringFailures.length === 0 && checks.blindEditorialAcceptance;
  return {
    instrumentStatus: checks.schemaCurrent ? "GREEN" : "BLOCK",
    engineeringStatus: engineeringFailures.length === 0 ? "GREEN_ENGINEERING_BOUNDED" : "BLOCK_ENGINEERING",
    editorialQualityClaim: qualityClaimMeasured ? "MEASURED_BOUNDED" : "BLOCK_UNMEASURED",
    claimStatus: qualityClaimMeasured ? "MEASURED_BOUNDED" : "BLOCK_UNMEASURED",
    checks,
    failures,
    engineeringFailures,
  };
}

function positiveFixtureMutations() {
  return [
    ["schema", (value) => { value.schema = "editkin.autopilot-edit-quality-evidence/v0"; }],
    ["fixture-live", (value) => { value.fixtureOnly = true; }],
    ["legacy-plan", (value) => { value.journey.plan.schema = "hao.video-autopilot.edit-plan/v3"; }],
    ["context-budget", (value) => { value.journey.plan.contextTokens = 1_101; }],
    ["semantic-receipt", (value) => { value.journey.plan.semanticReceiptCount = 0; }],
    ["atomic-revision", (value) => { value.journey.apply.projectRevisionAfter = 6; }],
    ["editable-reopen", (value) => { value.journey.apply.editableTimelineReopened = false; }],
    ["single-atomic-batch", (value) => { value.journey.apply.singleAtomicBatchBoundary = false; }],
    ["source-preservation", (value) => { value.journey.apply.sourcePreserved = false; }],
    ["plan-identity", (value) => { value.journey.render.planSha256 = "9".repeat(64); }],
    ["source-identity", (value) => { value.journey.qualityReceipt.sourceSha256 = "9".repeat(64); }],
    ["invocation-identity", (value) => { value.journey.apply.invocationBindingSha256 = "9".repeat(64); }],
    ["decoded-streams", (value) => { value.journey.render.hasAudio = false; }],
    ["tail-motion", (value) => { value.journey.render.uniqueTailFrames = 1; }],
    ["quality-output-binding", (value) => { value.journey.qualityReceipt.outputSha256 = "9".repeat(64); }],
    ["quality-common-binding", (value) => { value.families.qa.bindingSha256 = "9".repeat(64); }],
    ["semantic-common-binding", (value) => { value.journey.qualityReceipt.semanticReceiptSha256 = "8".repeat(64); }],
    ["audit-common-binding", (value) => { value.journey.qualityReceipt.auditReceiptSha256 = "9".repeat(64); }],
    ["execution-common-binding", (value) => { value.journey.qualityReceipt.executionReceiptSha256 = "9".repeat(64); }],
    ["decode-common-binding", (value) => { value.journey.qualityReceipt.decodedProbeSha256 = "9".repeat(64); }],
    ["review-overclaim", (value) => { value.journey.qualityReceipt.certified = true; }],
    ["family-closed-world", (value) => { delete value.families.transitions; }],
    ["family-measurement", (value) => { value.families.captions.state = "diagnostic"; }],
    ["family-negative-control", (value) => { value.families.audio.negativeControlsRejected = 0; }],
    ["family-decoded-evidence", (value) => { value.families.motionGraphics.evidenceLevel = "architecture"; }],
    ["family-journey-binding", (value) => { value.families.color.sameJourney = false; }],
    ["blind-holdout", (value) => { value.humanEditorial.datasetVisibility = "development-visible"; }],
    ["independent-reviewers", (value) => { value.humanEditorial.reviewerCount = 2; }],
    ["severe-editorial-error", (value) => { value.humanEditorial.severeErrorRate = 0.1; }],
  ];
}

async function selfTest() {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const positive = evaluateAutopilotEditQuality(fixture, { allowFixture: true });
  if (positive.engineeringStatus !== "GREEN_ENGINEERING_BOUNDED" || positive.claimStatus !== "MEASURED_BOUNDED") {
    throw new Error(`autopilot edit quality evaluator rejected positive fixture: ${positive.failures.join(",")}`);
  }
  const rejected = [];
  for (const [id, mutate] of positiveFixtureMutations()) {
    const candidate = structuredClone(fixture);
    mutate(candidate);
    const result = evaluateAutopilotEditQuality(candidate, { allowFixture: id !== "fixture-live" });
    if (result.claimStatus !== "BLOCK_UNMEASURED") throw new Error(`autopilot edit quality evaluator missed ${id}`);
    const editorialOnly = new Set(["blind-holdout", "independent-reviewers", "severe-editorial-error"]);
    if (editorialOnly.has(id)) {
      if (result.engineeringStatus !== "GREEN_ENGINEERING_BOUNDED") throw new Error(`${id} incorrectly blocked engineering closure`);
    } else if (result.engineeringStatus !== "BLOCK_ENGINEERING") throw new Error(`${id} did not block engineering closure`);
    rejected.push(id);
  }
  process.stdout.write(`${JSON.stringify({ status: "GREEN", positiveControl: "PASS", negativeControlsRejected: rejected.length, rejected })}\n`);
}

async function readOptional(path) {
  try {
    const bytes = await readFile(path);
    return { path, bytes, sha256: sha256(bytes), json: JSON.parse(bytes.toString("utf8")), missing: false };
  } catch (error) {
    return { path, missing: true, error: error instanceof Error ? error.message : String(error) };
  }
}

function reportGreen(report) {
  return [report?.status, report?.decision, report?.gate?.status].some((value) => value === "GREEN" || value === "PASS" || value === "MEASURED_BOUNDED");
}

async function currentEvidence() {
  const paths = {
    nativeAutopilot: join(benchmarkRoot, "editkin-native-autopilot-render/report.json"),
    editorialBatch: join(benchmarkRoot, "editkin-reference-29/v4-editorial-batch-verification.json"),
    smartCut: join(benchmarkRoot, "editkin-smart-cut-integration-windows-x64-20260822.json"),
    captions: join(benchmarkRoot, "editkin-automatic-captions-integration.json"),
    motionAndTransitions: join(benchmarkRoot, "editkin-05-creative-render/report.json"),
    audio: join(benchmarkRoot, "editkin-final-audio-quality/report.json"),
    color: join(benchmarkRoot, "editkin-color-render-20260822/report.json"),
    semanticHighlight: resolve(appRoot, ".rd/benchmarks/semantic-highlight-quality-report.json"),
    controlledE2E: CONTROLLED_REPORT_PATH,
  };
  const entries = await Promise.all(Object.entries(paths).map(async ([id, path]) => [id, await readOptional(path)]));
  const inputs = Object.fromEntries(entries);
  const batch = inputs.editorialBatch.json;
  let batchReceipt;
  if (typeof batch?.receiptPath === "string") batchReceipt = await readOptional(resolve(batch.receiptPath));
  const firstBatchOutput = batch?.results?.[0];
  const planSha = batchReceipt?.json?.planSha256;
  const sourceSha = batchReceipt?.json?.sourceSha256;
  const outputSha = firstBatchOutput?.outputSha256;
  const shared = (id, input, state = "diagnostic", evidenceLevel = "frozen-regression", negativeControlsRejected = 0) => ({
    state,
    status: reportGreen(input?.json) ? "GREEN" : "BLOCK",
    sameJourney: false,
    journeyId: id,
    evidenceLevel,
    evaluatorCalibrated: negativeControlsRejected > 0,
    negativeControlsRejected,
    reportSha256: input?.sha256,
  });
  const evidence = {
    schema: "editkin.autopilot-edit-quality-evidence/v1",
    fixtureOnly: false,
    journey: {
      id: "current-evidence-is-not-one-journey",
      sourceSha256: sourceSha,
      plan: {
        retainedEvidence: false,
        schema: batchReceipt?.json?.schema === "hao.video-autopilot.editorial-batch-receipt/v1"
          ? "hao.video-autopilot.editorial-batch/v1" : undefined,
        sha256: planSha,
        sourceSha256: sourceSha,
        contextTokens: undefined,
        maximumContextTokens: 1_100,
        semanticReceiptCount: 0,
        semanticReceiptSha256: undefined,
        auditReceiptSha256: undefined,
        auditAccepted: false,
        secondPassRequired: false,
      },
      apply: {
        retainedEvidence: Boolean(batchReceipt?.json),
        schema: batchReceipt?.json?.schema,
        planSha256: planSha,
        sourceSha256: sourceSha,
        projectRevisionBefore: 0,
        projectRevisionAfter: firstBatchOutput?.projectRevision,
        atomic: false,
        editableTimelineReopened: batch?.reopenedProjectCount === batch?.expectedDeliverableCount,
        singleAtomicBatchBoundary: false,
        sourcePreserved: true,
        executionReceiptSha256: batchReceipt?.sha256,
      },
      render: {
        retainedEvidence: reportGreen(batch),
        schema: "hao.video-autopilot.editorial-batch-verification/v1",
        planSha256: planSha,
        sourceSha256: sourceSha,
        projectRevision: firstBatchOutput?.projectRevision,
        outputSha256: outputSha,
        bytes: undefined,
        durationSeconds: firstBatchOutput?.decodedDuration,
        hasVideo: reportGreen(batch),
        hasAudio: reportGreen(batch),
        decodedFrameCount: undefined,
        uniqueTailFrames: undefined,
        decodedProbeSha256: undefined,
      },
      qualityReceipt: {
        retainedEvidence: false,
        schema: undefined,
        journeyId: undefined,
        planSha256: planSha,
        sourceSha256: sourceSha,
        projectRevision: firstBatchOutput?.projectRevision,
        outputSha256: outputSha,
        reviewState: batchReceipt?.json?.reviewState,
        certified: batchReceipt?.json?.certified,
        bindingSha256: undefined,
        semanticReceiptSha256: undefined,
        auditReceiptSha256: undefined,
        executionReceiptSha256: undefined,
        decodedProbeSha256: undefined,
      },
    },
    families: {
      smartCut: shared("smart-cut-standalone", inputs.smartCut, "diagnostic", "frozen-regression", 6),
      captions: shared("captions-standalone", inputs.captions, "diagnostic", "frozen-regression", 3),
      motionGraphics: shared("creative-render-standalone", inputs.motionAndTransitions, "diagnostic", "decoded-artifact", 0),
      transitions: shared("creative-render-standalone", inputs.motionAndTransitions, "diagnostic", "decoded-artifact", 0),
      audio: shared("final-audio-standalone", inputs.audio, "measured", "decoded-artifact", 4),
      color: shared("color-render-standalone", inputs.color, "diagnostic", "decoded-artifact", 0),
      qa: shared("editorial-batch-standalone", inputs.editorialBatch, "diagnostic", "decoded-artifact", 0),
    },
    humanEditorial: {
      state: "unmeasured",
      blind: false,
      independentGroundTruth: false,
      datasetVisibility: "none",
      caseCount: 0,
      reviewerCount: 0,
      responseCount: 0,
      winRateExcludingTies: 0,
      severeErrorRate: 0,
      meanScoreDelta: 0,
    },
  };
  const controlled = inputs.controlledE2E.json;
  if (controlled?.status === "GREEN_ENGINEERING_BOUNDED" && controlled?.aggregateEvidence) {
    return { evidence: controlled.aggregateEvidence, inputs, batchReceipt, controlled: true };
  }
  return { evidence, inputs, batchReceipt, controlled: false };
}

async function liveGate() {
  const { evidence, inputs, batchReceipt, controlled } = await currentEvidence();
  const result = evaluateAutopilotEditQuality(evidence);
  const inputReceipts = Object.fromEntries(Object.entries(inputs).map(([id, input]) => [id, {
    path: relative(appRoot, input.path).replaceAll("\\", "/"),
    missing: input.missing,
    bytes: input.bytes?.length,
    sha256: input.sha256,
    reportedGreen: reportGreen(input.json),
    error: input.error,
  }]));
  if (batchReceipt) inputReceipts.editorialBatchReceipt = {
    path: "external-editorial-batch-receipt",
    missing: batchReceipt.missing,
    bytes: batchReceipt.bytes?.length,
    sha256: batchReceipt.sha256,
    reportedGreen: batchReceipt.json?.reviewState === "REVIEW_REQUIRED",
    error: batchReceipt.error,
  };
  const report = {
    schema: "editkin.autopilot-edit-quality-gate/report-v1",
    measuredAt: new Date().toISOString(),
    ...result,
    observedCapabilities: {
      currentV4AuditApply: "reproducible-test-only-no-retained-plan-to-render-quality-receipt",
      editableRenderedBatch: reportGreen(inputs.editorialBatch.json) ? "diagnostic-eight-project-render-chain" : "missing-or-blocked",
      nativeAutomaticComposition: reportGreen(inputs.nativeAutopilot.json) ? "diagnostic-one-synthetic-render" : "missing-or-blocked",
      finalEncodedAudio: reportGreen(inputs.audio.json) ? "measured-standalone" : "missing-or-blocked",
      humanEditorialAcceptance: "unmeasured",
      controlledCurrentV4Journey: controlled ? "green-engineering-bounded" : "missing-or-blocked",
    },
    evidence,
    inputs: inputReceipts,
    claimBoundary: "GREEN_ENGINEERING_BOUNDED proves one controlled current-v4 source/invocation-bound journey produced one atomic reopenable EditGraph mutation, a decoded render and same-journey family receipts. It does not claim creator-grade editorial quality. That separate claim remains BLOCK_UNMEASURED until a frozen independent blind longform/shortform holdout with at least three reviewers is measured.",
    nextExperiment: controlled
      ? "Run the frozen independent blind longform/shortform editorial holdout with at least three reviewers; do not reuse this controlled fixture as quality ground truth."
      : "Retain one current v4 MCP audit/apply journey, render that exact post-apply revision without unrelated mutations, and bind every required family to its decoded artifact.",
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const size = await stat(outputPath);
  process.stdout.write(`${JSON.stringify({ status: report.engineeringStatus, editorialQualityClaim: report.editorialQualityClaim, instrumentStatus: report.instrumentStatus, engineeringFailures: report.engineeringFailures, editorialFailures: report.failures.filter((id) => id === "blindEditorialAcceptance"), report: relative(appRoot, outputPath).replaceAll("\\", "/"), bytes: size.size })}\n`);
  const requireEditorial = process.argv.includes("--require-editorial-quality");
  if (report.engineeringStatus !== "GREEN_ENGINEERING_BOUNDED" || (requireEditorial && report.editorialQualityClaim !== "MEASURED_BOUNDED")) process.exitCode = 1;
}

if (process.argv.includes("--self-test")) await selfTest();
else await liveGate();
