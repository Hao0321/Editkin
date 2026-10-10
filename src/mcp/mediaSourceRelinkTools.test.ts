import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { parseProject, readProjectFile, writeProjectFileAtomic } from "../application/projectFiles";
import { sha256Canonical } from "../application/autopilotInvocationIdentity";
import { autopilotCommands, type AutopilotPlan } from "../application/autopilotPlan";
import { applyProjectCommands, resolveProjectPath, resolveWorkspaceMediaPath } from "./storage";
import { prepareMediaSourceRelinkReadOnly, applyMediaSourceRelink, prepareMediaSourceRelinkInputSchema,
  type MediaSourceRelinkDependencies } from "./mediaSourceRelinkTools";

// Controlled ffprobe values; real file bytes, path boundaries, hashes, graph,
// project lease and atomic save are production implementations. No film claimed.
const roots: string[] = [], originalWorkspace = process.env.EDITKIN_WORKSPACE;
afterEach(async () => {
  if (originalWorkspace === undefined) delete process.env.EDITKIN_WORKSPACE;
  else process.env.EDITKIN_WORKSPACE = originalWorkspace;
  for (const path of roots.splice(0)) {
    const target = resolve(path);
    if (dirname(target) !== await realpath(tmpdir()) || !basename(target).startsWith("editkin-source-relink-")) throw new Error("Refusing unowned fixture cleanup");
    await rm(target, { recursive: true, force: true });
  }
});
async function fixture() {
  // Real temporary path: macOS tmpdir() sits under the /var symlink and Windows runners report 8.3 short names.
  const root = await mkdtemp(join(await realpath(tmpdir()), "editkin-source-relink-")); roots.push(root);
  const workspace = join(root, "workspace"); await mkdir(workspace);
  process.env.EDITKIN_WORKSPACE = workspace;
  const sourcePath = join(workspace, "moved.mp4"), projectPath = join(workspace, "saved.editkin.json");
  const bytes = Buffer.from("identified original byte fixture; this is not a decoded video\n");
  await writeFile(sourcePath, bytes);
  const sourceSha = createHash("sha256").update(bytes).digest("hex");
  let project = parseProject(createEmptyProject("Portable saved source", { id: "portable", width: 640, height: 360, fps: 30 }));
  project = applyCommand(project, { type: "import_asset", asset: { id: "source", name: "Original", uri: join(root, "old-unavailable.mp4"),
    kind: "video", duration: 8, width: 640, height: 360, displayAspectRatio: 16 / 9,
    provenance: "Owned controlled fixture", rightsBasis: "Test only", distributionScope: "private",
    derivatives: { sourceSha256: sourceSha, proxyUri: join(root, "old-proxy.mp4"), generatedAt: "2026-10-01T00:00:00.000Z" } } });
  project = applyCommand(project, { type: "add_clip", clip: { id: "clip", assetId: "source", trackId: "video-main", timelineStart: 0,
    sourceStart: 1, duration: 4, volume: .72, transform: DEFAULT_TRANSFORM, color: DEFAULT_COLOR, keyframes: [] } });
  const saved = await writeProjectFileAtomic(projectPath, project, null);
  const inspect = vi.fn(async () => ({ duration: 8, width: 640, height: 360, displayAspectRatio: 16 / 9, hasVideo: true, hasAudio: true }));
  const dependencies: MediaSourceRelinkDependencies = { readProject: async path => readProjectFile(await resolveProjectPath(path)),
    resolveProjectPath, resolveWorkspaceMediaPath, workspaceRoot: () => workspace, inspect, writeProjectAtomic: writeProjectFileAtomic };
  const input = { projectPath, assetId: "source", sourcePath, expectedProjectRevision: saved.revision, expectedSourceSha256: sourceSha };
  return { root, workspace, sourcePath, projectPath, bytes, sourceSha, project: saved, dependencies, input, inspect };
}
describe("formal persisted byte-identical media relink", () => {
  it("prepares without writes then atomically reconnects and reopens with every source/audio/visual setting retained", async () => {
    const f = await fixture(), before = await readFile(f.projectPath);
    const draft = await prepareMediaSourceRelinkReadOnly(f.input, f.dependencies);
    expect(draft).toMatchObject({ status: "PREPARED_NOT_APPLIED", readOnly: true, mutationPerformed: false, differentMediaReplacement: false });
    expect(await readFile(f.projectPath)).toEqual(before);
    const result = await applyMediaSourceRelink({ ...f.input, expectedPreparationSha256: draft.preparationSha256 }, f.dependencies);
    expect(result).toMatchObject({ status: "COMMITTED", projectRevisionBefore: f.project.revision,
      projectRevisionAfter: f.project.revision + 1, previousQaOrArtworkApprovalReusable: false, v4MotionRequired: true });
    const reopened = await readProjectFile(f.projectPath);
    expect(reopened.tracks).toEqual(f.project.tracks);
    expect(reopened.motionGraphics).toEqual(f.project.motionGraphics);
    expect(reopened.assets[0]).toEqual({ ...f.project.assets[0], uri: f.sourcePath,
      derivatives: { sourceSha256: f.sourceSha, generatedAt: f.project.assets[0].derivatives!.generatedAt } });
    expect(await readFile(f.sourcePath)).toEqual(f.bytes);
    await expect(applyMediaSourceRelink({ ...f.input, expectedPreparationSha256: draft.preparationSha256 }, f.dependencies)).rejects.toThrow(/revision.*stale/);
  });
  it("rejects outside-workspace and junction escape before probe or source reads", async () => {
    const f = await fixture(), outside = join(f.root, "outside"); await mkdir(outside);
    await writeFile(join(outside, "source.mp4"), f.bytes);
    await expect(prepareMediaSourceRelinkReadOnly({ ...f.input, sourcePath: join(outside, "source.mp4") }, f.dependencies)).rejects.toThrow(/WORKSPACE/);
    await symlink(outside, join(f.workspace, "linked"), process.platform === "win32" ? "junction" : "dir");
    await expect(prepareMediaSourceRelinkReadOnly({ ...f.input, sourcePath: join(f.workspace, "linked/source.mp4") }, f.dependencies)).rejects.toThrow(/symlink|junction/);
    expect(f.inspect).not.toHaveBeenCalled();
  });
  it("rejects unknown original SHA and changed bytes without commit", async () => {
    const f = await fixture(), before = await readFile(f.projectPath);
    await expect(prepareMediaSourceRelinkReadOnly({ ...f.input, expectedSourceSha256: "a".repeat(64) }, f.dependencies)).rejects.toThrow(/original saved source SHA/);
    await writeFile(f.sourcePath, Buffer.from(f.bytes).fill(65));
    await expect(prepareMediaSourceRelinkReadOnly(f.input, f.dependencies)).rejects.toThrow(/SHA-256 differs/);
    expect(await readFile(f.projectPath)).toEqual(before);
    expect(f.inspect).not.toHaveBeenCalled();
  });
  it.each([{ duration: 9 }, { width: 360 }, { displayAspectRatio: 9 / 16 }, { hasVideo: false }])("rejects incompatible actual probe %j", async patch => {
    const f = await fixture(), before = await readFile(f.projectPath);
    f.inspect.mockImplementation(async () => ({ duration: 8, width: 640, height: 360, displayAspectRatio: 16 / 9, hasVideo: true, hasAudio: true, ...patch }));
    await expect(prepareMediaSourceRelinkReadOnly(f.input, f.dependencies)).rejects.toThrow(/differs|dimensions/);
    expect(await readFile(f.projectPath)).toEqual(before);
  });
  it("checks source after the last preparation project-read callback", async () => {
    const f = await fixture(), originalRead = f.dependencies.readProject; let calls = 0;
    f.dependencies.readProject = async path => { const value = await originalRead(path); if (++calls === 2) await writeFile(f.sourcePath, "mutated during last project read"); return value; };
    await expect(prepareMediaSourceRelinkReadOnly(f.input, f.dependencies)).rejects.toThrow(/source changed/);
  });
  it("rejects same-revision project edits and source changes inside atomic beforeCommit", async () => {
    const f = await fixture(), draft = await prepareMediaSourceRelinkReadOnly(f.input, f.dependencies), before = await readFile(f.projectPath);
    const originalWrite = f.dependencies.writeProjectAtomic;
    f.dependencies.writeProjectAtomic = (path, graph, revision, options) => originalWrite(path, graph, revision, { ...options,
      beforeCommit: async () => { await writeFile(f.sourcePath, "changed before commit"); await options?.beforeCommit?.(); } });
    await expect(applyMediaSourceRelink({ ...f.input, expectedPreparationSha256: draft.preparationSha256 }, f.dependencies)).rejects.toThrow(/media changed before commit/);
    expect(await readFile(f.projectPath)).toEqual(before);
  });
  it("rejects project tampering with unchanged revision before atomic commit", async () => {
    const f = await fixture(), draft = await prepareMediaSourceRelinkReadOnly(f.input, f.dependencies);
    const originalWrite = f.dependencies.writeProjectAtomic;
    let modified = "";
    f.dependencies.writeProjectAtomic = (path, graph, revision, options) => originalWrite(path, graph, revision, { ...options,
      beforeCommit: async () => { const current = JSON.parse(await readFile(path, "utf8")); current.name = "External same-revision edit";
        modified = JSON.stringify(current); await writeFile(path, modified); await options?.beforeCommit?.(); } });
    await expect(applyMediaSourceRelink({ ...f.input, expectedPreparationSha256: draft.preparationSha256 }, f.dependencies)).rejects.toThrow(/project content changed/);
    expect(await readFile(f.projectPath, "utf8")).toBe(modified);
  });
  it("cannot be invoked as a raw command or hidden in v4 same-URI/revert batches", async () => {
    const f = await fixture(), command = { type: "relink_asset_source" as const, assetId: "source", sourceUri: f.sourcePath, expectedSourceSha256: f.sourceSha };
    await expect(applyProjectCommands(f.projectPath, [{ type: "batch", commands: [command] }])).rejects.toThrow(/raw commands/);
    for (const commands of [[command], [{ type: "batch", commands: [command] }], [command, { ...command, sourceUri: f.project.assets[0].uri }]]) {
      expect(() => autopilotCommands({ commands } as AutopilotPlan)).toThrow(/verified neutral/);
    }
  });
  it("rejects unknown fields before IO and canceled requests before IO", async () => {
    const f = await fixture();
    expect(prepareMediaSourceRelinkInputSchema.safeParse({ ...f.input, hostGrant: true }).success).toBe(false);
    const controller = new AbortController(); controller.abort();
    await expect(prepareMediaSourceRelinkReadOnly(f.input, f.dependencies, controller.signal)).rejects.toThrow();
    expect(f.inspect).not.toHaveBeenCalled();
  });
  it("never dispatches a contained sequence manifest to the inspector", async () => {
    const f = await fixture(), manifest = join(f.workspace, "sequence.json");
    await writeFile(manifest, f.bytes);
    await expect(prepareMediaSourceRelinkReadOnly({ ...f.input, sourcePath: manifest }, f.dependencies)).rejects.toThrow(/sequence manifests/);
    expect(f.inspect).not.toHaveBeenCalled();
  });
});
