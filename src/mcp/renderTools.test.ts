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
  return (mocks.exportVideo.mock.calls[0][0] as { options: { fontRoot: string } }).options.fontRoot;
}
it("passes the installed runtime font pack into the real render boundary", async () => {
  vi.stubEnv("EDITKIN_FONT_ROOT", "D:/installed/fonts");
  expect(await render()).toBe("D:/installed/fonts");
});
it("source MCP defaults to the bundled font pack, not machine-installed substitute fonts", async () => {
  vi.stubEnv("EDITKIN_FONT_ROOT", undefined);
  expect(await render()).toBe(resolve(import.meta.dirname, "../../public/fonts"));
});
