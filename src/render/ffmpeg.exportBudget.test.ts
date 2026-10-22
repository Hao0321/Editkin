import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { renderProject } from "./ffmpeg";
import { RENDER_WORK_ROOT_NAME } from "./renderWorkspace";

// Media processes, probing, encoder choice and output identity are controlled; the render lifetime, work-root
// selection and sweep, disk precheck, temporary-output publication and cleanup are the production code.
const controls = vi.hoisted(() => ({ run: vi.fn(), probe: vi.fn(), encoder: vi.fn(), identity: vi.fn(), statfs: vi.fn(), realStatfs: undefined as unknown, created: [] as string[] }));
vi.mock("./ffmpegMedia", async original => ({
  ...await original<typeof import("./ffmpegMedia")>(), runProcess: controls.run, probeMedia: controls.probe,
}));
vi.mock("./ffmpegComposite", async original => ({
  ...await original<typeof import("./ffmpegComposite")>(), chooseEncoder: controls.encoder,
}));
vi.mock("./renderArtifactIdentity", () => ({ collectRenderArtifactIdentity: controls.identity }));
vi.mock("./renderWorkspace", async original => {
  const actual = await original<typeof import("./renderWorkspace")>();
  return { ...actual, createRenderWorkDirectory: async (prefix: Parameters<typeof actual.createRenderWorkDirectory>[0]) => {
    const created = await actual.createRenderWorkDirectory(prefix); controls.created.push(created); return created;
  } };
});
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  controls.realStatfs = actual.statfs;
  controls.statfs.mockImplementation(actual.statfs);
  return { ...actual, statfs: controls.statfs };
});

function fixture() {
  const project = createDemoProject();
  project.width = 320; project.height = 180; project.fps = 30;
  project.captions = []; project.motionGraphics = []; project.motionTracks = [];
  Object.assign(project.assets[0], { uri: "C:/explicit-source-control/budget.mp4", width: 320, height: 180, duration: 2 });
  const clip = project.tracks[0].clips[0];
  Object.assign(clip, { timelineStart: 0, sourceStart: 0, duration: 1 });
  project.tracks[0].clips = [clip];
  return project;
}

const roots: string[] = [];
let encodes: Array<{ args: string[]; timeoutMs: number; watch: unknown; workEntries: string[] }> = [];
beforeEach(() => {
  vi.clearAllMocks();
  encodes = []; controls.created.length = 0;
  controls.encoder.mockResolvedValue("libx264");
  controls.identity.mockResolvedValue({ schema: "editkin.render-artifact-identity/v1" });
  controls.probe.mockResolvedValue({ hasVideo: true, hasAudio: true, duration: 1, width: 320, height: 180,
    encodedWidth: 320, encodedHeight: 180, sampleAspectRatio: 1, colorPrimaries: "bt709", colorTransfer: "bt709", colorMatrix: "bt709", colorRange: "tv" });
  controls.run.mockImplementation(async (_executable: string, args: string[], timeoutMs: number, _capture?: unknown, watch?: unknown) => {
    if (args.includes("-filter_complex")) {
      const output = args[args.length - 1];
      const hidden = join(dirname(output), RENDER_WORK_ROOT_NAME);
      encodes.push({ args: [...args], timeoutMs, watch, workEntries: await readdir(hidden).catch(() => []) });
      await writeFile(output, "candidate");
    }
    return { stdout: "ffmpeg version source-control", stderr: "" };
  });
});
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function scratch() { const root = await mkdtemp(join(tmpdir(), "editkin-export-budget-")); roots.push(root); return root; }
const exists = (path: string) => stat(path).then(() => true, () => false);

describe("export without hidden deadlines, on the output drive, with a disk precheck (mocked media)", () => {
  it("runs the main encode with the scaled budget, FFmpeg progress and work files beside the output", async () => {
    const directory = await scratch();
    const output = join(directory, "film.mp4");
    const result = await renderProject(fixture(), output, { fontRoot: resolve("public/fonts"), preferGpu: false });
    expect(result.outputPath).toBe(output);
    expect(await readFile(output, "utf8")).toBe("candidate");
    expect(encodes).toHaveLength(1);
    const [encode] = encodes;
    expect(encode.timeoutMs).toBeGreaterThan(15 * 60_000);
    expect(encode.args.slice(-4, -1)).toEqual(["-progress", "pipe:1", "-nostats"]);
    expect(encode.watch).toEqual({ ffmpegProgress: true, paths: [encode.args[encode.args.length - 1]] });
    expect(encode.workEntries.some(name => /^editkin-render-[A-Za-z0-9]{6}$/.test(name))).toBe(true);
    expect(controls.created.map(path => dirname(path))).toEqual([join(directory, RENDER_WORK_ROOT_NAME)]);
    expect(await exists(join(directory, RENDER_WORK_ROOT_NAME))).toBe(false);
    expect((await readdir(directory)).sort()).toEqual(["film.mp4"]);
  });

  it("refuses before encoding when the output drive is too small and leaves the previous output untouched", async () => {
    const directory = await scratch();
    const output = join(directory, "film.mp4");
    await writeFile(output, "previous film");
    controls.statfs.mockImplementation(async () => ({ type: 0n, bsize: 4096n, blocks: 1_000n, bfree: 2n, bavail: 2n, files: 0n, ffree: 0n }));
    try {
      await expect(renderProject(fixture(), output, { fontRoot: resolve("public/fonts"), preferGpu: false }))
        .rejects.toThrow(/^磁碟空間不足，已在開始輸出前停止：.+ 只剩 1 MB，這次輸出預估需要 \d+ MB（成片約 \d+ MB、暫存工作檔約 \d+ MB/);
    } finally {
      controls.statfs.mockImplementation(controls.realStatfs as never);
    }
    expect(encodes).toEqual([]);
    expect(await readFile(output, "utf8")).toBe("previous film");
    expect((await readdir(directory)).sort()).toEqual(["film.mp4"]);
  });

  it("sweeps a crashed render's stale work directory beside the output and keeps unrelated folders", async () => {
    const directory = await scratch();
    const hidden = join(directory, RENDER_WORK_ROOT_NAME);
    const stale = join(hidden, "editkin-render-Crash9"), unrelated = join(hidden, "keep-me");
    await mkdir(stale, { recursive: true }); await mkdir(unrelated);
    await writeFile(join(stale, "captions.ass"), "left by a crash");
    const old = new Date(Date.now() - 3 * 24 * 60 * 60_000);
    for (const path of [join(stale, "captions.ass"), stale, unrelated]) await utimes(path, old, old);
    await renderProject(fixture(), join(directory, "film.mp4"), { fontRoot: resolve("public/fonts"), preferGpu: false });
    expect(await exists(stale)).toBe(false);
    expect(await exists(unrelated)).toBe(true);
  });

  it("falls back to the OS temp folder when the hidden work folder name is taken by a file", async () => {
    const directory = await scratch();
    await writeFile(join(directory, RENDER_WORK_ROOT_NAME), "not ours");
    await renderProject(fixture(), join(directory, "film.mp4"), { fontRoot: resolve("public/fonts"), preferGpu: false });
    expect(controls.created.map(path => dirname(path))).toEqual([resolve(tmpdir())]);
    expect(controls.created.every(path => basename(path).startsWith("editkin-render-"))).toBe(true);
    expect(await readFile(join(directory, RENDER_WORK_ROOT_NAME), "utf8")).toBe("not ours");
    for (const path of controls.created) expect(await exists(path)).toBe(false);
  });
});
