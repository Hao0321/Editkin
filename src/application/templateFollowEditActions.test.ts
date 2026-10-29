import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import type { EditorCommand } from "../domain/commandTypes";
import { createHistory, dispatchCommand, undo, type EditorHistory } from "../domain/history";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type TimelineClip } from "../domain/types";
import { DEFAULT_REFERENCE_MOTION_STYLE, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { preparePhysicalFace, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { parseProject } from "./projectCodec";
import { inspectReferenceMotionTemplateInstance, prepareReferenceMotionTemplateInstance } from "./referenceMotionTemplateInstances";
import { createClipSourceEditActions, EXTEND_KEEPS_CHANGING } from "./clipSourceEditActions";
import { createTemplateFollowEditActions, RIPPLE_DELETE_DONE, SPLIT_KEEPS_CHANGING } from "./templateFollowEditActions";
import { templateFollowProgress } from "./templateFollowProgress";

// Real EditGraph commands, history, compiler and glyph bytes; the host is a plain object like the editor's.
const faces = new Map<string, Promise<(text: string) => PreparedGlyphRun>>();
async function physicalText(faceId: string, text: string) {
  let face = faces.get(faceId);
  if (!face) {
    face = readFile(join(resolve("public/fonts"), bundledFontFaceSpec(faceId).fontFile)).then(bytes => preparePhysicalFace(faceId, new Uint8Array(bytes)));
    faces.set(faceId, face);
  }
  return (await face)(text);
}
function clip(id: string, timelineStart: number, duration: number): TimelineClip {
  return { id, assetId: "source", trackId: "video-main", timelineStart, sourceStart: 1, duration, volume: 1, transform: { ...DEFAULT_TRANSFORM },
    color: { ...DEFAULT_COLOR }, keyframes: [], layer: { ...DEFAULT_CLIP_LAYER } };
}
/** [before 1–3 s][primary 3–9 s] … [after 12–14 s], a FOCUS title template on primary. */
async function project(): Promise<EditProject> {
  const value = createEmptyProject("Gestures", { id: "gestures", width: 1080, height: 1920, fps: 30 });
  value.assets = [{ id: "source", name: "旅行.mp4", kind: "video", uri: "D:/owned/trip.mp4", duration: 30, width: 1080, height: 1920,
    displayAspectRatio: 9 / 16, color: { interpretation: "rec709" } }];
  value.tracks[0].clips = [clip("before", 1, 2), clip("primary", 3, 6), clip("after", 12, 2)];
  const input: ReferenceMotionTemplateInput = { templateId: "level_bridge", clipId: "primary", startFrame: 90, durationFrames: 180, title: "FOCUS", kicker: "LOOK",
    purpose: "Owned control", evidenceRefs: ["owned:fixture"], graphicCadence: "kinetic",
    style: { ...structuredClone(DEFAULT_REFERENCE_MOTION_STYLE), typography: { headingFamily: "Bebas Neue", bodyFamily: "Bebas Neue" } } };
  let next = 0;
  const packet = await prepareReferenceMotionTemplateInstance(parseProject(validateProject(value)), input, (kind, role) => `gesture-${kind}-${role ?? ""}-${next++}`,
    { prepareText: physicalText });
  return applyCommand(parseProject(validateProject(value)), { type: "batch", commands: packet.commands });
}
function host(initial: EditProject) {
  const state: { history: EditorHistory } = { history: createHistory(initial) };
  const runCommand = vi.fn((command: EditorCommand, _message?: string) => { state.history = dispatchCommand(state.history, command); return true; });
  const setStatus = vi.fn((_message: string) => undefined);
  const dispose = vi.fn();
  const templateGlyphs = vi.fn(() => ({ prepareText: physicalText, dispose }));
  const value = { getProject: () => state.history.present, runCommand, setStatus, templateGlyphs };
  return { state, runCommand, setStatus, dispose, templateGlyphs, edits: createTemplateFollowEditActions(value), sources: createClipSourceEditActions(value) };
}
const templateOf = (value: EditProject) => value.referenceMotionInstances![0];
const current = async (value: EditProject) => (await inspectReferenceMotionTemplateInstance(value, templateOf(value).id)).status;

describe("the editor's split and delete keep title templates editable", () => {
  it("runs an ordinary split and delete at once, exactly as before", async () => {
    const f = host(await project());
    expect(f.edits.split("after", 13, "after-tail")).toBe(true);
    expect(f.runCommand).toHaveBeenLastCalledWith({ type: "split_clip", clipId: "after", at: 13, newClipId: "after-tail" }, "已在 13.00 秒分割。");
    expect(f.edits.rippleDelete("after-tail")).toBe(true);
    expect(f.runCommand).toHaveBeenLastCalledWith({ type: "ripple_delete_clip", clipId: "after-tail" }, RIPPLE_DELETE_DONE);
    expect(f.templateGlyphs).not.toHaveBeenCalled();
  }, 60_000);

  it("splits a template's clip in one command, says so while it works, and one Undo restores it", async () => {
    const start = await project(), f = host(start);
    const pending = f.edits.split("primary", 8, "tail");
    expect(pending).toBeInstanceOf(Promise);
    expect(templateFollowProgress().pending).toBe(true);
    await expect(pending).resolves.toBe(true);
    expect(templateFollowProgress().pending).toBe(false);
    expect(f.templateGlyphs).toHaveBeenCalledOnce(); expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.runCommand.mock.calls[0][1]).toBe("已在 8.00 秒切開片段，標題模板留在前一段，照新的長度重新排好；一次復原即可還原。");
    expect(f.state.history.past).toHaveLength(1);
    expect(templateOf(f.state.history.present).input).toMatchObject({ clipId: "primary", startFrame: 90, durationFrames: 150 });
    expect(await current(f.state.history.present)).toBe("CURRENT");
    const restored = undo(f.state.history).present;
    expect(templateOf(restored)).toEqual(templateOf(start));
    expect(restored.tracks).toEqual(start.tracks);
    expect(restored.motionGraphics).toEqual(start.motionGraphics);
  }, 120_000);

  it("a ripple delete carries the template along in one command", async () => {
    const f = host(await project());
    await expect(f.edits.rippleDelete("before")).resolves.toBe(true);
    expect(f.runCommand.mock.calls[0][1]).toBe("已刪除片段並自動補上空隙，後面的標題模板也跟著移好；一次復原即可還原。");
    expect(templateOf(f.state.history.present).input.startFrame).toBe(30);
    expect(await current(f.state.history.present)).toBe("CURRENT");
  }, 120_000);

  it("applies nothing when the project changed while the template was being laid out (an Undo, say), and says so", async () => {
    const f = host(await project());
    const pending = f.edits.split("primary", 8, "tail");
    f.state.history = dispatchCommand(f.state.history, { type: "move_clip", clipId: "after", timelineStart: 20 });
    // At the work's next pause point its hint goes away and the work is cancelled.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(templateFollowProgress()).toMatchObject({ visible: false });
    await expect(pending).resolves.toBe(false);
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.setStatus).toHaveBeenCalledExactlyOnceWith(SPLIT_KEEPS_CHANGING);
    expect(f.dispose).toHaveBeenCalledOnce();
  }, 120_000);
});

