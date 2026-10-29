import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

export const REQUIRED_OBLIGATION_IDS = Object.freeze([
  "owner-visual-commercial-bundle",
  "editgraph-core", "project-recovery-and-autosave", "native-render-pipeline", "runtime-supply-chain", "release-identity", "artifact-lifecycle-integrity", "release-security-hardening", "runtime-executable-integrity", "windows-pe-exploit-mitigations", "dependency-sbom-and-notices", "beginner-ui", "structured-agent-control", "mcp-canonical-workspace-boundary",
  "video-autopilot-plan-contract", "model-adaptive-agent-routing", "markdown-json-context-protocol", "model-quality-evaluation-matrix", "video-autopilot-workflow-parity", "market-benchmark-contract", "market-leadership-evidence",
  "smart-cut-silence", "automatic-captions", "caption-quality-evaluator", "caption-quality-corpus", "creator-pack", "windows-internal-installer",
  "personal-music-pack", "music-redistribution-rights", "automatic-music-editing", "motion-composition-runtime", "native-motion-tracking", "native-planar-tracking", "motion-tracking-quality",
  "mobile-remote-protocol", "mobile-remote-request-security", "permanent-mobile-device-binding", "mobile-remote-responsive-ui", "managed-update-engine", "update.client-check", "windows-public-signing", "public-update-channel", "update.release-channel", "product-license",
  "ffmpeg-binary-source-receipt", "ffmpeg-corresponding-source", "macos-signed-artifacts", "mobile-real-device-acceptance",
  "scene-detection", "semantic-auto-edit-pipeline", "semantic-highlight-regression-quality", "new-footage-ingestion-and-reentry", "batch-auto-edit-queue", "semantic-highlight-quality", "large-project-windows-4k-host",
  "cross-device-performance-matrix", "editorial-blind-evaluator", "human-editorial-parity",
  "professional-timeline-interaction", "timeline-direct-manipulation", "ripple-delete-close-gap", "timeline-drop-boundary", "source-orientation-auto-canvas", "professional-timeline-ui-parity", "bundled-open-fonts", "primary-color-workspace", "director-console", "professional-color-reference-parity", "aces2-color-management-pipeline", "customizable-modular-workspace",
  "visual-preset-preview-center", "native-autopilot-creative-composition", "caption-design-controls", "cross-network-relay-client", "cross-network-production-relay",
  "session-native-ai-control", "material-intelligence-packet", "mcp-multimodal-keyframes", "evidence-bound-autopilot-v4", "agent-one-click-setup",
  "editorial-profile-routing", "podcast-visual-director", "podcast-speaker-quality", "editorial-profile-token-benchmark", "editorial-unit-cardinality", "dynamic-video-autopilot-rule-coverage", "anonymous-aesthetic-standard", "anonymous-community-knowledge", "bounded-runtime-loading", "dynamic-plugin-automation",
  "wave2-creative-registry", "gpu-realtime-compositor", "gpu-compositor-sidecar", "system-layer-model", "safe-expression-dsl", "core-sfx-pack",
  "native-engine-graph-runtime", "hardware-video-decode-zero-copy", "auto-roto-pixel-matte", "auto-roto-quality-acceptance", "auto-roto-model-router", "roto-model-pack-supply-chain-and-rights",
  "self-authored-screen-keyer", "screen-keyer-quality-acceptance", "self-authored-optical-alpha-refinement", "optical-alpha-quality-acceptance", "high-bit-depth-alpha-and-foreground-delivery", "roto-keyer-autopilot-integration",
  "native-audio-graph", "ocio-gpu-preview-export-parity",
  "professional-layer-compositing", "native-effect-plugin-abi", "advanced-tracking-suite", "native-2_5d-scene", "native-vfx-simulation",
]);

const STATUSES = new Set(["verified", "blocked_external", "planned", "unmeasured"]);
const SCOPES = new Set(["internal", "public", "parity"]);
const REQUIRED_SCOPE_FLOORS = Object.freeze({
  "owner-visual-commercial-bundle": Object.freeze(["internal", "public"]),
  "update.client-check": Object.freeze(["internal", "public"]),
  "update.release-channel": Object.freeze(["public"]),
});
const PRIVATE_PATTERN = /(?:[a-z]:\\|\\\\|\/Users\/|\/home\/|Hao0321_YT_Claude|\.claude[\\/]skills|\.codex[\\/]skills|(?:api[_-]?key|token|secret|password)\s*[:=])/i;
const SUCCESS_EVIDENCE_STATUSES = new Set(["ALLOW", "PASS", "FRESH", "CURRENT", "COMPLETED"]);
const isSuccessfulEvidenceStatus = (status) => status.startsWith("GREEN") || SUCCESS_EVIDENCE_STATUSES.has(status);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const NPM_SCRIPT_RECEIPT_KIND = "editkin/npm-script-execution-receipt-v1";

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256Text(value) {
  return sha256Bytes(Buffer.from(value, "utf8"));
}

