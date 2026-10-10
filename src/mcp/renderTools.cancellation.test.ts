import { describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => Promise<any>>(), exportVideo: vi.fn(async (_request: any) => ({ outputPath: "movie.mp4" })), readProject: vi.fn(async () => ({ id: "current" })) }));
vi.mock("../application/exportVideo", () => ({ exportVideo: fixture.exportVideo }));
vi.mock("../application/creativeLibrary", () => ({ materializeCreativeAssets: vi.fn(async (project: any) => project) }));
vi.mock("../domain/editGraph", async importOriginal => ({ ...await importOriginal<typeof import("../domain/editGraph")>(), summarizeProject: () => ({}) }));
vi.mock("./storage", () => ({ readProject: fixture.readProject, resolveProjectPath: async () => "current.json", resolveRenderPath: async () => "movie.mp4", workspaceRoot: () => "owned", readAuthenticatedOriginalMotionReceipt: vi.fn() }));
vi.mock("./toolRuntime", () => ({ creativePackRoot: () => "creative", personalMusicRoot: () => "music", personalVisualRoot: () => "visual", textResult: (value: any) => value, errorResult: (error: Error) => ({ isError: true, reason: error.message }) }));
import { registerRenderTools, renderAutopilotProject } from "./renderTools";

describe("MCP export cancellation entry", () => {
  registerRenderTools({ registerTool: (name: string, _schema: any, handler: (...args: any[]) => Promise<any>) => fixture.handlers.set(name, handler) } as any);
  it("passes the actual request signal through normal render into exportVideo", async () => {
    const controller = new AbortController();
    await fixture.handlers.get("render_project")!({ projectPath: "current.json", outputPath: "movie.mp4", preferGpu: false }, { mcpReq: { signal: controller.signal } });
    expect(fixture.exportVideo.mock.calls.at(-1)?.[0].options.signal).toBe(controller.signal);
  });
  it("both MCP handlers refuse pre-cancelled work before project reads", async () => {
    const controller = new AbortController(); controller.abort(new Error("stop before admission"));
    fixture.readProject.mockClear(); fixture.exportVideo.mockClear();
    for (const name of ["render_project", "render_original_motion_project"]) {
      const result = await fixture.handlers.get(name)!({ projectPath: "current.json", outputPath: "movie.mp4", preferGpu: true }, { mcpReq: { signal: controller.signal } });
      expect(result).toEqual({ isError: true, reason: "stop before admission" });
    }
    expect(fixture.readProject).not.toHaveBeenCalled(); expect(fixture.exportVideo).not.toHaveBeenCalled();
  });
  it("does not return GREEN if export completes after its request was cancelled", async () => {
    const controller = new AbortController(); const reason = new Error("cancel during export");
    fixture.exportVideo.mockImplementationOnce(async () => { controller.abort(reason); return { outputPath: "movie.mp4" }; });
    await expect(renderAutopilotProject("current.json", "movie.mp4", true, undefined, controller.signal)).rejects.toBe(reason);
  });
});
