import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (request: unknown) => Promise<any>>(),
  analyze: vi.fn(), readProject: vi.fn(), resolveSource: vi.fn(), applyCommands: vi.fn(),
}));
vi.mock("@modelcontextprotocol/server", () => ({ McpServer: class {
  registerTool(name: string, _configuration: unknown, handler: (request: unknown) => Promise<any>) {
    mocks.handlers.set(name, handler);
  }
} }));
vi.mock("@modelcontextprotocol/server/stdio", () => ({ serveStdio: () => ({ close: async () => {} }) }));
vi.mock("../application/motionTracking", () => ({ analyzeMotionTrack: mocks.analyze }));
vi.mock("./storage", async importOriginal => ({ ...await importOriginal<typeof import("./storage")>(),
  readProject: mocks.readProject, resolveWorkspaceMediaPath: mocks.resolveSource, applyProjectCommands: mocks.applyCommands,
}));
import { createServer } from "./server";

const input = { projectPath: "demo.editkin.json", clipId: "clip-1", initialTime: 0,
  rect: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 }, label: "主角" };
function body(result: any) { return JSON.parse(result.content.find((item: any) => item.type === "text").text); }

beforeEach(() => {
  vi.clearAllMocks(); mocks.handlers.clear();
  const project = createEmptyProject("Tracking", { id: "tracking-project", width: 320, height: 180, fps: 30 });
  project.assets.push({ id: "asset-1", name: "owned", kind: "video", uri: "input.mp4", duration: 1, width: 320, height: 180 });
  project.tracks[0].clips.push({ id: "clip-1", assetId: "asset-1", trackId: "video-main", timelineStart: 0, sourceStart: 0,
    duration: 1, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
  mocks.readProject.mockResolvedValue(project);
  mocks.resolveSource.mockResolvedValue("C:/owned/input.mp4");
  mocks.analyze.mockResolvedValue({ engine: "hao-core-rust-motion-track-0.4-planar", analysisFps: 15, width: 320, height: 180,
    points: [{ frame: 0, time: 0, rect: input.rect, confidence: .9, status: "tracked", activity: 0,
      rotationDegrees: 0, scale: 1, quad: [{ x: .2, y: .2 }, { x: .4, y: .2 }, { x: .4, y: .4 }, { x: .2, y: .4 }] }],
    lostRatio: 0, analyzedSeconds: 1, elapsedMs: 10, cacheHit: false });
  createServer();
});

describe("autopilot motion tracking preparation", () => {
  it("returns an exact v4 command while keeping the project unchanged", async () => {
    const before = structuredClone(await mocks.readProject());
    const result = body(await mocks.handlers.get("prepare_autopilot_motion_track")!(input));
    expect(result).toMatchObject({ status: "REVIEW_REQUIRED", projectId: "tracking-project", projectRevision: 0,
      clipId: "clip-1", validPercent: 100, command: { type: "add_motion_track", track: { clipId: "clip-1", name: "主角" } } });
    expect(result.command.track.points).toHaveLength(1);
    expect(mocks.applyCommands).not.toHaveBeenCalled();
    expect(await mocks.readProject()).toEqual(before);
  });
  it("blocks an invalid region before analysis or mutation", async () => {
    const result = await mocks.handlers.get("prepare_autopilot_motion_track")!({ ...input, rect: { x: .9, y: .2, width: .2, height: .2 } });
    expect(result.isError).toBe(true);
    expect(mocks.analyze).not.toHaveBeenCalled();
    expect(mocks.applyCommands).not.toHaveBeenCalled();
  });
});

describe("autopilot template preparation", () => {
  it("compiles the long-form look and translucent subtitle panel without canned copy or mutation", async () => {
    const result = body(await mocks.handlers.get("prepare_autopilot_template_package")!({
      projectPath: input.projectPath, format: "long", templateId: "narrative_vlog", clipIds: ["clip-1"],
    }));
    expect(result.status).toBe("REVIEW_REQUIRED");
    expect(result.commands.map((command: any) => command.type)).toEqual(["set_clip_creative", "set_caption_style"]);
    expect(result.commands[0].patch).toEqual({ lookPresetId: "travel_airy_local" });
    expect(result.commands[1].patch).toMatchObject({ color: "#FFFFFF", translationColor: "#FFFFFF", backgroundColor: "#000000B3" });
    expect(result.suggestions).toMatchObject({ cinematicRecipeId: "spatial_orientation", transitionPresetId: "luma_fade" });
    expect(mocks.applyCommands).not.toHaveBeenCalled();
  });
  it("rejects a duplicate clip selection", async () => {
    const result = await mocks.handlers.get("prepare_autopilot_template_package")!({
      projectPath: input.projectPath, format: "long", templateId: "narrative_vlog", clipIds: ["clip-1", "clip-1"],
    });
    expect(result.isError).toBe(true);
    expect(mocks.applyCommands).not.toHaveBeenCalled();
  });
});
