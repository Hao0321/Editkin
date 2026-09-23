import { describe, expect, it } from "vitest";
import {
  AUTO_ROTO_MODEL_REGISTRY,
  AUTO_ROTO_MODEL_REGISTRY_SCHEMA,
  AUTO_ROTO_NATIVE_ENGINE,
  AUTO_ROTO_ONNX_ENGINE,
  AUTO_ROTO_SAM21_ENGINE,
  AutoRotoRouteError,
  rejectAutoRotoRoute,
  requireAutoRotoRoute,
  resolveAutoRotoRoute,
  routeAutoRotoNativeFallback,
} from "./autoRotoModelRouter";

const configured = { onnxConfigured: true, sam21Configured: true };

describe("closed-world Auto Roto model router", () => {
  it("publishes a frozen versioned registry with exactly one product-eligible self-authored engine", () => {
    expect(AUTO_ROTO_MODEL_REGISTRY_SCHEMA).toBe("editkin.auto-roto-model-registry/v1");
    expect(Object.isFrozen(AUTO_ROTO_MODEL_REGISTRY)).toBe(true);
    expect(AUTO_ROTO_MODEL_REGISTRY.map((entry) => entry.engine)).toEqual([
      AUTO_ROTO_NATIVE_ENGINE,
      AUTO_ROTO_ONNX_ENGINE,
      AUTO_ROTO_SAM21_ENGINE,
    ]);
    const product = AUTO_ROTO_MODEL_REGISTRY.filter((entry) => entry.productEligibility === "eligible");
    expect(product).toHaveLength(1);
    expect(product[0]).toMatchObject({
      engine: AUTO_ROTO_NATIVE_ENGINE,
      origin: "editkin-self-authored",
      licenseClass: "editkin-owned",
      artifactIsolation: "compiled-product",
      precision: "rgb24-analysis-to-u8-alpha",
    });
    expect(product[0].platforms).toEqual(["win32-x64"]);
    expect(product[0].promptCapabilities).toEqual(["initial-rectangle", "foreground-background-correction-strokes"]);
    expect(product[0].resourceCeiling).toMatchObject({ maxDurationSeconds: 120, maxFrames: 1440 });
    expect(AUTO_ROTO_MODEL_REGISTRY.filter((entry) => entry.origin === "external-model-pack")
      .every((entry) => entry.productEligibility === "forbidden" && entry.artifactIsolation === "debug-research-only"))
      .toBe(true);
  });

  it("defaults product mode to the Editkin-authored native engine", () => {
    const receipt = requireAutoRotoRoute(resolveAutoRotoRoute(configured));
    expect(receipt.mode).toBe("product");
    expect(receipt.requestedEngine).toBe(AUTO_ROTO_NATIVE_ENGINE);
    expect(receipt.selectedEngine).toBe(AUTO_ROTO_NATIVE_ENGINE);
    expect(receipt.candidates.find((candidate) => candidate.engine === AUTO_ROTO_SAM21_ENGINE)).toMatchObject({
      decision: "not-selected",
      productEligibility: "forbidden",
      artifactIsolation: "debug-research-only",
      precision: "float16",
    });
  });

  it.each([
    AUTO_ROTO_ONNX_ENGINE,
    AUTO_ROTO_SAM21_ENGINE,
  ] as const)("rejects explicitly requested external %s packs in product mode", (engine) => {
    const receipt = resolveAutoRotoRoute({ ...configured, policy: { mode: "product", requestedEngine: engine } });
    expect(receipt.status).toBe("rejected");
    expect(receipt.reasonCode).toBe("product-policy-self-authored-engine-only");
    expect(() => requireAutoRotoRoute(receipt)).toThrow(AutoRotoRouteError);
  });

  it("does not let a legacy research-pack boolean select an external engine", () => {
    const receipt = requireAutoRotoRoute(resolveAutoRotoRoute({ ...configured, policy: undefined }));
    expect(receipt.selectedEngine).toBe(AUTO_ROTO_NATIVE_ENGINE);
  });

  it("allows SAM 2.1 only through an explicit research route", () => {
    const receipt = requireAutoRotoRoute(resolveAutoRotoRoute({
      ...configured,
      policy: { mode: "research", requestedEngine: AUTO_ROTO_SAM21_ENGINE },
      sam21QualityTier: "research_candidate",
    }));
    expect(receipt.mode).toBe("research");
    expect(receipt.selectedEngine).toBe(AUTO_ROTO_SAM21_ENGINE);
    expect(receipt.candidates.find((candidate) => candidate.engine === AUTO_ROTO_SAM21_ENGINE)?.rightsClass).toBe("permissive-model-partial-runtime-attestation");
  });

  it("rejects integration fixtures from research mode", () => {
    const receipt = resolveAutoRotoRoute({
      ...configured,
      policy: { mode: "research", requestedEngine: AUTO_ROTO_ONNX_ENGINE },
      onnxQualityTier: "integration_fixture",
    });
    expect(receipt.status).toBe("rejected");
    expect(receipt.reasonCode).toBe("integration-fixture-requires-debug-mode");
  });

  it("allows integration fixtures only through an explicit debug route", () => {
    const receipt = requireAutoRotoRoute(resolveAutoRotoRoute({
      ...configured,
      policy: { mode: "debug", requestedEngine: AUTO_ROTO_ONNX_ENGINE },
      onnxQualityTier: "integration_fixture",
    }));
    expect(receipt.mode).toBe("debug");
    expect(receipt.selectedEngine).toBe(AUTO_ROTO_ONNX_ENGINE);
  });

  it.each([
    { policy: { mode: "production" }, reason: "unknown-route-mode" },
    { policy: { mode: "product", requestedEngine: "corridor-key/v1" }, reason: "unknown-engine" },
    { policy: { mode: "product", allowCommercialLicense: true }, reason: "unknown-policy-field" },
    { policy: "product", reason: "invalid-policy-shape" },
  ])("rejects malformed or open-world policy mutation %#", ({ policy, reason }) => {
    const receipt = resolveAutoRotoRoute({ ...configured, policy });
    expect(receipt.status).toBe("rejected");
    expect(receipt.reasonCode).toBe(reason);
  });

  it("rejects a requested route whose pack is absent", () => {
    const receipt = resolveAutoRotoRoute({
      onnxConfigured: false,
      sam21Configured: false,
      policy: { mode: "research", requestedEngine: AUTO_ROTO_SAM21_ENGINE },
    });
    expect(receipt.reasonCode).toBe("requested-engine-not-configured");
  });

  it("seals identical facts into identical deterministic receipts", () => {
    const left = resolveAutoRotoRoute({ ...configured, policy: { mode: "debug", requestedEngine: AUTO_ROTO_ONNX_ENGINE } });
    const right = resolveAutoRotoRoute({ ...configured, policy: { mode: "debug", requestedEngine: AUTO_ROTO_ONNX_ENGINE } });
    expect(left).toEqual(right);
    expect(left.receiptSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("records runtime fallback without aliasing the requested external route", () => {
    const selected = requireAutoRotoRoute(resolveAutoRotoRoute({
      ...configured,
      policy: { mode: "research", requestedEngine: AUTO_ROTO_SAM21_ENGINE },
      sam21QualityTier: "production",
    }));
    const fallback = routeAutoRotoNativeFallback(selected);
    expect(fallback.requestedEngine).toBe(AUTO_ROTO_SAM21_ENGINE);
    expect(fallback.selectedEngine).toBe(AUTO_ROTO_NATIVE_ENGINE);
    expect(fallback.reasonCode).toBe("requested-runtime-unavailable-native-fallback");
    expect(fallback.mode).toBe("research");
  });

  it("turns binding failures into deterministic rejected receipts", () => {
    const selected = requireAutoRotoRoute(resolveAutoRotoRoute({
      ...configured,
      policy: { mode: "debug", requestedEngine: AUTO_ROTO_ONNX_ENGINE },
    }));
    const rejected = rejectAutoRotoRoute(selected, "candidate-binding-failed");
    expect(rejected.status).toBe("rejected");
    expect(rejected.selectedEngine).toBeNull();
    expect(rejected.reasonCode).toBe("candidate-binding-failed");
  });
});
