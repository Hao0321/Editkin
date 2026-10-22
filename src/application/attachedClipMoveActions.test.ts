import { describe, expect, it, vi } from "vitest";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import type { EditorCommand } from "../domain/commandTypes";
import { createHistory, dispatchCommand, undo, type EditorHistory } from "../domain/history";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type TimelineClip } from "../domain/types";
import { createMotionGraphic } from "../motion/composition";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULT_REFERENCE_MOTION_STYLE, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { preparePhysicalFace, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { parseProject } from "./projectCodec";
import { inspectReferenceMotionTemplateInstance, prepareReferenceMotionTemplateInstance } from "./referenceMotionTemplateInstances";
import { createAttachedClipMoveActions } from "./attachedClipMoveActions";

// Real EditGraph commands and history; the host is a plain object like EditorShell's.
function clip(id: string, timelineStart: number, duration: number): TimelineClip {
  return { id, assetId: "source", trackId: "video-main", timelineStart, sourceStart: 1, duration, volume: 1, transform: { ...DEFAULT_TRANSFORM },
    color: { ...DEFAULT_COLOR }, keyframes: [], layer: { ...DEFAULT_CLIP_LAYER } };
}
function base(): EditProject {
  const project = createEmptyProject("Inspector move", { id: "inspector-move", width: 1080, height: 1920, fps: 30 });
  project.assets = [{ id: "source", name: "旅行.mp4", kind: "video", uri: "D:/owned/trip.mp4", duration: 30, width: 1080, height: 1920,
    displayAspectRatio: 9 / 16, color: { interpretation: "rec709" } }];
  project.tracks[0].clips = [clip("A", 0, 4), clip("B", 4, 4)];
  return validateProject(project);
}
function withTitle(project: EditProject): EditProject {
  return applyCommand(project, { type: "add_motion_graphic", graphic: createMotionGraphic("on-a", "title", "第一段", 1, 2) });
}
let made = 0;
const makeId = (kind: string) => `${kind}-made-${++made}`;

// Real bundled glyph bytes for a template laid out again by the real compiler.
const faces = new Map<string, Promise<(text: string) => PreparedGlyphRun>>();
async function physicalText(faceId: string, text: string) {
  let face = faces.get(faceId);
  if (!face) {
    face = readFile(join(resolve("public/fonts"), bundledFontFaceSpec(faceId).fontFile)).then(bytes => preparePhysicalFace(faceId, new Uint8Array(bytes)));
    faces.set(faceId, face);
  }
  return (await face)(text);
}
function host(project: EditProject) {
  const state: { history: EditorHistory } = { history: createHistory(project) };
  const runCommand = vi.fn((command: EditorCommand, _message?: string) => { state.history = dispatchCommand(state.history, command); return true; });
  const plainMove = vi.fn((_clipId: string, _start?: number, _trackId?: string) => true);
  const setStatus = vi.fn((_message: string) => undefined);
  const dispose = vi.fn();
  const templateGlyphs = vi.fn(() => ({ prepareText: physicalText, dispose }));
  const actions = createAttachedClipMoveActions({ getProject: () => state.history.present, runCommand, setStatus, plainMove, makeId, templateGlyphs });
  return { state, runCommand, plainMove, setStatus, actions, templateGlyphs, dispose };
}
const startOf = (project: EditProject, id: string) => project.tracks.flatMap(track => track.clips).find(item => item.id === id)!.timelineStart;
const titleStart = (project: EditProject) => project.motionGraphics.find(item => item.id === "on-a")!.timelineStart;

describe("Inspector start-time and layer edits keep titles on their clip", () => {
  it("keeps the editor's own move, at once, for a clip nothing follows", () => {
    const { actions, plainMove, runCommand } = host(base());
    expect(actions.move("A", 10)).toBe(true);
    expect(plainMove).toHaveBeenCalledWith("A", 10, undefined);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("moves the clip and its title in one command; one Undo restores both", async () => {
    const { actions, runCommand, plainMove, state } = host(withTitle(base()));
    await expect(actions.move("A", 10)).resolves.toBe(true);
    expect(plainMove).not.toHaveBeenCalled();
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand.mock.calls[0][1]).toBe("已把片段移到 10.00 秒，上面的標題也一起移動；一次復原即可還原。");
    expect(state.history.past).toHaveLength(1);
    expect(startOf(state.history.present, "A")).toBe(10);
    expect(titleStart(state.history.present)).toBe(11);
    const restored = undo(state.history).present;
    expect(startOf(restored, "A")).toBe(0);
    expect(titleStart(restored)).toBe(1);
  });

  it("applies only the newest of several quick requests for the same clip", async () => {
    const { actions, runCommand, state } = host(withTitle(base()));
    const first = actions.move("A", 10), second = actions.move("A", 12);
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(startOf(state.history.present, "A")).toBe(12);
    expect(titleStart(state.history.present)).toBe(13);
  });

  it("plans again on the live project when it changed while the move was being prepared", async () => {
    const { actions, runCommand, state } = host(withTitle(base()));
    const pending = actions.move("A", 10);
    state.history = dispatchCommand(state.history, { type: "move_clip", clipId: "B", timelineStart: 20 });
    await expect(pending).resolves.toBe(true);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(startOf(state.history.present, "B")).toBe(20);
    expect(startOf(state.history.present, "A")).toBe(10);
    expect(titleStart(state.history.present)).toBe(11);
  });

  it("says why in plain words when the move is refused, and changes nothing", async () => {
    const locked = applyCommand(withTitle(base()), { type: "toggle_track_lock", trackId: "video-main" });
    const { actions, runCommand, setStatus, state } = host(locked);
    await expect(actions.move("A", 10)).resolves.toBe(false);
    expect(runCommand).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus.mock.calls[0][0]).toMatch(/[\u4e00-\u9fff]/);
    expect(state.history.present).toBe(locked);
  });
});

describe("Inspector moves carry captions and keep a title template editable", () => {
  it("moves the captions inside the clip in the same command; one Undo restores them", async () => {
    const project = applyCommand(base(), { type: "batch", commands: [
      { type: "add_caption", caption: { id: "in", text: "第一句", start: 1, duration: 2 } },
      { type: "add_caption", caption: { id: "next", text: "第二句", start: 5, duration: 1 } }] });
    const { actions, runCommand, plainMove, state } = host(project);
    await expect(actions.move("A", 10)).resolves.toBe(true);
    expect(plainMove).not.toHaveBeenCalled();
    expect(runCommand.mock.calls[0][1]).toBe("已把片段移到 10.00 秒，上面的 1 段字幕也一起移動；一次復原即可還原。");
    expect(state.history.past).toHaveLength(1);
    expect(state.history.present.captions.map(caption => [caption.id, caption.start])).toEqual([["next", 5], ["in", 11]]);
    expect(undo(state.history).present.captions.map(caption => [caption.id, caption.start])).toEqual([["in", 1], ["next", 5]]);
  });

  it("a template that opens the video, moved off 0 s from the Inspector, is laid out again and stays editable", async () => {
    const project = createEmptyProject("Inspector template", { id: "inspector-template", width: 1080, height: 1920, fps: 30 });
    project.assets = [{ id: "media-0", name: "蝙蝠洞.mov", kind: "video", uri: "D:/owned/cave.mov", duration: 30, width: 1080, height: 1920,
      displayAspectRatio: 9 / 16, color: { interpretation: "rec709" } }];
    project.tracks[0].clips = [{ ...clip("primary", 0, 11), assetId: "media-0" }];
    const input = { templateId: "strike_reframe", clipId: "primary", startFrame: 0, durationFrames: 330, graphicCadence: "kinetic", intent: "shortform",
      designSystem: "trip_pop_v1", kicker: "桃園復興｜三民蝙蝠洞", previousText: "來看蝙蝠", title: "其實是來看水簾", accentText: "水簾", tag: "沒有蝙蝠",
      sources: [], evidenceRefs: ["owned:fixture"], purpose: "Owned design control" } as ReferenceMotionTemplateInput;
    let next = 0;
    const packet = await prepareReferenceMotionTemplateInstance(parseProject(validateProject(project)), input,
      (kind, role) => `inspector-${kind}-${role ?? ""}-${next++}`, { prepareText: physicalText });
    const current = applyCommand(parseProject(validateProject(project)), { type: "batch", commands: packet.commands });
    const f = host(current);
    await expect(f.actions.move("primary", 1)).resolves.toBe(true);
    expect(f.templateGlyphs).toHaveBeenCalledTimes(1); expect(f.dispose).toHaveBeenCalledTimes(1);
    expect(f.state.history.past).toHaveLength(1);
    expect(f.state.history.present.referenceMotionInstances![0]).toMatchObject({ instanceRevision: 2, input: { startFrame: 30 } });
    expect((await inspectReferenceMotionTemplateInstance(f.state.history.present, packet.instance.id)).status).toBe("CURRENT");
    expect(undo(f.state.history).present.referenceMotionInstances![0]).toEqual(packet.instance);
  }, 120_000);
});

describe("the Inspector's in and out points at the playhead", () => {
  it("runs the ordinary trim at once for a clip without a template", () => {
    const { actions, runCommand, state } = host(base());
    expect(actions.trimAtPlayhead("A", "start", 1)).toBe(true);
    expect(runCommand.mock.calls[0]).toEqual([{ type: "trim_clip_start", clipId: "A", seconds: 1 }, "已把播放頭設為片段入點。"]);
    expect(startOf(state.history.present, "A")).toBe(0);
  });
  it("lays a title template out again on the trimmed clip in the same command; it stays editable and one Undo restores both", async () => {
    const project = createEmptyProject("Inspector trim", { id: "inspector-trim", width: 1080, height: 1920, fps: 30 });
    project.assets = [{ id: "source", name: "旅行.mp4", kind: "video", uri: "D:/owned/trip.mp4", duration: 30, width: 1080, height: 1920,
      displayAspectRatio: 9 / 16, color: { interpretation: "rec709" } }];
    project.tracks[0].clips = [clip("primary", 1, 6)];
    const input = { templateId: "level_bridge", clipId: "primary", startFrame: 30, durationFrames: 180, title: "FOCUS", kicker: "LOOK", purpose: "Owned control",
      evidenceRefs: ["owned:fixture"], graphicCadence: "kinetic", style: { ...structuredClone(DEFAULT_REFERENCE_MOTION_STYLE),
        typography: { headingFamily: "Bebas Neue", bodyFamily: "Bebas Neue" } } } as ReferenceMotionTemplateInput;
    let next = 0;
    const packet = await prepareReferenceMotionTemplateInstance(parseProject(validateProject(project)), input,
      (kind, role) => `trim-${kind}-${role ?? ""}-${next++}`, { prepareText: physicalText });
    const f = host(applyCommand(parseProject(validateProject(project)), { type: "batch", commands: packet.commands }));
    await expect(f.actions.trimAtPlayhead("primary", "start", 1)).resolves.toBe(true);
    expect(f.runCommand.mock.calls[0][1]).toBe("已修剪片段開頭 1.00 秒，標題模板也照新的長度重新排好；一次復原即可還原。");
    expect(f.state.history.past).toHaveLength(1);
    const trimmed = f.state.history.present;
    // The in point moved: the clip keeps its start and plays from one second later in the media.
    expect(trimmed.tracks[0].clips[0]).toMatchObject({ timelineStart: 1, sourceStart: 2, duration: 5 });
    expect(trimmed.referenceMotionInstances![0]).toMatchObject({ instanceRevision: 2, input: { startFrame: 30, durationFrames: 150 } });
    expect((await inspectReferenceMotionTemplateInstance(trimmed, packet.instance.id)).status).toBe("CURRENT");
    expect(undo(f.state.history).present.referenceMotionInstances![0]).toEqual(packet.instance);
  }, 120_000);
});
