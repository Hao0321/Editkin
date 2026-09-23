import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  SOFTWARE_VIDEO_BENCHMARK_ITERATIONS,
  SOFTWARE_VIDEO_BENCHMARK_SCHEMA,
  SOFTWARE_VIDEO_DECODE_SCHEMA,
  SOFTWARE_VIDEO_REFERENCE_BUDGET_MS,
  parseSoftwareVideoDecodeBenchmarkReceipt,
  parseSoftwareVideoDecodeReceipt,
  type SoftwareVideoDecodeBenchmarkReceipt,
  type SoftwareVideoDecodeReceipt,
} from "../src/desktop/softwareVideoDecodeReceipt";

const root = resolve(import.meta.dirname, "..");
const compositorArgument = process.argv.indexOf("--compositor");
const executable = resolve(compositorArgument >= 0 && process.argv[compositorArgument + 1]
  ? process.argv[compositorArgument + 1]
  : join(root, "spikes/gpu-compositor/target/debug/editkin-gpu-compositor.exe"));
const runtimeEnvironment = process.env.EDITKIN_FFMPEG_LGPL_RD_ROOT;
const runtimeRoot = runtimeEnvironment ? resolve(runtimeEnvironment) : "";
const fixtureRoot = resolve(root, "spikes/gpu-compositor/fixtures/software-video");
const evidenceRoot = resolve(root, "../..", ".rd/benchmarks/software-video-decode-round1");
const evidencePath = join(evidenceRoot, "report.json");
const runtimeManifest = runtimeRoot ? join(runtimeRoot, "EDITKIN_FFMPEG_RUNTIME.json") : "";
const gateSource = resolve(import.meta.filename);

const FIXTURES = {
  h264: {
    file: "h264-yuv422p10le-rec709-limited.mp4",
    bytes: 87_065,
    sha256: "31bf4b41551665fb5d1a0f2d1acc442856f849556eb4c84f79ace6b8458aa33a",
    codec: "h264",
  },
  hevc: {
    file: "hevc-yuv422p10le-rec709-limited.mp4",
    bytes: 43_372,
    sha256: "cd6b67d34f13234dfba9f4b132760bfc3b434a51b0d086ef03adb21c6ff67e9f",
    codec: "hevc",
  },
  pixelNegative: {
    file: "h264-yuv420p8-rec709-limited.mp4",
    bytes: 77_787,
    sha256: "f9bb3a852e33e6e85890402a155889c59bae7b1de492781196fa49e2bdb66f5d",
    error: "SOFTWARE_DECODE_UNSUPPORTED_PIXEL_FORMAT",
  },
  colorNegative: {
    file: "h264-yuv422p10le-rec709-full.mp4",
    bytes: 90_755,
    sha256: "2282b3266b16f0351f38eedcf772fdf170d9d6f9e6a6d714ae0a1eef313de88d",
    error: "SOFTWARE_DECODE_UNSUPPORTED_COLOR",
  },
  codecNegative: {
    file: "ffv1-yuv422p10le-rec709-limited.mkv",
    bytes: 165_098,
    sha256: "9116d47a80d8b4ef731799913b2d936e7dced60f3501acc9425baa2923b31f21",
    error: "SOFTWARE_DECODE_UNSUPPORTED_CODEC",
  },
} as const;

const FROZEN_CONTRACT = {
  frozenAt: "2026-09-04",
  decodeReceiptSchema: SOFTWARE_VIDEO_DECODE_SCHEMA,
  benchmarkReceiptSchema: SOFTWARE_VIDEO_BENCHMARK_SCHEMA,
  benchmarkFixture: FIXTURES.h264,
  warmupIterations: 1,
  measuredIterations: SOFTWARE_VIDEO_BENCHMARK_ITERATIONS,
  targetSequenceSeconds: [0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4, 1.6],
  percentile: "nearest-rank/ceil(n*q)-1",
  p95ThresholdMilliseconds: SOFTWARE_VIDEO_REFERENCE_BUDGET_MS,
  measurementBoundary: "128x72 H.264 yuv422p10le Rec.709-limited synthetic fixture; same host/process; every sample reloads DLLs, opens, seeks, decodes one CPU frame, and copies tight planes; not resident playback, 4K, GPU, packaged-app, UI, or DaVinci parity",
} as const;

