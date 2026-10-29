import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type TimelineClip } from "../domain/types";
import { DEFAULT_REFERENCE_MOTION_STYLE, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { parseProject } from "../application/projectCodec";
import { inspectReferenceMotionTemplateInstance, prepareReferenceMotionTemplateInstance, prepareReferenceMotionTemplateReapply,
  TEMPLATE_REBUILD_ENVIRONMENT } from "../application/referenceMotionTemplateInstances";
import { withReferenceMotionPhysicalFonts } from "./referenceMotionPhysicalFonts";
import { readProject } from "./storage";

// The agent's command path: the registered apply_edit_commands tool (its input schema, then its handler, then the
// command application that writes the project) on a real project file, with the real compiler and the bundled fonts.
// Only the MCP transport is replaced.
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
    if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith("editkin-template-follow-mcp-")) throw new Error("Refusing unowned fixture cleanup");
    await rm(absolute, { recursive: true, force: true });
  }
});

function clip(id: string, timelineStart: number, duration: number): TimelineClip {
  return { id, assetId: "source", trackId: "video-main", timelineStart, sourceStart: 1, duration, volume: 1, transform: { ...DEFAULT_TRANSFORM },
    color: { ...DEFAULT_COLOR }, keyframes: [], layer: { ...DEFAULT_CLIP_LAYER } };
}
/** A saved project: [before 1–3 s][primary 3–9 s] … [after 12–14 s], a FOCUS title template (needs 3 s) on primary. */
async function savedProject(change?: (project: EditProject) => void) {
  const root = await mkdtemp(join(tmpdir(), "editkin-template-follow-mcp-")); roots.push(root); process.env.EDITKIN_WORKSPACE = root;
  const value = createEmptyProject("Agent edits", { id: "agent-edits", width: 1080, height: 1920, fps: 30 });
  value.assets = [{ id: "source", name: "旅行.mp4", kind: "video", uri: join(root, "trip.mp4"), duration: 30, width: 1080, height: 1920,
    displayAspectRatio: 9 / 16, color: { interpretation: "rec709" } }];
  value.tracks[0].clips = [clip("before", 1, 2), clip("primary", 3, 6), clip("after", 12, 2)];
  const input: ReferenceMotionTemplateInput = { templateId: "level_bridge", clipId: "primary", startFrame: 90, durationFrames: 180, title: "FOCUS", kicker: "LOOK",
    purpose: "Owned control", evidenceRefs: ["owned:fixture"], graphicCadence: "kinetic",
    style: { ...structuredClone(DEFAULT_REFERENCE_MOTION_STYLE), typography: { headingFamily: "Bebas Neue", bodyFamily: "Bebas Neue" } } };
  let next = 0;
  const packet = await withReferenceMotionPhysicalFonts(fonts => prepareReferenceMotionTemplateInstance(parseProject(validateProject(value)), input,
    (kind, role) => `agent-${kind}-${role ?? ""}-${next++}`, fonts));
  const project = applyCommand(parseProject(validateProject(value)), { type: "batch", commands: packet.commands });
  change?.(project);
  const path = join(root, "saved.editkin.json");
  await writeFile(path, JSON.stringify(project));
  return { path, project, instanceId: packet.instance.id, graphicIds: packet.instance.roles.filter(role => role.kind === "graphic").map(role => role.id) };
}
async function applyEdits(projectPath: string, commands: unknown[]) {
  return call("apply_edit_commands", { projectPath, commands });
}
async function call(name: string, input: unknown) {
  const tool = mocks.tools.get(name)!;
  const result = await tool.handler(tool.configuration.inputSchema.parse(input));
  return { isError: result.isError, body: JSON.parse(result.content[0].text) };
}
/** CURRENT on its main clip (start and length match it), and re-applying it changes nothing. */
async function editable(project: EditProject, id: string) {
  const saved = project.referenceMotionInstances!.find(item => item.id === id)!;
  const main = project.tracks.flatMap(track => track.clips).find(item => item.id === saved.input.clipId)!;
  expect([saved.input.startFrame, saved.input.durationFrames]).toEqual([Math.round(main.timelineStart * 30), Math.round(main.duration * 30)]);
  expect((await inspectReferenceMotionTemplateInstance(project, id)).status).toBe("CURRENT");
  const reapplied = await withReferenceMotionPhysicalFonts(fonts => prepareReferenceMotionTemplateReapply(project, id,
    { ...fonts, expectedInstanceRevision: saved.instanceRevision, idFactory: prefix => `${prefix}-check` }));
  expect(reapplied.status).toBe("UNCHANGED");
  return saved;
}
const followed = (f: { instanceId: string }) => ({ followed: [{ instanceId: f.instanceId, title: "FOCUS" }], needsReapply: [] });

