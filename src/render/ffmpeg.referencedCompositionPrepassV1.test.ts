import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderProject } from "./ffmpeg";
import { addCompositionFixtureV1, referencedCompositionProjectFixtureV1 } from "./referencedCompositionPrepassV1.fixture";
import { estimatePrepassWorkBytes } from "./renderDiskSpace";
import { renderDeadlineForWorkSeconds, renderLifetimeRemainingMs } from "./renderLifetime";
import { RENDER_WORK_ROOT_NAME } from "./renderWorkspace";

// The production renderer, validation, lifetime, work roots and disk checks run with controlled media calls.
const controls = vi.hoisted(() => ({ run: vi.fn(), probe: vi.fn(), encoder: vi.fn(), identity: vi.fn(), statfs: vi.fn(),
  created: [] as string[], realStatfs: undefined as unknown }));
vi.mock("./ffmpegMedia", async original => ({ ...await original<typeof import("./ffmpegMedia")>(),
  runProcess: controls.run, probeMedia: controls.probe }));
vi.mock("./ffmpegComposite", async original => ({ ...await original<typeof import("./ffmpegComposite")>(), chooseEncoder: controls.encoder }));
vi.mock("./nativeCore", async original => ({ ...await original<typeof import("./nativeCore")>(), nativeCoreAvailable: async () => false }));
vi.mock("./renderArtifactIdentity", () => ({ collectRenderArtifactIdentity: controls.identity }));
vi.mock("./renderWorkspace", async original => {
  const actual = await original<typeof import("./renderWorkspace")>();
  return { ...actual, createRenderWorkDirectory: async (prefix: Parameters<typeof actual.createRenderWorkDirectory>[0]) => {
    const created = await actual.createRenderWorkDirectory(prefix); controls.created.push(created); return created;
  } };
});
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  controls.realStatfs = actual.statfs; controls.statfs.mockImplementation(actual.statfs);
  return { ...actual, statfs: controls.statfs };
});

const roots: string[] = [];
let encodes: Array<{ args: string[]; remainingMs: number | undefined }> = [];
beforeEach(() => {
  vi.clearAllMocks(); encodes = []; controls.created.length = 0;
  controls.encoder.mockResolvedValue("libx264");
  controls.identity.mockResolvedValue({ schema: "editkin.render-artifact-identity/v1" });
  controls.probe.mockImplementation(async (path: string) => ({ hasVideo: true, hasAudio: !path.endsWith(".mkv"),
    duration: 1, width: 320, height: 180, encodedWidth: 320, encodedHeight: 180, sampleAspectRatio: 1,
    colorPrimaries: "bt709", colorTransfer: "bt709", colorMatrix: "bt709", colorRange: "tv" }));
  controls.run.mockImplementation(async (_executable: string, args: string[]) => {
    if (args.includes("-filter_complex")) {
      encodes.push({ args: [...args], remainingMs: renderLifetimeRemainingMs() });
      await writeFile(args[args.length - 1], "controlled candidate");
    }
    return { stdout: "ffmpeg version controlled-media", stderr: "" };
  });
});
afterEach(async () => {
  controls.statfs.mockImplementation(controls.realStatfs as never);
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), "editkin-referenced-prepass-"))) {
      throw new Error("Fixture cleanup escaped its own temp root");
    }
    await rm(root, { recursive: true, force: true });
  }
});
async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "editkin-referenced-prepass-")); roots.push(root); return root;
}
const options = { assetBase: resolve(tmpdir()), fontRoot: resolve("public/fonts"), preferGpu: false };

describe("production referenced-composition dispatch (controlled media)", () => {
  it("renders the used dependency before its parent and final output, never probing or encoding unused media", async () => {
    const root = await scratch(), project = referencedCompositionProjectFixtureV1();
    addCompositionFixtureV1(project, "parent", "asset:used");
    project.tracks[0].clips[0].assetId = "asset:parent";
    project.compositions.reverse();
    const snapshot = JSON.stringify(project);
    await renderProject(project, join(root, "final.mp4"), options);
    expect(encodes.map(encode => encode.args.at(-1)!.replaceAll("\\", "/").split("/").at(-1)!
      .replace(/^\./, "").replace(/\.\d+\.rendering\./, ".rendering.")))
      .toEqual(["used.mov.rendering.mov", "parent.mov.rendering.mov", "final.mp4.rendering.mp4"]);
    expect(controls.probe.mock.calls.every(([path]) => !String(path).includes("unused"))).toBe(true);
    expect(controls.run.mock.calls.every(([, args]) => !args.some((argument: string) => argument.includes("unused")))).toBe(true);
    expect(controls.created.filter(path => path.includes("editkin-precomp-"))).toHaveLength(1);
    expect(JSON.stringify(project)).toBe(snapshot);
    expect(await readdir(root)).toEqual(["final.mp4"]);
  });

  it("bypasses the composition workspace entirely when only unused compositions are declared", async () => {
    const root = await scratch(), project = referencedCompositionProjectFixtureV1();
    project.tracks[0].clips[0].assetId = project.assets[0].id;
    await renderProject(project, join(root, "final.mp4"), options);
    expect(encodes).toHaveLength(1);
    expect(controls.created.filter(path => path.includes("editkin-precomp-"))).toEqual([]);
    expect(controls.created.map(path => dirname(path))).toEqual([join(root, RENDER_WORK_ROOT_NAME)]);
    expect(await readdir(root)).toEqual(["final.mp4"]);
  });

  it.each(["cycle", "duration"] as const)("still validates an unused composition's %s before any media call", async fault => {
    const root = await scratch(), project = referencedCompositionProjectFixtureV1();
    const unused = project.compositions.find(composition => composition.id === "unused")!;
    if (fault === "cycle") unused.tracks[0].clips[0].assetId = "asset:unused";
    else unused.tracks[0].clips[0].duration = .5;
    await expect(renderProject(project, join(root, "final.mp4"), options)).rejects.toThrow(fault === "cycle" ? /環狀/ : /時長/);
    expect(controls.run).not.toHaveBeenCalled(); expect(controls.probe).not.toHaveBeenCalled();
    expect(controls.created).toEqual([]); expect(await readdir(root)).toEqual([]);
  });

  it("does not inflate disk requirements or the total deadline with an unused hour of media", async () => {
    const root = await scratch(), project = referencedCompositionProjectFixtureV1({ unusedDuration: 3600 });
    expect(estimatePrepassWorkBytes(project)).toBeGreaterThan(4 * 1024 ** 3);
    controls.statfs.mockImplementation(async () => ({ type: 0n, bsize: 4096n, blocks: 100_000n,
      bfree: 20_480n, bavail: 20_480n, files: 0n, ffree: 0n }));
    await renderProject(project, join(root, "final.mp4"), options);
    expect(encodes).toHaveLength(2);
    const expected = renderDeadlineForWorkSeconds(2);
    expect(encodes[0].remainingMs).toBeGreaterThan(expected - 20_000);
    expect(encodes[0].remainingMs).toBeLessThanOrEqual(expected);
    expect(await readdir(root)).toEqual(["final.mp4"]);
  });
});
