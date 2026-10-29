import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyCommand } from "../domain/commands";
import { createDemoProject } from "../domain/demo";
import type { EditorCommand } from "../domain/commandTypes";
import type { EditProject } from "../domain/types";
import type { CreativeLibraryAsset } from "../application/creativeLibrary";

/** Wave 2 defect sweep (W2-3), MCP surface regressions: each case failed before its fix. */
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (request: unknown) => Promise<any>>(),
  readProject: vi.fn(), readStoredProject: vi.fn(), applyCommands: vi.fn(), resolveSource: vi.fn(),
  listLibrary: vi.fn(), resolveLibrary: vi.fn(), inspectMedia: vi.fn(), transcribe: vi.fn(), analyze: vi.fn(),
}));
vi.mock("@modelcontextprotocol/server", () => ({ McpServer: class {
  registerTool(name: string, _configuration: unknown, handler: (request: unknown) => Promise<any>) { mocks.handlers.set(name, handler); }
} }));
vi.mock("@modelcontextprotocol/server/stdio", () => ({ serveStdio: () => ({ close: async () => {} }) }));
vi.mock("../application/creativeLibrary", async importOriginal => ({ ...await importOriginal<typeof import("../application/creativeLibrary")>(),
  listCreativeLibrary: mocks.listLibrary, resolveCreativeLibraryAsset: mocks.resolveLibrary }));
vi.mock("../application/inspectMedia", async importOriginal => ({ ...await importOriginal<typeof import("../application/inspectMedia")>(), inspectMedia: mocks.inspectMedia }));
vi.mock("../application/automaticCaptions", async importOriginal => ({ ...await importOriginal<typeof import("../application/automaticCaptions")>(), transcribeAutomaticCaptions: mocks.transcribe }));
vi.mock("../application/motionTracking", async importOriginal => ({ ...await importOriginal<typeof import("../application/motionTracking")>(), analyzeMotionTrack: mocks.analyze }));
vi.mock("./storage", async importOriginal => ({ ...await importOriginal<typeof import("./storage")>(),
  readProject: mocks.readProject, readStoredProject: mocks.readStoredProject, applyProjectCommands: mocks.applyCommands,
  resolveWorkspaceMediaPath: mocks.resolveSource, projectSummaryState: async () => ({ summary: { stub: true } }) }));
import { createServer } from "./server";

const body = (result: any) => JSON.parse(result.content.find((item: any) => item.type === "text").text);
const speedCommand = (project: EditProject): EditorCommand => {
  const clip = project.tracks[0].clips[0];
  return { type: "set_clip_speed", clipId: clip.id, expected: { assetId: clip.assetId, sourceStart: clip.sourceStart, duration: clip.duration, settings: { speed: null, timeRemap: null } }, speed: 2 };
};
let current: EditProject;
beforeEach(() => {
  vi.clearAllMocks(); mocks.handlers.clear();
  current = createDemoProject();
  mocks.readProject.mockImplementation(async () => structuredClone(current));
  mocks.readStoredProject.mockImplementation(async () => ({ project: structuredClone(current), projectSha256: "0".repeat(64) }));
  mocks.applyCommands.mockImplementation(async (_path: string, commands: EditorCommand[]) => { current = applyCommand(current, { type: "batch", commands }); return current; });
  mocks.resolveSource.mockResolvedValue("C:/owned/input.mp4");
  createServer();
});

describe("B14 (W2-4 speed render): speed is accepted exactly where the export renders it", () => {
  const followCurve = { schema: "editkin.clip-time-remap/v1" as const, direction: "forward" as const, interpolation: "frame_blending" as const, audioMode: "follow_speed" as const,
    segments: [{ from: { time: 0, speed: 1 }, control1: { time: 1 / 3, speed: 1 }, control2: { time: 2 / 3, speed: 1 }, to: { time: 1, speed: 1 } }] };
  beforeEach(() => { current.tracks[0].clips[0].duration = 4; }); // 4 s at 2x reads 8 s of the 12 s demo source
  it("apply_edit_commands accepts a renderable 2x speed and refuses a curve whose sound would have to follow it", async () => {
    const accepted = await mocks.handlers.get("apply_edit_commands")!({ projectPath: "p.editkin.json", commands: [speedCommand(current)] });
    expect(accepted.isError).not.toBe(true);
    expect(current.tracks[0].clips[0].speed).toBe(2);
    const clip = current.tracks[0].clips[0];
    const refused = await mocks.handlers.get("apply_edit_commands")!({ projectPath: "p.editkin.json", commands: [{ type: "set_clip_time_remap", clipId: clip.id,
      expected: { assetId: clip.assetId, sourceStart: clip.sourceStart, duration: clip.duration, settings: { speed: 2, timeRemap: null } }, timeRemap: followCurve }] });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused)).toContain("CLIP_TIME_REMAP_FOLLOW_AUDIO_UNAVAILABLE");
    expect(current.tracks[0].clips[0].timeRemap).toBeUndefined();
  });

  it("validate_project agrees: a renderable speed is GREEN, an unrenderable one is BLOCK with its code", async () => {
    current.tracks[0].clips[0].speed = 2;
    expect(body(await mocks.handlers.get("validate_project")!({ projectPath: "p.editkin.json" })).status).toBe("GREEN");
    current.tracks[0].clips[0].timeRemap = followCurve; // e.g. written by an earlier build
    const result = body(await mocks.handlers.get("validate_project")!({ projectPath: "p.editkin.json" }));
    expect(result).toMatchObject({ status: "BLOCK", renderBlockerCount: 1, renderBlockers: [{ clipId: "clip-demo", code: "CLIP_TIME_REMAP_FOLLOW_AUDIO_UNAVAILABLE" }] });
    expect(JSON.stringify(result).length).toBeLessThan(2048);
  });
});

