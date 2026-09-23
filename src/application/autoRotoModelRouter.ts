import { createHash } from "node:crypto";
import {
  PRODUCT_AUTO_ROTO_MAX_ALPHA_BYTES,
  PRODUCT_AUTO_ROTO_MAX_DURATION_SECONDS,
  PRODUCT_AUTO_ROTO_MAX_FRAMES,
  PRODUCT_AUTO_ROTO_MAX_RGB_BYTES,
} from "../domain/autoRotoProductReceipt";

export const AUTO_ROTO_NATIVE_ENGINE = "editkin-native-color-temporal-roto/v1" as const;
export const AUTO_ROTO_ONNX_ENGINE = "editkin-native-onnx-assisted-roto/v1" as const;
export const AUTO_ROTO_SAM21_ENGINE = "editkin-sam21-video-memory-roto/v1" as const;
export const AUTO_ROTO_MODEL_REGISTRY_SCHEMA = "editkin.auto-roto-model-registry/v1" as const;
export const AUTO_ROTO_ROUTING_POLICY = "editkin.auto-roto-routing-policy/2" as const;

export type AutoRotoEngine = typeof AUTO_ROTO_NATIVE_ENGINE | typeof AUTO_ROTO_ONNX_ENGINE | typeof AUTO_ROTO_SAM21_ENGINE;
export type AutoRotoRouteMode = "product" | "research" | "debug";

export interface AutoRotoModelRegistryEntry {
  schema: typeof AUTO_ROTO_MODEL_REGISTRY_SCHEMA;
  engine: AutoRotoEngine;
  modelId: string;
  version: "1";
  origin: "editkin-self-authored" | "external-model-pack";
  promptCapabilities: readonly ("initial-rectangle" | "foreground-background-correction-strokes")[];
  platforms: readonly ("win32-x64" | "win32-x64-cuda")[];
  precision: "rgb24-analysis-to-u8-alpha" | "external-manifest-defined" | "float16";
  resourceCeiling: Readonly<{
    state: "product-bounded" | "research-harness-only";
    maxDurationSeconds: number | null;
    maxFrames: number | null;
    maxRgbBytes: number | null;
    maxAlphaBytes: number | null;
  }>;
  licenseClass: "editkin-owned" | "unattested-external-model-and-runtime" | "permissive-model-partial-runtime-attestation";
  productEligibility: "eligible" | "forbidden";
  artifactIsolation: "compiled-product" | "debug-research-only";
}

function registryEntry(
  entry: Omit<AutoRotoModelRegistryEntry, "schema">,
): Readonly<AutoRotoModelRegistryEntry> {
  return Object.freeze({
    schema: AUTO_ROTO_MODEL_REGISTRY_SCHEMA,
    ...entry,
    promptCapabilities: Object.freeze([...entry.promptCapabilities]),
    platforms: Object.freeze([...entry.platforms]),
    resourceCeiling: Object.freeze({ ...entry.resourceCeiling }),
  });
}

/**
 * Closed-world runtime registry. Only the self-authored native cell is product
 * eligible. External entries document isolated comparison harnesses; their
 * presence must never be interpreted as a downloadable or selectable product
 * dependency.
 */
