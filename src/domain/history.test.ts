import { describe, expect, it } from "vitest";
import { createDemoProject } from "./demo";
import type { EditorCommand } from "./commandTypes";
import { createHistory, dispatchCommand, dispatchCommandSafely, redo, undo } from "./history";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM } from "./types";

describe("editor history persistence metadata", () => {
  it("keeps the latest disk revision across undo and redo", () => {
    const edited = dispatchCommand(createHistory(createDemoProject()), { type: "rename_project", name: "Edited" });
    const saved = { ...edited, present: { ...edited.present, revision: 7 } };
    const undone = undo(saved);
    expect(undone.present).toMatchObject({ revision: 7 });
    const redone = redo(undone);
    expect(redone.present).toMatchObject({ revision: 7, name: "Edited" });
  });

  it("keeps the editor mounted state when a command is invalid", () => {
    const initial = createHistory(createDemoProject());
    const clip = initial.present.tracks.flatMap((track) => track.clips)[0];
    const result = dispatchCommandSafely(initial, { type: "trim_clip_end", clipId: clip.id, seconds: clip.duration });
    expect(result.state).toBe(initial);
    expect(result.error).toContain("裁掉長度");
  });

  it("records, undoes and redoes a single-child add-clip batch without cloning untouched project branches",()=>{
    const initial=createHistory(createDemoProject());
    const command:EditorCommand={type:"batch",commands:[{type:"add_clip",clip:{id:"history-added",assetId:"asset-demo",trackId:"video-main",timelineStart:12,sourceStart:0,duration:1,volume:1,transform:{...DEFAULT_TRANSFORM},color:{...DEFAULT_COLOR},keyframes:[],layer:{...DEFAULT_CLIP_LAYER}}}]};
    const changed=dispatchCommand(initial,command,"add-existing-asset");
    expect(changed.present.assets).toBe(initial.present.assets);expect(changed.present.tracks[1]).toBe(initial.present.tracks[1]);expect(changed.journal).toHaveLength(1);
    const undone=undo(changed);expect(undone.present.tracks[0].clips).toHaveLength(1);
    const redone=redo(undone);expect(redone.present.tracks[0].clips.at(-1)?.id).toBe("history-added");
  });
});
