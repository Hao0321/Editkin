import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { canonicalJson } from "../shared/canonicalJson";
import { sourcePreservingFixtureV1 } from "../render/sourcePreservingV1.fixture";
import { renderTimeRemapToolV1, timeRemapRenderInputSchemaV1 } from "./timeRemapRenderToolsV1";
import type { renderTimeRemapSourceProjectV1 } from "../render/timeRemapSourceRenderV1";
function fixture() {
  const project = sourcePreservingFixtureV1(), release = vi.fn(async () => undefined);
  const render = vi.fn(async (...args: Parameters<typeof renderTimeRemapSourceProjectV1>) => {
    await args[2].withPublicationGuard!(async () => undefined);
    return { outputPath: args[1] } as Awaited<ReturnType<typeof renderTimeRemapSourceProjectV1>>;
  });
  const input = { projectPath: "owned.editkin.json", outputPath: "curve.mkv", policy: "diagnostic_lossless_source_clock_rgba8_v1",
    expectedSourceSha256: "a".repeat(64), expectedProjectSha256: createHash("sha256").update(canonicalJson(project)).digest("hex"), maximumOutputBytes: 1048576 };
  return { project, release, render, input, dependencies: { readProject: vi.fn(async () => project), resolveProjectPath: vi.fn(async () => "D:/owned/owned.editkin.json"),
    resolveRenderPath: vi.fn(async () => "D:/owned/curve.mkv"), workspaceRoot: () => "D:/owned", acquireProjectLock: vi.fn(async () => release), render } };
}
describe("source clock exporter saved-project publication lease", () => {
  it("requires bounded explicit policy and both identities; force cannot bypass it", () => {
    const f = fixture();
    for (const value of [{ ...f.input, policy: undefined }, { ...f.input, force: true }, { ...f.input, expectedProjectSha256: "bad" },
      { ...f.input, outputPath: "bad.mp4" }, { ...f.input, maximumOutputBytes: 1023 }, { ...f.input, maximumOutputBytes: Infinity }]) expect(() => timeRemapRenderInputSchemaV1.parse(value)).toThrow();
  });
  it("passes cancellation and cap, releases current project lease without mutating source graph", async () => {
    const f = fixture(), controller = new AbortController(), before = JSON.stringify(f.project);
    const result = await renderTimeRemapToolV1(f.input, controller.signal, f.dependencies);
    expect(f.render.mock.calls[0][2].signal).toBe(controller.signal); expect(f.render.mock.calls[0][2].maximumOutputBytes).toBe(1048576);
    expect(f.release).toHaveBeenCalledOnce(); expect(result.mutationPerformed).toBe(false); expect(JSON.stringify(f.project)).toBe(before);
  });
  it("initial stale project refuses before renderer; cancellation refuses before any reads", async () => {
    const f = fixture(); await expect(renderTimeRemapToolV1({ ...f.input, expectedProjectSha256: "0".repeat(64) }, undefined, f.dependencies)).rejects.toThrow("PROJECT_BINDING_CHANGED");
    expect(f.render).not.toHaveBeenCalled();
    const aborted = fixture(), controller = new AbortController(); controller.abort(Error("CONTROL_CANCEL"));
    await expect(renderTimeRemapToolV1(aborted.input, controller.signal, aborted.dependencies)).rejects.toThrow("CONTROL_CANCEL"); expect(aborted.dependencies.readProject).not.toHaveBeenCalled();
  });
  it("late persisted change rejects before publication and releases the lease", async () => {
    const f = fixture(); f.dependencies.readProject.mockResolvedValueOnce(f.project).mockResolvedValueOnce({ ...f.project, revision: 7 });
    await expect(renderTimeRemapToolV1(f.input, undefined, f.dependencies)).rejects.toThrow("SAVED_PROJECT_CHANGED"); expect(f.release).toHaveBeenCalledOnce();
  });
  it("releases the lease when publication fails", async () => {
    const f = fixture(); f.render.mockImplementationOnce(async (...args) => {
      await args[2].withPublicationGuard!(async () => { throw Error("PUBLICATION_REFUSED"); }); throw Error("UNREACHABLE");
    });
    await expect(renderTimeRemapToolV1(f.input, undefined, f.dependencies)).rejects.toThrow("PUBLICATION_REFUSED"); expect(f.release).toHaveBeenCalledOnce();
  });
});