export const AUTO_ROTO_MODEL_REGISTRY = Object.freeze([
  registryEntry({
    engine: AUTO_ROTO_NATIVE_ENGINE,
    modelId: "editkin-native-color-temporal-roto",
    version: "1",
    origin: "editkin-self-authored",
    promptCapabilities: ["initial-rectangle", "foreground-background-correction-strokes"],
    platforms: ["win32-x64"],
    precision: "rgb24-analysis-to-u8-alpha",
    resourceCeiling: {
      state: "product-bounded",
      maxDurationSeconds: PRODUCT_AUTO_ROTO_MAX_DURATION_SECONDS,
      maxFrames: PRODUCT_AUTO_ROTO_MAX_FRAMES,
      maxRgbBytes: PRODUCT_AUTO_ROTO_MAX_RGB_BYTES,
      maxAlphaBytes: PRODUCT_AUTO_ROTO_MAX_ALPHA_BYTES,
    },
    licenseClass: "editkin-owned",
    productEligibility: "eligible",
    artifactIsolation: "compiled-product",
  }),
  registryEntry({
    engine: AUTO_ROTO_ONNX_ENGINE,
    modelId: "editkin-native-onnx-assisted-roto",
    version: "1",
    origin: "external-model-pack",
    promptCapabilities: ["initial-rectangle"],
    platforms: ["win32-x64"],
    precision: "external-manifest-defined",
    resourceCeiling: {
      state: "research-harness-only",
      maxDurationSeconds: null,
      maxFrames: null,
      maxRgbBytes: null,
      maxAlphaBytes: null,
    },
    licenseClass: "unattested-external-model-and-runtime",
    productEligibility: "forbidden",
    artifactIsolation: "debug-research-only",
  }),
  registryEntry({
    engine: AUTO_ROTO_SAM21_ENGINE,
    modelId: "editkin-sam21-video-memory-roto",
    version: "1",
    origin: "external-model-pack",
    promptCapabilities: ["initial-rectangle", "foreground-background-correction-strokes"],
    platforms: ["win32-x64-cuda"],
    precision: "float16",
    resourceCeiling: {
      state: "research-harness-only",
      maxDurationSeconds: null,
      maxFrames: null,
      maxRgbBytes: null,
      maxAlphaBytes: null,
    },
    licenseClass: "permissive-model-partial-runtime-attestation",
    productEligibility: "forbidden",
    artifactIsolation: "debug-research-only",
  }),
] as const);

const AUTO_ROTO_MODEL_REGISTRY_BY_ENGINE = new Map<AutoRotoEngine, Readonly<AutoRotoModelRegistryEntry>>(
  AUTO_ROTO_MODEL_REGISTRY.map((entry) => [entry.engine, entry]),
);

export interface AutoRotoRoutePolicy {
  mode?: AutoRotoRouteMode;
  requestedEngine?: AutoRotoEngine;
}

export interface AutoRotoRouteCandidate {
  engine: AutoRotoEngine;
  configured: boolean;
  origin: "editkin-self-authored" | "external-model-pack";
  rightsClass: "editkin-owned" | "unattested-external-model-and-runtime" | "permissive-model-partial-runtime-attestation";
  qualityTier: "self-authored" | "uninspected" | "production" | "integration_fixture" | "research_candidate";
  registrySchema: typeof AUTO_ROTO_MODEL_REGISTRY_SCHEMA;
  modelId: string;
  version: "1";
  promptCapabilities: readonly ("initial-rectangle" | "foreground-background-correction-strokes")[];
  platforms: readonly ("win32-x64" | "win32-x64-cuda")[];
  precision: AutoRotoModelRegistryEntry["precision"];
  resourceCeiling: AutoRotoModelRegistryEntry["resourceCeiling"];
  licenseClass: AutoRotoModelRegistryEntry["licenseClass"];
  productEligibility: AutoRotoModelRegistryEntry["productEligibility"];
  artifactIsolation: AutoRotoModelRegistryEntry["artifactIsolation"];
  decision: "selected" | "not-selected" | "rejected";
  reasonCode: string;
}

export interface AutoRotoRouteReceipt {
  schema: "editkin.auto-roto-route-receipt/v2";
  policyVersion: typeof AUTO_ROTO_ROUTING_POLICY;
  mode: AutoRotoRouteMode;
  requestedEngine: AutoRotoEngine;
  selectedEngine: AutoRotoEngine | null;
  status: "selected" | "rejected";
  reasonCode: string;
  candidates: AutoRotoRouteCandidate[];
  receiptSha256: string;
}

