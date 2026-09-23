import { describe, expect, it } from "vitest";
import { AUTO_ROTO_ONNX_ENGINE, AUTO_ROTO_SAM21_ENGINE } from "./autoRotoModelRouter";
import { assertAutoRotoExternalInspectionAllowed, assertAutoRotoProductBoundary, AutoRotoProductBoundaryError, evaluateAutoRotoProductBoundary } from "./autoRotoProductBoundary";

describe("Auto Roto self-authored product boundary", () => {
  it("defaults to the self-authored product runtime", () => {
    const receipt = assertAutoRotoProductBoundary({});
    expect(receipt.status).toBe("allowed");
    expect(receipt.reasonCode).toBe("product-native-self-authored");
    expect(receipt.externalRuntimeRequested).toBe(false);
    expect(receipt.receiptSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    { autoRotoModelRoot: "external" },
    { autoRotoModelManifest: "external/manifest.json" },
    { autoRotoVideoModelRoot: "external-video" },
    { autoRotoVideoModelManifest: "external-video/manifest.json" },
    { autoRotoVideoHost: "external-video/host.py" },
    { autoRotoAllowResearchCandidate: true },
    { autoRotoRouteMode: "research" as const },
    { autoRotoRouteMode: "debug" as const },
    { autoRotoRequestedEngine: AUTO_ROTO_ONNX_ENGINE },
    { autoRotoRequestedEngine: AUTO_ROTO_SAM21_ENGINE },
  ])("rejects external product input before filesystem access: %j", (runtime) => {
    const receipt = evaluateAutoRotoProductBoundary(runtime);
    expect(receipt.status).toBe("rejected");
    expect(receipt.reasonCode).toBe("product-external-runtime-rejected");
    expect(() => assertAutoRotoProductBoundary(runtime)).toThrow(AutoRotoProductBoundaryError);
  });

  it.each([
    { pythonPath: "external/python.exe" },
    { weightsPath: "external/model.safetensors" },
    { autoRotoDownloadUrl: "https://example.invalid/model.onnx" },
    { modelHostAlias: "external/host.py" },
  ])("rejects unknown runtime smuggling fields instead of silently ignoring them: %j", (runtime) => {
    const receipt = evaluateAutoRotoProductBoundary(runtime as never);
    expect(receipt.status).toBe("rejected");
    expect(receipt.reasonCode).toBe("unknown-runtime-field-rejected");
    expect(receipt.rejectedRuntimeFields).toEqual(Object.keys(runtime));
    expect(() => assertAutoRotoProductBoundary(runtime as never)).toThrow(AutoRotoProductBoundaryError);
  });

  it("requires both debug-research distribution identity and explicit opt-in", () => {
    const request = { autoRotoRouteMode: "research" as const, autoRotoRequestedEngine: AUTO_ROTO_SAM21_ENGINE };
    expect(evaluateAutoRotoProductBoundary({ ...request, autoRotoExternalResearchEnabled: true }).status).toBe("rejected");
    expect(evaluateAutoRotoProductBoundary({ ...request, autoRotoDistributionMode: "debug-research" }).status).toBe("rejected");
    expect(evaluateAutoRotoProductBoundary({
      ...request,
      autoRotoDistributionMode: "debug-research",
      autoRotoExternalResearchEnabled: true,
    }).reasonCode).toBe("explicit-debug-research");
  });

  it("keeps external pack inspection behind the same isolated research boundary", () => {
    expect(() => assertAutoRotoExternalInspectionAllowed({})).toThrow(AutoRotoProductBoundaryError);
    expect(assertAutoRotoExternalInspectionAllowed({
      autoRotoDistributionMode: "debug-research",
      autoRotoExternalResearchEnabled: true,
    }).status).toBe("allowed");
  });
});
