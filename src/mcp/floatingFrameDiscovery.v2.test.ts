import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => new Map<string, (request: unknown) => Promise<any>>());
vi.mock("@modelcontextprotocol/server", () => ({ McpServer: class {
  registerTool(name: string, _configuration: unknown, handler: (request: unknown) => Promise<any>) { handlers.set(name, handler); }
} }));
vi.mock("@modelcontextprotocol/server/stdio", () => ({ serveStdio: () => ({ close: async () => {} }) }));
import { createServer } from "./server";

beforeEach(() => { handlers.clear(); createServer(); });
function body(result: any) { return JSON.parse(result.content.find((item: any) => item.type === "text").text); }

describe("actual MCP floating v2 discovery", () => {
  it("declares source-contain v2 presets and the separate explicit portrait orbit without true-3D parity", async () => {
    const result = body(await handlers.get("list_creative_presets")!({ kind: "motion" }));
    const presets = result.presets.floatingVideoFrames;
    expect(presets.map((preset: any) => preset.id)).toEqual(["matte", "prism", "graphite", "portrait_orbit"]);
    for (const preset of presets) {
      expect(preset.declaredSchema).toBe("editkin.floating-video-frame/v2");
      expect(preset.frame).toMatchObject({ schema: "editkin.floating-video-frame/v2", mediaFit: "contain",
        aspect: preset.id === "portrait_orbit" ? "portrait" : "source", motion: { entranceFrames: 6, exitFrames: 6, travelY: .012 } });
      expect(preset.requires).toContain("known_source_display_geometry");
      expect(preset.requires).toContain("at_least_13_clip_frames");
      expect(preset.capabilityBoundary).toContain("not_true_3d");
      expect(preset.capabilityBoundary).toContain("saved_v1_unchanged");
    }
  });

  it("declares both real scene IDs as editable source-aspect planes using the read-only prepare tool", async () => {
    const result = body(await handlers.get("list_creative_presets")!({ kind: "motion" }));
    const scenes = result.presets.floatingFrameScenes;
    expect(scenes.map((scene: any) => scene.id)).toEqual(["portrait_duo", "portrait_stack"]);
    for (const scene of scenes) {
      expect(scene).toMatchObject({ declaredSchema: "editkin.floating-video-frame/v2", aspect: "source", mediaFit: "contain",
        prepareTool: "prepare_floating_frame_scene", capabilityBoundary: "editable_2.5d_planes_not_true_3d" });
      expect(scene.requires).toContain("known_source_display_geometry");
    }
  });
});