function readFileIdentity(absolute, cache) {
  if (cache?.has(absolute)) return cache.get(absolute);
  const contents = readFileSync(absolute);
  const identity = { bytes: contents.length, sha256: sha256Bytes(contents), contents };
  cache?.set(absolute, identity);
  return identity;
}

function fail(findings, code, message, id) {
  findings.push({ status: "FAIL", code, message, ...(id ? { id } : {}) });
}

function hasValidIdentity(identity, allowEmpty = false) {
  return Number.isInteger(identity?.bytes)
    && (allowEmpty ? identity.bytes >= 0 : identity.bytes > 0)
    && SHA256_PATTERN.test(identity?.sha256 ?? "");
}

function validateRequiredIdentity(findings, identity, absolute, id, label, allowEmpty = false, cache) {
  if (identity?.bytes === undefined && identity?.sha256 === undefined) {
    fail(findings, "missing-evidence-identity", `${label} 必須提供 bytes＋sha256`, id);
    return false;
  }
  if (!hasValidIdentity(identity, allowEmpty)) {
    fail(findings, "invalid-evidence-identity", `${label} bytes／sha256 必須成對提供且格式正確`, id);
    return false;
  }
  const actual = readFileIdentity(absolute, cache);
  if (actual.bytes !== identity.bytes || actual.sha256 !== identity.sha256) {
    fail(findings, "stale-evidence-identity", `${label} identity 已漂移：${identity.value ?? absolute}`, id);
    return false;
  }
  return true;
}

function validateRelativeFile(findings, evidence, context, label, options = {}) {
  const { id, root } = context;
  if (typeof evidence?.value !== "string" || isAbsolute(evidence.value) || evidence.value.split(/[\\/]/).includes("..")) {
    fail(findings, "unsafe-evidence-path", `${label} 必須是 app root 內的相對路徑`, id);
    return undefined;
  }
  const absolute = resolve(root, evidence.value);
  if (!(absolute === root || absolute.startsWith(`${root}${sep}`)) || !existsSync(absolute)
    || lstatSync(absolute).isSymbolicLink() || !statSync(absolute).isFile()) {
    fail(findings, "missing-evidence-file", `找不到 ${label}：${evidence.value}`, id);
    return undefined;
  }
  const canonicalRoot = context.rootReal ?? realpathSync(root);
  const canonicalFile = realpathSync(absolute);
  if (!(canonicalFile === canonicalRoot || canonicalFile.startsWith(`${canonicalRoot}${sep}`))) {
    fail(findings, "unsafe-evidence-path", `${label} 不得透過 junction／symlink 離開 app root`, id);
    return undefined;
  }
  validateRequiredIdentity(findings, evidence, absolute, id, label, options.allowEmpty === true, context.identityCache);
  return absolute;
}

function validateFileEvidence(findings, evidence, absolute, id) {
  if (!absolute.toLowerCase().endsWith(".json")) return;
  let document;
  try { document = JSON.parse(readFileSync(absolute, "utf8")); }
  catch { fail(findings, "invalid-evidence-json", `evidence JSON 無法解析：${evidence.value}`, id); return; }
  const reportStatus = typeof document?.status === "string"
    ? document.status
    : typeof document?.decision === "string"
      ? document.decision
      : typeof document?.decision?.status === "string"
        ? document.decision.status
        : undefined;
  if (reportStatus !== undefined && !isSuccessfulEvidenceStatus(reportStatus)) {
    fail(findings, "evidence-report-block", `evidence 報告不是成功狀態：${evidence.value} (${reportStatus})`, id);
  }
}

function readReceipt(findings, absolute, evidence, id) {
  try { return JSON.parse(readFileSync(absolute, "utf8")); }
  catch { fail(findings, "invalid-npm-script-receipt", `npm script receipt 無法解析：${evidence.value}`, id); return undefined; }
}

function validateReceiptFileInput(findings, input, context) {
  // An execution input can deliberately be a failing fixture. Its identity
  // must be current, while success belongs to the executed receipt/result.
  return validateRelativeFile(findings, input, context, "npm script receipt input");
}

