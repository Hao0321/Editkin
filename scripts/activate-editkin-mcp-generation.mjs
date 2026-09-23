import {
  activateMcpGeneration,
  inspectMcpGenerationCandidate,
  verifyActiveMcpGeneration,
  verifyVendorNodeIdentity,
} from "./lib/editkin-mcp-generation-runtime.mjs";

function parseArguments(args) {
  if (args.length === 1 && args[0] === "--verify") return { mode: "verify" };
  if (args.length === 2 && args[0] === "--check-candidate") return { mode: "check", candidateId: args[1] };
  if (args.length === 4 && args[0] === "--candidate" && args[2] === "--expected-current") {
    return {
      mode: "activate",
      candidateId: args[1],
      expectedCurrentPointerIdentity: args[3] === "none" ? null : args[3],
    };
  }
  throw new Error("Usage: activate-editkin-mcp-generation.mjs --check-candidate candidate-<16 lowercase hex> | --candidate candidate-<16 lowercase hex> --expected-current none|<sha256> | --verify");
}

const request = parseArguments(process.argv.slice(2));
if (request.mode === "verify") {
  const vendorNode = await verifyVendorNodeIdentity();
  const active = await verifyActiveMcpGeneration();
  process.stdout.write(`${JSON.stringify({
    status: "GREEN_ACTIVE_GENERATION_VERIFIED",
    generationId: active.manifest.generationId,
    generationDirectoryName: active.pointer.generationDirectoryName,
    commitSha256: active.pointer.commitSha256,
    pointerIdentity: active.pointerSha256,
    selectionRevision: active.pointer.selectionRevision,
    candidateId: active.manifest.sourceCandidateId,
    fileCount: active.manifest.files.length,
    vendorNode,
  })}\n`);
} else if (request.mode === "check") {
  const candidate = await inspectMcpGenerationCandidate(request.candidateId);
  process.stdout.write(`${JSON.stringify({
    status: candidate.status,
    candidateId: candidate.candidateId,
    generationId: candidate.manifest.generationId,
    fileCount: candidate.manifest.files.length,
    preflightMs: candidate.preflightMs,
    entrypointBytes: candidate.entrypoint.bytes,
    entrypointSha256: candidate.entrypoint.sha256,
    vendorNode: candidate.vendorNode,
  })}\n`);
} else {
  process.stdout.write(`${JSON.stringify(await activateMcpGeneration(request.candidateId, {
    expectedCurrentPointerIdentity: request.expectedCurrentPointerIdentity,
  }))}\n`);
}
