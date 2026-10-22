import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/server";
import { resolve } from "node:path";
import { exportLongformSidecarBundleInputV1, prepareLongformSidecarBundleInputV1, registerLongformSidecarBundleToolsV1, LONGFORM_SIDECAR_RESPONSE_BYTES_V1 } from "./longformSidecarBundleToolsV1";
import type { prepareLongformSidecarExportV1, exportLongformSidecarBundleV1 } from "../application/longformSidecarExportV1";
function fixture() {
  const handlers = new Map<string, (input: unknown) => Promise<any>>(), configs = new Map<string, any>();
  const server = { registerTool: (name: string, config: unknown, handler: (input: unknown) => Promise<any>) => { handlers.set(name, handler); configs.set(name, config); } } as unknown as McpServer;
  const prepare = vi.fn<typeof prepareLongformSidecarExportV1>(async () => ({ status: "PREPARED", filesystemModified: false } as Awaited<ReturnType<typeof prepareLongformSidecarExportV1>>));
  const exportFiles = vi.fn<typeof exportLongformSidecarBundleV1>(async () => ({ status: "COMPLETE", completePairVerified: true } as Awaited<ReturnType<typeof exportLongformSidecarBundleV1>>));
  registerLongformSidecarBundleToolsV1(server, { EDITKIN_WORKSPACE: "D:/owned-srt" }, { prepare, export: exportFiles });
  const request = { projectPath: "project.editkin.json", expectedProjectRevision: 2, chapterMarkerIds: ["chapter"] };
  const writeRequest = { ...request, expectedProjectSha256: "a".repeat(64), expectedProjectFileSha256: "b".repeat(64), expectedBundleSha256: "c".repeat(64), outputDirectory: "new-pair" };
  return { handlers, configs, prepare, exportFiles, request, writeRequest };
}
describe("bounded longform companion export MCP", () => {
  it("marks preview as read-only and explicit new-directory export as a write with no publish or destructive hint", () => {
    const f = fixture(); expect([...f.handlers.keys()]).toEqual(["prepare_longform_sidecar_bundle", "export_longform_sidecar_bundle"]);
    expect(f.configs.get("prepare_longform_sidecar_bundle").annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(f.configs.get("export_longform_sidecar_bundle").annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
  });
  it("requires bounded explicit chapter selection and full prepared binding and rejects undeclared writer/apply options", async () => {
    const f = fixture();
    for (const input of [{ ...f.request, apply: true }, { ...f.request, chapterMarkerIds: [] }, { ...f.request, chapterMarkerIds: Array(201).fill("x") },
      { ...f.request, captionMode: "vtt" }, { ...f.request, expectedProjectRevision: -1 }]) {
      expect(prepareLongformSidecarBundleInputV1.safeParse(input).success).toBe(false);
      expect((await f.handlers.get("prepare_longform_sidecar_bundle")!(input)).isError).toBe(true);
    }
    for (const input of [f.request, { ...f.writeRequest, text: "injected" }, { ...f.writeRequest, overwrite: true }, { ...f.writeRequest, expectedBundleSha256: "bad" }]) {
      expect(exportLongformSidecarBundleInputV1.safeParse(input).success).toBe(false);
      expect((await f.handlers.get("export_longform_sidecar_bundle")!(input)).isError).toBe(true);
    }
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.exportFiles).not.toHaveBeenCalled();
  });
  it("passes the selected runtime workspace and default original mode and never exports during preview", async () => {
    const f = fixture(), response = await f.handlers.get("prepare_longform_sidecar_bundle")!(f.request);
    expect(response.isError).not.toBe(true);
    expect(f.prepare).toHaveBeenCalledWith({ workspaceRoot: resolve("D:/owned-srt") }, { ...f.request, captionMode: "original" });
    expect(f.exportFiles).not.toHaveBeenCalled();
    expect((await f.handlers.get("export_longform_sidecar_bundle")!(f.writeRequest)).isError).not.toBe(true);
    expect(f.exportFiles).toHaveBeenCalledWith({ workspaceRoot: resolve("D:/owned-srt") }, { ...f.writeRequest, captionMode: "original" });
  });
  it("refuses oversized transport replies and bounds large errors rather than exposing an unbounded payload", async () => {
    const f = fixture();
    f.prepare.mockResolvedValueOnce({ extra: "x".repeat(300000) } as any);
    const oversized = await f.handlers.get("prepare_longform_sidecar_bundle")!(f.request);
    expect(oversized.isError).toBe(true); expect(oversized.content[0].text).toContain("RESPONSE_BUDGET");
    f.exportFiles.mockRejectedValueOnce(Error("界".repeat(2 * 1024 * 1024)));
    const failed = await f.handlers.get("export_longform_sidecar_bundle")!(f.writeRequest);
    expect(failed.isError).toBe(true); expect(Buffer.byteLength(JSON.stringify(failed), "utf8")).toBeLessThan(LONGFORM_SIDECAR_RESPONSE_BYTES_V1);
  });
  it("surfaces stale source and incomplete delivery as refusal without a COMPLETE result", async () => {
    const f = fixture(); f.exportFiles.mockRejectedValueOnce(Error("SIDECAR_INCOMPLETE_OUTPUT: owned/new-pair; SIDECAR_SOURCE_CHANGED_DURING_EXPORT"));
    const result = await f.handlers.get("export_longform_sidecar_bundle")!(f.writeRequest), data = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true); expect(data.status).toBe("BLOCK"); expect(data.error).toContain("INCOMPLETE_OUTPUT");
    expect(data.completePairVerified).toBeUndefined(); expect(data.status).not.toBe("COMPLETE");
  });
});
