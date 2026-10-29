import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { evaluateProductCapabilities, REQUIRED_OBLIGATION_IDS } from "./lib/product-capability-gate.mjs";

// Independent literal sentinel. This list intentionally does not import or derive
// from either the ledger producer or the gate consumer, so synchronized deletion
// from both of those surfaces remains observable for every closed-world ID.
const INDEPENDENT_REQUIRED_OBLIGATION_IDS = Object.freeze([
  "owner-visual-commercial-bundle",
  "editgraph-core",
  "project-recovery-and-autosave",
  "native-render-pipeline",
  "runtime-supply-chain",
  "release-identity",
  "artifact-lifecycle-integrity",
  "release-security-hardening",
  "runtime-executable-integrity",
  "windows-pe-exploit-mitigations",
  "dependency-sbom-and-notices",
  "beginner-ui",
  "structured-agent-control",
  "mcp-canonical-workspace-boundary",
  "video-autopilot-plan-contract",
  "model-adaptive-agent-routing",
  "markdown-json-context-protocol",
  "model-quality-evaluation-matrix",
  "video-autopilot-workflow-parity",
  "market-benchmark-contract",
  "market-leadership-evidence",
  "smart-cut-silence",
  "automatic-captions",
  "caption-quality-evaluator",
  "caption-quality-corpus",
  "creator-pack",
  "personal-music-pack",
  "music-redistribution-rights",
  "automatic-music-editing",
  "motion-composition-runtime",
  "native-motion-tracking",
  "native-planar-tracking",
  "motion-tracking-quality",
  "windows-internal-installer",
  "mobile-remote-protocol",
  "mobile-remote-request-security",
  "permanent-mobile-device-binding",
  "mobile-remote-responsive-ui",
  "managed-update-engine",
  "update.client-check",
  "windows-public-signing",
  "public-update-channel",
  "update.release-channel",
  "product-license",
  "ffmpeg-binary-source-receipt",
  "ffmpeg-corresponding-source",
  "macos-signed-artifacts",
  "mobile-real-device-acceptance",
  "scene-detection",
  "semantic-auto-edit-pipeline",
  "semantic-highlight-regression-quality",
  "new-footage-ingestion-and-reentry",
  "batch-auto-edit-queue",
  "semantic-highlight-quality",
  "large-project-windows-4k-host",
  "cross-device-performance-matrix",
  "editorial-blind-evaluator",
  "human-editorial-parity",
  "professional-timeline-interaction",
  "timeline-direct-manipulation",
  "ripple-delete-close-gap",
  "timeline-drop-boundary",
  "source-orientation-auto-canvas",
  "professional-timeline-ui-parity",
  "bundled-open-fonts",
  "primary-color-workspace",
  "director-console",
  "professional-color-reference-parity",
  "aces2-color-management-pipeline",
  "customizable-modular-workspace",
  "visual-preset-preview-center",
  "native-autopilot-creative-composition",
  "caption-design-controls",
  "cross-network-relay-client",
  "cross-network-production-relay",
  "session-native-ai-control",
  "material-intelligence-packet",
  "mcp-multimodal-keyframes",
  "evidence-bound-autopilot-v4",
  "agent-one-click-setup",
  "editorial-profile-routing",
  "podcast-visual-director",
  "podcast-speaker-quality",
  "editorial-profile-token-benchmark",
  "editorial-unit-cardinality",
  "dynamic-video-autopilot-rule-coverage",
  "anonymous-aesthetic-standard",
  "anonymous-community-knowledge",
  "bounded-runtime-loading",
  "dynamic-plugin-automation",
  "wave2-creative-registry",
  "gpu-realtime-compositor",
  "gpu-compositor-sidecar",
  "system-layer-model",
  "safe-expression-dsl",
  "core-sfx-pack",
  "native-engine-graph-runtime",
  "hardware-video-decode-zero-copy",
  "auto-roto-pixel-matte",
  "auto-roto-quality-acceptance",
  "auto-roto-model-router",
  "roto-model-pack-supply-chain-and-rights",
  "self-authored-screen-keyer",
  "screen-keyer-quality-acceptance",
  "self-authored-optical-alpha-refinement",
  "optical-alpha-quality-acceptance",
  "high-bit-depth-alpha-and-foreground-delivery",
  "roto-keyer-autopilot-integration",
  "native-audio-graph",
  "ocio-gpu-preview-export-parity",
  "professional-layer-compositing",
  "native-effect-plugin-abi",
  "advanced-tracking-suite",
  "native-2_5d-scene",
  "native-vfx-simulation",
]);

