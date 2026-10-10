import { McpServer } from "@modelcontextprotocol/server";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { editorCommandSchema } from "../domain/schema";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { parseProject } from "../application/projectFiles";
import type { MediaProbe } from "../render/ffmpegContracts";
import { prepareMediaBootstrapInputSchema, prepareMediaBootstrapReadOnly, registerMediaBootstrapTools,
  type PrepareMediaBootstrapToolDependencies } from "./mediaBootstrapTools";

// These are adapter tests with controlled probe values, not decoded-media tests.
// File containment, regular-file checks and streamed hashes remain production code.
const ownedRoots: string[] = [];
afterEach(async () => { for (const root of ownedRoots.splice(0)) {
  const target = resolve(root);
  if (dirname(target) !== await realpath(tmpdir()) || !basename(target).startsWith("editkin-bootstrap-adapter-")) throw new Error("Refusing cleanup outside this test's owned temporary roots");
  await rm(target, { recursive: true, force: true });
} });

async function fixture() {
  // Real temporary path: macOS tmpdir() sits under the /var symlink and Windows runners report 8.3 short names.
  const root = await mkdtemp(join(await realpath(tmpdir()), "editkin-bootstrap-adapter-"));
  ownedRoots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const path = join(workspace, "controlled-source.mp4");
  const bytes = Buffer.from("owned neutral byte fixture; no actual media decoding is claimed\n");
  await writeFile(path, bytes);
  const project = parseProject(createEmptyProject("Source bootstrap adapter", { id: "bootstrap-project", width: 640, height: 360, fps: 30 }));
  project.revision = 17;
  const probe: MediaProbe = { duration: 8, width: 640, height: 360, encodedWidth: 640, encodedHeight: 360,
    displayAspectRatio: 16 / 9, hasVideo: true, hasAudio: true };
  const inspect = vi.fn(async (_path: string, _ffprobePath?: string): Promise<MediaProbe> => probe);
  const readProject = vi.fn(async (_path: string) => project);
  const dependencies: PrepareMediaBootstrapToolDependencies = {
    readProject, resolveWorkspaceMediaPath: async input => resolve(workspace, input), workspaceRoot: () => workspace,
    ffprobePath: "controlled-ffprobe", prepareDependencies: { inspect },
  };
  const input = { projectPath: "current.editkin.json", sourcePath: "controlled-source.mp4", assetId: "source", clipId: "inserted",
    trackId: "video-main", timelineStartFrame: 15, sourceStartFrame: 30, durationFrames: 60,
    rights: { provenance: "Owned synthetic byte fixture", rightsBasis: "caller assertion only", distributionScope: "private" } };
  return { root, workspace, path, bytes, project, probe, inspect, readProject, dependencies, input };
}

