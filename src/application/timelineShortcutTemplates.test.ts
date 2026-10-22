import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createEmptyProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import { createHistory, dispatchCommand, undo } from "../domain/history";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { DEFAULT_REFERENCE_MOTION_STYLE } from "../motion/referenceMotionTemplates";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { preparePhysicalFace } from "../typography/preparedGlyphRun";
import { decodeProjectBytes, encodeProjectBytes, parseProject } from "./projectCodec";
import { inspectReferenceMotionTemplateInstance, prepareReferenceMotionTemplateInstance } from "./referenceMotionTemplateInstances";
import { createTimelineShortcutActions, SHORTCUT_CHANGED, type TimelineShortcutHost } from "./timelineShortcutActions";
import type { TimelineSelection } from "./timelineSelection";
import type { TimelineClipboard } from "./timelineClipboard";
import { createTimelineNudgeQueue } from "./timelineNudgeQueue";

const faces = new Map<string, Promise<Awaited<ReturnType<typeof preparePhysicalFace>>>>();
async function physicalText(faceId: string, text: string) {
  let face = faces.get(faceId);
  if (!face) {
    face = readFile(join(resolve("public/fonts"), bundledFontFaceSpec(faceId).fontFile)).then(bytes => preparePhysicalFace(faceId, new Uint8Array(bytes)));
    faces.set(faceId, face);
  }
  return (await face)(text);
}

async function fixture() {
  const project = createEmptyProject("Owned B1 fixture", { id: "owned-b1", width: 1080, height: 1920, fps: 30 });
  project.assets = [{ id: "source", name: "Source", kind: "video", uri: "D:/owned/source.mp4", duration: 30,
    width: 1080, height: 1920, displayAspectRatio: 9 / 16, color: { interpretation: "rec709" } }];
  project.tracks[0].clips = [
    { id: "before", timelineStart: 0, duration: 1 }, { id: "primary", timelineStart: 1, duration: 6 }, { id: "after", timelineStart: 12, duration: 2 },
  ].map(clip => ({ ...clip, trackId: "video-main", assetId: "source", sourceStart: 1, volume: 1,
    transform: structuredClone(DEFAULT_TRANSFORM), color: structuredClone(DEFAULT_COLOR), keyframes: [], layer: structuredClone(DEFAULT_CLIP_LAYER) }));
  let id = 0;
  const makeId = (kind: string) => `${kind}-owned-${++id}`;
  const packet = await prepareReferenceMotionTemplateInstance(parseProject(project), {
    templateId: "level_bridge", clipId: "primary", startFrame: 30, durationFrames: 180, title: "FOCUS", kicker: "LOOK",
    purpose: "Owned B1 control", evidenceRefs: ["owned:b1"], graphicCadence: "kinetic",
    style: { ...structuredClone(DEFAULT_REFERENCE_MOTION_STYLE), typography: { headingFamily: "Bebas Neue", bodyFamily: "Bebas Neue" } },
  }, makeId, { prepareText: physicalText });
  const current = applyCommand(parseProject(project), { type: "batch", commands: packet.commands });
  return { current, instanceId: packet.instance.id, makeId };
}

function owner(project: EditProject, makeId: (kind: string) => string) {
  let history = createHistory(project), selection: TimelineSelection = { clipIds: ["primary", "after"], captionIds: [], primaryClipId: "primary" };
  let clipboard: TimelineClipboard | undefined, status = "", disposals = 0;
  const host: TimelineShortcutHost = {
    getProject: () => history.present,
    runCommand: (command, message, options) => { history = dispatchCommand(history, command, "owned-key", undefined, options?.coalesce); status = message ?? ""; return true; },
    setStatus: value => { status = value; }, templateGlyphs: () => ({ prepareText: physicalText, dispose: () => { disposals++; } }),
    getSelection: () => selection, setSelection: value => { selection = value; },
    getClipboard: () => clipboard, setClipboard: value => { clipboard = value; },
    getPlayhead: () => 0, setPlayhead: () => {}, pause: () => {}, getMarkRange: () => ({}), setMarkRange: () => {}, playRange: () => {},
    view: () => {}, simpleMode: () => true, escapeTool: () => false, clearMotionSelection: () => false,
    deleteMotionSelection: () => false, nudgeMotionSelection: () => false, nudgeSequence: { current: 0 }, nudgeQueue: createTimelineNudgeQueue(),
    makeId, defaultMarkerTitle: () => "Marker",
  };
  return { host, actions: createTimelineShortcutActions(host), get history() { return history; }, get status() { return status; }, get disposals() { return disposals; } };
}