const appRoot = resolve(import.meta.dirname, "..");
const document = JSON.parse(await readFile(resolve(appRoot, "product-capabilities.json"), "utf8"));
const packageJson = JSON.parse(await readFile(resolve(appRoot, "package.json"), "utf8"));

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function identityFromBytes(bytes) {
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

async function identityFor(relativePath, root) {
  const bytes = await readFile(resolve(root, relativePath));
  return { value: relativePath, ...identityFromBytes(bytes) };
}

async function writeJson(relativePath, value, root) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  await writeFile(resolve(root, relativePath), bytes);
  return { value: relativePath, ...identityFromBytes(bytes) };
}

function missingIndependentClosedWorldIds(candidate, consumerIds = REQUIRED_OBLIGATION_IDS) {
  return INDEPENDENT_REQUIRED_OBLIGATION_IDS.filter((id) => !consumerIds.includes(id)
    || !candidate.requiredObligationIds?.includes(id)
    || !candidate.obligations?.some((entry) => entry.id === id));
}

const duplicateSentinelIds = INDEPENDENT_REQUIRED_OBLIGATION_IDS.filter((id, index, ids) => ids.indexOf(id) !== index);
if (INDEPENDENT_REQUIRED_OBLIGATION_IDS.length !== 115 || duplicateSentinelIds.length) {
  throw new Error(`獨立 closed-world sentinel 必須正好含 115 個唯一 ID：${duplicateSentinelIds.join(", ")}`);
}
for (const [label, ids] of [["gate consumer", REQUIRED_OBLIGATION_IDS], ["ledger producer", document.requiredObligationIds]]) {
  if (!Array.isArray(ids) || ids.length !== INDEPENDENT_REQUIRED_OBLIGATION_IDS.length
    || new Set(ids).size !== ids.length
    || INDEPENDENT_REQUIRED_OBLIGATION_IDS.some((id) => !ids.includes(id))) {
    throw new Error(`${label} 與 115-ID 獨立 sentinel 不一致`);
  }
}
const initiallyMissing = missingIndependentClosedWorldIds(document);
if (initiallyMissing.length) throw new Error(`獨立 closed-world 固定義務遺漏：${initiallyMissing.join(", ")}`);

