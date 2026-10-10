import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const mocks = vi.hoisted(() => ({ exportVideo: vi.fn(async (request: unknown) => ({ request })),
  runtimeMetadata: vi.fn(async (_path: string, _args: readonly string[], _options?: unknown) => ({ stdout: "", stderr: "" })) }));
// The owned fixture below is not an executable: only its `video-runtime-identity`
// process output is synthetic. Real path, full-byte identity and schema checks run.
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(),
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: mocks.runtimeMetadata }) }));
vi.mock("../application/exportVideo", () => ({ exportVideo: mocks.exportVideo }));
vi.mock("../application/creativeLibrary", () => ({ materializeCreativeAssets: vi.fn(async (project) => project) }));
vi.mock("../domain/editGraph", () => ({ summarizeProject: vi.fn(() => ({})) }));
vi.mock("./storage", () => ({ readProject: vi.fn(async () => ({})), resolveRenderPath: vi.fn(async () => "D:/test/preview.mp4"), workspaceRoot: () => "D:/test" }));
vi.mock("./toolRuntime", () => ({ creativePackRoot: () => "", personalMusicRoot: () => "", personalVisualRoot: () => "", textResult: (value: unknown) => value, errorResult: (error: unknown) => { throw error; } }));
import { registerRenderTools } from "./renderTools";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.clearAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function render() {
  let handler: (input: unknown, context: unknown) => Promise<unknown>;
  registerRenderTools({ registerTool: (name: string, _config: unknown, run: typeof handler) => { if (name === "render_project") handler = run; } } as never);
  await handler!({ projectPath: "sample.json", outputPath: "preview.mp4", preferGpu: false }, { mcpReq: { signal: new AbortController().signal } });
  return (mocks.exportVideo.mock.calls[0][0] as { options: { fontRoot: string; gpuCompositorPath?: string;
    selectedNativeVideoRuntime?: { executableSha256: string; executableBytes: number } } }).options;
}
async function pinnedRuntime() {
  const root = await mkdtemp(join(tmpdir(), "editkin-render-tools-runtime-")); roots.push(root);
  const path = join(root, "owned-nonexecutable-runtime.bin"), buffer = Buffer.from("OWNED SYNTHETIC SELECTED RUNTIME CONTROL");
  await writeFile(path, buffer);
  const executableSha256 = createHash("sha256").update(buffer).digest("hex");
  mocks.runtimeMetadata.mockResolvedValue({ stdout: JSON.stringify({ schema: "editkin.native-video-runtime-metadata/v1", platform: "win32",
    executableSha256, executableBytes: buffer.length, videoInteropProtocol: "media-foundation-d3d11-d3d12-wgpu/v1",
    nativeFloatingVideoFrameContract: "editkin.native-floating-frame-material/v1",
    offscreenVideoProtocol: "editkin.resident-offscreen-video-target/v1", displayPaintSchema: "editkin.native-motion-paint-track/v2",
    videoTargetAdmission: { schema: "editkin.shared-video-target-admission/v1", requiredBackend: "Dx12", factory: "new_dx12_video",
      selection: "deferred-until-target-bind", offscreenProtocol: "editkin.resident-offscreen-video-target/v1" },
    actualTargetMeasured: false, noNativeWindowCreated: true }), stderr: "" });
  return { path, executableSha256, executableBytes: buffer.length };
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
  const runtime = await pinnedRuntime();
  vi.stubEnv("EDITKIN_GPU_COMPOSITOR_PATH", runtime.path);
  const options = await render();
  expect(options.gpuCompositorPath).toBe(await realpath(runtime.path));
  expect(options.selectedNativeVideoRuntime).toMatchObject({ executableSha256: runtime.executableSha256, executableBytes: runtime.executableBytes });
});
it("does not silently substitute an unpinned GPU executable when the launcher has none", async () => {
  vi.stubEnv("EDITKIN_GPU_COMPOSITOR_PATH", undefined);
  expect((await render()).gpuCompositorPath).toBeUndefined();
});