export interface ResolveAutoRotoRouteInput {
  policy?: unknown;
  onnxConfigured: boolean;
  sam21Configured: boolean;
  onnxQualityTier?: "production" | "integration_fixture";
  sam21QualityTier?: "production" | "research_candidate";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isEngine(value: unknown): value is AutoRotoEngine {
  return value === AUTO_ROTO_NATIVE_ENGINE || value === AUTO_ROTO_ONNX_ENGINE || value === AUTO_ROTO_SAM21_ENGINE;
}

function parsePolicy(value: unknown): { mode: AutoRotoRouteMode; requestedEngine: AutoRotoEngine } | { error: string } {
  if (value === undefined) return { mode: "product", requestedEngine: AUTO_ROTO_NATIVE_ENGINE };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "invalid-policy-shape" };
  const policy = value as Record<string, unknown>;
  const keys = Object.keys(policy);
  if (keys.some((key) => key !== "mode" && key !== "requestedEngine")) return { error: "unknown-policy-field" };
  const mode = policy.mode ?? "product";
  if (mode !== "product" && mode !== "research" && mode !== "debug") return { error: "unknown-route-mode" };
  const requestedEngine = policy.requestedEngine ?? AUTO_ROTO_NATIVE_ENGINE;
  if (!isEngine(requestedEngine)) return { error: "unknown-engine" };
  return { mode, requestedEngine };
}

function candidateFacts(input: ResolveAutoRotoRouteInput): AutoRotoRouteCandidate[] {
  return AUTO_ROTO_MODEL_REGISTRY.map((registry) => {
    const configured = registry.engine === AUTO_ROTO_NATIVE_ENGINE
      || (registry.engine === AUTO_ROTO_ONNX_ENGINE ? input.onnxConfigured : input.sam21Configured);
    const qualityTier = registry.engine === AUTO_ROTO_NATIVE_ENGINE
      ? "self-authored" as const
      : registry.engine === AUTO_ROTO_ONNX_ENGINE
        ? input.onnxQualityTier ?? "uninspected" as const
        : input.sam21QualityTier ?? "uninspected" as const;
    return {
      engine: registry.engine,
      configured,
      origin: registry.origin,
      rightsClass: registry.licenseClass,
      qualityTier,
      registrySchema: registry.schema,
      modelId: registry.modelId,
      version: registry.version,
      promptCapabilities: registry.promptCapabilities,
      platforms: registry.platforms,
      precision: registry.precision,
      resourceCeiling: registry.resourceCeiling,
      licenseClass: registry.licenseClass,
      productEligibility: registry.productEligibility,
      artifactIsolation: registry.artifactIsolation,
      decision: "not-selected" as const,
      reasonCode: registry.productEligibility === "eligible"
        ? "eligible-self-authored-engine"
        : configured ? "external-pack-requires-explicit-non-product-route" : "not-configured",
    };
  });
}

function sealReceipt(value: Omit<AutoRotoRouteReceipt, "receiptSha256">): AutoRotoRouteReceipt {
  return { ...value, receiptSha256: sha256(JSON.stringify(value)) };
}

function rejectedReceipt(input: ResolveAutoRotoRouteInput, mode: AutoRotoRouteMode, requestedEngine: AutoRotoEngine, reasonCode: string): AutoRotoRouteReceipt {
  const candidates = candidateFacts(input).map((candidate) => candidate.engine === requestedEngine
    ? { ...candidate, decision: "rejected" as const, reasonCode }
    : candidate);
  return sealReceipt({
    schema: "editkin.auto-roto-route-receipt/v2",
    policyVersion: AUTO_ROTO_ROUTING_POLICY,
    mode,
    requestedEngine,
    selectedEngine: null,
    status: "rejected",
    reasonCode,
    candidates,
  });
}

/**
 * Closed-world Auto Roto routing. Product policy v1 intentionally admits only
 * the Editkin-authored native engine. External model packs stay useful for
 * explicit research/debug cells, but cannot become product-ready by changing a
 * manifest label or by setting an old `allowResearchCandidate` flag.
 */
