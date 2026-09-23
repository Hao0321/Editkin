import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { compareUtf8Bytes } from "../shared/utf8ByteOrder";
import {
  productAutoRotoRouteReceiptBaseSchema,
  productAutoRotoRouteReceiptShapeSchema,
  PRODUCT_AUTO_ROTO_ENGINE,
  PRODUCT_AUTO_ROTO_MAX_ALPHA_BYTES,
  PRODUCT_AUTO_ROTO_MAX_DURATION_SECONDS,
  PRODUCT_AUTO_ROTO_MAX_FRAMES,
  PRODUCT_AUTO_ROTO_MAX_PREVIEW_BYTES,
  PRODUCT_AUTO_ROTO_MAX_PREVIEW_TOTAL_BYTES,
  PRODUCT_AUTO_ROTO_MAX_RGB_BYTES,
  PRODUCT_AUTO_ROTO_ROUTE_POLICY,
  PRODUCT_AUTO_ROTO_ROUTE_RECEIPT_SHA256,
  PRODUCT_AUTO_ROTO_ROUTE_SCHEMA,
  type ProductAutoRotoRouteReceipt,
} from "../domain/autoRotoProductReceipt";

export {
  PRODUCT_AUTO_ROTO_ENGINE,
  PRODUCT_AUTO_ROTO_MAX_ALPHA_BYTES,
  PRODUCT_AUTO_ROTO_MAX_DURATION_SECONDS,
  PRODUCT_AUTO_ROTO_MAX_FRAMES,
  PRODUCT_AUTO_ROTO_MAX_PREVIEW_BYTES,
  PRODUCT_AUTO_ROTO_MAX_PREVIEW_TOTAL_BYTES,
  PRODUCT_AUTO_ROTO_MAX_RGB_BYTES,
  PRODUCT_AUTO_ROTO_ROUTE_POLICY,
  PRODUCT_AUTO_ROTO_ROUTE_RECEIPT_SHA256,
  PRODUCT_AUTO_ROTO_ROUTE_SCHEMA,
  type ProductAutoRotoRouteReceipt,
} from "../domain/autoRotoProductReceipt";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareUtf8Bytes(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export const productAutoRotoRouteReceiptSchema = productAutoRotoRouteReceiptShapeSchema.superRefine((receipt, context) => {
  const { receiptSha256, ...base } = receipt;
  if (sha256Canonical(base) !== receiptSha256) {
    context.addIssue({
      code: "custom",
      path: ["receiptSha256"],
      message: "Auto Roto product route receipt 完整性驗證失敗",
    });
  }
});

export function createProductAutoRotoRouteReceipt(): ProductAutoRotoRouteReceipt {
  const base = productAutoRotoRouteReceiptBaseSchema.parse({
    schema: PRODUCT_AUTO_ROTO_ROUTE_SCHEMA,
    policyVersion: PRODUCT_AUTO_ROTO_ROUTE_POLICY,
    mode: "product",
    requestedEngine: PRODUCT_AUTO_ROTO_ENGINE,
    selectedEngine: PRODUCT_AUTO_ROTO_ENGINE,
    status: "selected",
    reasonCode: "selected-self-authored-product-artifact",
    boundary: {
      serviceArtifactKind: "product",
      externalResearchRuntime: "disabled",
      externalModelWeights: false,
      modelInjection: "forbidden",
    },
    provenance: {
      origin: "editkin-self-authored",
      implementation: "native-compiled",
      modelAndAlgorithmRights: "editkin-owned",
    },
    execution: { regionMemoryPolicy: "fixed_baseline" },
    quality: { state: "diagnostic", claim: "unmeasured", humanReviewRequired: true },
    candidates: [{
      engine: PRODUCT_AUTO_ROTO_ENGINE,
      configured: true,
      origin: "editkin-self-authored",
      rightsClass: "editkin-owned",
      qualityTier: "self-authored-unmeasured",
      decision: "selected",
      reasonCode: "compiled-into-product-artifact",
    }],
  });
  return productAutoRotoRouteReceiptSchema.parse({ ...base, receiptSha256: sha256Canonical(base) });
}

export function parseProductAutoRotoRouteReceipt(value: unknown): ProductAutoRotoRouteReceipt {
  return productAutoRotoRouteReceiptSchema.parse(value);
}

export function isProductAutoRotoRouteReceipt(value: unknown): value is ProductAutoRotoRouteReceipt {
  return productAutoRotoRouteReceiptSchema.safeParse(value).success;
}

export interface ProductAutoRotoArtifactPaths {
  manifestPath: string;
  sequencePath: string;
  frames: ReadonlyArray<{ frame: number; alphaPath: string }>;
}

interface ProductAutoRotoArtifactPathLayout {
  cacheRoot: string;
  productRoot: string;
  artifactRoot: string;
  manifestPath: string;
  sequencePath: string;
  framePaths: string[];
}

function isInside(root: string, target: string): boolean {
  const relation = relative(root, target);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function productArtifactPathLayout(
  value: ProductAutoRotoArtifactPaths,
  cacheRootInput: string,
): ProductAutoRotoArtifactPathLayout {
  if (!isAbsolute(cacheRootInput) || !isAbsolute(value.manifestPath) || !isAbsolute(value.sequencePath)) {
    throw new Error("Auto Roto product artifact 必須使用絕對路徑");
  }
  if (value.frames.length < 1 || value.frames.length > 172_800) {
    throw new Error("Auto Roto product artifact frame 數量不合法");
  }

  const cacheRoot = resolve(cacheRootInput);
  const productRoot = join(cacheRoot, "auto-roto-product");
  const manifestPath = resolve(value.manifestPath);
  const artifactRoot = dirname(manifestPath);
  const artifactRelation = relative(productRoot, artifactRoot);
  if (!isInside(productRoot, artifactRoot) || artifactRelation.includes("/") || artifactRelation.includes("\\")
    || !/^[a-f0-9]{64}$/.test(artifactRelation) || basename(manifestPath) !== "matte-manifest.json") {
    throw new Error("Auto Roto product manifest 不在內容定址 cache boundary");
  }

  const sequencePath = resolve(value.sequencePath);
  if (sequencePath !== join(artifactRoot, "matte-sequence.alpha8")) {
    throw new Error("Auto Roto product matte sequence 路徑不合法");
  }
  const framePaths = value.frames.map((frame, index) => {
    if (frame.frame !== index || !Number.isInteger(frame.frame) || !isAbsolute(frame.alphaPath)) {
      throw new Error("Auto Roto product preview frame 索引或路徑不合法");
    }
    const path = resolve(frame.alphaPath);
    if (path !== join(artifactRoot, `frame-${String(index).padStart(6, "0")}.png`)) {
      throw new Error("Auto Roto product preview frame 離開封閉 artifact inventory");
    }
    return path;
  });
  return { cacheRoot, productRoot, artifactRoot, manifestPath, sequencePath, framePaths };
}

/**
 * Verifies the exact native artifact inventory and resolves every path through
 * the filesystem so junctions/symlinks cannot escape the product cache root.
 */
export async function verifyProductAutoRotoArtifactPaths(
  value: ProductAutoRotoArtifactPaths,
  cacheRootInput: string,
): Promise<void> {
  const layout = productArtifactPathLayout(value, cacheRootInput);
  const lexicalEntries = await Promise.all([
    lstat(layout.cacheRoot), lstat(layout.productRoot), lstat(layout.artifactRoot), lstat(layout.manifestPath),
    lstat(layout.sequencePath), ...layout.framePaths.map((path) => lstat(path)),
  ]);
  if (!lexicalEntries[0].isDirectory() || lexicalEntries[0].isSymbolicLink()
    || !lexicalEntries[1].isDirectory() || lexicalEntries[1].isSymbolicLink()
    || !lexicalEntries[2].isDirectory() || lexicalEntries[2].isSymbolicLink()
    || lexicalEntries.slice(3).some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error("Auto Roto product artifact inventory 含不支援的檔案型態或連結");
  }
  const [cacheRoot, productRoot, artifactRoot, manifestPath, sequencePath, ...framePaths] = await Promise.all([
    realpath(layout.cacheRoot),
    realpath(layout.productRoot),
    realpath(layout.artifactRoot),
    realpath(layout.manifestPath),
    realpath(layout.sequencePath),
    ...layout.framePaths.map((path) => realpath(path)),
  ]);
  if (!isInside(cacheRoot, productRoot) || !isInside(productRoot, artifactRoot)
    || dirname(manifestPath) !== artifactRoot || dirname(sequencePath) !== artifactRoot
    || framePaths.some((path) => dirname(path) !== artifactRoot)) {
    throw new Error("Auto Roto product artifact realpath 離開 cache boundary");
  }
  const observed = await readdir(artifactRoot, { withFileTypes: true });
  const expectedNames = ["matte-manifest.json", "matte-sequence.alpha8", ...framePaths.map((path) => basename(path))].sort(compareUtf8Bytes);
  const observedNames = observed.map((entry) => entry.name).sort(compareUtf8Bytes);
  if (observed.some((entry) => !entry.isFile() || entry.isSymbolicLink())
    || JSON.stringify(observedNames) !== JSON.stringify(expectedNames)) {
    throw new Error("Auto Roto product artifact directory 含未列入 receipt 的檔案");
  }
}

/** Verifies the untrusted native process output before any payload bytes are read. */
export async function verifyProductAutoRotoStagingPayloadPaths(
  value: Pick<ProductAutoRotoArtifactPaths, "sequencePath" | "frames">,
  productRootInput: string,
  stagingRootInput: string,
): Promise<void> {
  if (!isAbsolute(productRootInput) || !isAbsolute(stagingRootInput) || value.frames.length < 1 || value.frames.length > 172_800) {
    throw new Error("Auto Roto staging artifact root 或 frame 數量不合法");
  }
  const productRoot = resolve(productRootInput);
  const stagingRoot = resolve(stagingRootInput);
  if (!isInside(productRoot, stagingRoot)
    || !/^\.[a-f0-9]{64}\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.staging$/.test(basename(stagingRoot))) {
    throw new Error("Auto Roto staging artifact 離開 product cache boundary");
  }
  const expectedSequence = join(stagingRoot, "matte-sequence.alpha8");
  const expectedManifest = join(stagingRoot, "matte-manifest.json");
  if (!isAbsolute(value.sequencePath) || resolve(value.sequencePath) !== expectedSequence) {
    throw new Error("Auto Roto staging matte sequence 路徑不合法");
  }
  const expectedFrames = value.frames.map((frame, index) => {
    const expected = join(stagingRoot, `frame-${String(index).padStart(6, "0")}.png`);
    if (frame.frame !== index || !Number.isInteger(frame.frame) || !isAbsolute(frame.alphaPath) || resolve(frame.alphaPath) !== expected) {
      throw new Error("Auto Roto staging preview 離開封閉 artifact inventory");
    }
    return expected;
  });
  const lexicalEntries = await Promise.all([
    lstat(productRoot), lstat(stagingRoot), lstat(expectedManifest), lstat(expectedSequence), ...expectedFrames.map((path) => lstat(path)),
  ]);
  if (!lexicalEntries[0].isDirectory() || lexicalEntries[0].isSymbolicLink()
    || !lexicalEntries[1].isDirectory() || lexicalEntries[1].isSymbolicLink()
    || lexicalEntries.slice(2).some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error("Auto Roto staging artifact inventory 含不支援的檔案型態或連結");
  }
  const [realProductRoot, realStagingRoot, realManifest, realSequence, ...realFrames] = await Promise.all([
    realpath(productRoot), realpath(stagingRoot), realpath(expectedManifest), realpath(expectedSequence), ...expectedFrames.map((path) => realpath(path)),
  ]);
  if (!isInside(realProductRoot, realStagingRoot) || dirname(realManifest) !== realStagingRoot || dirname(realSequence) !== realStagingRoot
    || realFrames.some((path) => dirname(path) !== realStagingRoot)) {
    throw new Error("Auto Roto staging artifact realpath 離開 product cache boundary");
  }
  const observed = await readdir(realStagingRoot, { withFileTypes: true });
  const expectedNames = ["matte-manifest.json", "matte-sequence.alpha8", ...realFrames.map((path) => basename(path))].sort(compareUtf8Bytes);
  const observedNames = observed.map((entry) => entry.name).sort(compareUtf8Bytes);
  if (observed.some((entry) => !entry.isFile() || entry.isSymbolicLink())
    || JSON.stringify(observedNames) !== JSON.stringify(expectedNames)) {
    throw new Error("Auto Roto staging artifact directory 含未列入 receipt 的檔案");
  }
}
