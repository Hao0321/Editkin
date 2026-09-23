import { createRequire } from "node:module";
import { resolve } from "node:path";
import {
  assertCandidateId,
  assertSha256,
  canonicalJson,
  EDITKIN_VENDOR_NODE,
  hashBytes,
  sameFilesystemPath,
} from "./editkin-mcp-generation-contract.mjs";

export { EDITKIN_VENDOR_NODE } from "./editkin-mcp-generation-contract.mjs";

export const EDITKIN_MCP_HOST_MIGRATION_SCHEMA = "editkin.mcp-host-migration/v2";
export const EDITKIN_MCP_PRE_MIGRATION_PLAN_SCHEMA = "editkin.mcp-pre-migration-plan/v1";
export const EDITKIN_MCP_HOSTS = Object.freeze(["codex", "claude"]);
export const EDITKIN_MCP_LAUNCHER = resolve(
  import.meta.dirname,
  "../editkin-mcp-generation-launcher.mjs",
);
export const EDITKIN_MCP_ACTIVATOR = resolve(
  import.meta.dirname,
  "../activate-editkin-mcp-generation.mjs",
);

const SHA256 = /^[a-f0-9]{64}$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const require = createRequire(import.meta.url);
const agentSetupContract = require("../../src/shared/agentSetupContract.json");
export const EDITKIN_AGENT_SETUP_ENV_KEYS = Object.freeze([...agentSetupContract.envKeys].sort());
const EDITKIN_AGENT_SETUP_ENV_KEY_SET = new Set(EDITKIN_AGENT_SETUP_ENV_KEYS);
const SECRET_KEY_NAME = /(?:^|_)(?:API_?KEY|AUTH|BEARER|COOKIE|CREDENTIAL|GH_?TOKEN|KEY|PASSWORD|PRIVATE_?KEY|SECRET|SESSION|TOKEN)(?:_|$)/iu;
const CREDENTIAL_SHAPE = /(?:-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|gh[opsu]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9_-]{12,}|(?:authorization|bearer|cookie|credential|password|private[_ -]?key|secret|session[_ -]?token|token|api[_ -]?key)[=: ]\S+)/iu;
const SENSITIVE_ARGUMENT_NAME = /(?:^|[-_])(?:api[-_]?key|auth|bearer|cookie|credential|gh[-_]?token|password|private[-_]?key|secret|session(?:[-_]?token)?|token)(?:$|[-_])/iu;

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  plainObject(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has an unexpected closed-world field set`);
  }
}

function exactHostMap(value, label) {
  exactKeys(value, EDITKIN_MCP_HOSTS, label);
  return value;
}

function sortedEnvironment(environment) {
  plainObject(environment, "MCP host environment");
  return Object.fromEntries(Object.entries(environment)
    .map(([key, value]) => {
      if (!/^[A-Z][A-Z0-9_]*$/u.test(key) || typeof value !== "string" || value.includes("\0")) {
        throw new Error("MCP host environment contains an invalid key or value");
      }
      if (SECRET_KEY_NAME.test(key)) {
        throw new Error("MCP host migration refuses to persist secret-bearing environment fields");
      }
      if (!EDITKIN_AGENT_SETUP_ENV_KEY_SET.has(key)) {
        throw new Error(`MCP host migration environment key is outside agentSetupContract: ${key}`);
      }
      if (CREDENTIAL_SHAPE.test(value)) {
        throw new Error("MCP host migration refuses credential-shaped environment values");
      }
      return [key, value];
    })
    .sort(([left], [right]) => left.localeCompare(right, "en")));
}

function validateArguments(args) {
  if (!Array.isArray(args)) throw new Error("MCP host arguments are invalid");
  for (const argument of args) {
    if (typeof argument !== "string" || argument.includes("\0") || CREDENTIAL_SHAPE.test(argument)) {
      throw new Error("MCP host command or arguments are invalid");
    }
    const flag = /^--?([^=]+)(?:=.*)?$/u.exec(argument);
    if (flag && SENSITIVE_ARGUMENT_NAME.test(flag[1])) {
      throw new Error("MCP host migration refuses credential-bearing arguments");
    }
  }
  return [...args];
}

export function normalizeHostConfiguration(configuration) {
  exactKeys(configuration, ["args", "command", "environment"], "MCP host configuration");
  if (typeof configuration.command !== "string" || !configuration.command.trim()
    || configuration.command.includes("\0") || CREDENTIAL_SHAPE.test(configuration.command)) {
    throw new Error("MCP host command or arguments are invalid");
  }
  return {
    command: resolve(configuration.command),
    args: validateArguments(configuration.args),
    environment: sortedEnvironment(configuration.environment),
  };
}

export function hostConfigurationIdentity(configuration) {
  return hashBytes(canonicalJson(normalizeHostConfiguration(configuration)));
}

export function childCommandIdentity(executable, args) {
  if (typeof executable !== "string" || !executable.trim()) throw new Error("Child executable is invalid");
  return hashBytes(canonicalJson({ executable: resolve(executable), args: validateArguments(args) }));
}

export function stableLauncherConfiguration(environment) {
  return normalizeHostConfiguration({
    command: EDITKIN_VENDOR_NODE,
    args: [EDITKIN_MCP_LAUNCHER],
    environment,
  });
}

export function isStableLauncherConfiguration(configuration) {
  try {
    const normalized = normalizeHostConfiguration(configuration);
    return sameFilesystemPath(normalized.command, EDITKIN_VENDOR_NODE)
      && normalized.args.length === 1
      && sameFilesystemPath(normalized.args[0], EDITKIN_MCP_LAUNCHER);
  } catch {
    return false;
  }
}

export function buildHostMigrationPlan(target, beforeConfiguration) {
  if (!EDITKIN_MCP_HOSTS.includes(target)) throw new Error("Unknown MCP host target");
  const before = normalizeHostConfiguration(beforeConfiguration);
  if (isStableLauncherConfiguration(before)) {
    throw new Error("Pre-migration host configuration already uses the stable launcher; refusing stable-to-stable rollback capture");
  }
  const after = stableLauncherConfiguration(before.environment);
  return {
    schema: EDITKIN_MCP_PRE_MIGRATION_PLAN_SCHEMA,
    target,
    serverId: "editkin",
    before,
    beforeSha256: hostConfigurationIdentity(before),
    after,
    afterSha256: hostConfigurationIdentity(after),
    rollback: {
      expectedCurrentSha256: hostConfigurationIdentity(after),
      restore: before,
      restoreSha256: hostConfigurationIdentity(before),
    },
  };
}

export function validateHostMigrationPlan(plan, expectedTarget) {
  exactKeys(plan, [
    "after", "afterSha256", "before", "beforeSha256", "rollback", "schema", "serverId", "target",
  ], "MCP host migration plan");
  if (plan.schema !== EDITKIN_MCP_PRE_MIGRATION_PLAN_SCHEMA || plan.serverId !== "editkin"
    || plan.target !== expectedTarget || !EDITKIN_MCP_HOSTS.includes(plan.target)) {
    throw new Error("MCP host migration plan identity is invalid");
  }
  const before = normalizeHostConfiguration(plan.before);
  const after = normalizeHostConfiguration(plan.after);
  assertSha256(plan.beforeSha256, "MCP host before configuration identity");
  assertSha256(plan.afterSha256, "MCP host target configuration identity");
  if (isStableLauncherConfiguration(before)) {
    throw new Error("Persisted pre-migration plan cannot use the stable launcher as its before state");
  }
  if (hostConfigurationIdentity(before) !== plan.beforeSha256
    || hostConfigurationIdentity(after) !== plan.afterSha256
    || !isStableLauncherConfiguration(after)) {
    throw new Error("MCP host migration plan is not bound to the stable launcher");
  }
  exactKeys(plan.rollback, ["expectedCurrentSha256", "restore", "restoreSha256"], "MCP host rollback plan");
  if (plan.rollback.expectedCurrentSha256 !== plan.afterSha256
    || plan.rollback.restoreSha256 !== plan.beforeSha256
    || canonicalJson(normalizeHostConfiguration(plan.rollback.restore)) !== canonicalJson(before)) {
    throw new Error("MCP host rollback plan does not restore the exact captured configuration");
  }
  return plan;
}

function preMigrationRecordIdentity(recordWithoutIdentity) {
  return hashBytes(canonicalJson(recordWithoutIdentity));
}

export function buildPreMigrationPlanRecord(observations, capturedAt = new Date().toISOString()) {
  exactHostMap(observations, "MCP host pre-migration observations");
  if (!ISO_UTC.test(capturedAt)) throw new Error("MCP pre-migration capture timestamp is invalid");
  const hosts = Object.fromEntries(EDITKIN_MCP_HOSTS.map((target) => {
    const observation = observations[target];
    exactKeys(observation, ["configuration", "sourceBytesSha256", "sourcePathSha256"], `${target} pre-migration observation`);
    assertSha256(observation.sourceBytesSha256, `${target} source bytes identity`);
    assertSha256(observation.sourcePathSha256, `${target} source path identity`);
    const plan = buildHostMigrationPlan(target, observation.configuration);
    return [target, {
      configurationSha256: plan.beforeSha256,
      sourceBytesSha256: observation.sourceBytesSha256,
      sourcePathSha256: observation.sourcePathSha256,
      plan,
    }];
  }));
  const unsigned = {
    schema: EDITKIN_MCP_PRE_MIGRATION_PLAN_SCHEMA,
    capturedAt,
    hosts,
  };
  return { ...unsigned, recordSha256: preMigrationRecordIdentity(unsigned) };
}

export function validatePreMigrationPlanRecord(record) {
  exactKeys(record, ["capturedAt", "hosts", "recordSha256", "schema"], "MCP pre-migration plan record");
  if (record.schema !== EDITKIN_MCP_PRE_MIGRATION_PLAN_SCHEMA || !ISO_UTC.test(record.capturedAt)) {
    throw new Error("MCP pre-migration plan record schema or timestamp is invalid");
  }
  assertSha256(record.recordSha256, "MCP pre-migration plan record identity");
  const unsigned = { schema: record.schema, capturedAt: record.capturedAt, hosts: record.hosts };
  if (preMigrationRecordIdentity(unsigned) !== record.recordSha256) {
    throw new Error("MCP pre-migration plan record identity drifted");
  }
  exactHostMap(record.hosts, "MCP pre-migration plan hosts");
  for (const target of EDITKIN_MCP_HOSTS) {
    const host = record.hosts[target];
    exactKeys(host, ["configurationSha256", "plan", "sourceBytesSha256", "sourcePathSha256"], `${target} persisted pre-migration host`);
    for (const [label, value] of [
      ["configuration", host.configurationSha256],
      ["source bytes", host.sourceBytesSha256],
      ["source path", host.sourcePathSha256],
    ]) assertSha256(value, `${target} persisted ${label} identity`);
    const plan = validateHostMigrationPlan(host.plan, target);
    if (host.configurationSha256 !== plan.beforeSha256) {
      throw new Error(`${target} persisted pre-migration identity disagrees with its rollback plan`);
    }
  }
  return record;
}

function validateCandidate(candidate) {
  exactKeys(candidate, [
    "candidateId", "entrypointSha256", "fileCount", "generationId", "manifestSha256", "status", "vendorNodeSha256",
  ], "MCP candidate identity");
  if (candidate.status !== "GREEN_MCP_GENERATION_CANDIDATE") {
    throw new Error("MCP candidate preflight is not GREEN");
  }
  assertCandidateId(candidate.candidateId);
  for (const [label, value] of [
    ["generation ID", candidate.generationId],
    ["manifest identity", candidate.manifestSha256],
    ["entrypoint identity", candidate.entrypointSha256],
    ["vendor Node identity", candidate.vendorNodeSha256],
  ]) assertSha256(value, `MCP candidate ${label}`);
  if (!Number.isSafeInteger(candidate.fileCount) || candidate.fileCount <= 0) {
    throw new Error("MCP candidate file count is invalid");
  }
  return candidate;
}

function validateActive(active, candidate, activationReceipt) {
  if (active === null) return null;
  exactKeys(active, [
    "candidateId", "commitSha256", "fileCount", "generationDirectoryName", "generationId",
    "manifestSha256", "pointerIdentity", "selectionRevision", "vendorNodeSha256",
  ], "Active MCP generation");
  for (const key of ["commitSha256", "generationId", "manifestSha256", "pointerIdentity", "vendorNodeSha256"]) {
    assertSha256(active[key], `Active MCP ${key}`);
  }
  if (!Number.isSafeInteger(active.fileCount) || active.fileCount <= 0
    || typeof active.generationDirectoryName !== "string"
    || !/^[a-f0-9]{32}$/u.test(active.selectionRevision)
    || active.candidateId !== candidate.candidateId
    || active.generationId !== candidate.generationId
    || active.manifestSha256 !== candidate.manifestSha256
    || active.fileCount !== candidate.fileCount
    || active.vendorNodeSha256 !== candidate.vendorNodeSha256) {
    throw new Error("Active MCP pointer selects a different candidate generation");
  }
  if (activationReceipt && (active.commitSha256 !== activationReceipt.commitSha256
    || active.pointerIdentity !== activationReceipt.pointerIdentity
    || active.generationDirectoryName !== activationReceipt.generationDirectoryName
    || active.selectionRevision !== activationReceipt.selectionRevision)) {
    throw new Error("Active MCP pointer disagrees with the gate-owned activation verification");
  }
  return active;
}

function validateBoundedChild(child, label, expectedCommandIdentity) {
  exactKeys(child, [
    "commandIdentity", "durationMs", "exitCode", "requestSha256", "responseSha256",
    "stderrBytes", "stderrSha256", "stdoutBytes", "stdoutSha256", "successMarker", "timedOut",
  ], label);
  for (const key of ["commandIdentity", "requestSha256", "responseSha256", "stderrSha256", "stdoutSha256"]) {
    assertSha256(child[key], `${label} ${key}`);
  }
  if (child.commandIdentity !== expectedCommandIdentity
    || !Number.isSafeInteger(child.durationMs) || child.durationMs < 0 || child.durationMs > 120_000
    || (child.exitCode !== null && !Number.isInteger(child.exitCode))
    || !Number.isSafeInteger(child.stderrBytes) || child.stderrBytes < 0 || child.stderrBytes > 4_194_304
    || !Number.isSafeInteger(child.stdoutBytes) || child.stdoutBytes < 0 || child.stdoutBytes > 4_194_304
    || typeof child.timedOut !== "boolean"
    || (child.successMarker !== null && typeof child.successMarker !== "string")) {
    throw new Error(`${label} is invalid or unbounded`);
  }
  return child;
}

function activationPayloadIdentity(candidate, active) {
  return hashBytes(canonicalJson({
    status: "GREEN_ACTIVE_GENERATION_VERIFIED",
    candidateId: active.candidateId,
    generationId: active.generationId,
    generationDirectoryName: active.generationDirectoryName,
    commitSha256: active.commitSha256,
    pointerIdentity: active.pointerIdentity,
    selectionRevision: active.selectionRevision,
    fileCount: active.fileCount,
    vendorNodeSha256: candidate.vendorNodeSha256,
  }));
}

export function validateActivationReceipt(receipt, candidate, activeInput) {
  if (receipt === null) return null;
  exactKeys(receipt, [
    "candidateId", "child", "commitSha256", "fileCount", "generationDirectoryName", "generationId",
    "payloadSha256", "pointerIdentity", "selectionRevision", "status", "vendorNodeSha256",
  ], "MCP gate-owned activation verification");
  if (!activeInput) throw new Error("Activation verification cannot exist without an authoritative active generation");
  const active = validateActive(activeInput, candidate, null);
  const child = validateBoundedChild(
    receipt.child,
    "MCP activator verification child",
    childCommandIdentity(EDITKIN_VENDOR_NODE, [EDITKIN_MCP_ACTIVATOR, "--verify"]),
  );
  if (receipt.status !== "PASS"
    || receipt.candidateId !== candidate.candidateId
    || receipt.generationId !== candidate.generationId
    || receipt.generationDirectoryName !== active.generationDirectoryName
    || receipt.commitSha256 !== active.commitSha256
    || receipt.pointerIdentity !== active.pointerIdentity
    || receipt.selectionRevision !== active.selectionRevision
    || receipt.fileCount !== candidate.fileCount
    || receipt.vendorNodeSha256 !== candidate.vendorNodeSha256
    || receipt.payloadSha256 !== activationPayloadIdentity(candidate, active)
    || child.exitCode !== 0 || child.timedOut
    || child.successMarker !== "ACTIVE_GENERATION_VERIFIED") {
    throw new Error("MCP activation verification is not bound to the activator stdout, pointer, commit, manifest, and candidate");
  }
  return receipt;
}

function validateHandshake(handshake, target, candidate, active, plan) {
  exactKeys(handshake, [
    "candidateId", "child", "contractIdentity", "generationId", "hostConfigurationSha256",
    "pointerIdentity", "reason", "status", "target",
  ], `${target} live handshake`);
  if (handshake.target !== target || !["NOT_RUN", "PASS", "FAIL"].includes(handshake.status)
    || typeof handshake.reason !== "string" || !handshake.reason) {
    throw new Error(`${target} live handshake status is invalid`);
  }
  const identityFields = ["generationId", "hostConfigurationSha256", "pointerIdentity"];
  for (const key of identityFields) {
    if (handshake[key] !== null && !SHA256.test(handshake[key])) {
      throw new Error(`${target} live handshake ${key} is invalid`);
    }
  }
  if (handshake.candidateId !== null && handshake.candidateId !== candidate.candidateId) {
    throw new Error(`${target} live handshake candidate identity drifted`);
  }
  if (handshake.status === "NOT_RUN") {
    if (handshake.child !== null || handshake.contractIdentity !== null) {
      throw new Error(`${target} NOT_RUN handshake cannot carry child success evidence`);
    }
    return handshake;
  }
  const child = validateBoundedChild(
    handshake.child,
    `${target} raw MCP child transcript`,
    childCommandIdentity(EDITKIN_VENDOR_NODE, [EDITKIN_MCP_LAUNCHER]),
  );
  if (handshake.status === "FAIL") {
    if (handshake.contractIdentity !== null || child.successMarker !== null) {
      throw new Error(`${target} failed handshake cannot carry contract success evidence`);
    }
    return handshake;
  }
  assertSha256(handshake.contractIdentity, `${target} MCP contract identity`);
  if (child.exitCode !== 0 || child.timedOut
    || child.successMarker !== "GET_AUTOPILOT_CONTRACT_BOUND"
    || !active
    || handshake.candidateId !== candidate.candidateId
    || handshake.generationId !== candidate.generationId
    || handshake.pointerIdentity !== active.pointerIdentity
    || handshake.hostConfigurationSha256 !== plan.afterSha256) {
    throw new Error(`${target} live handshake PASS was not produced by the pinned launcher against the selected generation`);
  }
  return handshake;
}

function validateHostCliProbe(probe, target, plan) {
  exactKeys(probe, [
    "commandIdentity", "exitCode", "hostConfigurationSha256", "outputBytes", "outputSha256",
    "reason", "status", "target", "timedOut",
  ], `${target} host CLI probe`);
  if (probe.target !== target || !["PASS", "BLOCKED"].includes(probe.status)
    || typeof probe.reason !== "string" || !probe.reason
    || (probe.commandIdentity !== null && !SHA256.test(probe.commandIdentity))
    || (probe.exitCode !== null && !Number.isInteger(probe.exitCode))
    || (probe.hostConfigurationSha256 !== null && !SHA256.test(probe.hostConfigurationSha256))
    || !Number.isSafeInteger(probe.outputBytes) || probe.outputBytes < 0 || probe.outputBytes > 4_194_304
    || !SHA256.test(probe.outputSha256) || typeof probe.timedOut !== "boolean") {
    throw new Error(`${target} host CLI probe is invalid`);
  }
  if (probe.status === "PASS" && (probe.exitCode !== 0 || probe.timedOut
    || probe.hostConfigurationSha256 !== plan.afterSha256 || probe.commandIdentity === null)) {
    throw new Error(`${target} host CLI PASS is not bound to the stable host configuration`);
  }
  return probe;
}

function validateProductDelivery(delivery) {
  exactKeys(delivery, [
    "agentSetupContractSha256", "productAgentConnectUsesStableLauncher", "receiptBytes",
    "receiptPathSha256", "receiptSha256", "status",
  ], "MCP product delivery state");
  assertSha256(delivery.agentSetupContractSha256, "Agent Setup contract identity");
  assertSha256(delivery.receiptPathSha256, "Product Agent Connect delivery receipt path identity");
  if (!Number.isSafeInteger(delivery.receiptBytes) || delivery.receiptBytes < 0
    || (delivery.receiptSha256 !== null && !SHA256.test(delivery.receiptSha256))
    || !["GREEN", "INVALID", "MISSING"].includes(delivery.status)
    || typeof delivery.productAgentConnectUsesStableLauncher !== "boolean") {
    throw new Error("MCP product delivery state is invalid");
  }
  if (delivery.status === "GREEN") {
    if (delivery.receiptBytes === 0 || delivery.receiptSha256 === null
      || delivery.productAgentConnectUsesStableLauncher !== true) {
      throw new Error("MCP product delivery GREEN is not bound to a verified receipt");
    }
  } else if (delivery.productAgentConnectUsesStableLauncher !== false) {
    throw new Error("Unverified MCP product delivery cannot claim the stable launcher");
  }
  if (delivery.status === "MISSING"
    && (delivery.receiptBytes !== 0 || delivery.receiptSha256 !== null)) {
    throw new Error("Missing MCP product delivery receipt has contradictory evidence");
  }
  return delivery;
}

function validateFinalReread(reread, candidate, active, hostConfigurations, hostSources, planRecord, delivery) {
  exactKeys(reread, [
    "activePointerSha256", "agentSetupContractSha256", "candidateId", "claudeConfigurationSha256",
    "claudeSourceBytesSha256", "claudeSourcePathSha256", "codexConfigurationSha256",
    "codexSourceBytesSha256", "codexSourcePathSha256", "deliveryEvidenceSha256", "generationId",
    "manifestSha256", "planRecordSha256", "status",
  ], "Final authoritative reread");
  if (!["PASS", "DRIFT"].includes(reread.status)) {
    throw new Error("Final authoritative reread status is invalid");
  }
  for (const key of ["activePointerSha256", "generationId", "manifestSha256"]) {
    if (reread[key] !== null && !SHA256.test(reread[key])) throw new Error(`Final reread ${key} is invalid`);
  }
  for (const key of [
    "agentSetupContractSha256", "claudeConfigurationSha256", "claudeSourceBytesSha256",
    "claudeSourcePathSha256", "codexConfigurationSha256", "codexSourceBytesSha256",
    "codexSourcePathSha256", "deliveryEvidenceSha256", "planRecordSha256",
  ]) {
    assertSha256(reread[key], `Final reread ${key}`);
  }
  const expected = {
    activePointerSha256: active?.pointerIdentity ?? null,
    candidateId: active?.candidateId ?? null,
    generationId: active?.generationId ?? null,
    manifestSha256: active?.manifestSha256 ?? null,
    codexConfigurationSha256: hostConfigurationIdentity(hostConfigurations.codex),
    claudeConfigurationSha256: hostConfigurationIdentity(hostConfigurations.claude),
    codexSourceBytesSha256: hostSources.codex.bytesSha256,
    codexSourcePathSha256: hostSources.codex.pathSha256,
    claudeSourceBytesSha256: hostSources.claude.bytesSha256,
    claudeSourcePathSha256: hostSources.claude.pathSha256,
    planRecordSha256: planRecord.recordSha256,
    agentSetupContractSha256: delivery.agentSetupContractSha256,
    deliveryEvidenceSha256: hashBytes(canonicalJson(delivery)),
  };
  const agrees = Object.entries(expected).every(([key, value]) => reread[key] === value);
  if (reread.status !== (agrees ? "PASS" : "DRIFT")) {
    throw new Error("Final authoritative reread status does not match its identities");
  }
  if (active && (active.candidateId !== candidate.candidateId || active.generationId !== candidate.generationId)) {
    throw new Error("Final authoritative reread selected a different candidate");
  }
  return agrees;
}

export function evaluateMcpHostMigration(input) {
  exactKeys(input, [
    "activationReceipt", "active", "candidate", "delivery", "finalReread", "handshakes",
    "hostCliProbes", "hostConfigurations", "hostSources", "planRecord",
  ], "MCP host migration evidence");
  const candidate = validateCandidate(input.candidate);
  const planRecord = validatePreMigrationPlanRecord(input.planRecord);
  exactHostMap(input.hostConfigurations, "MCP host configurations");
  exactHostMap(input.hostSources, "MCP host source identities");
  for (const target of EDITKIN_MCP_HOSTS) {
    exactKeys(input.hostSources[target], ["bytesSha256", "pathSha256"], `${target} MCP host source identity`);
    assertSha256(input.hostSources[target].bytesSha256, `${target} MCP host source bytes identity`);
    assertSha256(input.hostSources[target].pathSha256, `${target} MCP host source path identity`);
  }
  exactHostMap(input.handshakes, "MCP host handshakes");
  exactHostMap(input.hostCliProbes, "MCP host CLI probes");
  const delivery = validateProductDelivery(input.delivery);
  const active = input.active === null ? null : validateActive(input.active, candidate, null);
  const activationReceipt = validateActivationReceipt(input.activationReceipt, candidate, active);
  if (active) validateActive(active, candidate, activationReceipt);
  const checks = {
    candidatePreflightGreen: true,
    persistedFirstBeforePlans: true,
    exactCandidateActive: active !== null,
    gateOwnedActivationVerification: activationReceipt !== null && active !== null,
    stableLauncher: true,
    exactRollbackPlans: true,
    gateOwnedLiveHandshakes: true,
    hostCliOwnedProbes: true,
    finalAuthoritativeReread: true,
    productAgentConnectDeliveryVerified: true,
  };
  const blockers = [];
  if (!active) blockers.push("active-v3-pointer-missing");
  if (!activationReceipt) blockers.push("gate-owned-activation-verification-missing");

  for (const target of EDITKIN_MCP_HOSTS) {
    const configuration = normalizeHostConfiguration(input.hostConfigurations[target]);
    const plan = planRecord.hosts[target].plan;
    if (!isStableLauncherConfiguration(configuration)
      || hostConfigurationIdentity(configuration) !== plan.afterSha256) {
      checks.stableLauncher = false;
      blockers.push(`${target}-host-not-on-stable-launcher`);
    }
    if (plan.rollback.restoreSha256 !== plan.beforeSha256) {
      checks.exactRollbackPlans = false;
      blockers.push(`${target}-rollback-plan-invalid`);
    }
    const handshake = validateHandshake(input.handshakes[target], target, candidate, active, plan);
    if (handshake.status !== "PASS") {
      checks.gateOwnedLiveHandshakes = false;
      blockers.push(`${target}-live-handshake-${handshake.status.toLowerCase()}`);
    }
    const cliProbe = validateHostCliProbe(input.hostCliProbes[target], target, plan);
    if (cliProbe.status !== "PASS") {
      checks.hostCliOwnedProbes = false;
      blockers.push(`${target}-host-cli-probe-${cliProbe.reason}`);
    }
  }

  if (!validateFinalReread(
    input.finalReread,
    candidate,
    active,
    input.hostConfigurations,
    input.hostSources,
    planRecord,
    delivery,
  )) {
    checks.finalAuthoritativeReread = false;
    blockers.push("final-authoritative-reread-drifted");
  }
  if (delivery.status !== "GREEN" || delivery.productAgentConnectUsesStableLauncher !== true) {
    checks.productAgentConnectDeliveryVerified = false;
    blockers.push("product-agent-connect-delivery-unverified");
  }
  const uniqueBlockers = [...new Set(blockers)];
  return {
    schema: EDITKIN_MCP_HOST_MIGRATION_SCHEMA,
    status: uniqueBlockers.length === 0 ? "GREEN_MCP_V3_HOST_MIGRATION" : "BLOCKED_MCP_V3_HOST_MIGRATION",
    candidateId: candidate.candidateId,
    generationId: candidate.generationId,
    planRecordSha256: planRecord.recordSha256,
    checks,
    blockers: uniqueBlockers,
  };
}
