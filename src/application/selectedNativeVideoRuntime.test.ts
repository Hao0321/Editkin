import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson } from "../shared/canonicalJson";
import { createEmptyProject } from "../domain/editGraph";
import { assertAutopilotPlanSourceCurrent, autopilotPlanSourceFromIdentity, createAcceptedAutopilotAuditReceipt,
  createAutopilotProjectAuditIdentity, liveAutopilotIdentitySchema, sha256Canonical, verifyAcceptedAutopilotAuditReceipt } from "./autopilotInvocationIdentity";
import { assertSelectedNativeVideoRuntimeCurrent, nativeVideoRuntimeMetadataSchema, readSelectedNativeVideoRuntime,
  selectedNativeVideoRuntimeIdentitySchema } from "./selectedNativeVideoRuntime";

// These controls read actual owned fixture bytes, but inject synthetic metadata.
// They exercise identity/issuer boundaries; they do not certify a native target.
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const metadataFor = (buffer: Buffer) => ({
  schema: "editkin.native-video-runtime-metadata/v1", platform: "win32",
  executableSha256: sha(buffer), executableBytes: buffer.length,
  videoInteropProtocol: "media-foundation-d3d11-d3d12-wgpu/v1",
  nativeFloatingVideoFrameContract: "editkin.native-floating-frame-material/v1",
  offscreenVideoProtocol: "editkin.resident-offscreen-video-target/v1", displayPaintSchema: "editkin.native-motion-paint-track/v2",
  videoTargetAdmission: { schema: "editkin.shared-video-target-admission/v1", requiredBackend: "Dx12", factory: "new_dx12_video",
    selection: "deferred-until-target-bind", offscreenProtocol: "editkin.resident-offscreen-video-target/v1" },
  actualTargetMeasured: false, noNativeWindowCreated: true,
});
async function binary() {
  const root = await mkdtemp(join(tmpdir(), "editkin-selected-renderer-control-")); roots.push(root);
  const path = join(root, "owned-nonexecutable-fixture.bin"), buffer = Buffer.from("OWNED SYNTHETIC EXECUTABLE IDENTITY CONTROL");
  await writeFile(path, buffer);
  return { path, buffer, executeMetadata: async () => JSON.stringify(metadataFor(buffer)) };
}
function live(renderer: NonNullable<Awaited<ReturnType<typeof readSelectedNativeVideoRuntime>>>["identity"]) {
  const base = { schema: "editkin.video-autopilot.live-identity/v2", renderer,
    engine: { schema: "editkin.engine-continuity-pin/v1", sha256: "1".repeat(64) },
    skill: { id: "video-autopilot", revision: 1, sha256: "2".repeat(64), hardRuleCount: 1 },
    workflow: { schema: "hao.video-autopilot.workflow-contract/v1", revision: 6, sha256: "3".repeat(64), planSchema: "hao.video-autopilot.edit-plan/v4", legacyPlanPolicy: "reject" },
    knowledge: { schema: "editkin.community-knowledge/v1", revision: 1, packSha256: "4".repeat(64), stableRulesSha256: "5".repeat(64), includedModuleCount: 1, stableRuleCount: 1 },
    plugins: { schema: "editkin.plugin-registry-identity/v1", sha256: "6".repeat(64), pluginCount: 0, diagnosticCount: 0 } };
  return liveAutopilotIdentitySchema.parse({ ...base, bindingSha256: sha256Canonical(base) });
}
describe("selected native renderer actual-byte and metadata identity", () => {
  it("keeps an unconfigured source-only runtime absent and rejects relative or empty selections", async () => {
    vi.stubEnv("EDITKIN_GPU_COMPOSITOR_PATH", undefined);
    await expect(readSelectedNativeVideoRuntime()).resolves.toBeUndefined();
    for (const executablePath of ["", "relative-runtime.exe"]) await expect(readSelectedNativeVideoRuntime({ executablePath })).rejects.toThrow(/absolute/);
  });
  it("reads owned full bytes before/after metadata and binds the selected canonical path", async () => {
    const fixture = await binary();
    const executor = vi.fn(fixture.executeMetadata);
    const selected = await readSelectedNativeVideoRuntime({ executablePath: fixture.path, executeMetadata: executor });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor).toHaveBeenCalledWith(selected!.executablePath);
    expect(selected!.identity).toMatchObject({ executableSha256: sha(fixture.buffer), executableBytes: fixture.buffer.length,
      metadataSha256: sha(canonicalJson(metadataFor(fixture.buffer))), verification: "selected_binary_metadata_only" });
    expect(selected!.identity.metadata.actualTargetMeasured).toBe(false);
    expect(selected!.identity).not.toHaveProperty("executablePath");
  });
  it("rejects metadata self-reported SHA or length that differs from actual bytes", async () => {
    const fixture = await binary();
    for (const replacement of [{ executableSha256: "0".repeat(64) }, { executableBytes: fixture.buffer.length + 1 }]) {
      await expect(readSelectedNativeVideoRuntime({ executablePath: fixture.path,
        executeMetadata: async () => JSON.stringify({ ...metadataFor(fixture.buffer), ...replacement }) })).rejects.toThrow(/drifted/);
    }
  });
  it("rejects same-path binary replacement while metadata is being obtained", async () => {
    const fixture = await binary();
    await expect(readSelectedNativeVideoRuntime({ executablePath: fixture.path, executeMetadata: async () => {
      await writeFile(fixture.path, Buffer.from("DIFFERENT OWNED CONTROL BYTES")); return fixture.executeMetadata();
    } })).rejects.toThrow(/drifted/);
  });
  it("fails closed for unknown metadata, old paint, generic Vulkan or claimed actual target", () => {
    const metadata = metadataFor(Buffer.from("control"));
    for (const value of [{ ...metadata, extra: true }, { ...metadata, displayPaintSchema: "editkin.native-motion-paint-track/v1" },
      { ...metadata, actualTargetMeasured: true }, { ...metadata, noNativeWindowCreated: false },
      { ...metadata, videoTargetAdmission: { ...metadata.videoTargetAdmission, requiredBackend: "Vulkan" } }]) {
      expect(() => nativeVideoRuntimeMetadataSchema.parse(value)).toThrow();
    }
  });
  it("includes renderer identity in the v4 source and same-process signed audit binding", async () => {
    const fixture = await binary(), selected = (await readSelectedNativeVideoRuntime({ executablePath: fixture.path, executeMetadata: fixture.executeMetadata }))!;
    const first = live(selected.identity), changed = live(selectedNativeVideoRuntimeIdentitySchema.parse({ ...selected.identity, executablePathSha256: "9".repeat(64) }));
    expect(() => assertAutopilotPlanSourceCurrent(autopilotPlanSourceFromIdentity(first), changed)).toThrow(/invocationBindingSha256/);
    const project = createAutopilotProjectAuditIdentity(resolve("owned-control.editkin.json"), createEmptyProject("owned control"));
    const inputs = { planSha256: "a".repeat(64), project, invocation: first, materialEvidence: { receipts: [] } };
    const receipt = createAcceptedAutopilotAuditReceipt(inputs);
    expect(() => verifyAcceptedAutopilotAuditReceipt(receipt, inputs)).not.toThrow();
    expect(() => verifyAcceptedAutopilotAuditReceipt(receipt, { ...inputs, invocation: changed })).toThrow(/identity/);
  });
  it("rejects losing the configured selected renderer at the current binding boundary", async () => {
    const fixture = await binary(), selected = (await readSelectedNativeVideoRuntime({ executablePath: fixture.path, executeMetadata: fixture.executeMetadata }))!;
    vi.stubEnv("EDITKIN_GPU_COMPOSITOR_PATH", undefined);
    await expect(assertSelectedNativeVideoRuntimeCurrent(selected.identity)).rejects.toThrow(/drifted/);
    const legacy = live(selected.identity);
    const { renderer: _renderer, ...old } = legacy.schema === "editkin.video-autopilot.live-identity/v2" ? legacy : (() => { throw new Error("Expected v2 control"); })();
    expect(() => liveAutopilotIdentitySchema.parse({ ...old, schema: "editkin.video-autopilot.live-identity/v1" })).not.toThrow();
    expect(() => liveAutopilotIdentitySchema.parse({ ...legacy, schema: "editkin.video-autopilot.live-identity/v1" })).toThrow();
  });
});
