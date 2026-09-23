import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "../..");
const productReportPath = join(appRoot, ".rd/benchmarks/editkin-auto-roto-sam21-product-path/report.json");
const outputRoot = join(appRoot, ".rd/benchmarks/editkin-auto-roto-sam21-service-bridge");
const outputPath = join(outputRoot, "report.json");
const servicePath = join(appRoot, "desktop-dist/service.mjs");
const nodePath = join(appRoot, "vendor/node/win32-x64/node.exe");

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function callService(request) {
  return new Promise((resolveCall, rejectCall) => {
    const child = spawn(nodePath, [servicePath], { cwd: appRoot, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-16_000); });
    child.once("error", rejectCall);
    child.once("exit", (code) => {
      if (code !== 0) return rejectCall(new Error(stderr.trim() || `service exit ${code}`));
      try { resolveCall(JSON.parse(stdout)); }
      catch { rejectCall(new Error(`service returned invalid JSON: ${stdout.slice(0, 200)}`)); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

const productReport = JSON.parse(await readFile(productReportPath, "utf8"));
if (productReport.status !== "GREEN_ISOLATED_RESEARCH_PATH") throw new Error("SAM 2.1 isolated research-path evidence is not green");
const manifestPath = productReport.artifacts.manifest.path;
const trustedRoot = dirname(manifestPath);
const hostPath = join(trustedRoot, "host/auto-roto-sam21-video-host.py");
const sourcePath = join(repoRoot, ".rd/tmp/auto-roto-sam2/sam2/sav_dataset/example/sav_000001.mp4");
const inspectEnvelope = await callService({
  command: "inspect_auto_roto_video_pack",
  payload: { trustedRoot, manifestPath, hostScriptPath: hostPath },
  runtime: { autoRotoDistributionMode: "debug-research", autoRotoExternalResearchEnabled: true },
});
const request = {
  command: "analyze_auto_roto",
  payload: {
    sourcePath, sourceStart: 0, duration: 1.5, fps: 24, sourceWidth: 480, sourceHeight: 848, initialTime: .75,
    initialRect: { x: .23541666666666666, y: 0, width: .5666666666666667, height: .7924528301886793 },
    sourceSha256: hash(await readFile(sourcePath)), temporalStability: .12, feather: .004, edgeShift: 0, contrast: 1.2,
    corrections: [{ id: "remove-center", frame: 12, mode: "background", radius: .015, points: [{ x: .4465, y: .3741 }] }],
  },
  runtime: {
    ffmpeg: join(appRoot, "vendor/ffmpeg/win32-x64/ffmpeg.exe"),
    nativeCore: join(appRoot, "native/bin/win32-x64/hao-core.exe"),
    cacheRoot: join(appRoot, ".rd/benchmarks/editkin-auto-roto-sam21-product-path/cache"),
    autoRotoVideoModelRoot: trustedRoot,
    autoRotoVideoModelManifest: manifestPath,
    autoRotoVideoHost: hostPath,
    autoRotoDistributionMode: "debug-research",
    autoRotoExternalResearchEnabled: true,
    autoRotoAllowResearchCandidate: false,
    autoRotoRouteMode: "research",
    autoRotoRequestedEngine: "editkin-sam21-video-memory-roto/v1",
  },
};
const envelope = await callService(request);
const result = envelope.result ?? {};
const checks = {
  inspectionEnvelope: inspectEnvelope.ok === true && inspectEnvelope.result?.status === "verified",
  inspectionProductBlocked: inspectEnvelope.result?.productRouteReceipt?.status === "rejected" && inspectEnvelope.result?.productRouteReceipt?.reasonCode === "product-policy-self-authored-engine-only",
  serviceEnvelope: envelope.ok === true,
  videoMemoryEngine: result.engine === "editkin-sam21-video-memory-roto/v1",
  cacheReplay: result.cacheHit === true,
  modelIdentity: result.sam2Model?.manifestSha256 === productReport.model.manifestSha256 && result.sam2Model?.hostSha256 === productReport.model.hostSha256,
  correctionsPreserved: result.correctionStrokesApplied === 1 && result.correctedFrames?.join(",") === "12",
  sequencePreserved: result.frames?.length === 18 && result.sequencePath === productReport.artifacts.alphaSequence.path,
  researchBoundary: result.qualityState === "diagnostic" && result.routeReceipt?.mode === "research" && result.routeReceipt?.selectedEngine === "editkin-sam21-video-memory-roto/v1" && result.sam2Model?.schema === "editkin.auto-roto-video-pack/v2" && result.sam2Model?.selfContained === true,
  publisherTrust: result.sam2Model?.publisherKeyId === "editkin-auto-roto-production-2026" && [result.sam2Model?.receiptSha256, result.sam2Model?.signatureSha256, result.sam2Model?.inventorySha256].every((value) => /^[a-f0-9]{64}$/.test(value ?? "")),
  frozenSequenceIdentity: result.sequenceSha256 === productReport.artifacts.alphaSequence.sha256 && result.sequenceBytes === productReport.artifacts.alphaSequence.bytes,
};
const status = Object.values(checks).every(Boolean) ? "GREEN_ISOLATED_RESEARCH_SERVICE_BRIDGE" : "FAIL";
await mkdir(outputRoot, { recursive: true });
const serviceBytes = await readFile(servicePath);
const report = {
  schema: "editkin.auto-roto-sam21-service-bridge-gate/v3",
  status,
  checks,
  service: { path: servicePath, bytes: (await stat(servicePath)).size, sha256: hash(serviceBytes) },
  inspection: inspectEnvelope.result,
  model: { manifestSha256: result.sam2Model?.manifestSha256, selfContained: result.sam2Model?.selfContained, publisherKeyId: result.sam2Model?.publisherKeyId },
  result: { engine: result.engine, frames: result.frames?.length, cacheHit: result.cacheHit, elapsedMs: result.elapsedMs, qualityState: result.qualityState, routeReceipt: result.routeReceipt, sequenceSha256: result.sequenceSha256 },
  claimBoundary: "Proves the rebuilt Node service independently verifies the signed external pack only in an explicit research route and preserves its exact model, correction, cache, and frozen-sequence identities. It does not establish product eligibility or complete dependency-rights attestation.",
};
await writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
process.stdout.write(`AUTO_ROTO_SAM21_SERVICE status=${status} report=${outputPath}\n`);
if (status === "FAIL") process.exitCode = 1;
