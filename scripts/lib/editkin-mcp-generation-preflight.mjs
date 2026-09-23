import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import {
  assertCandidateId,
  assertExactKeys,
  assertSha256,
  assertStrictDescendant,
  canonicalJson,
  EDITKIN_APP_ROOT,
  hashBytes,
  McpGenerationPreflightTimeoutError,
  resolveCandidateEnvelope,
  sameFilesystemPath,
  validateSnapshotManifest,
} from "./editkin-mcp-generation-contract.mjs";
import { PRECHECK_MAX_DURATION_MS } from "./editkin-mcp-generation-snapshot.mjs";

const MAX_WORKER_STDOUT_BYTES = 32 * 1024 * 1024;
const MAX_WORKER_STDERR_BYTES = 64 * 1024;
const WORKER_PATH = resolve(import.meta.dirname, "../editkin-mcp-generation-preflight-worker.mjs");
const TEST_FAULTS = new Set([
  "packet-extra-key",
  "packet-nonce-spoof",
  "pending-read-close-hang",
  "result-entrypoint-spoof",
  "result-extra-key",
  "result-status-spoof",
  "result-vendor-spoof",
  "slow-read",
  "worker-identity-read-close-hang",
]);

function notify(hook, value) {
  try {
    Promise.resolve(hook?.(value)).catch(() => {});
  } catch {
    // Test instrumentation cannot alter supervisor lifecycle.
  }
}

function assertSupervisorRequest(candidateId, appRoot, timeoutMs, preflightFault) {
  assertCandidateId(candidateId);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > PRECHECK_MAX_DURATION_MS) {
    throw new Error(`Candidate preflight timeout must be between 1 and ${PRECHECK_MAX_DURATION_MS}ms`);
  }
  if (preflightFault !== undefined && !TEST_FAULTS.has(preflightFault)) {
    throw new Error("Candidate preflight test fault is unsupported");
  }
  return {
    candidateId,
    appRoot: resolve(appRoot),
    nonce: randomBytes(32).toString("hex"),
    preflightFault: preflightFault ?? null,
    workerTimeoutMs: Math.max(1, timeoutMs - Math.min(1000, Math.floor(timeoutMs / 2))),
  };
}

function boundedAppend(chunks, bytes, chunk, maximum, child, label) {
  const nextBytes = bytes + chunk.length;
  if (nextBytes > maximum) {
    child.kill("SIGKILL");
    throw new Error(`Candidate preflight worker ${label} exceeded its byte limit`);
  }
  chunks.push(chunk);
  return nextBytes;
}

function parseWorkerPacket(bytes, request) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const packet = JSON.parse(text);
  if (canonicalJson(packet) !== text) throw new Error("Candidate preflight worker output is not canonical JSON");
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) throw new Error("Candidate preflight worker packet is invalid");
  if (packet.status === "ok") {
    assertExactKeys(packet, ["requestNonce", "requestSha256", "result", "status"], "Candidate preflight success packet");
  } else if (packet.status === "error") {
    assertExactKeys(packet, ["error", "requestNonce", "requestSha256", "status"], "Candidate preflight error packet");
  } else {
    throw new Error("Candidate preflight worker packet status is invalid");
  }
  if (packet.requestNonce !== request.nonce
    || packet.requestSha256 !== hashBytes(canonicalJson(request))) {
    throw new Error("Candidate preflight worker packet is not bound to this request");
  }
  return packet;
}

function workerReportedError(packet, stderr) {
  assertExactKeys(packet.error, ["code", "message", "name"], "Candidate preflight worker error");
  if (packet.error.code !== null && typeof packet.error.code !== "string") {
    throw new Error("Candidate preflight worker error code is invalid");
  }
  if (typeof packet.error.message !== "string" || typeof packet.error.name !== "string") {
    throw new Error("Candidate preflight worker error identity is invalid");
  }
  const message = typeof packet?.error?.message === "string"
    ? packet.error.message
    : `Candidate preflight worker failed${stderr ? `: ${stderr}` : ""}`;
  const error = new Error(message);
  error.name = typeof packet?.error?.name === "string" ? packet.error.name : "McpGenerationWorkerError";
  if (typeof packet?.error?.code === "string") error.code = packet.error.code;
  return error;
}