function validateNpmScriptEvidence(findings, evidence, context) {
  const { id, root, rootReal, packageJson, verifiedVersion, identityCache } = context;
  const scriptName = evidence?.value;
  const command = typeof scriptName === "string" ? packageJson.scripts?.[scriptName] : undefined;
  if (typeof command !== "string" || !command.trim()) {
    fail(findings, "missing-npm-script", `找不到 npm script：${String(scriptName)}`, id);
    return;
  }
  if (!SHA256_PATTERN.test(evidence?.commandSha256 ?? "")) {
    fail(findings, "missing-npm-script-identity", `npm script evidence 必須提供 commandSha256：${scriptName}`, id);
  } else if (sha256Text(command) !== evidence.commandSha256) {
    fail(findings, "stale-npm-script-identity", `npm script command 已漂移：${scriptName}`, id);
  }

  if (!evidence?.receipt || typeof evidence.receipt !== "object") {
    fail(findings, "missing-npm-script-receipt", `npm script evidence 缺少執行 receipt：${scriptName}`, id);
    return;
  }
  const receiptAbsolute = validateRelativeFile(findings, evidence.receipt, { id, root, rootReal, identityCache }, "npm script receipt");
  if (!receiptAbsolute) return;
  const receipt = readReceipt(findings, receiptAbsolute, evidence.receipt, id);
  if (!receipt) return;
  if (PRIVATE_PATTERN.test(JSON.stringify(receipt))) fail(findings, "private-receipt-data", `npm script receipt 含 private path 或 secret-shaped 資料：${scriptName}`, id);
  if (receipt.schemaVersion !== 1 || receipt.kind !== NPM_SCRIPT_RECEIPT_KIND) {
    fail(findings, "invalid-npm-script-receipt", `npm script receipt schema／kind 不正確：${scriptName}`, id);
  }
  if (typeof receipt.status !== "string" || !isSuccessfulEvidenceStatus(receipt.status)) {
    fail(findings, "npm-script-receipt-block", `npm script receipt 不是成功狀態：${scriptName}`, id);
  }
  if (receipt.productVersion !== verifiedVersion || receipt.productVersion !== packageJson.version) {
    fail(findings, "stale-npm-script-receipt-version", `npm script receipt 產品版本已漂移：${scriptName}`, id);
  }
  if (receipt.script?.name !== scriptName || receipt.script?.command !== command
    || receipt.script?.commandSha256 !== evidence.commandSha256
    || receipt.script?.commandSha256 !== sha256Text(command)) {
    fail(findings, "stale-npm-script-receipt-command", `npm script receipt 未綁定目前 command：${scriptName}`, id);
  }

  const replay = receipt.replay;
  if (replay?.cwd !== "." || !Array.isArray(replay?.argv) || replay.argv.length === 0
    || replay.argv.some((item) => typeof item !== "string")
    || typeof replay?.successMarker !== "string" || !replay.successMarker.trim()) {
    fail(findings, "invalid-npm-script-replay", `npm script receipt 缺少可重播 cwd／argv／successMarker：${scriptName}`, id);
  } else if (PRIVATE_PATTERN.test(JSON.stringify(replay))) {
    fail(findings, "private-receipt-data", `npm script replay 含 private path 或 secret-shaped 資料：${scriptName}`, id);
  }

  const launcher = replay?.launcher;
  if (launcher?.kind === "current-node") {
    if (launcher.version !== process.version || !hasValidIdentity(launcher)) {
      fail(findings, "invalid-npm-script-launcher", `npm script receipt current-node identity 不完整：${scriptName}`, id);
    } else {
      const executableIdentity = readFileIdentity(process.execPath, identityCache);
      if (launcher.bytes !== executableIdentity.bytes || launcher.sha256 !== executableIdentity.sha256) {
        fail(findings, "stale-npm-script-launcher", `npm script receipt Node launcher 已漂移：${scriptName}`, id);
      }
    }
  } else if (launcher?.kind === "repo-file") {
    validateRelativeFile(findings, launcher, { id, root, rootReal, identityCache }, "npm script replay launcher");
  } else {
    fail(findings, "invalid-npm-script-launcher", `npm script receipt launcher kind 不正確：${scriptName}`, id);
  }

  const normalizedInputs = new Set();
  if (!Array.isArray(receipt.inputs) || receipt.inputs.length < 2) {
    fail(findings, "missing-npm-script-inputs", `npm script receipt 必須綁定 package.json 與至少一個執行輸入：${scriptName}`, id);
  } else {
    for (const input of receipt.inputs) {
      validateReceiptFileInput(findings, input, { id, root, rootReal, identityCache });
      if (typeof input?.value === "string") normalizedInputs.add(input.value.replaceAll("\\", "/"));
    }
    if (!normalizedInputs.has("package.json") || normalizedInputs.size < 2) {
      fail(findings, "missing-npm-script-inputs", `npm script receipt inputs 必須含 package.json 與獨立執行輸入：${scriptName}`, id);
    }
  }

  if (Array.isArray(replay?.argv)) {
    const replayFiles = replay.argv
      .filter((item) => typeof item === "string" && item.length > 0 && !isAbsolute(item) && !item.split(/[\\/]/).includes(".."))
      .map((item) => item.replaceAll("\\", "/"))
      .filter((item) => {
        const absolute = resolve(root, item);
        return absolute.startsWith(`${root}${sep}`) && existsSync(absolute) && statSync(absolute).isFile();
      });
    if (!replayFiles.length || replayFiles.some((item) => !normalizedInputs.has(item))) {
      fail(findings, "unbound-npm-script-replay-input", `npm script replay 的可執行檔案參數必須逐一出現在 receipt inputs：${scriptName}`, id);
    }
  }

  const result = receipt.result;
  if (result?.exitCode !== 0) {
    fail(findings, "invalid-npm-script-result", `npm script receipt child exitCode 不是 0：${scriptName}`, id);
  }
  const stdoutAbsolute = validateRelativeFile(findings, result?.stdout, { id, root, rootReal, identityCache }, "npm script stdout artifact", { allowEmpty: true });
  validateRelativeFile(findings, result?.stderr, { id, root, rootReal, identityCache }, "npm script stderr artifact", { allowEmpty: true });
  if (!stdoutAbsolute || statSync(stdoutAbsolute).size <= 0
    || typeof replay?.successMarker !== "string"
    || !readFileSync(stdoutAbsolute, "utf8").includes(replay.successMarker)) {
    fail(findings, "invalid-npm-script-result", `npm script stdout artifact 未保存 successMarker：${scriptName}`, id);
  }
}

