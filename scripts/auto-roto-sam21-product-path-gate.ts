import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { analyzeAutoRoto, type AnalyzeAutoRotoRequest } from "../src/application/autoRoto";
import { bindSam21VideoPack, probeSam21VideoPackRuntime } from "../src/application/autoRotoVideoModel";
import { AUTO_ROTO_SAM21_ENGINE } from "../src/application/autoRotoModelRouter";

const appRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(appRoot, "../..");
const researchRoot = resolve(repoRoot, ".rd/tmp/auto-roto-sam2/sam2");
const packRoot = resolve(repoRoot, ".rd/model-packs/editkin-auto-roto-sam21-tiny-windows-cuda-1.0.3");
const manifestPath = join(packRoot, "manifest.json");
const hostPath = join(packRoot, "host/auto-roto-sam21-video-host.py");
const runtimeReceiptPath = join(packRoot, "runtime/runtime-receipt.json");
const sourcePath = join(researchRoot, "sav_dataset/example/sav_000001.mp4");
const reportRoot = join(appRoot, ".rd/benchmarks/editkin-auto-roto-sam21-product-path");
const reportPath = join(reportRoot, "report.json");
const cacheRoot = join(reportRoot, "cache");
const ffmpegPath = join(appRoot, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const nativeCorePath = join(appRoot, "native/bin/win32-x64/hao-core.exe");

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fileSha(path: string): Promise<string> {
  return sha256(await readFile(path));
}

async function main(): Promise<void> {
  await mkdir(reportRoot, { recursive: true });
  await rm(cacheRoot, { recursive: true, force: true });
  const packRequest = { trustedRoot: packRoot, manifestPath, hostScriptPath: hostPath };
  const bound = await bindSam21VideoPack(packRequest);
  const probe = await probeSam21VideoPackRuntime(bound);
  const sourceSha256 = await fileSha(sourcePath);
  const baseRequest: AnalyzeAutoRotoRequest = {
    sourcePath, sourceStart: 0, duration: 1.5, fps: 24, sourceWidth: 480, sourceHeight: 848, initialTime: .75,
    initialRect: { x: .23541666666666666, y: 0, width: .5666666666666667, height: .7924528301886793 },
    sourceSha256, temporalStability: .12, feather: .004, edgeShift: 0, contrast: 1.2,
  };
  const correction = [{ id: "remove-center", frame: 12, mode: "background" as const, radius: .015, points: [{ x: .4465, y: .3741 }] }];
  // Historical gate name retained for evidence paths. The external SAM 2.1 cell
  // is now explicitly research-routed and cannot promote product readiness.
  const runtime = { ffmpegPath, nativeCorePath, cacheRoot, sam21Pack: packRequest, routePolicy: { mode: "research", requestedEngine: AUTO_ROTO_SAM21_ENGINE } as const };
  const baseline = await analyzeAutoRoto(baseRequest, runtime);
  const corrected = await analyzeAutoRoto({ ...baseRequest, corrections: correction }, runtime);
  const cacheReplay = await analyzeAutoRoto({ ...baseRequest, corrections: correction }, runtime);
  const [baselineAlpha, correctedAlpha] = await Promise.all([readFile(baseline.sequencePath), readFile(corrected.sequencePath)]);
  let changedBytes = 0;
  let alphaDelta = 0;
  for (let index = 0; index < baselineAlpha.length; index += 1) {
    const delta = Math.abs(baselineAlpha[index] - correctedAlpha[index]);
    if (delta > 0) changedBytes += 1;
    alphaDelta += delta;
  }
  const preview = corrected.frames[5].alphaPath;
  const originalPreview = await readFile(preview);
  await writeFile(preview, Buffer.concat([originalPreview, Buffer.from("tamper")]));
  const previewRepair = await analyzeAutoRoto({ ...baseRequest, corrections: correction }, runtime);
  const sequence = await readFile(previewRepair.sequencePath);
  sequence[Math.floor(sequence.length / 2)] ^= 0xff;
  await writeFile(previewRepair.sequencePath, sequence);
  const sequenceRepair = await analyzeAutoRoto({ ...baseRequest, corrections: correction }, runtime);
  const repairedAlpha = await readFile(sequenceRepair.sequencePath);
  const frameHashesBound = sequenceRepair.frames.every((frame, index) => frame.previewSha256 === undefined ? false
    : frame.alphaFrameSha256 === sha256(repairedAlpha.subarray(index * sequenceRepair.width * sequenceRepair.height, (index + 1) * sequenceRepair.width * sequenceRepair.height)));
  const checks = {
    productionPackBound: bound.identity.schema === "editkin.auto-roto-video-pack/v2" && bound.identity.qualityTier === "production" && bound.identity.selfContained,
    publisherTrustBound: [bound.identity.receiptSha256, bound.identity.signatureSha256, bound.identity.inventorySha256].every((value) => /^[a-f0-9]{64}$/.test(value ?? "")) && bound.identity.publisherKeyId === "editkin-auto-roto-production-2026",
    runtimeAvailable: probe.available && probe.gpu === "NVIDIA GeForce RTX 2060" && probe.torch === "2.7.1+cu118",
    realVideoMemoryEngine: baseline.engine === "editkin-sam21-video-memory-roto/v1" && corrected.engine === baseline.engine,
    isolatedResearchReceipt: corrected.qualityState === "diagnostic" && corrected.routeReceipt.mode === "research" && corrected.routeReceipt.selectedEngine === AUTO_ROTO_SAM21_ENGINE && corrected.sam2Model?.schema === "editkin.auto-roto-video-pack/v2" && corrected.sam2Model.qualityTier === "production" && corrected.sam2Model.selfContained,
    fullBidirectionalSequence: corrected.frames.length === 18 && corrected.frames[0]?.frame === 0 && corrected.frames.at(-1)?.frame === 17,
    alphaSequenceSized: correctedAlpha.length === corrected.width * corrected.height * corrected.frames.length,
    alphaNonDegenerate: correctedAlpha.some((value) => value > 0) && correctedAlpha.some((value) => value < 255),
    correctionAppliedAndChangedPixels: corrected.correctionStrokesApplied === 1 && corrected.correctedFrames.join(",") === "12" && changedBytes > 0 && alphaDelta > 0,
    cacheReplayBound: corrected.cacheHit === false && cacheReplay.cacheHit === true && cacheReplay.sequencePath === corrected.sequencePath,
    cacheReplayResponsive: cacheReplay.elapsedMs <= 5_000,
    previewTamperRecomputed: previewRepair.cacheHit === false && previewRepair.frames[5].previewSha256 === await fileSha(previewRepair.frames[5].alphaPath),
    sequenceTamperRecomputed: sequenceRepair.cacheHit === false && sequenceRepair.sequenceSha256 === sha256(repairedAlpha) && sequenceRepair.sequenceBytes === repairedAlpha.length,
    frameHashesBound,
    runtimeObserved: Boolean(corrected.sam2Model?.runtime.gpu) && (corrected.sam2Model?.runtime.propagationP95Ms ?? 0) > 0 && (corrected.sam2Model?.runtime.peakReservedBytes ?? 0) > 0,
  };
  const status = Object.values(checks).every(Boolean) ? "GREEN_ISOLATED_RESEARCH_PATH" : "FAIL";
  const report = {
    schema: "editkin.auto-roto-sam21-product-path-gate/v3", status, checks, model: corrected.sam2Model, routeReceipt: corrected.routeReceipt, probe,
    run: {
      width: corrected.width, height: corrected.height, frames: corrected.frames.length, changedBytes,
      meanAlphaDelta: alphaDelta / baselineAlpha.length, meanBoundaryChatter: corrected.meanBoundaryChatter,
      baselineElapsedMs: baseline.elapsedMs, correctedElapsedMs: corrected.elapsedMs, cacheElapsedMs: cacheReplay.elapsedMs,
      previewRepairElapsedMs: previewRepair.elapsedMs, sequenceRepairElapsedMs: sequenceRepair.elapsedMs,
    },
    artifacts: {
      manifest: { path: manifestPath, bytes: (await stat(manifestPath)).size, sha256: await fileSha(manifestPath) },
      runtimeReceipt: { path: runtimeReceiptPath, bytes: (await stat(runtimeReceiptPath)).size, sha256: await fileSha(runtimeReceiptPath) },
      matteManifest: { path: sequenceRepair.manifestPath, bytes: (await stat(sequenceRepair.manifestPath)).size, sha256: await fileSha(sequenceRepair.manifestPath) },
      alphaSequence: { path: sequenceRepair.sequencePath, bytes: repairedAlpha.length, sha256: sha256(repairedAlpha) },
    },
    claimBoundary: {
      proves: "The signed, self-contained Windows CUDA pack executes real SAM 2.1 bidirectional video-memory propagation only through Editkin's explicit research route, applies correction prompts, freezes hash-bound alpha/PNG artifacts, detects cache tampering and recomputes.",
      doesNotProve: "Product eligibility, complete dependency-rights attestation, diverse natural hard-case quality, installer lifecycle, formal render parity, public Authenticode, or macOS parity.",
    },
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  process.stdout.write(`AUTO_ROTO_SAM21_PRODUCT_PATH status=${status} frames=${corrected.frames.length} changed=${changedBytes} report=${reportPath}\n`);
  if (status === "FAIL") process.exitCode = 1;
}

await main();
