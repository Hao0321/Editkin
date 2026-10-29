import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { registerMesh3dTools } from "./mesh3dTools";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmptyProject } from "../domain/editGraph";

type Result = { content: { type: string; text: string }[]; isError?: boolean };
function tools() {
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<Result>>();
  const server = { registerTool(name: string, _definition: unknown, handler: (input: Record<string, unknown>) => Promise<Result>) { handlers.set(name, handler); } };
  registerMesh3dTools(server as unknown as McpServer);
  return handlers;
}
describe("withdrawn 3D designs at the automatic editing boundary", () => {
  it("exposes explicit opt-in overlay preparation without writing the project or accepting absent scenes", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh-tool-")), path = join(root, "input.editkin.json");
    const before = JSON.stringify(createEmptyProject("no-scene")); await writeFile(path, before);
    const previous = process.env.EDITKIN_WORKSPACE; process.env.EDITKIN_WORKSPACE = root;
    try {
      const response = await tools().get("prepare_mesh_3d_overlays")!({ projectPath: path,
        bindings: { schema: "editkin.mesh-overlays/v1", anchors: [], layers: [] } });
      expect(response.isError).toBe(true); expect(response.content[0].text).toContain("ENABLED_SCENE_REQUIRED");
      expect(await readFile(path, "utf8")).toBe(before);
      const project = createEmptyProject("existing-scene", { width: 160, height: 90, fps: 10 });
      project.assets.push({ id: "art", name: "owned", kind: "image", uri: "D:/owned.png", duration: 1 });
      project.scene3d = { schema: "editkin.mesh-scene/v1", enabled: true,
        background: { color: "#FFFFFF", gridColor: "#000000", grid: false, spacing: 72 }, light: { direction: [0, 0, 1], ambient: .5, intensity: .5 },
        segments: [{ id: "s", name: "shot", timelineStart: 0, duration: 1,
          camera: { position: [0, 0, 4], target: [0, 0, 0], verticalFovDegrees: 55, near: .1, far: 30 }, cameraKeyframes: [],
          objects: [{ id: "hero", name: "hero", geometry: { kind: "box", width: 1, height: 1, depth: 1 }, material: { color: "#203040", unlit: true },
            pose: { position: [0, 0, 0], rotationDegrees: [0, 0, 0], scale: [1, 1, 1] }, keyframes: [] }] }] };
      const validBefore = JSON.stringify(project); await writeFile(path, validBefore);
      const prepared = await tools().get("prepare_mesh_3d_overlays")!({ projectPath: path,
        bindings: { schema: "editkin.mesh-overlays/v1", anchors: [{ id: "a", segmentId: "s", objectId: "hero", localPoint: [0, 0, .5] }],
          layers: [{ id: "l", anchorId: "a", clipId: "new-art", size: [.3, .3], offset: [0, 0], pivot: [.5, .5], opacity: 1, occlusion: "depth_test" }] },
        newSources: [{ clipId: "new-art", assetId: "art", trackId: project.tracks[0].id, timelineStart: 0, sourceStart: 0, duration: 1 }] });
      expect(prepared.isError).not.toBe(true);
      expect(JSON.parse(prepared.content[0].text)).toMatchObject({ status: "PREPARED_NOT_APPLIED", commands: [{ type: "batch" }] });
      expect(await readFile(path, "utf8")).toBe(validBefore);
    } finally { if (previous === undefined) delete process.env.EDITKIN_WORKSPACE; else process.env.EDITKIN_WORKSPACE = previous; }
  });
  it("does not recommend rejected recipes", async () => {
    const response = await tools().get("list_mesh_3d_templates")!({});
    expect(JSON.parse(response.content[0].text)).toMatchObject({ status: "DESIGN_REWORK", templates: [] });
  });
  it.each(["curved_video_orbit", "extruded_typography", "depth_studio"])("refuses %s before opening an input project", async templateId => {
    const response = await tools().get("prepare_mesh_3d_template")!({
      templateId, projectPath: "Z:/does-not-exist/private.editkin.json", clipId: "footage", title: "作品",
    });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text)).toMatchObject({ status: "BLOCK", error: expect.stringContaining("已撤回") });
    expect(response.content[0].text).not.toContain("commands");
    expect(response.content[0].text).not.toContain("ENOENT");
  });
});
