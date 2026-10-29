import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { canonicalJson } from "../shared/canonicalJson";
import { NATIVE_FLOATING_MATERIAL_CONTRACT, NATIVE_VIDEO_TARGET_ADMISSION,
  nativeFloatRuntimeMatches, assertNativeVideoTargetIdentity } from "./nativeFloatingVideoFrameReceipt";
import { assertBoundNativeVideoTargetIdentity, assertNativeVideoWorkerRuntime } from "./nativeVideoRuntimeReceipt";

const ready = { event: "ready", engine: "editkin-wgpu-resident-engine/v1", generation: 1,
  backend: "Vulkan", adapter: "NVIDIA GeForce RTX 2060", deviceType: "DiscreteGpu",
  videoInteropProtocol: "media-foundation-d3d11-d3d12-wgpu/v1",
  nativeFloatingVideoFrameContract: NATIVE_FLOATING_MATERIAL_CONTRACT, videoTargetAdmission: NATIVE_VIDEO_TARGET_ADMISSION };
const identity = { schema: "editkin.actual-video-target-identity/v1", generation: 1,
  executableSha256: "a".repeat(64), executableBytes: 100,
  backend: "Dx12", adapter: "actual-video-adapter-control", deviceType: "DiscreteGpu",
  target: { renderTargetContract: "editkin.resident-offscreen-render-target/v1", offscreen: true,
    width: 960, height: 540, nativeWindow: false, nativeSwapChain: false } };
const metadata = { schema: "editkin.native-video-runtime-metadata/v1", platform: "win32", executableSha256: identity.executableSha256,
  executableBytes: identity.executableBytes, videoInteropProtocol: "media-foundation-d3d11-d3d12-wgpu/v1", nativeFloatingVideoFrameContract: NATIVE_FLOATING_MATERIAL_CONTRACT,
  offscreenVideoProtocol: "editkin.resident-offscreen-video-target/v1", displayPaintSchema: "editkin.native-motion-paint-track/v2",
  videoTargetAdmission: NATIVE_VIDEO_TARGET_ADMISSION, actualTargetMeasured: false, noNativeWindowCreated: true } as const;
const selected = { schema: "editkin.selected-native-video-runtime/v1", executablePathSha256: "b".repeat(64),
  executableSha256: identity.executableSha256, executableBytes: identity.executableBytes, metadata,
  metadataSha256: createHash("sha256").update(canonicalJson(metadata)).digest("hex"), verification: "selected_binary_metadata_only" } as const;

describe("actual video factory handoff, separate from generic adapter (unsigned controls)", () => {
  it("admits the declared current factory with real-world generic Vulkan while requiring the measured Dx12 output target", () => {
    expect(nativeFloatRuntimeMatches(ready)).toBe(true);
    expect(assertNativeVideoTargetIdentity(identity, 1, true, { width: 960, height: 540 })).toEqual(identity);
  });
  it.each(["factory", "contract", "missing", "generation"])("refuses the declared %s drift before target selection", defect => {
    const altered = structuredClone(ready) as Record<string, any>;
    if (defect === "factory") altered.videoTargetAdmission.factory = "generic_adapter";
    if (defect === "contract") altered.nativeFloatingVideoFrameContract = "old";
    if (defect === "missing") delete altered.videoTargetAdmission;
    if (defect === "generation") altered.generation = 0;
    expect(nativeFloatRuntimeMatches(altered)).toBe(false);
  });
  it.each(["backend", "generation", "window", "swapchain", "dimensions", "extra", "unbound"])("refuses actual %s even if generic ready claimed Dx12", defect => {
    expect(nativeFloatRuntimeMatches({ ...ready, backend: "Dx12" })).toBe(true);
    const altered = structuredClone(identity) as Record<string, any>;
    if (defect === "backend") altered.backend = "Vulkan";
    if (defect === "generation") altered.generation = 2;
    if (defect === "window") altered.target.nativeWindow = true;
    if (defect === "swapchain") altered.target.nativeSwapChain = true;
    if (defect === "dimensions") altered.target.width = 640;
    if (defect === "extra") altered.derivedFromGenericAdapter = true;
    if (defect === "unbound") altered.target = null;
    expect(() => assertNativeVideoTargetIdentity(altered, 1, true, { width: 960, height: 540 })).toThrow();
  });
  it("permits a measured Dx12 decoder load before desktop surface binding while formal output still requires its target", () => {
    const load = { ...identity, target: null };
    expect(() => assertNativeVideoTargetIdentity(load, 1)).not.toThrow();
    expect(() => assertNativeVideoTargetIdentity(load, 1, true)).toThrow();
  });
  it("pins serving worker metadata and actual target to the selected executable bytes", () => {
    expect(() => assertNativeVideoWorkerRuntime({ ...ready, nativeRuntimeMetadata: metadata }, selected)).not.toThrow();
    expect(() => assertBoundNativeVideoTargetIdentity(identity, 1, true, { width: 960, height: 540 }, selected)).not.toThrow();
  });
  it("rejects serving worker metadata from another executable despite current capabilities", () => {
    expect(() => assertNativeVideoWorkerRuntime({ ...ready, nativeRuntimeMetadata: { ...metadata, executableSha256: "c".repeat(64) } }, selected)).toThrow();
  });
  it.each(["executableSha256", "executableBytes"])("rejects actual target %s drift", field => {
    const altered = { ...identity, [field]: field === "executableSha256" ? "c".repeat(64) : 101 };
    expect(() => assertBoundNativeVideoTargetIdentity(altered, 1, true, { width: 960, height: 540 }, selected)).toThrow();
  });
});
