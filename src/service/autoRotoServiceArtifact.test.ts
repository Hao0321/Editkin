import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { evaluateAutoRotoProductBoundary } from "../application/autoRotoProductBoundary";
import {
  AUTO_ROTO_SERVICE_ARTIFACT_KIND,
  assertProductServiceAutoRotoRuntime,
  autoRotoServiceArtifactReceipt,
  bindAutoRotoRuntimeToServiceArtifact,
} from "./autoRotoServiceArtifact";

describe("Auto Roto service artifact identity", () => {
  it("fails closed to a product artifact when source is executed directly", () => {
    expect(AUTO_ROTO_SERVICE_ARTIFACT_KIND).toBe("product");
    expect(autoRotoServiceArtifactReceipt()).toEqual({
      schema: "editkin.auto-roto-service-artifact/v1",
      kind: "product",
      externalResearchRuntime: "disabled",
    });
  });

  it("does not trust a request that self-identifies as research", () => {
    expect(() => bindAutoRotoRuntimeToServiceArtifact({
      ffmpeg: "ffmpeg.exe",
      autoRotoDistributionMode: "debug-research",
      autoRotoExternalResearchEnabled: true,
      autoRotoVideoModelRoot: "external-pack",
      autoRotoVideoModelManifest: "external-pack/manifest.json",
      autoRotoVideoHost: "external-pack/host.py",
    })).toThrow(/未允許欄位/);
    const ffmpeg = resolve(process.cwd(), "vendor/ffmpeg/win32-x64/ffmpeg.exe");
    const runtime = bindAutoRotoRuntimeToServiceArtifact({ ffmpeg });
    expect(runtime.ffmpeg).toBe(ffmpeg);
    expect(runtime.autoRotoDistributionMode).toBe("product");
    expect(runtime.autoRotoExternalResearchEnabled).toBe(false);
    expect(evaluateAutoRotoProductBoundary(runtime).status).toBe("allowed");
    expect(() => assertProductServiceAutoRotoRuntime(runtime)).not.toThrow();
  });

  it("drops no aliases because every unknown product runtime key is rejected", () => {
    expect(() => bindAutoRotoRuntimeToServiceArtifact({ ffmpeg: "ffmpeg.exe", modelHostAlias: "external.py" })).toThrow(/modelHostAlias/);
    expect(() => bindAutoRotoRuntimeToServiceArtifact({ pluginRoots: ["ok", 42] })).toThrow(/pluginRoots/);
  });

  it("rejects caller substitution through allowed executable fields before Auto Roto can spawn", () => {
    const runtime = bindAutoRotoRuntimeToServiceArtifact({
      ffmpeg: process.execPath,
      nativeCore: process.execPath,
      cacheRoot: process.cwd(),
    });
    expect(() => assertProductServiceAutoRotoRuntime(runtime)).toThrow(/executable|identity|attestation/i);
  });

  it("allows external fields only in a separately compiled research artifact", () => {
    const runtime = bindAutoRotoRuntimeToServiceArtifact({
      autoRotoExternalResearchEnabled: true,
      autoRotoVideoModelRoot: "external-pack",
      autoRotoVideoModelManifest: "external-pack/manifest.json",
      autoRotoVideoHost: "external-pack/host.py",
    }, "debug-research");
    expect(evaluateAutoRotoProductBoundary(runtime).status).toBe("allowed");
    expect(autoRotoServiceArtifactReceipt("debug-research").externalResearchRuntime).toBe("artifact-isolated");
  });
});