function validateWorkerResult(result, request, expectedWorkerExecutable) {
  if (!result || typeof result !== "object" || Array.isArray(result) || result.candidateId !== request.candidateId) {
    throw new Error("Candidate preflight worker returned the wrong candidate identity");
  }
  assertExactKeys(result, [
    "candidateId", "entrypoint", "envelopeRoot", "manifest", "manifestSha256",
    "preflightMs", "status", "vendorNode",
  ], "Candidate preflight worker result");
  if (result.status !== "GREEN_MCP_GENERATION_CANDIDATE") {
    throw new Error("Candidate preflight worker result status is invalid");
  }
  if (!Number.isSafeInteger(result.preflightMs) || result.preflightMs < 0) {
    throw new Error("Candidate preflight worker duration is invalid");
  }
  const expectedEnvelope = resolveCandidateEnvelope(request.appRoot, request.candidateId).envelopeRoot;
  if (!sameFilesystemPath(result.envelopeRoot, expectedEnvelope)) {
    throw new Error("Candidate preflight worker returned an escaped candidate root");
  }
  const manifest = validateSnapshotManifest(result.manifest);
  if (manifest.sourceCandidateId !== request.candidateId
    || hashBytes(canonicalJson(manifest)) !== result.manifestSha256) {
    throw new Error("Candidate preflight worker returned an invalid manifest identity");
  }
  const entrypoint = manifest.files.find(({ path }) => path === manifest.entrypoint);
  assertExactKeys(result.entrypoint, ["bytes", "path", "sha256"], "Candidate preflight worker entrypoint");
  if (!entrypoint || canonicalJson(result.entrypoint) !== canonicalJson(entrypoint)) {
    throw new Error("Candidate preflight worker returned an invalid entrypoint identity");
  }
  assertExactKeys(
    result.vendorNode,
    ["bytes", "manifest", "path", "sha256", "version"],
    "Candidate preflight worker vendor Node",
  );
  assertExactKeys(
    result.vendorNode.manifest,
    ["archiveSha256", "licenseSha256", "nodeExeSha256", "source", "version"],
    "Candidate preflight worker vendor Node manifest",
  );
  assertSha256(result.vendorNode.sha256, "Candidate preflight worker vendor Node hash");
  assertSha256(result.vendorNode.manifest.archiveSha256, "Candidate preflight worker vendor Node archive hash");
  assertSha256(result.vendorNode.manifest.licenseSha256, "Candidate preflight worker vendor Node license hash");
  assertSha256(result.vendorNode.manifest.nodeExeSha256, "Candidate preflight worker vendor Node manifest hash");
  if (!sameFilesystemPath(result.vendorNode.path, expectedWorkerExecutable)
    || result.vendorNode.version !== process.versions.node
    || result.vendorNode.manifest.version !== result.vendorNode.version
    || result.vendorNode.manifest.nodeExeSha256 !== result.vendorNode.sha256
    || !Number.isSafeInteger(result.vendorNode.bytes)
    || result.vendorNode.bytes <= 0
    || typeof result.vendorNode.manifest.source !== "string") {
    throw new Error("Candidate preflight worker returned a spoofed vendor Node identity");
  }
  return result;
}

