import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { registerMesh3dTools } from "./mesh3dTools";

type Result = { content: { type: string; text: string }[]; isError?: boolean };
function tools() {
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<Result>>();
  const server = { registerTool(name: string, _definition: unknown, handler: (input: Record<string, unknown>) => Promise<Result>) { handlers.set(name, handler); } };
  registerMesh3dTools(server as unknown as McpServer);
  return handlers;
}
describe("withdrawn 3D designs at the automatic editing boundary", () => {
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