function validateEvidence(findings, evidenceItems, context) {
  const { id, root, rootReal, packageJson, verifiedVersion, identityCache } = context;
  if (verifiedVersion !== packageJson.version) fail(findings, "stale-verification", "verifiedVersion 必須等於目前產品版本", id);
  if (!Array.isArray(evidenceItems) || evidenceItems.length === 0) {
    fail(findings, "missing-evidence", "verified 能力必須有可重跑 evidence", id);
    return;
  }
  for (const evidence of evidenceItems) {
    if (evidence?.kind === "npm_script") {
      validateNpmScriptEvidence(findings, evidence, context);
    } else if (evidence?.kind === "file") {
      const absolute = validateRelativeFile(findings, evidence, { id, root, rootReal, identityCache }, "evidence file");
      if (absolute) validateFileEvidence(findings, evidence, absolute, id);
    } else fail(findings, "invalid-evidence-kind", `不支援 evidence kind：${String(evidence?.kind)}`, id);
  }
}

function validateState(findings, state, context) {
  const { id, label } = context;
  if (!STATUSES.has(state?.status)) {
    fail(findings, "invalid-status", `${label} 不支援 status：${String(state?.status)}`, id);
    return;
  }
  if (state.status === "verified") {
    validateEvidence(findings, state.evidence, { ...context, verifiedVersion: state.verifiedVersion });
  } else if (state.status === "blocked_external") {
    for (const field of ["owner", "condition", "action"]) {
      if (typeof state.blocker?.[field] !== "string" || !state.blocker[field].trim()) fail(findings, "incomplete-blocker", `${label} blocked_external 缺少 blocker.${field}`, id);
    }
  } else if (typeof state.nextExperiment !== "string" || !state.nextExperiment.trim()) {
    fail(findings, "missing-next-experiment", `${label} ${state.status} 能力必須有 nextExperiment`, id);
  }
}

