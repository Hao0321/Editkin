import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type TimelineClip } from "../domain/types";
import { readProject } from "./storage";

// The agent's command path for the 2026-10-11 timeline rules: the registered apply_edit_commands tool (its input schema,
// its handler and the project write) on a real project file. Only the MCP transport is replaced.
type Tool = { configuration: { inputSchema: { parse(value: unknown): unknown } }; handler: (input: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> };
const mocks = vi.hoisted(() => ({ tools: new Map<string, Tool>() }));
vi.mock("@modelcontextprotocol/server", () => ({ McpServer: class {
  registerTool(name: string, configuration: Tool["configuration"], handler: Tool["handler"]) { mocks.tools.set(name, { configuration, handler }); }
} }));
vi.mock("@modelcontextprotocol/server/stdio", () => ({ serveStdio: () => ({ close: async () => {} }) }));
import { createServer } from "./server";

const roots: string[] = [], previousWorkspace = process.env.EDITKIN_WORKSPACE;
beforeEach(() => { mocks.tools.clear(); createServer(); });
afterEach(async () => {
  if (previousWorkspace === undefined) delete process.env.EDITKIN_WORKSPACE; else process.env.EDITKIN_WORKSPACE = previousWorkspace;
  for (const root of roots.splice(0)) {
    const absolute = resolve(root);
    if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith("editkin-timeline-rules-mcp-")) throw new Error("Refusing unowned fixture cleanup");
    await rm(absolute, { recursive: true, force: true });
  }
});

function clip(id: string, assetId: string, trackId: string, timelineStart: number, duration: number, sourceStart = 0): TimelineClip {
  return { id, assetId, trackId, timelineStart, sourceStart, duration, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] };
}
/** The audit's example on disk: 主畫面 A[0,4) B[4,8) C[8,12); 聲音 VO1[0,5) VO2[5,9) VO3[9,15); a caption inside B. */
async function saved(change?: (project: EditProject) => void) {
  const root = await mkdtemp(join(tmpdir(), "editkin-timeline-rules-mcp-")); roots.push(root); process.env.EDITKIN_WORKSPACE = root;
  const value = createEmptyProject("Agent rules", { id: "agent-rules", width: 1920, height: 1080, fps: 30 });
  value.assets = [{ id: "cam", name: "cam.mp4", kind: "video", uri: join(root, "cam.mp4"), duration: 60, width: 1920, height: 1080 },
    { id: "vo", name: "vo.wav", kind: "audio", uri: join(root, "vo.wav"), duration: 60 }];
  value.tracks[0].clips = [clip("A", "cam", "video-main", 0, 4), clip("B", "cam", "video-main", 4, 4, 10), clip("C", "cam", "video-main", 8, 4, 20)];
  value.tracks[1].clips = [clip("VO1", "vo", "audio-main", 0, 5), clip("VO2", "vo", "audio-main", 5, 4, 5), clip("VO3", "vo", "audio-main", 9, 6, 9)];
  value.captions = [{ id: "line-in-B", text: "在 B 裡", start: 5, duration: 1 }, { id: "line-in-C", text: "在 C 裡", start: 9, duration: 1 }];
  change?.(value);
  const path = join(root, "saved.editkin.json");
  await writeFile(path, JSON.stringify(validateProject(value)));
  return path;
}
async function call(name: string, input: unknown) {
  const tool = mocks.tools.get(name)!;
  const result = await tool.handler(tool.configuration.inputSchema.parse(input));
  return { isError: result.isError, body: JSON.parse(result.content[0].text) };
}

describe("apply_edit_commands follows the editor's timeline rules", () => {
  it("ripple_delete_clip on 主畫面 succeeds where it used to be refused, and says what stayed in place", async () => {
    const path = await saved();
    const result = await call("apply_edit_commands", { projectPath: path, commands: [{ type: "ripple_delete_clip", clipId: "B" }] });
    expect(result.isError).toBeFalsy();
    expect(result.body.rippleDelete).toEqual([{ clipId: "B", message: "已刪除片段並自動補上空隙；其他軌道的聲音沒有跟著移動，避免重疊；復原一次即可完整還原。",
      heldTracks: [{ trackId: "audio-main", name: "聲音", kind: "audio", reason: "overlap" }], removedCaptionIds: ["line-in-B"], trimmedCaptionIds: [],
      removedGraphicIds: [], trimmedGraphicIds: [], removedMarkerIds: [], removedTemplateIds: [] }]);
    const after = await readProject(path);
    expect(after.tracks[0].clips.map(item => [item.id, Math.round(item.timelineStart * 30)])).toEqual([["A", 0], ["C", 120]]);
    expect(after.tracks[1].clips.map(item => [item.id, Math.round(item.timelineStart * 30)])).toEqual([["VO1", 0], ["VO2", 150], ["VO3", 270]]);
    expect(after.captions.map(item => [item.id, item.start])).toEqual([["line-in-C", 5]]);
  });

  it("an edit on a locked track is refused in plain words and the file is not written", async () => {
    const path = await saved(value => { value.tracks[0].locked = true; });
    const before = await readFile(path, "utf8");
    for (const command of [{ type: "split_clip", clipId: "A", at: 2, newClipId: "A2" }, { type: "trim_clip_end", clipId: "A", seconds: 1 },
      { type: "delete_clip", clipId: "A" }, { type: "update_clip_transform", clipId: "A", patch: { scale: 1.5 } }]) {
      const result = await call("apply_edit_commands", { projectPath: path, commands: [command] });
      expect(result.isError).toBe(true);
      expect(result.body.error).toBe("這個軌道已鎖定，先解鎖才能修改。");
    }
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("toggle_track_hidden and toggle_track_mute are separate switches for an agent too, and readProject migrates the old form", async () => {
    const path = await saved(value => {
      value.tracks.push({ id: "v2", name: "畫面軌 2", kind: "video", locked: false, muted: true, clips: [clip("R", "cam", "v2", 0, 2, 30)] });
    });
    // Saved before the split: muted only, no hidden key. The MCP load path reads it as muted and hidden (as it rendered).
    expect(JSON.parse(await readFile(path, "utf8")).tracks.at(-1)).not.toHaveProperty("hidden");
    expect((await readProject(path)).tracks.at(-1)).toMatchObject({ muted: true, hidden: true });
    expect((await call("apply_edit_commands", { projectPath: path, commands: [{ type: "toggle_track_hidden", trackId: "v2" }] })).isError).toBeFalsy();
    expect((await readProject(path)).tracks.at(-1)).toMatchObject({ muted: true, hidden: false });
    expect((await call("apply_edit_commands", { projectPath: path, commands: [{ type: "toggle_track_mute", trackId: "v2" }] })).isError).toBeFalsy();
    expect((await readProject(path)).tracks.at(-1)).toMatchObject({ muted: false, hidden: false });
  });
});
