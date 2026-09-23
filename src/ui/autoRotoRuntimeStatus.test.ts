import { describe, expect, it, vi } from "vitest";
import {
  PRODUCT_AUTO_ROTO_ENGINE,
  PRODUCT_AUTO_ROTO_ROUTE_POLICY,
  PRODUCT_AUTO_ROTO_ROUTE_RECEIPT_SHA256,
  PRODUCT_AUTO_ROTO_ROUTE_SCHEMA,
} from "../domain/autoRotoProductReceipt";
import { autoRotoRuntimeStatusFromReceipt, initialAutoRotoRuntimeStatus } from "./autoRotoRuntimeStatus";

function routeReceipt() {
  return {
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
    receiptSha256: PRODUCT_AUTO_ROTO_ROUTE_RECEIPT_SHA256,
  };
}

function validReceipt() {
  return {
    schema: "editkin.auto-roto-matte/v1",
    engine: PRODUCT_AUTO_ROTO_ENGINE,
    width: 16,
    height: 16,
    frozen: true,
    qualityState: "diagnostic",
    sequenceSha256: "a".repeat(64),
    sequenceBytes: 256,
    manifestPath: "C:/Editkin/cache/matte-manifest.json",
    routeReceipt: routeReceipt(),
    regionMemoryRouting: {
      schema: "editkin.region-memory-routing/v1",
      requested: "fixed_baseline",
      executed: "fixed_baseline",
      candidateAttempted: false,
      deterministicFallback: false,
    },
    alphaRefinement: {
      schema: "editkin.optical-alpha-refinement-aggregate/v1",
      engine: "editkin-self-authored-optical-alpha-refiner/v1",
      appliedFrames: 1,
    },
    frames: [{
      frame: 0,
      alphaPath: "C:/Editkin/cache/frame-000000.png",
      previewSha256: "b".repeat(64),
      alphaFrameSha256: "c".repeat(64),
    }],
  };
}

describe("Auto Roto runtime activation receipt", () => {
  it("keeps API presence in candidate/diagnostic state and absence unavailable", () => {
    expect(initialAutoRotoRuntimeStatus(vi.fn())).toMatchObject({ state: "candidate_diagnostic", canInvoke: true });
    expect(initialAutoRotoRuntimeStatus(undefined)).toMatchObject({ state: "unavailable", canInvoke: false });
  });

  it("activates only from the bounded current execution receipt", () => {
    const status = autoRotoRuntimeStatusFromReceipt(validReceipt());
    expect(status).toMatchObject({
      state: "activated_current",
      canInvoke: true,
      receipt: {
        engine: PRODUCT_AUTO_ROTO_ENGINE,
        routeReceiptSha256: PRODUCT_AUTO_ROTO_ROUTE_RECEIPT_SHA256,
        sequenceSha256: "a".repeat(64),
        sequenceBytes: 256,
        frameCount: 1,
        qualityState: "diagnostic",
      },
    });
  });

  const mutations: Array<[string, (receipt: ReturnType<typeof validReceipt>) => void]> = [
    ["forged route hash", (receipt) => { receipt.routeReceipt.receiptSha256 = "f".repeat(64) as typeof PRODUCT_AUTO_ROTO_ROUTE_RECEIPT_SHA256; }],
    ["quality promotion", (receipt) => { receipt.qualityState = "verified" as "diagnostic"; }],
    ["unfrozen artifact", (receipt) => { receipt.frozen = false; }],
    ["sequence byte drift", (receipt) => { receipt.sequenceBytes += 1; }],
    ["sequence hash drift", (receipt) => { receipt.sequenceSha256 = "UPPERCASE"; }],
    ["candidate route executed", (receipt) => { receipt.regionMemoryRouting.candidateAttempted = true; }],
    ["refinement frame drift", (receipt) => { receipt.alphaRefinement.appliedFrames = 0; }],
    ["preview hash missing", (receipt) => { receipt.frames[0].previewSha256 = ""; }],
  ];

  it.each(mutations)("rejects %s instead of showing activated", (_name, mutate) => {
    const receipt = validReceipt();
    mutate(receipt);
    expect(() => autoRotoRuntimeStatusFromReceipt(receipt)).toThrow(/拒絕標示為目前已執行/);
  });
});