describe("a new in-point and a longer clip keep title templates editable", () => {
  it("slips a template's clip in one command; an ordinary clip slips at once", async () => {
    const f = host(await project());
    expect(f.sources.slipClip("after", 3)).toBe(true);
    expect(f.runCommand).toHaveBeenLastCalledWith({ type: "slip_clip", clipId: "after", sourceStart: 3 },
      "已換入點：素材改從 3.00 秒開始；片段位置和長度不變，一次復原即可還原。");
    const pending = f.sources.slipClip("primary", 4);
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).resolves.toBe(true);
    expect(f.runCommand.mock.calls[1][1]).toBe("已換入點：素材改從 4.00 秒開始，片段位置和長度不變，標題模板也照新的畫面重新排好；一次復原即可還原。");
    expect(f.state.history.past).toHaveLength(2);
    expect(await current(f.state.history.present)).toBe("CURRENT");
  }, 120_000);

  it("an extension that pushes the template later moves it along in one command", async () => {
    const f = host(await project());
    await expect(f.sources.extendClip("before", "end", 1)).resolves.toBe(true);
    expect(f.runCommand.mock.calls[0][1]).toBe("已把片段結尾延長 1.00 秒，後面的內容一起往後移，標題模板也跟著移好；一次復原即可還原。");
    expect(templateOf(f.state.history.present).input.startFrame).toBe(120);
    expect(await current(f.state.history.present)).toBe("CURRENT");
    const changed = host(await project());
    const pending = changed.sources.extendClip("before", "end", 1);
    changed.state.history = dispatchCommand(changed.state.history, { type: "move_clip", clipId: "after", timelineStart: 20 });
    await expect(pending).resolves.toBe(false);
    expect(changed.setStatus).toHaveBeenCalledExactlyOnceWith(EXTEND_KEEPS_CHANGING);
  }, 120_000);
});
