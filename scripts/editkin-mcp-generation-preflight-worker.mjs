import { canonicalJson, hashBytes } from "./lib/editkin-mcp-generation-contract.mjs";
import { inspectMcpGenerationCandidateInProcess } from "./lib/editkin-mcp-generation-snapshot.mjs";

const CHUNK_BYTES = 1024 * 1024;
const FAULTS = new Set([
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

function parseRequest() {
  if (process.argv.length !== 3 || process.argv[2].length > 64 * 1024) {
    throw new Error("Candidate preflight worker accepts exactly one bounded request");
  }
  const text = Buffer.from(process.argv[2], "base64url").toString("utf8");
  const request = JSON.parse(text);
  if (canonicalJson(request) !== text) throw new Error("Candidate preflight worker request is not canonical JSON");
  const expectedKeys = ["appRoot", "candidateId", "nonce", "preflightFault", "workerTimeoutMs"];
  const keys = Object.keys(request).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("Candidate preflight worker request fields are invalid");
  }
  if (request.preflightFault !== null && !FAULTS.has(request.preflightFault)) {
    throw new Error("Candidate preflight worker fault is unsupported");
  }
  if (typeof request.nonce !== "string" || !/^[0-9a-f]{64}$/u.test(request.nonce)) {
    throw new Error("Candidate preflight worker nonce is invalid");
  }
  return request;
}

function faultIo(fault) {
  if (!fault || !["slow-read", "pending-read-close-hang", "worker-identity-read-close-hang"].includes(fault)) {
    return undefined;
  }
  let targetHandle;
  let keepAlive;
  return {
    read({ handle, path, position, defaultRead }) {
      const isIdentityTarget = fault === "worker-identity-read-close-hang"
        && path.toLocaleLowerCase("en-US").endsWith("node.exe");
      const isCandidateTarget = fault !== "worker-identity-read-close-hang" && path.endsWith("slow.bin");
      if ((!isIdentityTarget && !isCandidateTarget) || position < CHUNK_BYTES) return defaultRead();
      targetHandle = handle;
      const realRead = Promise.resolve(defaultRead());
      process.stderr.write(`EDITKIN_PREFLIGHT_TEST_FAULT:${fault}:mid-hash-real-read-started\n`);
      return new Promise((_resolveRead, rejectRead) => {
        realRead.catch(rejectRead);
      });
    },
    close({ handle, defaultClose }) {
      if (["pending-read-close-hang", "worker-identity-read-close-hang"].includes(fault)
        && handle === targetHandle) {
        keepAlive ??= setInterval(() => {}, 60_000);
        return new Promise(() => {});
      }
      return defaultClose();
    },
  };
}

function successPacket(request, result) {
  const packet = {
    requestNonce: request.nonce,
    requestSha256: hashBytes(canonicalJson(request)),
    result,
    status: "ok",
  };
  switch (request.preflightFault) {
    case "packet-extra-key":
      packet.unexpected = true;
      break;
    case "packet-nonce-spoof":
      packet.requestNonce = "0".repeat(64);
      break;
    case "result-entrypoint-spoof":
      packet.result = { ...result, entrypoint: { ...result.entrypoint, sha256: "0".repeat(64) } };
      break;
    case "result-extra-key":
      packet.result = { ...result, unexpected: true };
      break;
    case "result-status-spoof":
      packet.result = { ...result, status: "GREEN_MCP_GENERATION_CANDIDATE_SPOOF" };
      break;
    case "result-vendor-spoof":
      packet.result = { ...result, vendorNode: { ...result.vendorNode, version: "22.0.0" } };
      break;
    default:
      break;
  }
  return packet;
}

function errorRecord(error) {
  return {
    code: typeof error?.code === "string" ? error.code : null,
    message: typeof error?.message === "string" ? error.message : "Candidate preflight worker failed",
    name: typeof error?.name === "string" ? error.name : "Error",
  };
}

let request;
try {
  request = parseRequest();
  const result = await inspectMcpGenerationCandidateInProcess(request.candidateId, {
    appRoot: request.appRoot,
    execPath: process.execPath,
    preflightTimeoutMs: request.workerTimeoutMs,
    preflightIo: faultIo(request.preflightFault),
  });
  process.stdout.write(canonicalJson(successPacket(request, result)));
} catch (error) {
  if (request) {
    process.stdout.write(canonicalJson({
      error: errorRecord(error),
      requestNonce: request.nonce,
      requestSha256: hashBytes(canonicalJson(request)),
      status: "error",
    }));
  } else {
    process.stderr.write("Candidate preflight worker rejected its request\n");
  }
  process.exitCode = 1;
}
