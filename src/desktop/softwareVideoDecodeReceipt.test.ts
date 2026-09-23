import { describe, expect, it } from "vitest";
import {
  SOFTWARE_VIDEO_PACKAGING_BLOCKER,
  SOFTWARE_VIDEO_REFERENCE_BUDGET_MS,
  parseSoftwareVideoDecodeBenchmarkReceipt,
  parseSoftwareVideoDecodeReceipt,
} from "./softwareVideoDecodeReceipt";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

function validRuntime() {
  return {
    provider: "BtbN/FFmpeg-Builds",
    releaseTag: "autobuild-2026-09-03-13-17",
    buildRepositoryCommit: "8267213e26c1031621e6e1210fe3aa4867214f6a",
    ffmpegCommit: "1a748fe2cd43e3ead22fafb1b5b7d77f153898a8",
    assetName: "ffmpeg-n8.1.2-50-g1a748fe2cd-win64-lgpl-shared-8.1.zip",
    assetBytes: 70_835_267,
    assetSha256: "383f173d39cf610ba7d1d56bf22941f5e9470dd5ebfcf76a152e8a6f6235fe68",
    licenseExpression: "LGPL-3.0-or-later",
    license: "LGPL version 3 or later",
    configurationSha256: "e8d1f4eea6fe04058e71e84365dd90f7dd0ad99e8954667f58c86b6c6baca325",
    avutilVersion: "60.26.102",
    avcodecVersion: "62.28.102",
    avformatVersion: "62.12.102",
    manifestExactMatch: true,
    fileHashesVerified: true,
    closedWorldLibrarySet: true,
    reparsePointsRejected: true,
    admissionMilliseconds: 3_100,
  };
}

function validDecodeReceipt(): Record<string, any> {
  return {
    schema: "editkin.software-video-decode/v1",
    status: "GREEN_RD_CELL",
    route: "ffmpeg-libav-software/v1",
    shippingEligible: false,
    packagedLatencyMeasured: false,
    scope: {
      codecs: ["h264", "hevc"], pixelFormat: "yuv422p10le", color: "rec709-limited",
      scan: "progressive", execution: "cpu-software", integration: "standalone-rd-cli-only",
    },
    runtime: validRuntime(),
    input: { path: "D:\\fixture.mp4", bytes: 87_065, sha256: HASH_A },
    request: {
      target100ns: 5_000_000, targetSeconds: 0.5, tolerance100ns: 170_000,
      toleranceSeconds: 0.017, timeoutMilliseconds: 5_000,
    },
    frame: {
      width: 128, height: 72, codec: "h264", codecId: 27,
      pixelFormat: "yuv422p10le", pixelFormatId: 64,
      colorRange: "limited", colorSpace: "bt709", colorPrimaries: "bt709",
      colorTransfer: "bt709", scan: "progressive",
      pts100ns: 5_000_000, ptsSeconds: 0.5,
      duration100ns: 333_333, durationSeconds: 0.0333333,
      absoluteDrift100ns: 0, clockWithinTolerance: true,
      frameRateNumerator: 30, frameRateDenominator: 1,
      packetsRead: 3, framesDecoded: 1, keyFrame: true,
    },
    planes: {
      layout: "yuv422p10le-tight-planar/v1", totalBytes: 36_864, combinedSha256: HASH_A,
      y: { offset: 0, strideBytes: 256, bytes: 18_432, sha256: HASH_B, minimumSample: 64, maximumSample: 900, samplesOutsideTenBit: 0 },
      u: { offset: 18_432, strideBytes: 128, bytes: 9_216, sha256: HASH_C, minimumSample: 64, maximumSample: 950, samplesOutsideTenBit: 0 },
      v: { offset: 27_648, strideBytes: 128, bytes: 9_216, sha256: HASH_D, minimumSample: 64, maximumSample: 960, samplesOutsideTenBit: 0 },
    },
    copyAccounting: {
      decoderOutputMemory: "libav-cpu-frame", decoderOutputFrames: 1,
      bridgeTightPlaneCpuCopyCount: 1, bridgeTightPlaneCpuCopyBytes: 36_864,
      rustPixelBufferCopyCount: 0, gpuUploadCount: 0, gpuCopyCount: 0, zeroCopy: false,
    },
    timings: {
      decodeMilliseconds: 22,
      measurementBoundary: "same-process bridge call: dynamic DLL load, demux open, seek, software decode, and one tight-plane CPU copy; excludes runtime/input hashing, GPU upload, composition, UI, and packaging",
    },
    packagingBlocker: SOFTWARE_VIDEO_PACKAGING_BLOCKER,
  };
}

