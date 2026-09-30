import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveOpenProjectMaterials } from "./kitWorkflowBridge";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "editkin-kit-bind-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const source = join(workspace, "source.mp4");
  const project = join(workspace, "movie.editkin.json");
  await writeFile(source, "fixture-video-bytes");
  const data = {
    assets: [{ id: "asset-demo", uri: join(workspace, "demo.mp4") }, { id: "asset-real", uri: source }],
    tracks: [{ clips: [{ id: "clip-demo", assetId: "asset-demo" }, { id: "clip-real", assetId: "asset-real" }] }],
  };
  await writeFile(project, JSON.stringify(data));
  return { root, workspace, source, project, data };
}

describe("Kit create material binding", () => {
  it("derives real source clips from the open project and excludes the UI demo", async () => {
    const { workspace, source, project } = await fixture();
    expect(await deriveOpenProjectMaterials(project, workspace)).toEqual([{ clipId: "clip-real", sourcePath: source }]);
  });

  it("stops when only the demonstration clip remains", async () => {
    const { workspace, project, data } = await fixture();
    data.tracks[0].clips.pop();
    await writeFile(project, JSON.stringify(data));
    await expect(deriveOpenProjectMaterials(project, workspace)).rejects.toThrow(/請先加入自己的素材/);
  });

  it("rejects an asset outside the bound workspace and duplicate clip IDs", async () => {
    const { root, workspace, project, data } = await fixture();
    data.assets[1].uri = join(root, "outside.mp4");
    await writeFile(data.assets[1].uri, "fixture-video-bytes");
    await writeFile(project, JSON.stringify(data));
    await expect(deriveOpenProjectMaterials(project, workspace)).rejects.toThrow(/existing workspace file/);
    data.assets[1].uri = join(workspace, "source.mp4");
    data.tracks[0].clips[1].id = "clip-demo";
    await writeFile(project, JSON.stringify(data));
    await expect(deriveOpenProjectMaterials(project, workspace)).rejects.toThrow(/duplicate clip ID/);
  });

  it("does not read a project outside the bound workspace", async () => {
    const { root, workspace, project } = await fixture();
    const outside = join(root, "outside.editkin.json");
    await writeFile(outside, await readFile(project));
    await expect(deriveOpenProjectMaterials(outside, workspace)).rejects.toThrow(/outside the workspace/);
  });
});