export function evaluateProductCapabilities(document, options) {
  const findings = [];
  const identityCache = new Map();
  const root = resolve(options.root);
  const rootReal = realpathSync(root);
  const packageJson = options.packageJson;
  const scope = options.scope ?? "internal";
  if (!SCOPES.has(scope)) fail(findings, "invalid-scope", `不支援 scope：${scope}`);
  if (document?.schemaVersion !== 1) fail(findings, "schema-version", "schemaVersion 必須是 1");
  if (document?.product !== packageJson.productName) fail(findings, "product-drift", "產品名稱與 package.json 不一致");
  if (document?.productVersion !== packageJson.version) fail(findings, "version-drift", "能力總帳版本與 package.json 不一致");
  if (PRIVATE_PATTERN.test(JSON.stringify(document))) fail(findings, "private-data", "能力總帳含本機路徑、private skill 路徑或 secret-shaped 欄位");
  if (!Array.isArray(document?.obligations)) fail(findings, "obligations", "obligations 必須是陣列");
  if (!Array.isArray(document?.requiredObligationIds) || document.requiredObligationIds.length !== REQUIRED_OBLIGATION_IDS.length
    || REQUIRED_OBLIGATION_IDS.some((id) => !document.requiredObligationIds.includes(id))) {
    fail(findings, "required-id-list", "requiredObligationIds 必須完整列出產品的 closed-world 能力義務");
  }

  const obligations = Array.isArray(document?.obligations) ? document.obligations : [];
  const byId = new Map();
  for (const obligation of obligations) {
    const id = typeof obligation?.id === "string" ? obligation.id : "";
    if (!id) { fail(findings, "missing-id", "能力義務缺少 id"); continue; }
    if (byId.has(id)) fail(findings, "duplicate-id", `重複 obligation id：${id}`, id);
    byId.set(id, obligation);
    if (typeof obligation.title !== "string" || !obligation.title.trim()) fail(findings, "missing-title", "能力義務缺少 title", id);
    if (!Array.isArray(obligation.requiredFor) || obligation.requiredFor.some((item) => !SCOPES.has(item))) {
      fail(findings, "invalid-required-for", "requiredFor 必須只包含 internal/public/parity", id);
    }
    for (const requiredScope of Object.hasOwn(REQUIRED_SCOPE_FLOORS, id) ? REQUIRED_SCOPE_FLOORS[id] : []) {
      if (!Array.isArray(obligation.requiredFor) || !obligation.requiredFor.includes(requiredScope)) {
        fail(findings, "required-obligation-scope-floor", `必要能力義務不得省略 ${requiredScope} scope`, id);
      }
    }

    validateState(findings, obligation, { id, label: "aggregate", root, rootReal, packageJson, identityCache });
    if (obligation.scopeStates !== undefined) {
      const declaredScopes = Object.keys(obligation.scopeStates ?? {}).sort();
      const requiredScopes = [...obligation.requiredFor].sort();
      if (declaredScopes.length !== requiredScopes.length || declaredScopes.some((item, index) => item !== requiredScopes[index])) {
        fail(findings, "scope-state-list", "scopeStates 必須與 requiredFor 一對一閉集對應", id);
      }
      for (const scoped of declaredScopes) {
        validateState(findings, obligation.scopeStates[scoped], { id, label: `${scoped} scope`, root, rootReal, packageJson, identityCache });
      }
      if (obligation.status === "verified" && declaredScopes.some((item) => obligation.scopeStates[item]?.status !== "verified")) {
        fail(findings, "aggregate-scope-overclaim", "aggregate verified 不得掩蓋仍開放的 scope", id);
      }
    }

    const effectiveState = obligation.scopeStates?.[scope] ?? obligation;
    if (obligation.requiredFor?.includes(scope) && effectiveState.status !== "verified") {
      fail(findings, "required-capability-open", `${scope} scope 仍未完成：${effectiveState.status}`, id);
    }
  }

  for (const id of document?.requiredObligationIds ?? REQUIRED_OBLIGATION_IDS) if (!byId.has(id)) fail(findings, "missing-obligation", `必要能力義務不存在：${id}`, id);
  const effectiveStatus = (item) => item.scopeStates?.[scope]?.status ?? item.status;
  const counts = Object.fromEntries([...STATUSES].map((status) => [status, obligations.filter((item) => effectiveStatus(item) === status).length]));
  const aggregateCounts = Object.fromEntries([...STATUSES].map((status) => [status, obligations.filter((item) => item.status === status).length]));
  return {
    schemaVersion: 1,
    status: findings.length ? "BLOCK" : "GREEN",
    scope,
    productVersion: document?.productVersion,
    counts,
    aggregateCounts,
    scopedObligationCount: obligations.filter((item) => item.scopeStates !== undefined).length,
    open: obligations.filter((item) => effectiveStatus(item) !== "verified").map((item) => ({ id: item.id, status: effectiveStatus(item), aggregateStatus: item.status, requiredFor: item.requiredFor })),
    findings: findings.length ? findings : [{ status: "PASS", code: "capability-obligation-closure", message: `${scope} scope 的必要能力皆有當版證據` }],
  };
}
