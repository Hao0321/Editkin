import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { evaluateHardwareZeroCopyClosure, REQUIRED_EVIDENCE_IDS } from "./lib/hardware-zero-copy-closure.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDirectory = resolve(root, ".rd", "benchmarks", "hardware-zero-copy-internal");
const fixtureDirectory = resolve(root, ".rd", "fixtures", "hardware-zero-copy");
const ffmpeg = resolve(root, "vendor", "ffmpeg", "win32-x64", "ffmpeg.exe");
const executable = resolve(root, "spikes", "gpu-compositor", "target", "debug", "editkin-gpu-compositor.exe");
const standardCargo = resolve(homedir(), ".cargo", "bin", "cargo.exe");
const cargo = process.env.CARGO ?? (existsSync(standardCargo) ? standardCargo : "cargo");

function run(command, args, timeout = 300_000) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error?.code === "ETIMEDOUT") throw new Error(`${command} ${args[0] ?? ""} timed out after ${timeout} ms`);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status})\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  return result;
}

function runJson(command, args, timeout) {
  const result = run(command, args, timeout);
  try {
    return JSON.parse((result.stdout ?? "").trim());
  } catch (error) {
    throw new Error(`child did not emit exactly one JSON document: ${args[0] ?? command}\n${String(error)}\n${result.stdout ?? ""}`);
  }
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function evidenceIdentity(id, path, publicPath = path.replace(`${root}\\`, "").replaceAll("\\", "/")) {
  return { id, path: publicPath, sha256: await sha256(path) };
}

function generateH264Fixture(path, filter) {
  const common = ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=3840x2160:r=30:d=2"];
  const filters = filter ? ["-vf", filter] : [];
  const nvenc = run(ffmpeg, [...common, ...filters, "-c:v", "h264_nvenc", "-preset", "p4", "-pix_fmt", "yuv420p", path], 120_000);
  return nvenc.status;
}

function normalizeHardwareCase(item) {
  return {
    id: `${item.codec}-1080p-d3d11va`,
    status: item.status,
    minimumFrames: 85,
    decodedFrames: item.decodedFrames,
    cpuPixelCopies: item.noCpuDownload ? 0 : 1,
    fullInterop: false,
    residentSurfaceFormat: item.residentSurfaceFormat,
  };
}

async function normalizeInteropCase(id, fixture, nativeReportPath) {
  const report = JSON.parse(await readFile(nativeReportPath, "utf8"));
  const parity = report.verificationPixelHashes.length === report.verificationD3d11PixelHashes.length
    && report.verificationPixelHashes.every((hash, index) => hash === report.verificationD3d11PixelHashes[index]);
  return {
    id,
    status: report.decision,
    minimumFrames: 12,
    decodedFrames: report.decodedDxgiFrames,
    cpuPixelCopies: report.decodePathCpuPixelCopies,
    fullInterop: true,
    width: report.width,
    height: report.height,
    producerConsumerParity: parity,
    temporalFramesChanged: new Set(report.verificationPixelHashes).size > 1,
    gpuProcessingPassesPerFrame: report.gpuProcessingPassesPerFrame,
    adapterName: report.adapterName,
    sourceSha256: await sha256(fixture),
    reportSha256: await sha256(nativeReportPath),
  };
}

function selfTest() {
  const baseCase = (id, fullInterop = false) => ({
    id, status: "GREEN", minimumFrames: 12, decodedFrames: 12, cpuPixelCopies: 0, fullInterop,
    ...(fullInterop ? { width: 3840, height: 2160, producerConsumerParity: true, temporalFramesChanged: true, gpuProcessingPassesPerFrame: 2, sourceSha256: id.padEnd(64, "a").slice(0, 64) } : {}),
  });
  const residentChecks = Object.fromEntries([
    "advertisedResidentVideoProtocol", "dx12VideoBackend", "decoderStayedResident", "tripleFrameRingAllocated",
    "tripleFrameRingReused", "producerConsumerParity", "noDecodePathCpuPixelCopies", "nativeSwapChainPresentation",
    "sixLayer1080pStagingAdvertised", "sixtySecondSixLayerRunCompleted", "stagingStayedGpuResident", "stagingFenceRingOwned",
    "crossApiSharedFenceOwned", "stagingClockStayedSynchronized", "stagingMetRealtimeBudget", "stagingNegativeControls",
    "variableFrameRatePtsPreserved", "recoveryInvalidatedSession",
  ].map((id) => [id, true]));
  const positive = {
    schema: "editkin.hardware-zero-copy-closure/v1", platform: "win32", adapterName: "fixture-adapter",
    claimBoundary: { fullInteropCodecs: ["h264"], directHardwareEncode: false, macosParity: "unmeasured" },
    matrix: [
      baseCase("h264-1080p-d3d11va"), baseCase("hevc-1080p-d3d11va"),
      baseCase("h264-4k-source-a-d3d11va-wgpu", true), baseCase("h264-4k-source-b-d3d11va-wgpu", true),
    ],
    resident: { decision: "GREEN", checks: residentChecks },
    negativeControls: { corruptInputRejected: true, releasedSessionRejected: true },
    evidence: REQUIRED_EVIDENCE_IDS.map((id, index) => ({ id, sha256: (index % 10).toString().repeat(64) })),
  };
  positive.matrix[2].sourceSha256 = "a".repeat(64);
  positive.matrix[3].sourceSha256 = "b".repeat(64);
  if (evaluateHardwareZeroCopyClosure(positive).status !== "GREEN") throw new Error("positive closure fixture failed");
  const mutations = [
    ["missing case", (item) => item.matrix.pop(), "missing-case"],
    ["CPU copy", (item) => { item.matrix[2].cpuPixelCopies = 1; }, "cpu-pixel-copy"],
    ["pixel mismatch", (item) => { item.matrix[2].producerConsumerParity = false; }, "pixel-parity"],
    ["same source", (item) => { item.matrix[3].sourceSha256 = item.matrix[2].sourceSha256; }, "distinct-source-coverage"],
    ["resident ring", (item) => { item.resident.checks.tripleFrameRingReused = false; }, "resident-check"],
    ["encoder overclaim", (item) => { item.claimBoundary.directHardwareEncode = true; }, "encoder-overclaim"],
    ["missing evaluator identity", (item) => { item.evidence = item.evidence.filter((entry) => entry.id !== "closure-evaluator"); }, "missing-evidence-id"],
  ];
  const detected = mutations.map(([name, mutate, code]) => {
    const fixture = structuredClone(positive);
    mutate(fixture);
    const decision = evaluateHardwareZeroCopyClosure(fixture);
    if (decision.status !== "BLOCK" || !decision.findings.some((item) => item.code === code)) throw new Error(`${name} fixture missed ${code}`);
    return code;
  });
  process.stdout.write(`${JSON.stringify({ status: "GREEN", detected })}\n`);
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  if (process.platform !== "win32") throw new Error("hardware zero-copy internal closure currently requires Windows");
  await mkdir(evidenceDirectory, { recursive: true });
  await mkdir(fixtureDirectory, { recursive: true });
  const hardware = runJson(process.execPath, [resolve(root, "scripts", "hardware-video-decode-gate.mjs")], 180_000);
  const resident = runJson(process.execPath, [resolve(root, "scripts", "resident-video-interop-gate.mjs")], 360_000);
  run(cargo, ["build", "--locked", "--manifest-path", "spikes/gpu-compositor/Cargo.toml"], 180_000);

  const sourceA = resolve(fixtureDirectory, "h264-4k-source-a.mp4");
  const sourceB = resolve(fixtureDirectory, "h264-4k-source-b.mp4");
  generateH264Fixture(sourceA, "hue=h=18:s=1.05");
  generateH264Fixture(sourceB, "hflip,hue=h=142:s=.85");
  const reportA = resolve(evidenceDirectory, "h264-4k-source-a-native.json");
  const reportB = resolve(evidenceDirectory, "h264-4k-source-b-native.json");
  run(executable, ["decode-interop", sourceA, "12", reportA], 180_000);
  run(executable, ["decode-interop", sourceB, "12", reportB], 180_000);

  const matrix = [
    ...hardware.cases.map(normalizeHardwareCase),
    await normalizeInteropCase("h264-4k-source-a-d3d11va-wgpu", sourceA, reportA),
    await normalizeInteropCase("h264-4k-source-b-d3d11va-wgpu", sourceB, reportB),
  ];
  const residentPath = resolve(root, ".rd", "benchmarks", "p0-resident-video-interop", "report.json");
  const hardwareRawPath = resolve(evidenceDirectory, "hardware-decode-raw.json");
  await writeFile(hardwareRawPath, `${JSON.stringify(hardware, null, 2)}\n`);
  const report = {
    schema: "editkin.hardware-zero-copy-closure/v1",
    platform: process.platform,
    adapterName: matrix.find((item) => item.fullInterop)?.adapterName,
    claimBoundary: {
      fullInteropCodecs: ["h264"],
      hardwareResidentDecodeCodecs: ["h264", "hevc"],
      hevcToWgpu: "unsupported-current-media-foundation-host; D3D11VA decode remains available",
      directHardwareEncode: false,
      macosParity: "unmeasured",
    },
    matrix,
    resident: { decision: resident.decision, checks: resident.checks },
    negativeControls: {
      corruptInputRejected: hardware.negativeControl?.corruptInputRejected === true,
      releasedSessionRejected: resident.checks?.releaseInvalidatedSession === true,
    },
    evidence: await Promise.all([
      evidenceIdentity("source-a", sourceA),
      evidenceIdentity("source-b", sourceB),
      evidenceIdentity("native-a", reportA),
      evidenceIdentity("native-b", reportB),
      evidenceIdentity("hardware-decode", hardwareRawPath),
      evidenceIdentity("resident-runtime", residentPath),
      evidenceIdentity("closure-runner", resolve(root, "scripts", "hardware-zero-copy-closure-gate.mjs")),
      evidenceIdentity("closure-evaluator", resolve(root, "scripts", "lib", "hardware-zero-copy-closure.mjs")),
      evidenceIdentity("hardware-decode-runner", resolve(root, "scripts", "hardware-video-decode-gate.mjs")),
      evidenceIdentity("resident-runtime-runner", resolve(root, "scripts", "resident-video-interop-gate.mjs")),
      evidenceIdentity("native-executable", executable),
      evidenceIdentity("native-windows-video-source", resolve(root, "spikes", "gpu-compositor", "src", "windows_video.rs")),
      evidenceIdentity("node-executable", process.execPath, "runtime/node.exe"),
      evidenceIdentity("ffmpeg-executable", ffmpeg),
    ]),
  };
  const decision = evaluateHardwareZeroCopyClosure(report);
  const envelope = { ...report, decision };
  const output = resolve(evidenceDirectory, "report.json");
  await writeFile(output, `${JSON.stringify(envelope, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: decision.status, output, matrix, claimBoundary: report.claimBoundary, findings: decision.findings })}\n`);
  if (decision.status !== "GREEN") process.exitCode = 1;
}