describe("A5/B7 + C: auto_add_music", () => {
  const track = (id: string, name: string, category: string, use: string, bpm: number, duration: number): CreativeLibraryAsset => ({
    id: `music:${id}`, name, category, role: "background-music", domains: [category, use], mediaKind: "audio", bytes: 1, license: "test",
    provenance: "test", duration, bpm, suggestedUse: use, redistributable: true });
  beforeEach(() => {
    mocks.listLibrary.mockResolvedValue({ assets: [
      track("camp", "朋友歡樂露營-01", "露營", "general/explain", 107.67, 46),
      track("chill", "chill-01", "_通用", "general/explain", 92.29, 143),
      track("teach", "教學-01", "_通用", "hook/reveal (high energy)", 117.45, 142),
    ] });
    mocks.resolveLibrary.mockImplementation(async (_root: string, id: string) => ({ absolutePath: `C:/music/${id.slice(6)}.wav` }));
    mocks.inspectMedia.mockResolvedValue({ duration: 30, width: undefined, height: undefined });
  });
  it("re-running after trimming sizes the bed from the picture and explains a neutral pick under `auto`", async () => {
    current.name = "示範專案";
    expect(body(await mocks.handlers.get("auto_add_music")!({ projectPath: "p.editkin.json", targetBpm: 107 })).status).toBe("GREEN");
    current = applyCommand(current, { type: "trim_clip_end", clipId: "clip-demo", seconds: 7.8 });
    const result = body(await mocks.handlers.get("auto_add_music")!({ projectPath: "p.editkin.json", targetBpm: 107 }));
    expect(result).toMatchObject({ status: "GREEN", selection: { profile: "auto", pool: "neutral" }, selected: { category: "_通用" } });
    expect(result.targetDuration).toBeCloseTo(4.2, 9);
    expect(result.selection.reason).toContain("中性");
    const bedEnd = Math.max(...current.tracks.filter(item => item.id.startsWith("audio-music-")).flatMap(item => item.clips.map(clip => clip.timelineStart + clip.duration)));
    expect(bedEnd).toBeCloseTo(4.2, 9);
    expect(JSON.stringify(result).length).toBeLessThan(2048);
  });
});

describe("C: direct_podcast_speakers resolves the bundled whisper-cli like the caption tools", () => {
  it("passes a whisperCliPath without EDITKIN_WHISPER_CLI_PATH", async () => {
    const previous = process.env.EDITKIN_WHISPER_CLI_PATH;
    delete process.env.EDITKIN_WHISPER_CLI_PATH;
    try {
      mocks.analyze.mockResolvedValue({ engine: "test", analysisFps: 15, points: [], lostRatio: 1 });
      mocks.transcribe.mockResolvedValue({ cues: [], engine: "test" });
      await mocks.handlers.get("direct_podcast_speakers")!({ projectPath: "p.editkin.json", clipId: "clip-demo", initialTime: 0, language: "auto",
        hostRect: { x: .1, y: .1, width: .2, height: .2 }, guestRect: { x: .6, y: .1, width: .2, height: .2 } });
      expect(mocks.transcribe).toHaveBeenCalledTimes(1);
      const runtime = mocks.transcribe.mock.calls[0][1];
      expect(runtime.whisperCliPath).toMatch(process.platform === "win32" ? /vendor[\\/]whisper[\\/]win32-x64[\\/]whisper-cli\.exe$/ : /whisper-cli$/);
      expect(runtime.modelRoot).toBeTruthy();
    } finally { if (previous === undefined) delete process.env.EDITKIN_WHISPER_CLI_PATH; else process.env.EDITKIN_WHISPER_CLI_PATH = previous; }
  });
});
