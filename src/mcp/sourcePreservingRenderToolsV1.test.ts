import { describe, expect, it, vi } from "vitest";
// Media binding has its own per-route tests (renderRouteMediaBinding.test.ts); this fixture's source is not a real file.
vi.mock("./renderMediaBinding", () => ({ bindProjectMediaForRender: async (project: unknown) => project }));
import { renderSourcePreservingToolV1, sourcePreservingRenderInputSchemaV1, registerSourcePreservingRenderToolsV1 } from "./sourcePreservingRenderToolsV1";
import { sourcePreservingFixtureV1 } from "../render/sourcePreservingV1.fixture";
import type { renderSourcePreservingProjectV1 } from "../render/sourcePreservingExportV1";
function fixture() {
  const project = sourcePreservingFixtureV1(), release = vi.fn(async () => undefined);
  const render = vi.fn(async (...args: Parameters<typeof renderSourcePreservingProjectV1>) => {
    await args[2].withPublicationGuard!(async () => undefined); return { outputPath: args[1] } as Awaited<ReturnType<typeof renderSourcePreservingProjectV1>>;
  });
  return { project, release, render, dependencies: { readProject: vi.fn(async () => project), resolveProjectPath: vi.fn(async () => "D:/owned/p.editkin.json"),
    resolveRenderPath: vi.fn(async () => "D:/owned/out.mp4"), workspaceRoot: () => "D:/owned", acquireProjectLock: vi.fn(async () => release), render } };
}
const input = { projectPath: "p.editkin.json", outputPath: "out.mp4", policy: "preserve_original_container" as const, expectedSourceSha256: "a".repeat(64) };
describe("explicit source-preserving source MCP policy and publication guard", () => {
  it("requires deliberate policy/hash and registers a separate export, not changing render_project", () => {
    expect(() => sourcePreservingRenderInputSchemaV1.parse({ ...input, policy: undefined })).toThrow();
    expect(() => sourcePreservingRenderInputSchemaV1.parse({ ...input, expectedSourceSha256: "wrong" })).toThrow();
    expect(() => sourcePreservingRenderInputSchemaV1.parse({ ...input, force: true })).toThrow();
    const tools: { name: string; config: any }[] = []; registerSourcePreservingRenderToolsV1({ registerTool: (name: string, config: unknown) => tools.push({ name, config }) } as never);
    expect(tools.map(t => t.name)).toEqual(["render_source_preserving_project"]); expect(tools[0].config.annotations.destructiveHint).toBe(false);
  });
  it("forwards cancellation/policy and uses project lease for current revision before publication", async () => {
    const f = fixture(), controller = new AbortController(), result = await renderSourcePreservingToolV1(input, controller.signal, f.dependencies);
    expect(f.render.mock.calls[0][2].signal).toBe(controller.signal); expect(f.render.mock.calls[0][2].policy).toBe(input.policy);
    expect(f.dependencies.acquireProjectLock).toHaveBeenCalledWith("D:/owned/p.editkin.json"); expect(f.release).toHaveBeenCalledOnce();
    expect(result.mutationPerformed).toBe(false); expect(result.certificationPerformed).toBe(false);
  });
  it("project change rejects before publication and releases the exact lease; preabort starts nothing", async () => {
    const f = fixture(); f.dependencies.readProject.mockResolvedValueOnce(f.project).mockResolvedValueOnce({ ...f.project, revision: 9 });
    await expect(renderSourcePreservingToolV1(input, undefined, f.dependencies)).rejects.toThrow("PROJECT_CHANGED"); expect(f.release).toHaveBeenCalledOnce();
    const aborted = fixture(), controller = new AbortController(); controller.abort(Error("CONTROL_CANCEL"));
    await expect(renderSourcePreservingToolV1(input, controller.signal, aborted.dependencies)).rejects.toThrow("CONTROL_CANCEL"); expect(aborted.render).not.toHaveBeenCalled();
  });
});
