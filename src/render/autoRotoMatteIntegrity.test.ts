import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProductAutoRotoRouteReceipt } from "../application/autoRotoProductContract";
import type { RotoMatteSequence } from "../domain/types";
import { verifyFrozenRotoMatte } from "./autoRotoMatteIntegrity";

const temporaryRoots: string[] = [];
const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

async function fixture(): Promise<{
  cacheRoot: string;
  sequencePath: string;
  manifestPath: string;
  framePath: string;
  matte: RotoMatteSequence;
  manifest: Record<string, unknown>;
}> {
  const cacheRoot = await mkdtemp(join(tmpdir(), "editkin-roto-render-"));
  temporaryRoots.push(cacheRoot);
  const artifactRoot = join(cacheRoot, "auto-roto-product", "c".repeat(64));
  await mkdir(artifactRoot, { recursive: true });
  const sequencePath = join(artifactRoot, "matte-sequence.alpha8");
  const manifestPath = join(artifactRoot, "matte-manifest.json");
  const framePath = join(artifactRoot, "frame-000000.png");
  const sequence = Buffer.alloc(16 * 16, 127);
  const preview = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(40, 1)]);
  const routeReceipt = createProductAutoRotoRouteReceipt();
  const regionMemoryRouting = {
    schema: "editkin.region-memory-routing/v1" as const,
    requested: "fixed_baseline" as const,
    executed: "fixed_baseline" as const,
    candidateAttempted: false as const,
    deterministicFallback: false as const,
  };
  const alphaRefinement = {
    schema: "editkin.optical-alpha-refinement-aggregate/v1" as const,
    engine: "editkin-self-authored-optical-alpha-refiner/v1" as const,
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
  };
  const matte: RotoMatteSequence = {
    schema: "editkin.auto-roto-matte/v1",
    engine: "editkin-native-color-temporal-roto/v1",
    width: 16,
    height: 16,
    analysisFps: 12,
    frameCount: 1,
    sequenceUri: sequencePath,
    sequenceSha256: sha256(sequence),
    sequenceBytes: sequence.length,
    manifestUri: manifestPath,
    framePreviewUris: ["asset://localhost/preview"],
    frameArtifactUris: [framePath],
    meanBoundaryChatter: .02,
    correctionStrokesApplied: 0,
    correctedFrames: [],
    regionMemoryRouting,
    alphaRefinement,
    routeReceipt,
    frozen: true,
    qualityState: "diagnostic",
  };
  const manifest: Record<string, unknown> = {
    schema: matte.schema,
    engine: matte.engine,
    width: matte.width,
    height: matte.height,
    analysisFps: matte.analysisFps,
    initialFrame: 0,
    sequencePath,
    frames: [{
      frame: 0,
      time: 0,
      alphaPath: framePath,
      confidence: .9,
      foregroundRatio: .4,
      boundaryChatter: .02,
      previewSha256: sha256(preview),
      alphaFrameSha256: sha256(sequence),
    }],
    sequenceSha256: matte.sequenceSha256,
    sequenceBytes: matte.sequenceBytes,
    meanBoundaryChatter: matte.meanBoundaryChatter,
    correctionStrokesApplied: 0,
    correctedFrames: [],
    regionMemoryRouting,
    alphaRefinement,
    frozen: true,
    qualityState: "diagnostic",
    routeReceipt,
  };
  await Promise.all([
    writeFile(sequencePath, sequence),
    writeFile(framePath, preview),
    writeFile(manifestPath, JSON.stringify(manifest)),
  ]);
  return { cacheRoot, sequencePath, manifestPath, framePath, matte, manifest };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("formal Auto Roto matte render integrity", () => {
  it("accepts a byte-verified native v2 product artifact", async () => {
    const value = await fixture();
    await expect(verifyFrozenRotoMatte(value.matte, value.sequencePath, value.manifestPath, value.cacheRoot)).resolves.toBe(value.sequencePath);
  });

  it("rejects legacy external engines before touching artifacts", async () => {
    const value = await fixture();
    (value.matte as unknown as { engine: string }).engine = "editkin-sam21-video-memory-roto/v1";
    await expect(verifyFrozenRotoMatte(value.matte, value.sequencePath, value.manifestPath, value.cacheRoot)).rejects.toThrow(/純自研 native/);
  });

  it("rejects unknown runtime-injection fields on the product matte", async () => {
    const value = await fixture();
    (value.matte as unknown as Record<string, unknown>).runtimeAlias = { path: "research-runtime" };
    await expect(verifyFrozenRotoMatte(value.matte, value.sequencePath, value.manifestPath, value.cacheRoot)).rejects.toThrow(/純自研 native/);
  });

  it("rejects missing receipt, trusted root and escaped inventory", async () => {
    const value = await fixture();
    const missingReceipt = structuredClone(value.matte);
    delete missingReceipt.routeReceipt;
    await expect(verifyFrozenRotoMatte(missingReceipt, value.sequencePath, value.manifestPath, value.cacheRoot)).rejects.toThrow();
    await expect(verifyFrozenRotoMatte(value.matte, value.sequencePath, value.manifestPath)).rejects.toThrow(/可信 product cache root/);
    const escaped = structuredClone(value.matte);
    escaped.frameArtifactUris![0] = join(value.cacheRoot, "outside.png");
    await expect(verifyFrozenRotoMatte(escaped, value.sequencePath, value.manifestPath, value.cacheRoot)).rejects.toThrow(/inventory|路徑/);
  });

  it("rejects tampered sequence, preview and manifest bytes", async () => {
    const sequenceTamper = await fixture();
    await writeFile(sequenceTamper.sequencePath, Buffer.alloc(256, 1));
    await expect(verifyFrozenRotoMatte(sequenceTamper.matte, sequenceTamper.sequencePath, sequenceTamper.manifestPath, sequenceTamper.cacheRoot)).rejects.toThrow(/alpha receipt|SHA-256/);

    const previewTamper = await fixture();
    await writeFile(previewTamper.framePath, Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(40, 2)]));
    await expect(verifyFrozenRotoMatte(previewTamper.matte, previewTamper.sequencePath, previewTamper.manifestPath, previewTamper.cacheRoot)).rejects.toThrow(/frame 0/);

    const manifestTamper = await fixture();
    await writeFile(manifestTamper.manifestPath, JSON.stringify({ ...manifestTamper.manifest, legacyModelPath: "model.onnx" }));
    await expect(verifyFrozenRotoMatte(manifestTamper.matte, manifestTamper.sequencePath, manifestTamper.manifestPath, manifestTamper.cacheRoot)).rejects.toThrow(/封閉式 v2/);
  });
});