describe("apply_edit_commands on a title template's main clip: the template follows in the same write (the editor's own path)", () => {
  it.each([
    // trim_clip_start is the in-point trim: the clip keeps its place and plays from one second later in the media.
    ["trim_clip_start", { type: "trim_clip_start", clipId: "primary", seconds: 1 }, { clipId: "primary", startFrame: 90, durationFrames: 150 }],
    ["trim_clip_end", { type: "trim_clip_end", clipId: "primary", seconds: 1 }, { clipId: "primary", startFrame: 90, durationFrames: 150 }],
    ["extend_clip", { type: "extend_clip", clipId: "primary", edge: "end", seconds: 1 }, { clipId: "primary", startFrame: 90, durationFrames: 210 }],
    ["move_clip", { type: "move_clip", clipId: "primary", timelineStart: 4 }, { clipId: "primary", startFrame: 120, durationFrames: 180 }],
    ["split_clip (the cut leaves the template's start on the first piece)", { type: "split_clip", clipId: "primary", at: 8, newClipId: "agent-tail" },
      { clipId: "primary", startFrame: 90, durationFrames: 150 }],
    ["split_clip (the cut is inside the template's start: the longer piece keeps it)", { type: "split_clip", clipId: "primary", at: 4, newClipId: "agent-rest" },
      { clipId: "agent-rest", startFrame: 120, durationFrames: 150 }],
    ["ripple_delete_clip of the clip before it", { type: "ripple_delete_clip", clipId: "before" }, { clipId: "primary", startFrame: 30, durationFrames: 180 }],
    ["extend_clip of the clip before it (a ripple insert)", { type: "extend_clip", clipId: "before", edge: "end", seconds: 1 }, { clipId: "primary", startFrame: 120, durationFrames: 180 }],
    ["compact_track", { type: "compact_track", trackId: "video-main" }, { clipId: "primary", startFrame: 60, durationFrames: 180 }],
  ])("%s", async (_name, command, expected) => {
    const f = await savedProject();
    const { isError, body } = await applyEdits(f.path, [command]);
    expect(isError).toBeUndefined();
    expect(body).toMatchObject({ status: "GREEN", appliedCommandCount: 1, templateFollow: followed(f) });
    const written = await readProject(f.path);
    expect(written.revision).toBe(f.project.revision + 1);
    expect(await editable(written, f.instanceId)).toMatchObject({ instanceRevision: 2, input: expected });
    // Its own titles sit inside its main clip.
    const saved = written.referenceMotionInstances![0];
    for (const id of f.graphicIds) {
      const graphic = written.motionGraphics.find(item => item.id === id);
      if (!graphic) continue;
      expect(Math.round(graphic.timelineStart * 30)).toBeGreaterThanOrEqual(saved.input.startFrame);
      expect(Math.round((graphic.timelineStart + graphic.duration) * 30)).toBeLessThanOrEqual(saved.input.startFrame + saved.input.durationFrames);
    }
  }, 120_000);

  it("move_clip_to_track: the template goes along with its main clip to the other track", async () => {
    const f = await savedProject(project => { project.tracks.splice(1, 0, { id: "video-b", name: "B", kind: "video", locked: false, muted: false, clips: [] }); });
    const { body } = await applyEdits(f.path, [{ type: "move_clip_to_track", clipId: "primary", trackId: "video-b", timelineStart: 4 }]);
    expect(body).toMatchObject({ status: "GREEN", appliedCommandCount: 1, templateFollow: followed(f) });
    const written = await readProject(f.path);
    expect(written.tracks.find(track => track.id === "video-b")!.clips.map(item => item.id)).toEqual(["primary"]);
    expect(await editable(written, f.instanceId)).toMatchObject({ instanceRevision: 2, input: { clipId: "primary", startFrame: 120, durationFrames: 180 } });
  }, 120_000);

  it("a prepared copy revision applied as raw commands manages its own template: applied as it is, nothing reported", async () => {
    const f = await savedProject();
    const prepared = await call("prepare_reference_motion_template_revision", { projectPath: f.path, instanceId: f.instanceId,
      expectedInstanceRevision: 1, patch: { title: "FOCUS NOW" } });
    expect(prepared.isError).toBeUndefined();
    const { isError, body } = await applyEdits(f.path, prepared.body.commands);
    expect(isError).toBeUndefined();
    // W2-2 B3: every summary also carries the saved file SHA and media state; nothing else (no templateFollow) is reported.
    expect(body).toEqual({ status: "GREEN", appliedCommandCount: prepared.body.commands.length, summary: body.summary,
      projectSha256: expect.stringMatching(/^[a-f0-9]{64}$/), missingMedia: body.missingMedia, outsideWorkspaceMedia: body.outsideWorkspaceMedia });
    const written = await readProject(f.path);
    expect(written.referenceMotionInstances![0].input.title).toBe("FOCUS NOW");
    expect((await inspectReferenceMotionTemplateInstance(written, f.instanceId)).status).toBe("CURRENT");
  }, 120_000);

  it("keeps an edit that touches no template exactly as before", async () => {
    const f = await savedProject();
    const plain = await applyEdits(f.path, [{ type: "extend_clip", clipId: "after", edge: "end", seconds: 1 }]);
    expect(plain.body).toEqual({ status: "GREEN", appliedCommandCount: 1, summary: plain.body.summary,
      projectSha256: expect.stringMatching(/^[a-f0-9]{64}$/), missingMedia: plain.body.missingMedia, outsideWorkspaceMedia: plain.body.outsideWorkspaceMedia });
    expect(await editable(await readProject(f.path), f.instanceId)).toMatchObject({ instanceRevision: 1 });
  }, 120_000);

  it("refuses a malformed extend_clip before anything is read or written", async () => {
    const f = await savedProject(), bytes = await readFile(f.path);
    const tool = mocks.tools.get("apply_edit_commands")!;
    expect(() => tool.configuration.inputSchema.parse({ projectPath: f.path, commands: [{ type: "extend_clip", clipId: "primary", edge: "middle", seconds: 1 }] })).toThrow();
    expect(() => tool.configuration.inputSchema.parse({ projectPath: f.path, commands: [{ type: "extend_clip", clipId: "primary", edge: "end", seconds: -1 }] })).toThrow();
    expect(await readFile(f.path)).toEqual(bytes);
  }, 60_000);
});

