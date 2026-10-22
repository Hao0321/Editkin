import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyCommand } from "./commands";
import { createDemoProject } from "./demo";
import { migrateProject, validateProject } from "./editGraph";
import { createHistory, dispatchCommand, undo } from "./history";
import { editorCommandSchema } from "./schema";
import { trackAudioAudible } from "./trackState";

describe("track solo and legacy project compatibility", () => {
  it("opens a frozen r56 project with no solo fields without changing its JSON or sound policy", () => {
    const old = JSON.parse(readFileSync(new URL("./fixtures/r57SoloLegacy.json", import.meta.url), "utf8"));
    const project = validateProject(migrateProject(old));
    expect(JSON.parse(JSON.stringify(project))).toEqual(old);
    expect(project.tracks.every(track => !Object.hasOwn(track, "solo"))).toBe(true);
    expect(project.tracks.map(track => trackAudioAudible(project, track))).toEqual(project.tracks.map(track => track.kind !== "caption" && !track.muted));
  });
  it("accepts the additive command schema and restores the absent field with one Undo", () => {
    const project = createDemoProject(), command = editorCommandSchema.parse({ type: "set_track_solo", trackId: project.tracks[0].id, solo: true });
    const state = dispatchCommand(createHistory(project), command);
    expect(state.past).toHaveLength(1); expect(state.present.tracks[0].solo).toBe(true);
    expect(undo(state).present.tracks).toEqual(project.tracks);
    expect(applyCommand(state.present, { type: "set_track_solo", trackId: project.tracks[0].id, solo: false }).tracks[0].solo).toBe(false);
  });
  it("refuses missing, caption and non-boolean solo settings without editing the source", () => {
    const project = createDemoProject(), before = JSON.stringify(project), caption = project.tracks.find(track => track.kind === "caption")!;
    expect(() => applyCommand(project, { type: "set_track_solo", trackId: "missing", solo: true })).toThrow("找不到");
    expect(() => applyCommand(project, { type: "set_track_solo", trackId: caption.id, solo: true })).toThrow("字幕軌");
    expect(editorCommandSchema.safeParse({ type: "set_track_solo", trackId: project.tracks[0].id, solo: 1 }).success).toBe(false);
    expect(JSON.stringify(project)).toBe(before);
  });
  it("can change sound monitoring on a locked track without changing its picture or clips", () => {
    const project = createDemoProject(); project.tracks[0].locked = true; project.tracks[0].hidden = false;
    const next = applyCommand(project, { type: "set_track_solo", trackId: project.tracks[0].id, solo: true });
    expect(next.tracks[0]).toEqual({ ...project.tracks[0], solo: true });
  });
});
