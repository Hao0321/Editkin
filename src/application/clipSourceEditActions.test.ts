import { describe, expect, it } from "vitest";
import type { EditorCommand } from "../domain/commandTypes";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { createHistory, dispatchCommandSafely, undo, type EditorHistory } from "../domain/history";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type TimelineClip } from "../domain/types";
import { createClipSourceEditActions } from "./clipSourceEditActions";

function clip(id: string, timelineStart: number, sourceStart: number, duration: number): TimelineClip {
  return { id, assetId: "source", trackId: "video-main", timelineStart, sourceStart, duration, volume: 1,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], layer: { ...DEFAULT_CLIP_LAYER } };
}
function host(project: EditProject) {
  let history: EditorHistory = createHistory(project);
  const statuses: string[] = [], commands: EditorCommand[] = [];
  const actions = createClipSourceEditActions({
    getProject: () => history.present,
    runCommand: (command, message) => {
      commands.push(command);
      const result = dispatchCommandSafely(history, command, `cmd-${commands.length}`);
      history = result.state;
      statuses.push(result.error ?? message ?? "");
      return !result.error;
    },
    setStatus: message => statuses.push(message),
  });
  return { actions, statuses, commands, history: () => history };
}
function fixture(): EditProject {
  const project = createEmptyProject("Actions", { id: "actions", fps: 30 });
  project.assets = [{ id: "source", name: "Source.mp4", kind: "video", uri: "C:/owned/source.mp4", duration: 20, width: 1920, height: 1080 }];
  project.tracks[0].clips = [clip("A", 0, 4, 3), clip("B", 3, 10, 2)];
  return validateProject(project);
}

describe("clip source edit actions", () => {
  it("commits a drag extension as one frame-aligned command and says what moved", () => {
    const f = host(fixture());
    expect(f.actions.extendClip("A", "end", 0.5)).toBe(true);
    expect(f.commands).toEqual([{ type: "extend_clip", clipId: "A", edge: "end", seconds: 0.5 }]);
    expect(f.statuses.at(-1)).toBe("已把片段結尾延長 0.50 秒，後面的內容一起往後移 0.50 秒；一次復原即可還原。");
    expect(f.history().past).toHaveLength(1);
    expect(undo(f.history()).present).toEqual(f.history().past[0]);
  });

  it("explains a start that grew later because the previous clip leaves no room", () => {
    const f = host(fixture());
    expect(f.actions.extendClip("B", "start", 1)).toBe(true);
    expect(f.statuses.at(-1)).toBe("已把片段開頭延長 1.00 秒；前面沒有空位，片段改往後長。一次復原即可還原。");
  });

  it("refuses without a command when the media has no more frames", () => {
    const f = host(fixture());
    expect(f.actions.extendClip("A", "start", 5)).toBe(false);
    expect(f.commands).toEqual([]);
    expect(f.statuses).toEqual(["開頭最多只能再延長 4.00 秒：素材在這之前沒有更多畫面。"]);
  });

  it("changes the in-point once and reports the new source start", () => {
    const f = host(fixture());
    expect(f.actions.slipClip("A", 6)).toBe(true);
    expect(f.commands).toEqual([{ type: "slip_clip", clipId: "A", sourceStart: 6 }]);
    expect(f.statuses.at(-1)).toBe("已換入點：素材改從 6.00 秒開始；片段位置和長度不變，一次復原即可還原。");
    expect(f.actions.slipClip("A", 18)).toBe(false);
    expect(f.statuses.at(-1)).toMatch(/最晚只能從 17\.00 秒開始/);
    expect(f.commands).toHaveLength(1);
  });

  it("reads the live project at release, not a copy captured earlier", () => {
    const f = host(fixture());
    f.actions.slipClip("A", 6);
    // The second identical request sees the already-changed project and makes no phantom Undo step.
    expect(f.actions.slipClip("A", 6)).toBe(false);
    expect(f.statuses.at(-1)).toBe("入點沒有改變。");
    expect(f.history().past).toHaveLength(1);
  });
});