describe("apply_edit_commands when a template truly cannot follow: the edit happens and the result says it needs re-applying, and why", () => {
  it("a main clip trimmed shorter than the template's reading time", async () => {
    const f = await savedProject();
    const { body } = await applyEdits(f.path, [{ type: "trim_clip_end", clipId: "primary", seconds: 4 }]);
    expect(body.templateFollow).toEqual({ followed: [],
      needsReapply: [{ instanceId: f.instanceId, title: "FOCUS", reason: "片段只有 2.00 秒，這個模板至少要 3.00 秒；先把片段拉長。" }] });
    const written = await readProject(f.path);
    expect(written.tracks[0].clips.find(item => item.id === "primary")!.duration).toBe(2);
    expect(written.referenceMotionInstances![0]).toEqual(f.project.referenceMotionInstances![0]);
    expect((await inspectReferenceMotionTemplateInstance(written, f.instanceId)).status).toBe("EDITED");
  }, 120_000);

  it("a template whose recipe or font version changed (ENVIRONMENT_CHANGED) is reported with the editor's own words; a move still carries it along", async () => {
    const f = await savedProject(project => { project.referenceMotionInstances![0].dependencies.recipeVersion = "editkin.reference-motion-recipes/older:0"; });
    expect((await inspectReferenceMotionTemplateInstance(f.project, f.instanceId)).status).toBe("ENVIRONMENT_CHANGED");
    const { body } = await applyEdits(f.path, [{ type: "trim_clip_start", clipId: "primary", seconds: 1 }]);
    expect(body.templateFollow).toEqual({ followed: [], needsReapply: [{ instanceId: f.instanceId, title: "FOCUS", reason: TEMPLATE_REBUILD_ENVIRONMENT }] });
    expect(TEMPLATE_REBUILD_ENVIRONMENT).toBe("這個模板或字型的版本已經更新，要重新套用後才能改字。");
    const trimmed = await readProject(f.path);
    expect(trimmed.referenceMotionInstances![0]).toEqual(f.project.referenceMotionInstances![0]);
    // A plain move cannot re-record it either, but its titles still go along with the clip they belong to.
    const before = new Map(f.graphicIds.map(id => [id, trimmed.motionGraphics.find(item => item.id === id)!.timelineStart]));
    const shift = 5 - trimmed.tracks[0].clips.find(item => item.id === "primary")!.timelineStart;
    const moved = await applyEdits(f.path, [{ type: "move_clip", clipId: "primary", timelineStart: 5 }]);
    expect(moved.body.templateFollow.needsReapply).toHaveLength(1);
    const after = await readProject(f.path);
    expect(shift).toBe(2);
    for (const id of f.graphicIds) expect(after.motionGraphics.find(item => item.id === id)!.timelineStart).toBeCloseTo(before.get(id)! + shift, 9);
  }, 120_000);
});
