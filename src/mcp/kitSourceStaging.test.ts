// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectKitProjectExternalSources, pinKitProjectExternalSources, stageKitProjectSources, verifyKitRunExternalSources } from "./kitSourceStaging";

const roots: string[] = [];
afterEach(async () => {
  pinKitProjectExternalSources("", "");
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "editkin-kit-source-"));
  roots.push(root);
  const workspace = join(root, "project");
  const imports = join(root, "imports");
  await mkdir(workspace);
  await mkdir(imports);
  const source = join(imports, "original.mp4");
  const project = join(workspace, "movie.editkin.json");
  await writeFile(source, "synthetic-video-source");
  const data = { assets: [{ id: "asset-source", uri: source }],
    tracks: [{ clips: [{ id: "clip-source", assetId: "asset-source" }] }] };
  await writeFile(project, JSON.stringify(data));
  return { root, workspace, imports, source, project, data };
}

describe("Kit external source snapshots", () => {
  it("copies and reuses an exact source snapshot without altering the project or original", async () => {
    const { workspace, source, project } = await fixture();
    const before = await readFile(project);
    pinKitProjectExternalSources(workspace, project);
    const first = await stageKitProjectSources(workspace, project);
    const copied = first.materials[0].sourcePath;
    expect(copied).not.toBe(source);
    expect(await readFile(copied)).toEqual(await readFile(source));
    expect(await readFile(project)).toEqual(before);
    expect(first.snapshot).toBeDefined();
    const second = await stageKitProjectSources(workspace, project);
    expect(second.materials).toEqual(first.materials);
    expect(second.snapshot).toBe(first.snapshot);
  });

  it("refuses a changed workspace copy instead of silently replacing it", async () => {
    const { workspace, project } = await fixture();
    pinKitProjectExternalSources(workspace, project);
    const first = await stageKitProjectSources(workspace, project);
    await writeFile(first.materials[0].sourcePath, "corrupt copy");
    await expect(stageKitProjectSources(workspace, project)).rejects.toThrow(/snapshot bytes changed/);
  });

  it("does not replace a pre-existing snapshot lock even if its owner is gone", async () => {
    const { workspace, project } = await fixture();
    pinKitProjectExternalSources(workspace, project);
    const first = await stageKitProjectSources(workspace, project);
    await rm(first.snapshot!);
    const lock = join(dirname(first.snapshot!), "stage.lock");
    await writeFile(lock, "stale owner fixture");
    await expect(stageKitProjectSources(workspace, project)).rejects.toThrow(/副本鎖已存在/);
    expect(await readFile(lock, "utf8")).toBe("stale owner fixture");
  });

  it("refuses an external path inserted after the Agent session was pinned", async () => {
    const { imports, workspace, project, data } = await fixture();
    pinKitProjectExternalSources(workspace, project);
    const other = join(imports, "other.mp4");
    await writeFile(other, "other bytes");
    data.assets[0].uri = other;
    await writeFile(project, JSON.stringify(data));
    await expect(stageKitProjectSources(workspace, project)).rejects.toThrow(/not an original external import/);
  });

  it("stages only a selected pinned clip when another project clip has an unpinned outside source", async () => {
    const { imports, workspace, project, data, source } = await fixture();
    pinKitProjectExternalSources(workspace, project);
    const unrelated = join(imports, "unrelated.jpg");
    await writeFile(unrelated, "unapproved image source");
    data.assets.push({ id: "asset-unrelated", uri: unrelated });
    data.tracks[0].clips.push({ id: "clip-unrelated", assetId: "asset-unrelated" });
    await writeFile(project, JSON.stringify(data));
    await expect(stageKitProjectSources(workspace, project)).rejects.toThrow(/not an original external import/);
    expect(inspectKitProjectExternalSources(workspace, project, ["clip-source"]).count).toBe(1);
    const selected = await stageKitProjectSources(workspace, project, {}, ["clip-source"]);
    expect(selected.materials).toHaveLength(1);
    expect(selected.materials[0].clipId).toBe("clip-source");
    expect(await readFile(selected.materials[0].sourcePath)).toEqual(await readFile(source));
    await expect(stageKitProjectSources(workspace, project, {}, ["clip-unrelated"]))
      .rejects.toThrow(/not an original external import/);
    await expect(stageKitProjectSources(workspace, project, {}, ["clip-missing"]))
      .rejects.toThrow(/clipIds must name real/);
  });

  it("refuses malformed project bindings instead of silently omitting a clip", async () => {
    const { workspace, project, data } = await fixture();
    data.tracks[0].clips.push({ id: "clip-missing-source", assetId: "missing" });
    await writeFile(project, JSON.stringify(data));
    pinKitProjectExternalSources(workspace, project);
    await expect(stageKitProjectSources(workspace, project)).rejects.toThrow(/no source asset/);
  });

  it("blocks a run if its original outside source changed after staging", async () => {
    const { workspace, source, project } = await fixture();
    pinKitProjectExternalSources(workspace, project);
    const staged = await stageKitProjectSources(workspace, project);
    const run = join(workspace, "run");
    await mkdir(run);
    const sha256 = createHash("sha256").update(await readFile(source)).digest("hex");
    await writeFile(join(run, "workflow-state.json"), JSON.stringify({ binding: { materials: [{
      source_path: relative(realpathSync(workspace), staged.materials[0].sourcePath).replaceAll("\\", "/"), source_sha256: sha256,
    }] } }));
    await expect(verifyKitRunExternalSources(workspace, project, run, true)).resolves.toBeUndefined();
    await writeFile(source, "changed source bytes");
    await expect(verifyKitRunExternalSources(workspace, project, run, true)).rejects.toThrow(/原始素材.*變更/);
  });

  it("rejects a staged source disguised by a lexical workspace alias", async () => {
    const { workspace, project } = await fixture();
    const run = join(workspace, "run");
    await mkdir(run);
    await writeFile(join(run, "workflow-state.json"), JSON.stringify({ binding: { materials: [
      { source_path: "../.editkin-kit-sources/foreign/source.mp4", source_sha256: "0".repeat(64) },
    ] } }));
    await expect(verifyKitRunExternalSources(workspace, project, run)).rejects.toThrow(/staged source path is invalid/);
  });

  it("reports work and stops hashing when cancelled before creating a snapshot", async () => {
    const { workspace, project, source } = await fixture();
    await writeFile(source, Buffer.alloc(256 * 1024, 7));
    pinKitProjectExternalSources(workspace, project);
    expect(inspectKitProjectExternalSources(workspace, project)).toMatchObject({ count: 1, bytes: 256 * 1024 });
    const controller = new AbortController();
    const phases: string[] = [];
    await expect(stageKitProjectSources(workspace, project, { signal: controller.signal, onProgress: progress => {
      phases.push(progress.phase);
      if (progress.phase === "hashing" && progress.bytesDone > 0) controller.abort();
    } })).rejects.toThrow();
    expect(phases).toContain("hashing");
    expect(await readFile(source)).toEqual(Buffer.alloc(256 * 1024, 7));
  });

  it("removes an interrupted copy and can retry the same source", async () => {
    const { workspace, project, source } = await fixture();
    await writeFile(source, Buffer.alloc(256 * 1024, 5));
    pinKitProjectExternalSources(workspace, project);
    const controller = new AbortController();
    await expect(stageKitProjectSources(workspace, project, { signal: controller.signal, onProgress: progress => {
      if (progress.phase === "copying" && progress.bytesDone > progress.bytesTotal / 3) controller.abort();
    } })).rejects.toThrow();
    const completed = await stageKitProjectSources(workspace, project);
    expect(completed.snapshot).toBeDefined();
    expect(await readFile(completed.materials[0].sourcePath)).toEqual(await readFile(source));
  });
});
