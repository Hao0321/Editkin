import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const AUTO_ROTO_SERVICE_ARTIFACT_SCHEMA = "editkin.auto-roto-service-artifact/v1" as const;

export type AutoRotoServiceArtifactKind = "product" | "debug-research";

declare const __EDITKIN_AUTO_ROTO_SERVICE_ARTIFACT_KIND__: AutoRotoServiceArtifactKind | undefined;

/**
 * `product` is the fail-closed source/development default. The desktop build
 * replaces the compile-time token with the same literal and the product gate
 * compares the emitted bundle byte-for-byte with a fresh deterministic build.
 * A research artifact must be built separately and is never staged by the
 * product resource pipeline.
 */
export const AUTO_ROTO_SERVICE_ARTIFACT_KIND: AutoRotoServiceArtifactKind =
  typeof __EDITKIN_AUTO_ROTO_SERVICE_ARTIFACT_KIND__ === "undefined"
    ? "product"
    : __EDITKIN_AUTO_ROTO_SERVICE_ARTIFACT_KIND__;

export interface AutoRotoServiceArtifactReceipt {
  schema: typeof AUTO_ROTO_SERVICE_ARTIFACT_SCHEMA;
  kind: AutoRotoServiceArtifactKind;
  externalResearchRuntime: "disabled" | "artifact-isolated";
}

const PRODUCT_RUNTIME_STRING_KEYS = [
  "ffmpeg", "ffprobe", "whisperCli", "nativeCore", "gpuCompositor", "assetBase", "cacheRoot", "modelRoot",
  "creativePackRoot", "personalMusicRoot", "personalVisualRoot", "fontRoot", "colorRoot", "pluginRoot",
] as const;
const PRODUCT_RUNTIME_KEYS = new Set<string>([...PRODUCT_RUNTIME_STRING_KEYS, "pluginRoots"]);

interface ProductBuildManifestEntry {
  path: string;
  bytes: number;
  sha256: string;
}

interface ProductBuildManifest {
  schemaVersion: number;
  product: string;
  outputs: ProductBuildManifestEntry[];
}

interface ProductManifestContext {
  manifest: ProductBuildManifest;
  manifestPath: string;
  runtimeRoot: string;
  layout: "staged-flat" | "workspace";
}

export type ProductExecutableRuntimeKey = keyof typeof PRODUCT_EXECUTABLE_OUTPUTS;

export interface AttestedProductExecutableIdentity {
  available: true;
  productAttested: true;
  bytes: number;
  sha256: string;
  outputPath: string;
  manifestPath: string;
}

const PRODUCT_EXECUTABLE_OUTPUTS = Object.freeze({
  ffmpeg: process.platform === "win32"
    ? "vendor/ffmpeg/win32-x64/ffmpeg.exe"
    : ".platform-runtime/ffmpeg",
  nativeCore: process.platform === "win32"
    ? "native/bin/win32-x64/hao-core.exe"
    : ".platform-runtime/hao-core",
});

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.localeCompare(right, "en", { sensitivity: "accent" }) === 0
    : left === right;
}

function parseProductManifest(path: string): ProductBuildManifest {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`manifest is not a regular file: ${path}`);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ProductBuildManifest>;
  if (parsed.schemaVersion !== 2 || parsed.product !== "Editkin" || !Array.isArray(parsed.outputs)) {
    throw new Error(`invalid Editkin product manifest: ${path}`);
  }
  return parsed as ProductBuildManifest;
}

function locateProductManifest(): ProductManifestContext {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    { path: join(moduleDirectory, "BUILD-MANIFEST.json"), layout: "staged-flat" as const },
    { path: join(moduleDirectory, ".release-input-manifest.json"), layout: "workspace" as const },
    { path: resolve(moduleDirectory, "..", ".release-input-manifest.json"), layout: "workspace" as const },
    { path: resolve(moduleDirectory, "..", "..", ".release-input-manifest.json"), layout: "workspace" as const },
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue;
    const manifestPath = realpathSync.native(candidate.path);
    return {
      manifest: parseProductManifest(manifestPath),
      manifestPath,
      runtimeRoot: realpathSync.native(dirname(manifestPath)),
      layout: candidate.layout,
    };
  }
  throw new Error("Editkin product executable identity attestation 缺少 BUILD-MANIFEST");
}