describe("B1 selection edits use the real saved-template compiler and glyph bytes", () => {
  it("a group nudge is one Undo and keeps the title CURRENT after save/reopen", async () => {
    const saved = await fixture(), editor = owner(saved.current, saved.makeId);
    expect((await inspectReferenceMotionTemplateInstance(saved.current, saved.instanceId)).status).toBe("CURRENT");
    editor.actions["nudge-forward"]!({ repeat: false });
    await vi.waitFor(() => expect(editor.history.past).toHaveLength(1), { timeout: 15000, interval: 10 });
    expect(editor.history.present.tracks[0].clips.find(clip => clip.id === "primary")!.timelineStart).toBe(31 / 30);
    expect(editor.history.present.tracks[0].clips.find(clip => clip.id === "after")!.timelineStart).toBe(361 / 30);
    expect((await inspectReferenceMotionTemplateInstance(editor.history.present, saved.instanceId)).status).toBe("CURRENT");
    const reopened = decodeProjectBytes(encodeProjectBytes(editor.history.present));
    expect((await inspectReferenceMotionTemplateInstance(reopened, saved.instanceId)).status).toBe("CURRENT");
    const restored = undo(editor.history).present;
    expect(restored.referenceMotionInstances).toEqual(saved.current.referenceMotionInstances);
    expect(restored.tracks).toEqual(saved.current.tracks);
  });

  it("a multi-delete ripples a surviving title and deletes a later selected clip in one Undo", async () => {
    const saved = await fixture(), editor = owner(saved.current, saved.makeId);
    editor.host.setSelection({ clipIds: ["before", "after"], captionIds: [], primaryClipId: "before" });
    editor.actions.delete!({ repeat: false });
    await vi.waitFor(() => expect(editor.history.past).toHaveLength(1), { timeout: 15000, interval: 10 });
    expect(editor.history.present.tracks[0].clips.map(clip => clip.id)).toEqual(["primary"]);
    expect(editor.history.present.tracks[0].clips[0].timelineStart).toBe(0);
    expect((await inspectReferenceMotionTemplateInstance(editor.history.present, saved.instanceId)).status).toBe("CURRENT");
    expect(undo(editor.history).present.tracks).toEqual(saved.current.tracks);
  });

  it("a duplicate omits the title recipe and generated layers, leaving the original title CURRENT", async () => {
    const saved = await fixture(), editor = owner(saved.current, saved.makeId);
    editor.actions.duplicate!({ repeat: false });
    await vi.waitFor(() => expect(editor.history.past).toHaveLength(1), { timeout: 15000, interval: 10 });
    expect(editor.history.present.referenceMotionInstances).toHaveLength(1);
    expect(editor.history.present.motionGraphics).toEqual(saved.current.motionGraphics);
    expect(editor.host.getSelection().clipIds).toHaveLength(2);
    expect(editor.status).toContain("標題模板沒有一起複製。");
    expect((await inspectReferenceMotionTemplateInstance(editor.history.present, saved.instanceId)).status).toBe("CURRENT");
    expect(undo(editor.history).present.tracks).toEqual(saved.current.tracks);
  });

  it("a live project change cancels an asynchronous template edit before it can commit", async () => {
    const saved = await fixture(), editor = owner(saved.current, saved.makeId);
    editor.actions["nudge-forward"]!({ repeat: false });
    editor.host.runCommand({ type: "add_director_marker", marker: { id: "other-edit", time: 0, title: "Other edit", note: "",
      kind: "note", status: "open", createdAt: "2026-10-11T05:00:00Z" } });
    await vi.waitFor(() => expect(editor.status).toBe(SHORTCUT_CHANGED), { timeout: 15000, interval: 10 });
    expect(editor.history.past).toHaveLength(1);
    expect(editor.history.present.tracks).toEqual(saved.current.tracks);
    expect(editor.history.present.referenceMotionInstances).toEqual(saved.current.referenceMotionInstances);
  });

  it("held nudges survive per-render handler replacement, move every requested frame, and remain one Undo", async () => {
    const saved = await fixture(), editor = owner(saved.current, saved.makeId);
    editor.actions["nudge-forward"]!({ repeat: false });
    const nextRender = createTimelineShortcutActions(editor.host);
    nextRender["nudge-forward"]!({ repeat: true }); nextRender["nudge-forward"]!({ repeat: true });
    await vi.waitFor(() => expect(editor.disposals).toBe(3), { timeout: 15000, interval: 10 });
    expect(editor.history.present.tracks[0].clips.find(clip => clip.id === "primary")!.timelineStart).toBe(33 / 30);
    expect(editor.history.present.tracks[0].clips.find(clip => clip.id === "after")!.timelineStart).toBe(363 / 30);
    expect(editor.history.past).toHaveLength(1);
    expect((await inspectReferenceMotionTemplateInstance(editor.history.present, saved.instanceId)).status).toBe("CURRENT");
    expect(undo(editor.history).present.tracks).toEqual(saved.current.tracks);
  });

  it("a project change clears all queued held nudges instead of applying them to the newer project", async () => {
    const saved = await fixture(), editor = owner(saved.current, saved.makeId);
    for (let index = 0; index < 3; index++) editor.actions["nudge-forward"]!({ repeat: index > 0 });
    editor.host.runCommand({ type: "add_director_marker", marker: { id: "changed-during-hold", time: 0, title: "Other edit", note: "",
      kind: "note", status: "open", createdAt: "2026-10-11T05:00:00Z" } });
    await vi.waitFor(() => expect(editor.status).toBe(SHORTCUT_CHANGED), { timeout: 15000, interval: 10 });
    expect(editor.disposals).toBe(1);
    expect(editor.history.past).toHaveLength(1);
    expect(editor.history.present.tracks).toEqual(saved.current.tracks);
  });

  it("an unexpected asynchronous template error reports the refusal and drops the remaining held edits", async () => {
    const saved = await fixture(), editor = owner(saved.current, saved.makeId);
    let disposals = 0;
    editor.host.templateGlyphs = () => ({ prepareText: physicalText, dispose: () => { disposals++; throw new Error("Template fixture failure"); } });
    for (let index = 0; index < 3; index++) editor.actions["nudge-forward"]!({ repeat: index > 0 });
    await vi.waitFor(() => expect(editor.status).toBe("Template fixture failure"), { timeout: 15000, interval: 10 });
    expect(disposals).toBe(1); expect(editor.history.past).toHaveLength(0);
    expect(editor.history.present).toEqual(saved.current);
  });
});