function validBenchmarkReceipt(): Record<string, any> {
  const targets = Array.from({ length: 20 }, (_, index) => [0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4, 1.6][index % 8]);
  const samples = Array.from({ length: 20 }, (_, index) => 10 + index);
  return {
    schema: "editkin.software-video-decode-benchmark/v1",
    status: "MEASURED_RD_ONLY",
    route: "ffmpeg-libav-software/v1",
    shippingEligible: false,
    packagedLatencyMeasured: false,
    runtime: validRuntime(),
    input: {
      path: "D:\\h264-yuv422p10le-rec709-limited.mp4",
      bytes: 87_065,
      sha256: "31bf4b41551665fb5d1a0f2d1acc442856f849556eb4c84f79ace6b8458aa33a",
    },
    warmupIterations: 1,
    measuredIterations: 20,
    targetSequenceSeconds: targets,
    samplesMilliseconds: samples,
    decodedPtsSeconds: [...targets],
    p50Milliseconds: 19,
    p95Milliseconds: 28,
    maximumMilliseconds: 29,
    referenceFrameBudgetMilliseconds: SOFTWARE_VIDEO_REFERENCE_BUDGET_MS,
    withinReferenceFrameBudget: true,
    measurementBoundary: "single host/process; each sample reloads the pinned DLLs, opens the container, seeks, software-decodes one selected CPU frame, and copies tight planes; excludes hashing/admission, persistent scheduler/cache, GPU upload, composition, packaged app, and UI",
    packagingBlocker: SOFTWARE_VIDEO_PACKAGING_BLOCKER,
  };
}

describe("software video decode receipt trust boundary", () => {
  it("accepts the exact closed-world R&D receipt", () => {
    expect(parseSoftwareVideoDecodeReceipt(validDecodeReceipt()).schema).toBe("editkin.software-video-decode/v1");
  });

  const negativeMutations: Record<string, (value: Record<string, any>) => void> = {
    forgedSchema: (value) => { value.schema = "editkin.software-video-decode/v2"; },
    forgedStatus: (value) => { value.status = "GREEN"; },
    forgedRoute: (value) => { value.route = "system-ffmpeg"; },
    extraTopLevel: (value) => { value.untrusted = true; },
    extraNested: (value) => { value.frame.untrusted = true; },
    shippingClaim: (value) => { value.shippingEligible = true; },
    packagedLatencyClaim: (value) => { value.packagedLatencyMeasured = true; },
    codecMismatch: (value) => { value.frame.codecId = 173; },
    wrongPixelFormat: (value) => { value.frame.pixelFormat = "yuv420p"; },
    wrongColor: (value) => { value.frame.colorRange = "full"; },
    interlace: (value) => { value.frame.scan = "interlaced"; },
    forgedClock: (value) => { value.frame.pts100ns += 180_000; },
    forgedDrift: (value) => { value.frame.absoluteDrift100ns = 1; },
    wrongPlaneOffset: (value) => { value.planes.v.offset -= 2; },
    wrongStride: (value) => { value.planes.u.strideBytes = 256; },
    wrongCopyBytes: (value) => { value.copyAccounting.bridgeTightPlaneCpuCopyBytes -= 2; },
    falseZeroCopy: (value) => { value.copyAccounting.zeroCopy = true; },
    hiddenRustCopy: (value) => { value.copyAccounting.rustPixelBufferCopyCount = 1; },
    elevenBitSample: (value) => { value.planes.y.maximumSample = 1_024; },
    admittedBadSample: (value) => { value.planes.y.samplesOutsideTenBit = 1; },
    nonFiniteTiming: (value) => { value.timings.decodeMilliseconds = Number.NaN; },
    wrongRuntime: (value) => { value.runtime.avcodecVersion = "62.28.103"; },
    badHash: (value) => { value.input.sha256 = "not-a-hash"; },
    removedBlocker: (value) => { value.packagingBlocker = ""; },
  };

  for (const [name, mutate] of Object.entries(negativeMutations)) {
    it(`rejects ${name}`, () => {
      const candidate = structuredClone(validDecodeReceipt());
      mutate(candidate);
      expect(() => parseSoftwareVideoDecodeReceipt(candidate)).toThrow();
    });
  }
});

describe("software video frozen benchmark receipt", () => {
  it("accepts exact corpus, raw samples, and nearest-rank percentiles", () => {
    expect(parseSoftwareVideoDecodeBenchmarkReceipt(validBenchmarkReceipt()).measuredIterations).toBe(20);
  });

  const negativeMutations: Record<string, (value: Record<string, any>) => void> = {
    changedCorpus: (value) => { value.input.sha256 = HASH_A; },
    changedIterations: (value) => { value.measuredIterations = 19; },
    changedTarget: (value) => { value.targetSequenceSeconds[4] = 0.9; },
    inaccurateSeek: (value) => { value.decodedPtsSeconds[3] += 0.002; },
    forgedP50: (value) => { value.p50Milliseconds += 1; },
    forgedP95: (value) => { value.p95Milliseconds += 1; },
    forgedMaximum: (value) => { value.maximumMilliseconds += 1; },
    forgedBudgetVerdict: (value) => { value.withinReferenceFrameBudget = false; },
    packagedLatencyClaim: (value) => { value.packagedLatencyMeasured = true; },
    nonFiniteSample: (value) => { value.samplesMilliseconds[0] = Number.POSITIVE_INFINITY; },
    extraNested: (value) => { value.runtime.binary = "hidden"; },
  };

  for (const [name, mutate] of Object.entries(negativeMutations)) {
    it(`rejects ${name}`, () => {
      const candidate = structuredClone(validBenchmarkReceipt());
      mutate(candidate);
      expect(() => parseSoftwareVideoDecodeBenchmarkReceipt(candidate)).toThrow();
    });
  }
});
