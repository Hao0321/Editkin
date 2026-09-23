import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const workspaceRoot = resolve(root, "../..");
const outputRoot = resolve(root, ".rd/benchmarks/ocio-gpu-preview-export-internal");
const outputPath = resolve(outputRoot, "report.json");
const compositorPath = resolve(root, "native/bin/win32-x64/editkin-gpu-compositor.exe");

const paths = {
  sdrPreview: resolve(workspaceRoot, ".rd/benchmarks/editkin-common-video-scene-linear-aces2/report.json"),
  pqPreview: resolve(workspaceRoot, ".rd/benchmarks/editkin-common-video-pq-preview/report.json"),
  hdrSurface: resolve(workspaceRoot, ".rd/benchmarks/editkin-native-hdr-surface/report.json"),
  sdrOutput: resolve(workspaceRoot, ".rd/benchmarks/editkin-aces2-native-output/report.json"),
  hdrOutput: resolve(workspaceRoot, ".rd/benchmarks/editkin-aces2-native-hdr/report.json"),
  sdrVideo: resolve(workspaceRoot, ".rd/benchmarks/editkin-aces2-sdr-video/report.json"),
  hdrVideo: resolve(workspaceRoot, ".rd/benchmarks/editkin-aces2-hdr-video/report.json"),
  tauri: resolve(workspaceRoot, ".rd/benchmarks/editkin-tauri-cdp-smoke.json"),
  releaseManifest: resolve(root, ".release-input-manifest.json"),
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const identity = async (path) => {
  const bytes = await readFile(path);
  return { path, bytes: bytes.byteLength, sha256: sha256(bytes) };
};
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

export function evaluateOcioGpuPreviewExport(inputs) {
  const findings = [];
  const reject = (code, detail) => findings.push({ code, detail });
  const { compositor, sdrPreview, pqPreview, hdrSurface, sdrOutput, hdrOutput, sdrVideo, hdrVideo, tauri, releaseManifest } = inputs;
  const candidateSha = compositor?.sha256;
  const sameCandidate = (value) => value === candidateSha && /^[a-f0-9]{64}$/.test(value ?? "");

  if (sdrPreview?.schema !== "editkin.common-video-scene-linear-aces2-gate/v1" || sdrPreview?.status !== "GREEN"
    || !sameCandidate(sdrPreview?.executableSha256) || sdrPreview?.contractReceipt !== true || sdrPreview?.productPathCpuPixelCopies !== 0
    || sdrPreview?.measurements?.p99CodeError > 2 || sdrPreview?.rejectedNegativeControls?.length !== 9) {
    reject("sdr-resident-preview", "SDR scene-linear resident preview evidence is incomplete or stale");
  }
  if (pqPreview?.schema !== "editkin.common-video-pq-preview-gate/v1" || pqPreview?.status !== "GREEN"
    || !sameCandidate(pqPreview?.executable?.sha256) || pqPreview?.contractReceipt !== true || pqPreview?.surfaceReceipt !== true
    || pqPreview?.inactiveReceipt !== true || pqPreview?.productPathCpuPixelCopies !== 0 || pqPreview?.presentedFrames < 18
    || pqPreview?.measurements?.samples < 100_000 || pqPreview?.measurements?.meanCodeError > .25 || pqPreview?.measurements?.p99CodeError > 2
    || pqPreview?.formalParity?.samples < 100_000 || pqPreview?.formalParity?.meanCodeError > .25 || pqPreview?.formalParity?.p99CodeError > 2
    || pqPreview?.rejectedNegativeControls?.length !== 4 || pqPreview?.releaseFences?.pendingFenceCount !== 0) {
    reject("pq-resident-preview", "PQ resident preview did not preserve the measured LUT, parity, negative-control and fence contracts");
  }
  const pqSurface = hdrSurface?.evidence?.pq;
  if (hdrSurface?.schema !== "editkin.native-hdr-surface-gate/v1" || hdrSurface?.status !== "GREEN" || !sameCandidate(hdrSurface?.candidate?.sha256)
    || pqSurface?.surfaceFormat !== "Rgb10a2Unorm" || pqSurface?.surfaceColorSpace !== "Bt2100Pq"
    || pqSurface?.hdrTransportConfigured !== true || pqSurface?.pixelContract !== "rec2020-pq-encoded-rgb/v1"
    || hdrSurface?.evidence?.negatives?.hlg?.ok !== false || hdrSurface?.evidence?.negatives?.illegalModeSwitch?.ok !== false) {
    reject("dx12-hdr-surface", "DX12 PQ surface transport or its fail-closed controls are incomplete");
  }
  if (sdrOutput?.schema !== "editkin.aces2-native-output-gate/v1" || sdrOutput?.status !== "GREEN" || !sameCandidate(sdrOutput?.candidate?.sha256)
    || sdrOutput?.receiptValid !== true || sdrOutput?.sequenceReceiptValid !== true || sdrOutput?.measurements?.gpuVsPyOcio?.p99 > 2) {
    reject("sdr-formal-output", "formal SDR ACES2 output is incomplete or stale");
  }
  if (hdrOutput?.schema !== "editkin.aces2-native-hdr-gate/v1" || hdrOutput?.status !== "GREEN" || !sameCandidate(hdrOutput?.candidate?.sha256)
    || hdrOutput?.results?.hlg?.receiptValid !== true || hdrOutput?.results?.pq?.receiptValid !== true
    || hdrOutput?.results?.hlg?.sequenceReceiptValid !== true || hdrOutput?.results?.pq?.sequenceReceiptValid !== true
    || hdrOutput?.results?.hlg?.metrics?.gpuVsCpu?.max > 1 || hdrOutput?.results?.pq?.metrics?.gpuVsCpu?.max > 1) {
    reject("hdr-formal-output", "formal HLG/PQ ACES2 output is incomplete or stale");
  }
  if (sdrVideo?.schema !== "editkin.aces2-sdr-video-integration/v1" || sdrVideo?.status !== "GREEN" || !sameCandidate(sdrVideo?.candidate?.sha256)
    || sdrVideo?.probe?.colorPrimaries !== "bt709" || sdrVideo?.probe?.colorTransfer !== "bt709" || sdrVideo?.probe?.pixelFormat !== "yuv420p") {
    reject("sdr-video-output", "SDR encoded video tags or candidate identity are invalid");
  }
  const hlg = hdrVideo?.outputs?.rec2100_hlg_1000;
  const pq = hdrVideo?.outputs?.rec2100_pq_1000;
  if (hdrVideo?.schema !== "editkin.aces2-hdr-video-integration/v1" || hdrVideo?.status !== "GREEN" || !sameCandidate(hdrVideo?.candidate?.sha256)
    || hlg?.probe?.colorPrimaries !== "bt2020" || hlg?.probe?.colorTransfer !== "arib-std-b67" || hlg?.sideData?.masteringDisplay !== true || hlg?.sideData?.contentLightLevel !== true
    || pq?.probe?.colorPrimaries !== "bt2020" || pq?.probe?.colorTransfer !== "smpte2084" || pq?.sideData?.masteringDisplay !== true || pq?.sideData?.contentLightLevel !== true) {
    reject("hdr-video-output", "HLG/PQ encoded video tags or HDR metadata are invalid");
  }
  const product = tauri?.bridge?.gpuCommonVideoPqPreview;
  const productReceipt = product?.active?.receipt;
  if (tauri?.status !== "GREEN" || product?.status !== "GREEN" || product?.loaded?.displayTransform !== "aces2_rec2100_pq1000"
    || product?.bound?.surfaceFormat !== "Rgb10a2Unorm" || product?.bound?.surfaceColorSpace !== "Bt2100Pq"
    || productReceipt?.outputSpace !== "rec2100_pq_1000" || productReceipt?.productPathCpuPixelCopies !== 0
    || productReceipt?.frame?.nativeSurfacePresented !== true || productReceipt?.frame?.nativeSurfaceCpuPixelReadbacks !== 0
    || product?.inactive?.receipt?.nativeSurfaceCleared !== true || product?.released?.fences?.pendingFenceCount !== 0) {
    reject("tauri-pq-product-journey", "the delivered Tauri bridge did not execute and release the exact PQ resident preview route");
  }
  const builtInput = tauri?.buildManifest?.inputIdentity;
  const currentInput = releaseManifest?.inputIdentity;
  if (!builtInput || !currentInput || builtInput.files !== currentInput.files || builtInput.bytes !== currentInput.bytes || builtInput.sha256 !== currentInput.sha256) {
    reject("stale-delivered-build", "the delivered Tauri smoke does not match the current release input identity");
  }
  return { status: findings.length === 0 ? "GREEN" : "BLOCK", findings };
}

function syntheticSelfTest() {
  const sha = "a".repeat(64);
  const currentInput = { files: 8, bytes: 1024, sha256: "b".repeat(64) };
  const valid = {
    compositor: { sha256: sha },
    sdrPreview: { schema: "editkin.common-video-scene-linear-aces2-gate/v1", status: "GREEN", executableSha256: sha, contractReceipt: true, productPathCpuPixelCopies: 0, measurements: { p99CodeError: 0 }, rejectedNegativeControls: Array(9).fill("negative") },
    pqPreview: { schema: "editkin.common-video-pq-preview-gate/v1", status: "GREEN", executable: { sha256: sha }, contractReceipt: true, surfaceReceipt: true, inactiveReceipt: true, productPathCpuPixelCopies: 0, presentedFrames: 24, measurements: { samples: 130_000, meanCodeError: .1, p99CodeError: 0 }, formalParity: { samples: 130_000, meanCodeError: .1, p99CodeError: 0 }, rejectedNegativeControls: Array(4).fill("negative"), releaseFences: { pendingFenceCount: 0 } },
    hdrSurface: { schema: "editkin.native-hdr-surface-gate/v1", status: "GREEN", candidate: { sha256: sha }, evidence: { pq: { surfaceFormat: "Rgb10a2Unorm", surfaceColorSpace: "Bt2100Pq", hdrTransportConfigured: true, pixelContract: "rec2020-pq-encoded-rgb/v1" }, negatives: { hlg: { ok: false }, illegalModeSwitch: { ok: false } } } },
    sdrOutput: { schema: "editkin.aces2-native-output-gate/v1", status: "GREEN", candidate: { sha256: sha }, receiptValid: true, sequenceReceiptValid: true, measurements: { gpuVsPyOcio: { p99: 1 } } },
    hdrOutput: { schema: "editkin.aces2-native-hdr-gate/v1", status: "GREEN", candidate: { sha256: sha }, results: { hlg: { receiptValid: true, sequenceReceiptValid: true, metrics: { gpuVsCpu: { max: 0 } } }, pq: { receiptValid: true, sequenceReceiptValid: true, metrics: { gpuVsCpu: { max: 0 } } } } },
    sdrVideo: { schema: "editkin.aces2-sdr-video-integration/v1", status: "GREEN", candidate: { sha256: sha }, probe: { colorPrimaries: "bt709", colorTransfer: "bt709", pixelFormat: "yuv420p" } },
    hdrVideo: { schema: "editkin.aces2-hdr-video-integration/v1", status: "GREEN", candidate: { sha256: sha }, outputs: { rec2100_hlg_1000: { probe: { colorPrimaries: "bt2020", colorTransfer: "arib-std-b67" }, sideData: { masteringDisplay: true, contentLightLevel: true } }, rec2100_pq_1000: { probe: { colorPrimaries: "bt2020", colorTransfer: "smpte2084" }, sideData: { masteringDisplay: true, contentLightLevel: true } } } },
    tauri: { status: "GREEN", buildManifest: { inputIdentity: currentInput }, bridge: { gpuCommonVideoPqPreview: { status: "GREEN", loaded: { displayTransform: "aces2_rec2100_pq1000" }, bound: { surfaceFormat: "Rgb10a2Unorm", surfaceColorSpace: "Bt2100Pq" }, active: { receipt: { outputSpace: "rec2100_pq_1000", productPathCpuPixelCopies: 0, frame: { nativeSurfacePresented: true, nativeSurfaceCpuPixelReadbacks: 0 } } }, inactive: { receipt: { nativeSurfaceCleared: true } }, released: { fences: { pendingFenceCount: 0 } } } } },
    releaseManifest: { inputIdentity: { ...currentInput } },
  };
  if (evaluateOcioGpuPreviewExport(valid).status !== "GREEN") throw new Error("valid OCIO aggregate fixture did not pass");
  const mutations = [
    (value) => { value.sdrPreview.status = "BLOCK"; },
    (value) => { value.pqPreview.measurements.p99CodeError = 3; },
    (value) => { value.hdrSurface.evidence.pq.surfaceFormat = "Bgra8UnormSrgb"; },
    (value) => { value.sdrOutput.candidate.sha256 = "c".repeat(64); },
    (value) => { value.hdrVideo.outputs.rec2100_pq_1000.sideData.masteringDisplay = false; },
    (value) => { value.tauri.bridge.gpuCommonVideoPqPreview.status = "BLOCK"; },
    (value) => { value.releaseManifest.inputIdentity.sha256 = "stale"; },
  ];
  for (const mutate of mutations) {
    const broken = structuredClone(valid);
    mutate(broken);
    if (evaluateOcioGpuPreviewExport(broken).status !== "BLOCK") throw new Error("OCIO aggregate evaluator accepted a calibrated negative");
  }
  process.stdout.write(`${JSON.stringify({ schema: "editkin.ocio-gpu-preview-export-internal-self-test/v1", status: "GREEN", calibratedNegatives: mutations.length }, null, 2)}\n`);
}

async function main() {
  if (process.argv.includes("--self-test")) return syntheticSelfTest();
  const values = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, await readJson(path)])));
  values.compositor = await identity(compositorPath);
  await stat(values.tauri.executable);
  const evaluated = evaluateOcioGpuPreviewExport(values);
  const report = {
    schema: "editkin.ocio-gpu-preview-export-internal/v1",
    measuredAt: new Date().toISOString(),
    ...evaluated,
    scope: "Windows DX12 internal product route: scene-linear ACES 2 Rec.709 SDR and Rec.2100 PQ resident preview; formal Rec.709 SDR, Rec.2100 HLG and Rec.2100 PQ output.",
    claimBoundary: "Physical HDR visibility is advisory-unverified on this SDR display; direct RGB HLG preview, P3 resident preview, macOS/Metal, public preview/export parity and long-duration recovery remain open.",
    compositor: values.compositor,
    deliveredExecutable: await identity(values.tauri.executable),
    releaseInputIdentity: values.releaseManifest.inputIdentity,
    measurements: {
      sdrPreview: values.sdrPreview.measurements,
      pqPreview: values.pqPreview.measurements,
      pqFormalParity: values.pqPreview.formalParity,
      sdrFormalOutput: values.sdrOutput.measurements,
      hdrFormalOutput: { hlg: values.hdrOutput.results.hlg.metrics, pq: values.hdrOutput.results.pq.metrics },
      pqPresentP95Ms: values.pqPreview.presentP95Ms,
    },
    productJourney: {
      displayTransform: values.tauri.bridge.gpuCommonVideoPqPreview.loaded.displayTransform,
      surfaceFormat: values.tauri.bridge.gpuCommonVideoPqPreview.bound.surfaceFormat,
      surfaceColorSpace: values.tauri.bridge.gpuCommonVideoPqPreview.bound.surfaceColorSpace,
      physicalDisplayHdrVisibility: values.tauri.bridge.gpuCommonVideoPqPreview.bound.physicalDisplayHdrVisibility,
      productPathCpuPixelCopies: values.tauri.bridge.gpuCommonVideoPqPreview.active.receipt.productPathCpuPixelCopies,
      pendingFenceCount: values.tauri.bridge.gpuCommonVideoPqPreview.released.fences.pendingFenceCount,
    },
    inputs: Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, await identity(path)]))),
  };
  await mkdir(outputRoot, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: report.status, reportPath: outputPath, findings: report.findings, compositor: report.compositor, productJourney: report.productJourney, claimBoundary: report.claimBoundary }, null, 2)}\n`);
  if (report.status !== "GREEN") process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
