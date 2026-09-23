import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseNativeProductAutoRotoResult,
  validateAnalyzeProductAutoRotoRequest,
  verifyProductAutoRotoSourceIdentity,
  withProductAutoRotoCacheLock,
  type AnalyzeProductAutoRotoRequest,
} from "./autoRotoNativeProduct";

const temporaryRoots: string[] = [];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function request(): AnalyzeProductAutoRotoRequest {
  return {
    sourcePath: "C:/video.mp4",
    sourceStart: 0,
    duration: 10,
    fps: 30,
    sourceWidth: 1920,
    sourceHeight: 1080,
    initialTime: 2,
    initialRect: { x: .1, y: .1, width: .4, height: .6 },
  };
}

const expectedNative = {
  width: 16,
  height: 16,
  analysisFps: 12,
  frameCount: 1,
  initialFrame: 0,
  correctionStrokesApplied: 0,
  correctedFrames: [] as number[],
};

function nativeReceipt(): Record<string, unknown> {
  return {
    schema: "editkin.auto-roto-matte/v1",
    engine: "editkin-native-color-temporal-roto/v1",
    width: 16,
    height: 16,
    analysisFps: 12,
    initialFrame: 0,
    sequencePath: "C:/cache/staging/matte-sequence.alpha8",
    frames: [{ frame: 0, time: 0, alphaPath: "C:/cache/staging/frame-000000.png", confidence: .9, foregroundRatio: .4, boundaryChatter: .02 }],
    meanBoundaryChatter: .02,
    correctionStrokesApplied: 0,
    correctedFrames: [],
    alphaRefinement: {
      schema: "editkin.optical-alpha-refinement-aggregate/v1",
      engine: "editkin-self-authored-optical-alpha-refiner/v1",
      appliedFrames: 1,
      radius: 4,
      backgroundThreshold: .2,
      foregroundThreshold: .8,
      coarseWeight: .5,
      temporalStability: .5,
      temporalGate: .5,
      changedPixels: 10,
      fractionalPixels: 20,
      solvedPixels: 10,
      meanSolveConfidence: .8,
    },
    regionMemoryRouting: {
      schema: "editkin.region-memory-routing/v1",
      requested: "fixed_baseline",
      executed: "fixed_baseline",
      candidateAttempted: false,
      deterministicFallback: false,
    },
    frozen: true,
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Auto Roto native product boundary", () => {
  it("parses only an exact native result bound to request dimensions and initial frame", () => {
    expect(parseNativeProductAutoRotoResult(nativeReceipt(), expectedNative)).toMatchObject({ width: 16, initialFrame: 0 });
    for (const mutate of [
      (value: Record<string, unknown>) => { value.width = 32; },
      (value: Record<string, unknown>) => { value.regionMemory = { enabled: true }; },
      (value: Record<string, unknown>) => { (value.frames as Array<Record<string, unknown>>)[0].runtimeAlias = "external"; },
      (value: Record<string, unknown>) => { (value.regionMemoryRouting as Record<string, unknown>).fallbackReason = "unexpected"; },
    ]) {
      const value = nativeReceipt();
      mutate(value);
      expect(() => parseNativeProductAutoRotoResult(value, expectedNative)).toThrow(/封閉式 contract/);
    }
  });

  it("requires exact per-frame and sequence hashes for a frozen native result", () => {
    const value = nativeReceipt();
    value.sequenceSha256 = "a".repeat(64);
    value.sequenceBytes = 256;
    const frame = (value.frames as Array<Record<string, unknown>>)[0];
    frame.previewSha256 = "b".repeat(64);
    frame.alphaFrameSha256 = "c".repeat(64);
    expect(parseNativeProductAutoRotoResult(value, expectedNative, { frozen: true })).toMatchObject({ sequenceBytes: 256 });
    value.sequenceBytes = 255;
    expect(() => parseNativeProductAutoRotoResult(value, expectedNative, { frozen: true })).toThrow(/封閉式 contract/);
  });

  it.each([
    ["negative sourceStart", { sourceStart: -1 }],
    ["non-finite sourceStart", { sourceStart: Number.NaN }],
    ["duration beyond product memory envelope", { duration: 121, initialTime: 2 }],
    ["oversized width", { sourceWidth: 32_769 }],
    ["unsafe aspect ratio", { sourceWidth: 32_000, sourceHeight: 16 }],
    ["negative rectangle origin", { initialRect: { x: -.01, y: .1, width: .4, height: .6 } }],
    ["rectangle leaves frame", { initialRect: { x: .8, y: .1, width: .3, height: .6 } }],
    ["malformed source hash", { sourceSha256: "A".repeat(64) }],
  ])("rejects %s", (_label, patch) => {
    expect(() => validateAnalyzeProductAutoRotoRequest({ ...request(), ...patch })).toThrow();
  });

  it("rejects duplicate correction ids", () => {
    const stroke = { id: "same", frame: 0, mode: "foreground" as const, radius: .02, points: [{ x: .5, y: .5 }] };
    expect(() => validateAnalyzeProductAutoRotoRequest({ ...request(), corrections: [stroke, stroke] })).toThrow(/修正筆刷/);
  });

  it("measures the live source and rejects a forged caller hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "editkin-roto-source-"));
    temporaryRoots.push(root);
    const sourcePath = join(root, "source.bin");
    await writeFile(sourcePath, "source-v1");

    const measured = await verifyProductAutoRotoSourceIdentity(sourcePath, hash("source-v1"));
    expect(measured.sha256).toBe(hash("source-v1"));
    expect(measured.bytes).toBe(9);
    await expect(verifyProductAutoRotoSourceIdentity(sourcePath, hash("source-v2"))).rejects.toThrow(/SHA-256/);
  });

  it("serializes identical cache-key writers and releases after failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "editkin-roto-lock-"));
    temporaryRoots.push(root);
    const lockPath = join(root, `${"a".repeat(64)}.lock`);
    let active = 0;
    let maximum = 0;
    const run = () => withProductAutoRotoCacheLock(lockPath, async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
      active -= 1;
    }, { timeoutMs: 2_000, staleMs: 5_000 });
    await Promise.all([run(), run(), run()]);
    expect(maximum).toBe(1);

    await expect(withProductAutoRotoCacheLock(lockPath, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(withProductAutoRotoCacheLock(lockPath, async () => "released")).resolves.toBe("released");
  });
});