function attestProductExecutable(
  context: ProductManifestContext,
  runtimeKey: ProductExecutableRuntimeKey,
  suppliedPath: unknown,
): AttestedProductExecutableIdentity {
  if (typeof suppliedPath !== "string" || !isAbsolute(suppliedPath)) {
    throw new Error(`Editkin product executable identity attestation 拒絕 ${runtimeKey} 非絕對路徑`);
  }
  const outputPath = PRODUCT_EXECUTABLE_OUTPUTS[runtimeKey];
  const entry = context.manifest.outputs.find((candidate) => candidate.path === outputPath);
  if (!entry || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || !/^[a-f0-9]{64}$/u.test(entry.sha256)) {
    throw new Error(`Editkin product executable identity attestation 缺少 ${outputPath}`);
  }
  const expectedPath = context.layout === "staged-flat"
    ? join(context.runtimeRoot, basename(outputPath))
    : join(context.runtimeRoot, outputPath);
  if (!samePath(resolve(suppliedPath), resolve(expectedPath))) {
    throw new Error(`Editkin product executable identity attestation 拒絕 ${runtimeKey} 路徑替換`);
  }
  const suppliedInfo = lstatSync(suppliedPath);
  if (!suppliedInfo.isFile() || suppliedInfo.isSymbolicLink()) {
    throw new Error(`Editkin product executable identity attestation 拒絕 ${runtimeKey} 非一般檔案`);
  }
  const actualPath = realpathSync.native(suppliedPath);
  const canonicalExpectedPath = realpathSync.native(expectedPath);
  if (!samePath(actualPath, canonicalExpectedPath)) {
    throw new Error(`Editkin product executable identity attestation 拒絕 ${runtimeKey} 路徑替換`);
  }
  const before = statSync(actualPath);
  const bytes = readFileSync(actualPath);
  const after = statSync(actualPath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino
    || bytes.length !== entry.bytes || before.size !== entry.bytes) {
    throw new Error(`Editkin product executable identity attestation 拒絕 ${runtimeKey} 非穩定 bytes`);
  }
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== entry.sha256) {
    throw new Error(`Editkin product executable identity attestation 拒絕 ${runtimeKey} SHA-256 不符`);
  }
  return {
    available: true,
    productAttested: true,
    bytes: bytes.length,
    sha256: actualSha256,
    outputPath,
    manifestPath: context.manifestPath,
  };
}

export function attestProductExecutableIdentity(
  runtimeKey: ProductExecutableRuntimeKey,
  suppliedPath: unknown,
): AttestedProductExecutableIdentity {
  return attestProductExecutable(locateProductManifest(), runtimeKey, suppliedPath);
}

export function autoRotoServiceArtifactReceipt(
  kind: AutoRotoServiceArtifactKind = AUTO_ROTO_SERVICE_ARTIFACT_KIND,
): AutoRotoServiceArtifactReceipt {
  return {
    schema: AUTO_ROTO_SERVICE_ARTIFACT_SCHEMA,
    kind,
    externalResearchRuntime: kind === "product" ? "disabled" : "artifact-isolated",
  };
}

/**
 * The request payload is untrusted. In a product service, a caller may ask for
 * research mode, but can never establish that identity. Only the artifact's
 * compile-time identity can select the research boundary.
 */
export function bindAutoRotoRuntimeToServiceArtifact<T extends Record<string, unknown>>(
  runtime: T,
  kind: AutoRotoServiceArtifactKind = AUTO_ROTO_SERVICE_ARTIFACT_KIND,
): T & {
  autoRotoDistributionMode: AutoRotoServiceArtifactKind;
  autoRotoExternalResearchEnabled: boolean;
} {
  if (kind === "product") {
    const unknownKeys = Object.keys(runtime).filter((key) => !PRODUCT_RUNTIME_KEYS.has(key));
    if (unknownKeys.length) {
      throw new Error(`Editkin product service runtime 含未允許欄位：${unknownKeys.sort().join(",")}`);
    }
    const product: Record<string, unknown> = {};
    for (const key of PRODUCT_RUNTIME_STRING_KEYS) {
      const value = runtime[key];
      if (value === undefined || value === null) continue;
      if (typeof value !== "string" || !value.trim()) throw new Error(`Editkin product service runtime ${key} 不合法`);
      product[key] = value;
    }
    if (runtime.pluginRoots !== undefined && runtime.pluginRoots !== null) {
      if (!Array.isArray(runtime.pluginRoots) || runtime.pluginRoots.length > 128
        || runtime.pluginRoots.some((value) => typeof value !== "string" || !value.trim())) {
        throw new Error("Editkin product service runtime pluginRoots 不合法");
      }
      product.pluginRoots = [...new Set(runtime.pluginRoots)];
    }
    return {
      ...product,
      autoRotoDistributionMode: "product",
      autoRotoExternalResearchEnabled: false,
    } as T & { autoRotoDistributionMode: AutoRotoServiceArtifactKind; autoRotoExternalResearchEnabled: boolean };
  }
  return {
    ...runtime,
    autoRotoDistributionMode: "debug-research",
    autoRotoExternalResearchEnabled: runtime.autoRotoExternalResearchEnabled === true,
  };
}

export function assertProductServiceAutoRotoRuntime(runtime: Record<string, unknown>): void {
  if (AUTO_ROTO_SERVICE_ARTIFACT_KIND !== "product") return;
  const allowed = new Set([...PRODUCT_RUNTIME_KEYS, "autoRotoDistributionMode", "autoRotoExternalResearchEnabled"]);
  if (Object.keys(runtime).some((key) => !allowed.has(key))
    || runtime.autoRotoDistributionMode !== "product" || runtime.autoRotoExternalResearchEnabled !== false) {
    throw new Error("Editkin product boundary 拒絕外部或未知 Auto Roto runtime：product-external-runtime-rejected");
  }
  const context = locateProductManifest();
  if (runtime.ffmpeg !== undefined) attestProductExecutable(context, "ffmpeg", runtime.ffmpeg);
  if (runtime.nativeCore !== undefined) attestProductExecutable(context, "nativeCore", runtime.nativeCore);
}