async function superviseWorker(request, timeoutMs, totalStartedAt, expiresAt, expectedWorkerExecutable, hooks) {
  if (performance.now() >= expiresAt) {
    throw new McpGenerationPreflightTimeoutError(
      `Editkin MCP candidate preflight exceeded its ${timeoutMs}ms process deadline`,
      { childPid: null, elapsedMs: Math.round(performance.now() - totalStartedAt), terminated: false, timeoutMs },
    );
  }
  const encodedRequest = Buffer.from(canonicalJson(request), "utf8").toString("base64url");
  const child = spawn(expectedWorkerExecutable, [WORKER_PATH, encodedRequest], {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  notify(hooks?.onChildSpawn, { pid: child.pid, workerPath: WORKER_PATH });
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let fatalError;
  let timedOut = false;
  let terminationRequested = false;
  child.stdout.on("data", (chunk) => {
    if (fatalError) return;
    try {
      stdoutBytes = boundedAppend(stdout, stdoutBytes, chunk, MAX_WORKER_STDOUT_BYTES, child, "stdout");
    } catch (error) {
      fatalError = error;
    }
  });
  child.stderr.on("data", (chunk) => {
    if (fatalError) return;
    try {
      stderrBytes = boundedAppend(stderr, stderrBytes, chunk, MAX_WORKER_STDERR_BYTES, child, "stderr");
      notify(hooks?.onChildStderr, { pid: child.pid, chunk: chunk.toString("utf8") });
    } catch (error) {
      fatalError = error;
    }
  });
  const closedPromise = new Promise((resolveClose) => {
    child.once("error", (error) => {
      fatalError ??= error;
    });
    child.once("close", (code, signal) => resolveClose({ code, signal }));
  });
  const requestTermination = () => {
    timedOut = true;
    try {
      terminationRequested = child.kill("SIGKILL");
    } catch (error) {
      fatalError ??= error;
      terminationRequested = false;
    }
    notify(hooks?.onChildTerminationRequested, { pid: child.pid, terminationRequested });
  };
  const remainingAfterSpawnMs = Math.max(0, Math.ceil(expiresAt - performance.now()));
  let timer = null;
  if (remainingAfterSpawnMs <= 0) requestTermination();
  else timer = setTimeout(requestTermination, remainingAfterSpawnMs);
  const closed = await closedPromise;
  if (timer) clearTimeout(timer);
  const elapsedMs = Math.round(performance.now() - totalStartedAt);
  notify(hooks?.onChildExit, { pid: child.pid, ...closed, elapsedMs, timedOut });
  if (timedOut) {
    throw new McpGenerationPreflightTimeoutError(
      `Editkin MCP candidate preflight exceeded its ${timeoutMs}ms process deadline`,
      { childPid: child.pid, elapsedMs, terminated: terminationRequested, timeoutMs },
    );
  }
  if (fatalError) throw fatalError;
  let packet;
  try {
    packet = parseWorkerPacket(Buffer.concat(stdout, stdoutBytes), request);
  } catch (error) {
    const boundedStderr = Buffer.concat(stderr, stderrBytes).toString("utf8").slice(0, 1024);
    throw new Error(`Candidate preflight worker emitted an invalid packet: ${error.message}${boundedStderr ? ` (${boundedStderr})` : ""}`);
  }
  if (closed.code !== 0 || packet.status !== "ok") {
    throw workerReportedError(packet, Buffer.concat(stderr, stderrBytes).toString("utf8").slice(0, 1024));
  }
  return { ...validateWorkerResult(packet.result, request, expectedWorkerExecutable), preflightMs: elapsedMs };
}

export async function inspectMcpGenerationCandidate(candidateId, {
  appRoot = EDITKIN_APP_ROOT,
  preflightTimeoutMs = PRECHECK_MAX_DURATION_MS,
  preflightFault,
  supervisorHooks,
} = {}) {
  const totalStartedAt = performance.now();
  const expiresAt = totalStartedAt + preflightTimeoutMs;
  const request = assertSupervisorRequest(candidateId, appRoot, preflightTimeoutMs, preflightFault);
  const expectedWorkerExecutable = resolve(request.appRoot, "vendor/node/win32-x64/node.exe");
  assertStrictDescendant(request.appRoot, expectedWorkerExecutable, "Pinned Editkin Node executable");
  if (!sameFilesystemPath(process.execPath, expectedWorkerExecutable)
    || !/^22\.[0-9]+\.[0-9]+$/u.test(process.versions.node)) {
    throw new Error("Editkin MCP launcher must run through the lexical pinned Node 22 executable path");
  }
  return superviseWorker(
    request,
    preflightTimeoutMs,
    totalStartedAt,
    expiresAt,
    expectedWorkerExecutable,
    supervisorHooks,
  );
}
