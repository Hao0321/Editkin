import { createHash } from "node:crypto";
import { AUTO_ROTO_NATIVE_ENGINE, AUTO_ROTO_ONNX_ENGINE, AUTO_ROTO_SAM21_ENGINE, type AutoRotoEngine, type AutoRotoRouteMode } from "./autoRotoModelRouter";

export const AUTO_ROTO_PRODUCT_BOUNDARY_POLICY = "editkin.auto-roto-product-boundary/2" as const;

export interface AutoRotoRuntimeBoundaryInput {
  autoRotoDistributionMode?: "product" | "debug-research";
  autoRotoExternalResearchEnabled?: boolean;
  autoRotoModelRoot?: string;
  autoRotoModelManifest?: string;
  autoRotoVideoModelRoot?: string;
  autoRotoVideoModelManifest?: string;
  autoRotoVideoHost?: string;
  autoRotoAllowResearchCandidate?: boolean;
  autoRotoRouteMode?: AutoRotoRouteMode;
  autoRotoRequestedEngine?: AutoRotoEngine;
}

export interface AutoRotoProductBoundaryReceipt {
  schema: "editkin.auto-roto-product-boundary-receipt/v2";
  policy: typeof AUTO_ROTO_PRODUCT_BOUNDARY_POLICY;
  distributionMode: "product" | "debug-research";
  externalRuntimeRequested: boolean;
  status: "allowed" | "rejected";
  reasonCode: "product-native-self-authored" | "explicit-debug-research" | "product-external-runtime-rejected" | "unknown-runtime-field-rejected" | "invalid-runtime-field-rejected";
  rejectedRuntimeFields: string[];
  receiptSha256: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function seal(value: Omit<AutoRotoProductBoundaryReceipt, "receiptSha256">): AutoRotoProductBoundaryReceipt {
  return { ...value, receiptSha256: sha256(JSON.stringify(value)) };
}

// The service passes its complete product runtime object through this boundary.
// These neutral host paths are known fields, but they do not grant permission
// to select an external Auto Roto engine or model pack. Their executable
// identity is attested separately by the product service artifact boundary.
const AUTO_ROTO_RUNTIME_BOUNDARY_KEYS = new Set<string>([
  "autoRotoDistributionMode",
  "autoRotoExternalResearchEnabled",
  "autoRotoModelRoot",
  "autoRotoModelManifest",
  "autoRotoVideoModelRoot",
  "autoRotoVideoModelManifest",
  "autoRotoVideoHost",
  "autoRotoAllowResearchCandidate",
  "autoRotoRouteMode",
  "autoRotoRequestedEngine",
  "ffmpeg",
  "ffprobe",
  "whisperCli",
  "nativeCore",
  "gpuCompositor",
  "assetBase",
  "cacheRoot",
  "modelRoot",
  "creativePackRoot",
  "personalMusicRoot",
  "personalVisualRoot",
  "fontRoot",
  "colorRoot",
  "pluginRoot",
  "pluginRoots",
]);

function invalidRuntimeFields(runtime: AutoRotoRuntimeBoundaryInput): string[] {
  const invalid: string[] = [];
  if (runtime.autoRotoDistributionMode !== undefined
    && runtime.autoRotoDistributionMode !== "product" && runtime.autoRotoDistributionMode !== "debug-research") invalid.push("autoRotoDistributionMode");
  if (runtime.autoRotoExternalResearchEnabled !== undefined && typeof runtime.autoRotoExternalResearchEnabled !== "boolean") invalid.push("autoRotoExternalResearchEnabled");
  if (runtime.autoRotoAllowResearchCandidate !== undefined && typeof runtime.autoRotoAllowResearchCandidate !== "boolean") invalid.push("autoRotoAllowResearchCandidate");
  if (runtime.autoRotoRouteMode !== undefined
    && runtime.autoRotoRouteMode !== "product" && runtime.autoRotoRouteMode !== "research" && runtime.autoRotoRouteMode !== "debug") invalid.push("autoRotoRouteMode");
  if (runtime.autoRotoRequestedEngine !== undefined
    && runtime.autoRotoRequestedEngine !== AUTO_ROTO_NATIVE_ENGINE
    && runtime.autoRotoRequestedEngine !== AUTO_ROTO_ONNX_ENGINE
    && runtime.autoRotoRequestedEngine !== AUTO_ROTO_SAM21_ENGINE) invalid.push("autoRotoRequestedEngine");
  for (const key of ["autoRotoModelRoot", "autoRotoModelManifest", "autoRotoVideoModelRoot", "autoRotoVideoModelManifest", "autoRotoVideoHost"] as const) {
    const value = runtime[key];
    if (value !== undefined && (typeof value !== "string" || !value.trim())) invalid.push(key);
  }
  return [...new Set(invalid)].sort();
}

export function evaluateAutoRotoProductBoundary(runtime: AutoRotoRuntimeBoundaryInput): AutoRotoProductBoundaryReceipt {
  const unknownFields = Object.keys(runtime).filter((key) => !AUTO_ROTO_RUNTIME_BOUNDARY_KEYS.has(key)).sort();
  if (unknownFields.length) {
    return seal({
      schema: "editkin.auto-roto-product-boundary-receipt/v2",
      policy: AUTO_ROTO_PRODUCT_BOUNDARY_POLICY,
      distributionMode: "product",
      externalRuntimeRequested: true,
      status: "rejected",
      reasonCode: "unknown-runtime-field-rejected",
      rejectedRuntimeFields: unknownFields,
    });
  }
  const invalidFields = invalidRuntimeFields(runtime);
  if (invalidFields.length) {
    return seal({
      schema: "editkin.auto-roto-product-boundary-receipt/v2",
      policy: AUTO_ROTO_PRODUCT_BOUNDARY_POLICY,
      distributionMode: "product",
      externalRuntimeRequested: true,
      status: "rejected",
      reasonCode: "invalid-runtime-field-rejected",
      rejectedRuntimeFields: invalidFields,
    });
  }
  const distributionMode = runtime.autoRotoDistributionMode ?? "product";
  const externalRouteRequested = runtime.autoRotoRouteMode === "research" || runtime.autoRotoRouteMode === "debug"
    || runtime.autoRotoRequestedEngine === AUTO_ROTO_ONNX_ENGINE || runtime.autoRotoRequestedEngine === AUTO_ROTO_SAM21_ENGINE;
  const externalPackConfigured = Boolean(runtime.autoRotoModelRoot) || Boolean(runtime.autoRotoModelManifest)
    || Boolean(runtime.autoRotoVideoModelRoot) || Boolean(runtime.autoRotoVideoModelManifest) || Boolean(runtime.autoRotoVideoHost)
    || runtime.autoRotoAllowResearchCandidate === true;
  const externalRuntimeRequested = externalRouteRequested || externalPackConfigured;
  const explicitDebugResearch = distributionMode === "debug-research" && runtime.autoRotoExternalResearchEnabled === true;
  if (externalRuntimeRequested && !explicitDebugResearch) {
    return seal({
      schema: "editkin.auto-roto-product-boundary-receipt/v2",
      policy: AUTO_ROTO_PRODUCT_BOUNDARY_POLICY,
      distributionMode,
      externalRuntimeRequested,
      status: "rejected",
      reasonCode: "product-external-runtime-rejected",
      rejectedRuntimeFields: [],
    });
  }
  return seal({
    schema: "editkin.auto-roto-product-boundary-receipt/v2",
    policy: AUTO_ROTO_PRODUCT_BOUNDARY_POLICY,
    distributionMode,
    externalRuntimeRequested,
    status: "allowed",
    reasonCode: explicitDebugResearch ? "explicit-debug-research" : "product-native-self-authored",
    rejectedRuntimeFields: [],
  });
}

export function assertAutoRotoProductBoundary(runtime: AutoRotoRuntimeBoundaryInput): AutoRotoProductBoundaryReceipt {
  const receipt = evaluateAutoRotoProductBoundary(runtime);
  if (receipt.status === "rejected") throw new AutoRotoProductBoundaryError(receipt);
  return receipt;
}

export function assertAutoRotoExternalInspectionAllowed(runtime: AutoRotoRuntimeBoundaryInput): AutoRotoProductBoundaryReceipt {
  return assertAutoRotoProductBoundary({
    ...runtime,
    autoRotoRequestedEngine: AUTO_ROTO_SAM21_ENGINE,
    autoRotoRouteMode: "research",
  });
}

export class AutoRotoProductBoundaryError extends Error {
  constructor(public readonly receipt: AutoRotoProductBoundaryReceipt) {
    super(`Editkin product boundary 拒絕外部 Auto Roto runtime：${receipt.reasonCode}`);
    this.name = "AutoRotoProductBoundaryError";
  }
}

export const AUTO_ROTO_PRODUCT_ENGINE = AUTO_ROTO_NATIVE_ENGINE;