describe("prepare_media_bootstrap read-only MCP adapter", () => {
  it("binds the actual source and current project, with complete neutral commands and no file/project mutation", async () => {
    const f = await fixture(), beforeProject = structuredClone(f.project), beforeEntries = await readdir(f.workspace);
    expect(prepareMediaBootstrapInputSchema.parse(f.input).sourceColorInterpretation).toBe("auto");
    const result = await prepareMediaBootstrapReadOnly(f.input, f.dependencies);
    expect(result).toMatchObject({ status: "PREPARED_NOT_APPLIED", readOnly: true, mutationPerformed: false, bootstrapOnly: true,
      projectPath: "current.editkin.json", binding: { project: { id: "bootstrap-project", revision: 17 },
        source: { bytes: f.bytes.length, sha256: createHash("sha256").update(f.bytes).digest("hex") } },
      rights: { state: "CALLER_DECLARED_NOT_VERIFIED", declaration: f.input.rights } });
    expect(f.inspect).toHaveBeenCalledWith(f.path, "controlled-ffprobe");
    expect(f.readProject.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(f.readProject.mock.calls.every(([path]) => path === f.input.projectPath)).toBe(true);
    expect(result.commands.every(command => editorCommandSchema.safeParse(command).success)).toBe(true);
    const imported = result.commands.find(command => command.type === "import_asset");
    const inserted = result.commands.find(command => command.type === "add_clip");
    if (imported?.type !== "import_asset" || inserted?.type !== "add_clip") throw new Error("Producer omitted its actual import/clip commands");
    expect(imported.asset).toMatchObject({ id: "source", uri: f.path, duration: 8, displayAspectRatio: 16 / 9 });
    expect(imported.asset.derivatives).toMatchObject({ sourceSha256: result.binding.source.sha256 });
    expect(imported.asset.derivatives?.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(inserted.clip).toMatchObject({ id: "inserted", assetId: "source", trackId: "video-main", timelineStart: .5,
      sourceStart: 1, duration: 2, volume: 1, transform: DEFAULT_TRANSFORM, color: DEFAULT_COLOR,
      keyframes: [], layer: DEFAULT_CLIP_LAYER, expressions: {} });
    expect(f.project).toEqual(beforeProject);
    expect(await readFile(f.path)).toEqual(f.bytes);
    expect(await readdir(f.workspace)).toEqual(beforeEntries);
  });

  it("rejects nonneutral carriers and unsafe/noninteger frame fields before any source/project access", async () => {
    const f = await fixture();
    for (const extra of [{ clip: { color: { exposure: 9 } } }, { transform: { scale: 2 } },
      { motion: { graphicCadence: "legacy" } }, { timelineStartFrame: .5 }, { sourceStartFrame: -1 },
      { durationFrames: 0 }, { durationFrames: Number.MAX_SAFE_INTEGER + 1 }]) {
      await expect(prepareMediaBootstrapReadOnly({ ...f.input, ...extra }, f.dependencies)).rejects.toThrow();
    }
    expect(prepareMediaBootstrapInputSchema.safeParse({ ...f.input, rights: { ...f.input.rights, hostGrant: true } }).success).toBe(false);
    expect(prepareMediaBootstrapInputSchema.safeParse({ ...f.input, sourceColorInterpretation: "acescct" }).success).toBe(false);
    expect(f.readProject).not.toHaveBeenCalled();
    expect(f.inspect).not.toHaveBeenCalled();
  });

  it("propagates the workspace resolver rejection before probing or reading the project", async () => {
    const f = await fixture();
    await expect(prepareMediaBootstrapReadOnly(f.input, { ...f.dependencies,
      resolveWorkspaceMediaPath: async () => { throw new Error("Workspace canonical boundary rejected"); },
    })).rejects.toThrow("Workspace canonical boundary rejected");
    expect(f.readProject).not.toHaveBeenCalled();
    expect(f.inspect).not.toHaveBeenCalled();
  });

  it("honours the actual SDK cancellation signal before source/project access", async () => {
    const f = await fixture(), controller = new AbortController();
    controller.abort(new Error("Owned preparation cancelled"));
    await expect(prepareMediaBootstrapReadOnly(f.input, f.dependencies, controller.signal)).rejects.toThrow("Owned preparation cancelled");
    expect(f.readProject).not.toHaveBeenCalled();
    expect(f.inspect).not.toHaveBeenCalled();
  });

  it("independently rejects a real regular source outside the workspace even if an adapter resolver supplies it", async () => {
    const f = await fixture(), outside = join(f.root, "outside.mp4");
    await writeFile(outside, f.bytes);
    await expect(prepareMediaBootstrapReadOnly({ ...f.input, sourcePath: outside }, f.dependencies)).rejects.toThrow(/workspace|工作區/i);
    expect(f.inspect).not.toHaveBeenCalled();
  });

  it("rejects a directory as source before the controlled media probe", async () => {
    const f = await fixture();
    const directory = join(f.workspace, "source-directory");
    await mkdir(directory);
    await expect(prepareMediaBootstrapReadOnly({ ...f.input, sourcePath: directory }, f.dependencies)).rejects.toThrow(/regular|一般檔案|file/i);
    expect(f.inspect).not.toHaveBeenCalled();
  });

  it("rejects a project change after the actual producer reads its starting graph", async () => {
    const f = await fixture();
    let reads = 0;
    await expect(prepareMediaBootstrapReadOnly(f.input, { ...f.dependencies,
      readProject: async () => ++reads === 1 ? f.project : { ...f.project, revision: f.project.revision + 1 },
    })).rejects.toThrow(/project|專案/i);
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(f.project.revision).toBe(17);
  });

  it("rejects real source byte changes during probe rather than returning a stale draft", async () => {
    const f = await fixture();
    await expect(prepareMediaBootstrapReadOnly(f.input, { ...f.dependencies, prepareDependencies: {
      inspect: async () => { await writeFile(f.path, Buffer.from("changed owned fixture bytes\n")); return f.probe; },
    } })).rejects.toThrow(/source|來源|changed|變動/i);
  });

  it("enforces current locked-track, kind and real source-window guards through the actual producer", async () => {
    const f = await fixture();
    f.project.tracks[0].locked = true;
    await expect(prepareMediaBootstrapReadOnly(f.input, f.dependencies)).rejects.toThrow(/locked|鎖/i);
    f.project.tracks[0].locked = false;
    await expect(prepareMediaBootstrapReadOnly({ ...f.input, trackId: "audio-main" }, f.dependencies)).rejects.toThrow(/kind|種類|相容/i);
    await expect(prepareMediaBootstrapReadOnly({ ...f.input, sourceStartFrame: 210, durationFrames: 60 }, f.dependencies)).rejects.toThrow(/source|來源|window|超/i);
  });

  it("registers only the strict read-only preparation tool, without an apply or render authority", () => {
    const server = new McpServer({ name: "owned-bootstrap-adapter-test", version: "1.0.0" });
    const registration = vi.spyOn(server, "registerTool");
    registerMediaBootstrapTools(server);
    expect(registration).toHaveBeenCalledTimes(1);
    expect(registration.mock.calls[0][0]).toBe("prepare_media_bootstrap");
    expect(registration.mock.calls[0][1].inputSchema).toBe(prepareMediaBootstrapInputSchema);
    expect(registration.mock.calls[0][1].annotations).toEqual({ readOnlyHint: true, destructiveHint: false,
      idempotentHint: true, openWorldHint: false });
  });
});
