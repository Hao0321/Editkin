import { afterEach, expect, it, vi } from "vitest";
import { resolve } from "node:path";

const mocks = vi.hoisted(() => ({ exportVideo: vi.fn(async (request: unknown) => ({ request })) }));
vi.mock("../application/exportVideo", () => ({ exportVideo: mocks.exportVideo }));
vi.mock("../application/creativeLibrary", () => ({ materializeCreativeAssets: vi.fn(async (project) => project) }));
vi.mock("../domain/editGraph", () => ({ summarizeProject: vi.fn(() => ({})) }));
vi.mock("./storage", () => ({ readProject: vi.fn(async () => ({})), resolveRenderPath: vi.fn(async () => "D:/test/preview.mp4"), workspaceRoot: () => "D:/test" }));
vi.mock("./toolRuntime", () => ({ creativePackRoot: () => "", personalMusicRoot: () => "", personalVisualRoot: () => "", textResult: (value: unknown) => value, errorResult: (error: unknown) => { throw error; } }));
import { registerRenderTools } from "./renderTools";

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
async function render() {
  let handler: (input: unknown) => Promise<unknown>;
  registerRenderTools({ registerTool: (_name: string, _config: unknown, run: typeof handler) => { handler = run; } } as never);
  await handler!({ projectPath: "sample.json", outputPath: "preview.mp4", preferGpu: false });
  return (mocks.exportVideo.mock.calls[0][0] as { options: { fontRoot: string; gpuCompositorPath?: string } }).options;
}
it("passes the installed runtime font pack into the real render boundary", async () => {
  vi.stubEnv("EDITKIN_FONT_ROOT", "D:/installed/fonts");
  expect((await render()).fontRoot).toBe("D:/installed/fonts");
});
it("source MCP defaults to the bundled font pack, not machine-installed substitute fonts", async () => {
  vi.stubEnv("EDITKIN_FONT_ROOT", undefined);
  expect((await render()).fontRoot).toBe(resolve(import.meta.dirname, "../../public/fonts"));
});
it("passes the launcher's pinned GPU runtime to the normal render boundary", async () => {
  vi.stubEnv("EDITKIN_GPU_COMPOSITOR_PATH", "D:/generation/runtime/editkin-gpu-compositor.exe");
  expect((await render()).gpuCompositorPath).toBe("D:/generation/runtime/editkin-gpu-compositor.exe");
});
it("does not silently substitute an unpinned GPU executable when the launcher has none", async () => {
  vi.stubEnv("EDITKIN_GPU_COMPOSITOR_PATH", undefined);
  expect((await render()).gpuCompositorPath).toBeUndefined();
});