const fixtureRoot = await mkdtemp(join(tmpdir(), "editkin-product-capability-gate-"));
const detected = new Set();
try {
  await mkdir(resolve(fixtureRoot, "scripts"), { recursive: true });
  await mkdir(resolve(fixtureRoot, "evidence"), { recursive: true });
  const successMarker = "GREEN_PRODUCT_CAPABILITY_SCRIPT_FIXTURE";
  const scriptName = "fixture:pass";
  const scriptCommand = "node scripts/fixture-pass.mjs";
  const fixturePackageJson = {
    name: "editkin-product-capability-fixture",
    productName: packageJson.productName,
    version: packageJson.version,
    scripts: { [scriptName]: scriptCommand },
  };
  await writeJson("package.json", fixturePackageJson, fixtureRoot);
  const fixtureScript = Buffer.from(`process.stdout.write(${JSON.stringify(`${successMarker}\n`)});\n`, "utf8");
  await writeFile(resolve(fixtureRoot, "scripts/fixture-pass.mjs"), fixtureScript);
  const verifiedFile = Buffer.from("identity-bound product capability evidence\n", "utf8");
  await writeFile(resolve(fixtureRoot, "evidence/verified.txt"), verifiedFile);

  const child = spawnSync(process.execPath, ["scripts/fixture-pass.mjs"], {
    cwd: fixtureRoot,
    encoding: null,
    windowsHide: true,
  });
  if (child.error || child.status !== 0 || !child.stdout?.includes(Buffer.from(successMarker))) {
    throw new Error(`npm script receipt 正控制無法執行：${child.error?.message ?? child.status}`);
  }
  const executableBytes = await readFile(process.execPath);
  const packageInput = await identityFor("package.json", fixtureRoot);
  const scriptInput = await identityFor("scripts/fixture-pass.mjs", fixtureRoot);
  await writeFile(resolve(fixtureRoot, "evidence/fixture-script-stdout.log"), child.stdout ?? Buffer.alloc(0));
  await writeFile(resolve(fixtureRoot, "evidence/fixture-script-stderr.log"), child.stderr ?? Buffer.alloc(0));
  const stdoutArtifact = await identityFor("evidence/fixture-script-stdout.log", fixtureRoot);
  const stderrArtifact = await identityFor("evidence/fixture-script-stderr.log", fixtureRoot);
  const commandSha256 = sha256(Buffer.from(scriptCommand, "utf8"));
  const receiptDocument = {
    schemaVersion: 1,
    kind: "editkin/npm-script-execution-receipt-v1",
    status: "PASS",
    productVersion: fixturePackageJson.version,
    script: { name: scriptName, command: scriptCommand, commandSha256 },
    replay: {
      cwd: ".",
      launcher: { kind: "current-node", version: process.version, ...identityFromBytes(executableBytes) },
      argv: ["scripts/fixture-pass.mjs"],
      successMarker,
    },
    inputs: [packageInput, scriptInput],
    result: {
      exitCode: child.status,
      stdout: stdoutArtifact,
      stderr: stderrArtifact,
    },
  };
  const receiptEvidence = await writeJson("evidence/fixture-script-receipt.json", receiptDocument, fixtureRoot);
  const blockReportEvidence = await writeJson("evidence/block-report.json", { status: "BLOCK" }, fixtureRoot);
  await writeFile(resolve(fixtureRoot, "evidence/no-success-marker.log"), Buffer.from("script output without the required marker\n", "utf8"));
  const noMarkerReceipt = structuredClone(receiptDocument);
  noMarkerReceipt.result.stdout = await identityFor("evidence/no-success-marker.log", fixtureRoot);
  const noMarkerReceiptEvidence = await writeJson("evidence/no-marker-script-receipt.json", noMarkerReceipt, fixtureRoot);

  const verifiedEvidence = [
    { kind: "file", ...(await identityFor("evidence/verified.txt", fixtureRoot)) },
    { kind: "npm_script", value: scriptName, commandSha256, receipt: receiptEvidence },
  ];
  const scopedVerifiedEvidence = { kind: "file", ...(await identityFor("evidence/verified.txt", fixtureRoot)) };
  const positiveDocument = {
    schemaVersion: 1,
    product: fixturePackageJson.productName,
    productVersion: fixturePackageJson.version,
    requiredObligationIds: [...INDEPENDENT_REQUIRED_OBLIGATION_IDS],
    obligations: INDEPENDENT_REQUIRED_OBLIGATION_IDS.map((id) => {
      if (id === "editgraph-core") {
        return { id, title: "Identity-bound positive control", status: "verified", requiredFor: ["internal"], verifiedVersion: fixturePackageJson.version, evidence: structuredClone(verifiedEvidence) };
      }
      if (id === "update.client-check" || id === "update.release-channel" || id === "owner-visual-commercial-bundle") {
        return {
          id, title: `Updater floor fixture ${id}`, status: "verified",
          requiredFor: id === "update.release-channel" ? ["public"] : ["internal", "public"],
          verifiedVersion: fixturePackageJson.version, evidence: structuredClone(verifiedEvidence),
        };
      }
      if (id === "hardware-video-decode-zero-copy") {
        return {
          id,
          title: "Scoped positive control",
          status: "planned",
          requiredFor: ["internal", "parity"],
          nextExperiment: "Fixture aggregate remains open",
          scopeStates: {
            internal: { status: "verified", verifiedVersion: fixturePackageJson.version, evidence: [structuredClone(scopedVerifiedEvidence)] },
            parity: { status: "unmeasured", nextExperiment: "Fixture parity remains unmeasured" },
          },
        };
      }
      return { id, title: `Fixture ${id}`, status: "planned", requiredFor: [], nextExperiment: "Not required by the internal evaluator fixture" };
    }),
  };
  const clone = () => structuredClone(positiveDocument);

  function requireDetection(name, mutate, code, packageOverride = fixturePackageJson, scope = "internal") {
    const fixture = clone();
    mutate(fixture);
    const report = evaluateProductCapabilities(fixture, { root: fixtureRoot, packageJson: packageOverride, scope });
    if (report.status !== "BLOCK" || !report.findings.some((item) => item.code === code)) {
      throw new Error(`${name} fixture 未偵測 ${code}：${JSON.stringify(report.findings)}`);
    }
    detected.add(code);
  }

  const positive = evaluateProductCapabilities(positiveDocument, { root: fixtureRoot, packageJson: fixturePackageJson, scope: "internal" });
  if (positive.status !== "GREEN") throw new Error(`identity-bound positive control 失敗：${JSON.stringify(positive.findings)}`);
  const negativeFixtureInputReceipt = structuredClone(receiptDocument);
  negativeFixtureInputReceipt.inputs.push(blockReportEvidence);
  const negativeFixtureInputEvidence = await writeJson("evidence/negative-fixture-input-receipt.json", negativeFixtureInputReceipt, fixtureRoot);
  const negativeFixtureInputDocument = clone();
  negativeFixtureInputDocument.obligations.find((entry) => entry.id === "editgraph-core")
    .evidence.find((entry) => entry.kind === "npm_script").receipt = negativeFixtureInputEvidence;
  const negativeFixtureInput = evaluateProductCapabilities(negativeFixtureInputDocument, { root: fixtureRoot, packageJson: fixturePackageJson, scope: "internal" });
  if (negativeFixtureInput.status !== "GREEN") throw new Error(`failing script fixture must be accepted as an identity-bound input: ${JSON.stringify(negativeFixtureInput.findings)}`);

  for (const id of INDEPENDENT_REQUIRED_OBLIGATION_IDS) {
    requireDetection(`missing ${id} obligation`, (item) => {
      item.obligations = item.obligations.filter((entry) => entry.id !== id);
    }, "missing-obligation");

    const synchronizedFixture = clone();
    synchronizedFixture.requiredObligationIds = synchronizedFixture.requiredObligationIds.filter((entry) => entry !== id);
    synchronizedFixture.obligations = synchronizedFixture.obligations.filter((entry) => entry.id !== id);
    const synchronizedConsumer = REQUIRED_OBLIGATION_IDS.filter((entry) => entry !== id);
    if (!missingIndependentClosedWorldIds(synchronizedFixture, synchronizedConsumer).includes(id)) {
      throw new Error(`獨立 literal sentinel 未偵測 producer／consumer 同步刪除：${id}`);
    }
    detected.add("synchronized-closed-world-deletion");
  }

  requireDetection("required ID list", (item) => { item.requiredObligationIds = item.requiredObligationIds.filter((id) => id !== "macos-signed-artifacts"); }, "required-id-list");
  const updaterFloorChecks = [];
  for (const [id, scopes] of [["update.client-check", ["internal", "public"]], ["update.release-channel", ["public"]], ["owner-visual-commercial-bundle", ["internal", "public"]]]) {
    requireDetection(`updater ${id} required ID omitted`, (item) => {
      item.requiredObligationIds = item.requiredObligationIds.filter((entry) => entry !== id);
    }, "required-id-list");
    for (const scope of scopes) {
      requireDetection(`updater ${id} ${scope} scope omitted`, (item) => {
        const obligation = item.obligations.find((entry) => entry.id === id);
        obligation.requiredFor = obligation.requiredFor.filter((entry) => entry !== scope);
      }, "required-obligation-scope-floor");
      requireDetection(`updater ${id} ${scope} capability open`, (item) => {
        const obligation = item.obligations.find((entry) => entry.id === id);
        obligation.status = "planned";
        obligation.nextExperiment = "Updater fixture remains open";
        delete obligation.verifiedVersion;
        delete obligation.evidence;
      }, "required-capability-open", fixturePackageJson, scope);
    }
    updaterFloorChecks.push({ id, scopes, missingObligation: "PASS", synchronizedDeletion: "PASS", requiredListOmission: "PASS", scopeOmission: "PASS", openCapability: "PASS" });
  }
  requireDetection("duplicate obligation", (item) => { item.obligations.push(structuredClone(item.obligations[0])); }, "duplicate-id");
  requireDetection("version drift", (item) => { item.productVersion = "0.0.0"; }, "version-drift");
  requireDetection("stale verification", (item) => { item.obligations.find((entry) => entry.status === "verified").verifiedVersion = "0.0.0"; }, "stale-verification");
  requireDetection("missing evidence", (item) => { item.obligations.find((entry) => entry.status === "verified").evidence = []; }, "missing-evidence");
  requireDetection("missing file evidence identity", (item) => {
    const evidence = item.obligations.find((entry) => entry.status === "verified").evidence.find((entry) => entry.kind === "file");
    delete evidence.bytes;
    delete evidence.sha256;
  }, "missing-evidence-identity");
  requireDetection("stale file evidence identity", (item) => {
    const evidence = item.obligations.find((entry) => entry.status === "verified").evidence.find((entry) => entry.kind === "file");
    evidence.bytes = 1;
    evidence.sha256 = "0".repeat(64);
  }, "stale-evidence-identity");
  requireDetection("blocked evidence report", (item) => {
    item.obligations.find((entry) => entry.status === "verified").evidence = [{ kind: "file", ...blockReportEvidence }];
  }, "evidence-report-block");
  requireDetection("missing npm script identity", (item) => {
    delete item.obligations.find((entry) => entry.status === "verified").evidence.find((entry) => entry.kind === "npm_script").commandSha256;
  }, "missing-npm-script-identity");
  requireDetection("missing npm script receipt", (item) => {
    delete item.obligations.find((entry) => entry.status === "verified").evidence.find((entry) => entry.kind === "npm_script").receipt;
  }, "missing-npm-script-receipt");
  const poisonedPackageJson = structuredClone(fixturePackageJson);
  poisonedPackageJson.scripts[scriptName] = "node scripts/poisoned-script.mjs";
  requireDetection("poisoned npm script", () => {}, "stale-npm-script-identity", poisonedPackageJson);
  requireDetection("stale npm script receipt file", (item) => {
    const receipt = item.obligations.find((entry) => entry.status === "verified").evidence.find((entry) => entry.kind === "npm_script").receipt;
    receipt.bytes = 1;
    receipt.sha256 = "0".repeat(64);
  }, "stale-evidence-identity");
  requireDetection("npm script stdout marker", (item) => {
    item.obligations.find((entry) => entry.status === "verified").evidence.find((entry) => entry.kind === "npm_script").receipt = noMarkerReceiptEvidence;
  }, "invalid-npm-script-result");
  requireDetection("incomplete blocker", (item) => {
    const obligation = item.obligations.find((entry) => entry.id === "macos-signed-artifacts");
    obligation.status = "blocked_external";
    obligation.blocker = { owner: "fixture owner", condition: "fixture condition" };
    delete obligation.nextExperiment;
  }, "incomplete-blocker");
  requireDetection("private path", (item) => { item.obligations[0].title = "C:\\Users\\Private\\secret"; }, "private-data");
  requireDetection("missing scoped state", (item) => { delete item.obligations.find((entry) => entry.id === "hardware-video-decode-zero-copy").scopeStates.parity; }, "scope-state-list");
  requireDetection("scoped evidence", (item) => { item.obligations.find((entry) => entry.id === "hardware-video-decode-zero-copy").scopeStates.internal.evidence = []; }, "missing-evidence");
  requireDetection("aggregate scope overclaim", (item) => {
    const obligation = item.obligations.find((entry) => entry.id === "hardware-video-decode-zero-copy");
    obligation.status = "verified";
    obligation.verifiedVersion = fixturePackageJson.version;
    obligation.evidence = structuredClone(verifiedEvidence);
    delete obligation.nextExperiment;
  }, "aggregate-scope-overclaim");

  const motionRuntime = document.obligations.find((entry) => entry.id === "motion-composition-runtime");
  if (motionRuntime?.status !== "planned" || motionRuntime.scopeStates?.internal?.status !== "verified"
    || motionRuntime.scopeStates?.public?.status !== "planned" || motionRuntime.scopeStates?.parity?.status !== "unmeasured") {
    throw new Error("motion-composition-runtime 必須保留 bounded internal／open public／unmeasured parity 的誠實分層");
  }
  const publicReport = evaluateProductCapabilities(document, { root: appRoot, packageJson, scope: "public" });
  if (publicReport.status !== "BLOCK" || !publicReport.findings.some((item) => item.code === "required-capability-open")) {
    throw new Error("public negative control 沒有被未關閉能力阻擋");
  }
  const liveInternalReport = evaluateProductCapabilities(document, { root: appRoot, packageJson, scope: "internal" });
  process.stdout.write(`${JSON.stringify({
    status: "GREEN",
    positiveControl: "PASS",
    publicNegativeControl: "PASS",
    poisonedScriptNegativeControl: "PASS",
    independentClosedWorldSentinelCount: INDEPENDENT_REQUIRED_OBLIGATION_IDS.length,
    synchronizedDeletionChecks: INDEPENDENT_REQUIRED_OBLIGATION_IDS.length,
    updaterFloorChecks,
    liveLedgerStatus: liveInternalReport.status,
    liveLedgerFindingCount: liveInternalReport.findings.filter((item) => item.status === "FAIL").length,
    detected: [...detected],
  })}\n`);
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