export function resolveAutoRotoRoute(input: ResolveAutoRotoRouteInput): AutoRotoRouteReceipt {
  const parsed = parsePolicy(input.policy);
  if ("error" in parsed) return rejectedReceipt(input, "product", AUTO_ROTO_NATIVE_ENGINE, parsed.error);
  const { mode, requestedEngine } = parsed;
  const registry = AUTO_ROTO_MODEL_REGISTRY_BY_ENGINE.get(requestedEngine);
  if (!registry) return rejectedReceipt(input, mode, requestedEngine, "unknown-engine");
  if (mode === "product" && registry.productEligibility !== "eligible") {
    return rejectedReceipt(input, mode, requestedEngine, "product-policy-self-authored-engine-only");
  }
  const configured = requestedEngine === AUTO_ROTO_NATIVE_ENGINE
    || (requestedEngine === AUTO_ROTO_ONNX_ENGINE ? input.onnxConfigured : input.sam21Configured);
  if (!configured) return rejectedReceipt(input, mode, requestedEngine, "requested-engine-not-configured");
  if (requestedEngine === AUTO_ROTO_ONNX_ENGINE && mode === "research" && input.onnxQualityTier === "integration_fixture") {
    return rejectedReceipt(input, mode, requestedEngine, "integration-fixture-requires-debug-mode");
  }
  const candidates = candidateFacts(input).map((candidate) => candidate.engine === requestedEngine
    ? { ...candidate, decision: "selected" as const, reasonCode: requestedEngine === AUTO_ROTO_NATIVE_ENGINE ? "selected-self-authored-default" : `selected-explicit-${mode}-route` }
    : candidate);
  return sealReceipt({
    schema: "editkin.auto-roto-route-receipt/v2",
    policyVersion: AUTO_ROTO_ROUTING_POLICY,
    mode,
    requestedEngine,
    selectedEngine: requestedEngine,
    status: "selected",
    reasonCode: requestedEngine === AUTO_ROTO_NATIVE_ENGINE ? "selected-self-authored-default" : `selected-explicit-${mode}-route`,
    candidates,
  });
}

export function routeAutoRotoNativeFallback(receipt: AutoRotoRouteReceipt): AutoRotoRouteReceipt {
  if (receipt.status !== "selected" || receipt.selectedEngine !== AUTO_ROTO_SAM21_ENGINE) {
    throw new Error("Auto Roto native fallback 只能從已選取的 SAM 2.1 route 建立");
  }
  const candidates = receipt.candidates.map((candidate) => {
    if (candidate.engine === AUTO_ROTO_NATIVE_ENGINE) return { ...candidate, decision: "selected" as const, reasonCode: "selected-runtime-unavailable-fallback" };
    if (candidate.engine === AUTO_ROTO_SAM21_ENGINE) return { ...candidate, decision: "rejected" as const, reasonCode: "requested-runtime-unavailable" };
    return candidate;
  });
  return sealReceipt({
    schema: receipt.schema,
    policyVersion: receipt.policyVersion,
    mode: receipt.mode,
    requestedEngine: receipt.requestedEngine,
    selectedEngine: AUTO_ROTO_NATIVE_ENGINE,
    status: "selected",
    reasonCode: "requested-runtime-unavailable-native-fallback",
    candidates,
  });
}

export function rejectAutoRotoRoute(receipt: AutoRotoRouteReceipt, reasonCode: string): AutoRotoRouteReceipt {
  const candidates = receipt.candidates.map((candidate) => candidate.engine === receipt.selectedEngine
    ? { ...candidate, decision: "rejected" as const, reasonCode }
    : candidate);
  return sealReceipt({
    schema: receipt.schema,
    policyVersion: receipt.policyVersion,
    mode: receipt.mode,
    requestedEngine: receipt.requestedEngine,
    selectedEngine: null,
    status: "rejected",
    reasonCode,
    candidates,
  });
}

export class AutoRotoRouteError extends Error {
  readonly routeReceipt: AutoRotoRouteReceipt;

  constructor(receipt: AutoRotoRouteReceipt, message?: string, options?: ErrorOptions) {
    super(message ?? `Auto Roto route 已拒絕：${receipt.reasonCode}`, options);
    this.name = "AutoRotoRouteError";
    this.routeReceipt = receipt;
  }
}

export function requireAutoRotoRoute(receipt: AutoRotoRouteReceipt): AutoRotoRouteReceipt & { status: "selected"; selectedEngine: AutoRotoEngine } {
  if (receipt.status !== "selected" || !receipt.selectedEngine) throw new AutoRotoRouteError(receipt);
  return receipt as AutoRotoRouteReceipt & { status: "selected"; selectedEngine: AutoRotoEngine };
}
