import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { applyCommand } from "../domain/commands";
import { createHistory, dispatchCommand, undo } from "../domain/history";
import { createProjectSession } from "./projectSession";
import { parseProject } from "./projectFiles";
import type { MediaAsset } from "../domain/types";
import { planImportedMediaTimeline } from "./timelineImport";

const asset = (id = "drop-source", duration = 2.017): MediaAsset => ({ id, name: "Controlled fractional-duration source", kind: "video", uri: `${id}.mp4`, duration, width: 540, height: 960 });
const ids = () => { let n = 0; return (prefix: string) => `${prefix}-drop-${++n}`; };
const clips = (project: ReturnType<typeof createDemoProject>) => project.tracks.flatMap(track => track.clips);

describe("import drop intent through actual command/session persistence (not native input)", () => {
  it("retains a second-track frame300 drop without replacing starter or resizing canvas", () => {
    const project = createDemoProject();
    project.tracks.push({ id: "video-second", name: "Second", kind: "video", locked: false, muted: false, clips: [] });
    const plan = planImportedMediaTimeline(project, [asset()], { trackId: "video-second", trackKind: "video", timelineStart: 10 }, ids());
    const applied = applyCommand(project, plan.command), inserted = clips(applied).find(clip => clip.id === plan.lastClipId)!;
    expect(inserted).toMatchObject({ trackId: "video-second", timelineStart: 10, duration: 2, sourceStart: 0 });
    expect(applied.tracks[0].clips).toEqual(project.tracks[0].clips);
    expect([applied.width, applied.height]).toEqual([project.width, project.height]);
    expect(parseProject(JSON.parse(JSON.stringify(applied))).tracks.find(track => track.id === "video-second")?.clips).toEqual([inserted]);
  });
  it("imports multiple fractional sources in complete frames with one undo", () => {
    const project = createDemoProject();
    const plan = planImportedMediaTimeline(project, [asset(), asset("second-source", 1.999)], { trackId: "video-main", trackKind: "video", timelineStart: 5 }, ids());
    const state = dispatchCommand(createHistory(project), plan.command);
    const inserted = clips(state.present).filter(clip => clip.id !== "clip-demo");
    expect(inserted.map(clip => clip.timelineStart)).toEqual([5, 7]);
    expect(inserted.map(clip => clip.duration)).toEqual([2, 59 / 30]);
    for (const clip of inserted) expect(clip.timelineStart * project.fps).toBeCloseTo(Math.round(clip.timelineStart * project.fps), 9);
    expect(state.past).toHaveLength(1);
    expect(undo(state).present).toEqual(project);
  });
  it("uses the live project after async probing instead of resurrecting an unlocked old target", () => {
    const session = createProjectSession(createDemoProject());
    const intent = Object.freeze({ trackId: "video-main", trackKind: "video" as const, timelineStart: 3 });
    session.setHistory(history => dispatchCommand(history, { type: "toggle_track_lock", trackId: "video-main" }));
    const before = session.getSnapshot();
    expect(() => planImportedMediaTimeline(before.history.present, [asset()], intent, ids())).toThrow(/鎖定/);
    expect(session.getSnapshot()).toBe(before);
    expect(before.history.present.assets.some(item => item.id === "drop-source")).toBe(false);
  });
  it("rejects changed track kinds and mixed imports atomically without phantom assets", () => {
    const project = createDemoProject();
    const intent = { trackId: "video-main", trackKind: "video" as const, timelineStart: 4 };
    const audio: MediaAsset = { ...asset("sound"), kind: "audio" };
    expect(() => planImportedMediaTimeline(project, [asset(), audio], intent, ids())).toThrow(/種類不同/);
    expect(project.assets.map(item => item.id)).toEqual(["asset-demo"]);
    expect(clips(project)).toHaveLength(1);
    expect(() => planImportedMediaTimeline(project, [asset()], { ...intent, trackId: "missing" }, ids())).toThrow(/刪除/);
  });
  it("default import honestly replaces starter and sets portrait source orientation", () => {
    const project = createDemoProject();
    const plan = planImportedMediaTimeline(project, [asset()], undefined, ids());
    const applied = applyCommand(project, plan.command);
    expect(applied.assets.map(item => item.id)).toEqual(["drop-source"]);
    expect([applied.width, applied.height]).toEqual([1080, 1920]);
    expect(clips(applied)[0]).toMatchObject({ timelineStart: 0, duration: 2 });
    expect(project.assets.map(item => item.id)).toEqual(["asset-demo"]);
  });
  it("default append skips locked tracks and never rounds backwards into fractional clip ends", () => {
    const project = parseProject(createDemoProject());
    project.assets[0].id = "owned-source"; project.tracks[0].clips[0].assetId = "owned-source";
    project.tracks[0].locked = true;
    project.tracks[0].clips[0].duration = 2.017;
    const applied = applyCommand(project, planImportedMediaTimeline(project, [asset()], undefined, ids()).command);
    const inserted = clips(applied).find(clip => clip.assetId === "drop-source")!;
    expect(inserted.trackId).not.toBe("video-main");
    expect(inserted.timelineStart).toBe(61 / 30);
    expect(applied.tracks[0]).toEqual(project.tracks[0]);
  });
  it("retains newer drop position when a previous save completes late", () => {
    const session = createProjectSession(createDemoProject());
    const save = session.beginSave(true)!;
    const plan = planImportedMediaTimeline(session.getSnapshot().history.present, [asset()], { trackId: "video-main", trackKind: "video", timelineStart: 9 }, ids());
    session.setHistory(history => dispatchCommand(history, plan.command));
    session.completeSave(save, { canceled: false, path: "D:/controlled-fixture-only.json", project: { ...save.project, revision: save.project.revision + 1 } });
    session.finishSave(save);
    expect(clips(session.getSnapshot().history.present).find(clip => clip.id === plan.lastClipId)?.timelineStart).toBe(9);
    expect(session.getSnapshot().dirty).toBe(true);
  });
  it("rejects subframe source and invalid positions before returning an import command", () => {
    const project = createDemoProject();
    expect(() => planImportedMediaTimeline(project, [asset("too-short", 0.01)], undefined, ids())).toThrow(/影格/);
    for (const timelineStart of [-1, NaN, Infinity]) expect(() => planImportedMediaTimeline(project, [asset()], { trackId: "video-main", trackKind: "video", timelineStart }, ids())).toThrow(/落點/);
    expect(project.assets).toHaveLength(1);
  });
});
