import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProductAutoRotoRouteReceipt,
  isProductAutoRotoRouteReceipt,
  parseProductAutoRotoRouteReceipt,
  verifyProductAutoRotoArtifactPaths,
} from "./autoRotoProductContract";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("native-only Auto Roto product contract", () => {
  it("creates and strictly parses the deterministic v2 receipt", () => {
    const first = createProductAutoRotoRouteReceipt();
    const second = createProductAutoRotoRouteReceipt();

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schema: "editkin.auto-roto-product-route-receipt/v2",
      policyVersion: "editkin.auto-roto-product-artifact-policy/2",
      requestedEngine: "editkin-native-color-temporal-roto/v1",
      selectedEngine: "editkin-native-color-temporal-roto/v1",
      boundary: {
        serviceArtifactKind: "product",
        externalResearchRuntime: "disabled",
        externalModelWeights: false,
        modelInjection: "forbidden",
      },
      quality: { state: "diagnostic", claim: "unmeasured", humanReviewRequired: true },
    });
    expect(first.receiptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(parseProductAutoRotoRouteReceipt(structuredClone(first))).toEqual(first);
    expect(isProductAutoRotoRouteReceipt(first)).toBe(true);
  });

  it.each([
    ["v1 receipt", (receipt: Record<string, unknown>) => { receipt.schema = "editkin.auto-roto-product-route-receipt/v1"; }],
    ["ONNX engine", (receipt: Record<string, unknown>) => { receipt.selectedEngine = "editkin-native-onnx-assisted-roto/v1"; }],
    ["SAM engine", (receipt: Record<string, unknown>) => { receipt.selectedEngine = "editkin-sam21-video-memory-roto/v1"; }],
    ["research mode", (receipt: Record<string, unknown>) => { receipt.mode = "research"; }],
    ["external weights", (receipt: Record<string, unknown>) => { (receipt.boundary as Record<string, unknown>).externalModelWeights = true; }],
    ["unknown top-level field", (receipt: Record<string, unknown>) => { receipt.legacyModelPath = "model.onnx"; }],
    ["unknown nested field", (receipt: Record<string, unknown>) => { (receipt.provenance as Record<string, unknown>).license = "custom"; }],
  ])("rejects %s from the product surface", (_label, mutate) => {
    const forged = structuredClone(createProductAutoRotoRouteReceipt()) as unknown as Record<string, unknown>;
    mutate(forged);
    expect(() => parseProductAutoRotoRouteReceipt(forged)).toThrow();
    expect(isProductAutoRotoRouteReceipt(forged)).toBe(false);
  });

  it("rejects a structurally valid receipt when its integrity hash was changed", () => {
    const forged = { ...createProductAutoRotoRouteReceipt(), receiptSha256: "0".repeat(64) };
    expect(() => parseProductAutoRotoRouteReceipt(forged)).toThrow();
  });

  it("accepts only the exact content-addressed matte inventory", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "editkin-roto-contract-"));
    temporaryRoots.push(cacheRoot);
    const artifactRoot = join(cacheRoot, "auto-roto-product", "a".repeat(64));
    await mkdir(artifactRoot, { recursive: true });
    const manifestPath = join(artifactRoot, "matte-manifest.json");
    const sequencePath = join(artifactRoot, "matte-sequence.alpha8");
    const frames = [0, 1].map((frame) => ({ frame, alphaPath: join(artifactRoot, `frame-${String(frame).padStart(6, "0")}.png`) }));
    await Promise.all([
      writeFile(manifestPath, "{}"),
      writeFile(sequencePath, Buffer.from([0, 255])),
      ...frames.map((frame) => writeFile(frame.alphaPath, Buffer.from([137, 80, 78, 71]))),
    ]);

    await expect(verifyProductAutoRotoArtifactPaths({ manifestPath, sequencePath, frames }, cacheRoot)).resolves.toBeUndefined();
    const extraPath = join(artifactRoot, "unattested.bin");
    await writeFile(extraPath, "unexpected");
    await expect(verifyProductAutoRotoArtifactPaths({ manifestPath, sequencePath, frames }, cacheRoot)).rejects.toThrow(/未列入 receipt/);
    await rm(extraPath);
    await expect(verifyProductAutoRotoArtifactPaths({
      manifestPath,
      sequencePath,
      frames: [{ ...frames[0], alphaPath: join(cacheRoot, "outside.png") }, frames[1]],
    }, cacheRoot)).rejects.toThrow(/inventory|路徑/);
    await expect(verifyProductAutoRotoArtifactPaths({
      manifestPath,
      sequencePath,
      frames: [frames[1], frames[0]],
    }, cacheRoot)).rejects.toThrow(/索引/);
  });

  it("rejects a linked artifact directory before resolving payloads", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "editkin-roto-link-contract-"));
    temporaryRoots.push(cacheRoot);
    const productRoot = join(cacheRoot, "auto-roto-product");
    const payloadRoot = join(cacheRoot, "untrusted-payload");
    const artifactRoot = join(productRoot, "b".repeat(64));
    await Promise.all([mkdir(productRoot, { recursive: true }), mkdir(payloadRoot, { recursive: true })]);
    const manifestPath = join(artifactRoot, "matte-manifest.json");
    const sequencePath = join(artifactRoot, "matte-sequence.alpha8");
    const frames = [{ frame: 0, alphaPath: join(artifactRoot, "frame-000000.png") }];
    await Promise.all([
      writeFile(join(payloadRoot, "matte-manifest.json"), "{}"),
      writeFile(join(payloadRoot, "matte-sequence.alpha8"), Buffer.from([0])),
      writeFile(join(payloadRoot, "frame-000000.png"), Buffer.from([137, 80, 78, 71])),
    ]);
    try {
      await symlink(payloadRoot, artifactRoot, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    await expect(verifyProductAutoRotoArtifactPaths({ manifestPath, sequencePath, frames }, cacheRoot)).rejects.toThrow(/連結|boundary/);
  });
});