interface FileIdentity {
  path: string;
  bytes: number;
  sha256: string;
}

interface NativeFailure {
  fixture: string;
  expectedError: string;
  exitCode: number | null;
  observed: string;
}

interface CorrectnessEvidence {
  h264AtHalf: SoftwareVideoDecodeReceipt;
  h264AtHalfRepeat: SoftwareVideoDecodeReceipt;
  h264AtOne: SoftwareVideoDecodeReceipt;
  hevcAtHalf: SoftwareVideoDecodeReceipt;
  deterministicSameTarget: boolean;
  distinctSeekOutput: boolean;
  tenBitEvidence: boolean;
  negativeControls: NativeFailure[];
}

function contractSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function fileIdentity(path: string): Promise<FileIdentity> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size <= 0) throw new Error(`NOT_A_FILE:${path}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { path, bytes: metadata.size, sha256: hash.digest("hex") };
}

function assertIdentity(actual: FileIdentity, expected: { bytes: number; sha256: string }): void {
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
    throw new Error(`FIXTURE_IDENTITY_MISMATCH:${basename(actual.path)}:${actual.bytes}:${actual.sha256}`);
  }
}

function invoke(arguments_: string[]) {
  const result = spawnSync(executable, arguments_, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw new Error(`NATIVE_PROCESS_ERROR:${result.error.message}`);
  return result;
}

async function decode(
  temporaryRoot: string,
  label: string,
  fixture: string,
  targetSeconds: number,
): Promise<SoftwareVideoDecodeReceipt> {
  const output = join(temporaryRoot, `${label}.json`);
  const result = invoke([
    "software-decode", runtimeRoot, join(fixtureRoot, fixture),
    String(targetSeconds), "0.017", output,
  ]);
  if (result.status !== 0) {
    throw new Error(`NATIVE_DECODE_FAILED:${label}:${result.status}:${result.stderr.trim()}`);
  }
  return parseSoftwareVideoDecodeReceipt(JSON.parse(await readFile(output, "utf8")));
}

function assertPositiveFixture(
  receipt: SoftwareVideoDecodeReceipt,
  expected: { bytes: number; sha256: string; codec: "h264" | "hevc" },
  targetSeconds: number,
): void {
  if (receipt.input.bytes !== expected.bytes || receipt.input.sha256 !== expected.sha256) {
    throw new Error(`POSITIVE_INPUT_IDENTITY_MISMATCH:${expected.codec}`);
  }
  if (receipt.frame.codec !== expected.codec || receipt.frame.width !== 128 || receipt.frame.height !== 72) {
    throw new Error(`POSITIVE_FRAME_IDENTITY_MISMATCH:${expected.codec}`);
  }
  if (Math.abs(receipt.frame.ptsSeconds - targetSeconds) > 0.017 || !receipt.frame.clockWithinTolerance) {
    throw new Error(`POSITIVE_SEEK_OUT_OF_TOLERANCE:${expected.codec}:${targetSeconds}`);
  }
  if (receipt.planes.totalBytes !== 36_864
    || receipt.copyAccounting.bridgeTightPlaneCpuCopyBytes !== 36_864
    || receipt.copyAccounting.rustPixelBufferCopyCount !== 0
    || receipt.copyAccounting.gpuUploadCount !== 0
    || receipt.copyAccounting.gpuCopyCount !== 0
    || receipt.copyAccounting.zeroCopy) {
    throw new Error(`POSITIVE_COPY_ACCOUNTING_MISMATCH:${expected.codec}`);
  }
}

async function negativeControl(
  temporaryRoot: string,
  key: "pixelNegative" | "colorNegative" | "codecNegative",
): Promise<NativeFailure> {
  const fixture = FIXTURES[key];
  const output = join(temporaryRoot, `${key}.json`);
  const result = invoke([
    "software-decode", runtimeRoot, join(fixtureRoot, fixture.file),
    "0.5", "0.017", output,
  ]);
  const observed = `${result.stdout}\n${result.stderr}`.trim();
  if (result.status === 0 || !observed.includes(fixture.error) || existsSync(output)) {
    throw new Error(`NEGATIVE_CONTROL_NOT_REJECTED:${fixture.file}:${result.status}:${observed}`);
  }
  return { fixture: fixture.file, expectedError: fixture.error, exitCode: result.status, observed };
}

async function runCorrectness(temporaryRoot: string): Promise<CorrectnessEvidence> {
  const h264AtHalf = await decode(temporaryRoot, "h264-half", FIXTURES.h264.file, 0.5);
  const h264AtHalfRepeat = await decode(temporaryRoot, "h264-half-repeat", FIXTURES.h264.file, 0.5);
  const h264AtOne = await decode(temporaryRoot, "h264-one", FIXTURES.h264.file, 1);
  const hevcAtHalf = await decode(temporaryRoot, "hevc-half", FIXTURES.hevc.file, 0.5);
  assertPositiveFixture(h264AtHalf, FIXTURES.h264, 0.5);
  assertPositiveFixture(h264AtHalfRepeat, FIXTURES.h264, 0.5);
  assertPositiveFixture(h264AtOne, FIXTURES.h264, 1);
  assertPositiveFixture(hevcAtHalf, FIXTURES.hevc, 0.5);

  const deterministicSameTarget = h264AtHalf.frame.pts100ns === h264AtHalfRepeat.frame.pts100ns
    && h264AtHalf.planes.combinedSha256 === h264AtHalfRepeat.planes.combinedSha256
    && h264AtHalf.planes.y.sha256 === h264AtHalfRepeat.planes.y.sha256
    && h264AtHalf.planes.u.sha256 === h264AtHalfRepeat.planes.u.sha256
    && h264AtHalf.planes.v.sha256 === h264AtHalfRepeat.planes.v.sha256;
  const distinctSeekOutput = h264AtHalf.frame.pts100ns !== h264AtOne.frame.pts100ns
    && h264AtHalf.planes.combinedSha256 !== h264AtOne.planes.combinedSha256;
  const tenBitEvidence = [h264AtHalf, h264AtOne, hevcAtHalf].every((receipt) =>
    Math.max(receipt.planes.y.maximumSample, receipt.planes.u.maximumSample, receipt.planes.v.maximumSample) > 255
    && receipt.planes.y.samplesOutsideTenBit === 0
    && receipt.planes.u.samplesOutsideTenBit === 0
    && receipt.planes.v.samplesOutsideTenBit === 0);
  if (!deterministicSameTarget) throw new Error("DETERMINISM_CONTROL_FAILED");
  if (!distinctSeekOutput) throw new Error("SEEK_OUTPUT_DID_NOT_CHANGE");
  if (!tenBitEvidence) throw new Error("TEN_BIT_EVIDENCE_MISSING");

  const negativeControls = [];
  for (const key of ["pixelNegative", "colorNegative", "codecNegative"] as const) {
    negativeControls.push(await negativeControl(temporaryRoot, key));
  }
  return {
    h264AtHalf, h264AtHalfRepeat, h264AtOne, hevcAtHalf,
    deterministicSameTarget, distinctSeekOutput, tenBitEvidence, negativeControls,
  };
}

async function runFrozenBenchmark(temporaryRoot: string): Promise<SoftwareVideoDecodeBenchmarkReceipt> {
  const output = join(temporaryRoot, "benchmark.json");
  const result = invoke([
    "software-decode-benchmark", runtimeRoot, join(fixtureRoot, FIXTURES.h264.file),
    String(SOFTWARE_VIDEO_BENCHMARK_ITERATIONS), output,
  ]);
  if (result.status !== 0) {
    throw new Error(`NATIVE_BENCHMARK_FAILED:${result.status}:${result.stderr.trim()}`);
  }
  return parseSoftwareVideoDecodeBenchmarkReceipt(JSON.parse(await readFile(output, "utf8")));
}

async function main(): Promise<void> {
  await mkdir(evidenceRoot, { recursive: true });
  const failures: string[] = [];
  let temporaryRoot = "";
  let correctness: CorrectnessEvidence | null = null;
  let benchmark: SoftwareVideoDecodeBenchmarkReceipt | null = null;
  let benchmarkInvocations = 0;
  let executableIdentity: FileIdentity | null = null;
  let runtimeManifestIdentity: FileIdentity | null = null;
  let gateIdentity: FileIdentity | null = null;
  const fixtureIdentities: Record<string, FileIdentity> = {};

  try {
    if (process.platform !== "win32") throw new Error("WINDOWS_HOST_REQUIRED");
    if (!runtimeRoot) throw new Error("EDITKIN_FFMPEG_LGPL_RD_ROOT_REQUIRED");
    if (!existsSync(executable)) throw new Error(`COMPOSITOR_NOT_FOUND:${executable}`);
    if (!existsSync(runtimeManifest)) throw new Error(`RUNTIME_MANIFEST_NOT_FOUND:${runtimeManifest}`);
    executableIdentity = await fileIdentity(executable);
    runtimeManifestIdentity = await fileIdentity(runtimeManifest);
    gateIdentity = await fileIdentity(gateSource);
    if (runtimeManifestIdentity.sha256 !== "51d1b965925aa6e4dfe7b3ffc724e2e03cd59f73709873104ccc867dff990ee2") {
      throw new Error(`RUNTIME_MANIFEST_IDENTITY_MISMATCH:${runtimeManifestIdentity.sha256}`);
    }
    for (const [key, fixture] of Object.entries(FIXTURES)) {
      const identity = await fileIdentity(join(fixtureRoot, fixture.file));
      assertIdentity(identity, fixture);
      fixtureIdentities[key] = identity;
    }
    temporaryRoot = await mkdtemp(join(tmpdir(), "editkin-software-video-round1-"));
    correctness = await runCorrectness(temporaryRoot);
    // This is the only call site for the frozen benchmark. It is reached only after all
    // identity, schema, seek, deterministic-output, copy-accounting, and negative controls pass.
    benchmarkInvocations += 1;
    benchmark = await runFrozenBenchmark(temporaryRoot);
    if (!benchmark.withinReferenceFrameBudget) failures.push("FROZEN_P95_BUDGET_EXCEEDED");
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  } finally {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  }

  const report = {
    schema: "editkin.software-video-decode-round1-gate/v1",
    status: failures.length === 0 ? "GREEN_RD_CELL" : "BLOCK",
    shippingEligible: false,
    packagedLatencyMeasured: false,
    productPreviewIntegrated: false,
    davinciParityClaimed: false,
    frozenContract: FROZEN_CONTRACT,
    frozenContractSha256: contractSha256(FROZEN_CONTRACT),
    identities: {
      executable: executableIdentity,
      runtimeManifest: runtimeManifestIdentity,
      gate: gateIdentity,
      fixtures: fixtureIdentities,
    },
    correctness,
    benchmark,
    benchmarkInvocations,
    performanceStatus: benchmark
      ? (benchmark.withinReferenceFrameBudget ? "PASS_RD_REFERENCE_ONLY" : "BLOCK")
      : "NOT_RUN",
    failures,
    boundaries: [
      "Standalone clean-room R&D CLI only; no product preview route.",
      "No FFmpeg DLL is bundled in the application.",
      "The benchmark is a 128x72 synthetic single-frame cold load/open/seek/decode/copy measurement, not resident playback or packaged latency.",
      "No shipping, 4K, DaVinci Resolve, or general editorial-performance parity is claimed.",
    ],
  } as const;
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    schema: report.schema,
    status: report.status,
    benchmarkInvocations,
    p95Milliseconds: benchmark?.p95Milliseconds ?? null,
    performanceStatus: report.performanceStatus,
    reportPath: evidencePath,
    failures,
  })}\n`);
  if (failures.length > 0) process.exitCode = 1;
}

void main();
