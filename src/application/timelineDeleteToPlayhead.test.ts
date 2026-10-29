import { describe, expect, it, vi } from "vitest";
import type { EditorCommand } from "../domain/commandTypes";
import { applyCommand } from "../domain/commands";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { createHistory, dispatchCommandSafely, undo } from "../domain/history";
import { TRACK_LOCKED_MESSAGE } from "../domain/trackLock";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type TimelineClip } from "../domain/types";
import { createTemplateFollowEditActions, splitManyDone } from "./templateFollowEditActions";
import { DELETE_LEFT_DONE, DELETE_RIGHT_DONE, DELETE_SIDE_NOTHING_HERE, planDeleteToPlayhead, RIPPLE_NOTES, rippleMessage } from "./timelineRippleEdits";
import { findSplitTarget } from "./timelineSplitTarget";

// Q (delete left) and W (delete right): the part of a clip before or after the playhead goes and the gap closes, as ONE
// command made of the editor's own split and the overlap-safe ripple delete. Real EditGraph commands and history.
const FPS = 30;
function clip(id: string, assetId: string, trackId: string, timelineStart: number, duration: number, sourceStart = 0): TimelineClip {
  return { id, assetId, trackId, timelineStart, sourceStart, duration, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR },
    keyframes: [], layer: { ...DEFAULT_CLIP_LAYER } };
}
/** 主畫面 A[0,4) B[4,8) C[8,12); 聲音 VO1[0,5) VO2[5,9) VO3[9,15); a caption inside B's left part and one after B. */
function project(): EditProject {
  const value = createEmptyProject("QW", { id: "qw", width: 1920, height: 1080, fps: FPS });
  value.assets = [{ id: "cam", name: "cam.mp4", kind: "video", uri: "D:/owned/cam.mp4", duration: 60, width: 1920, height: 1080 },
    { id: "vo", name: "vo.wav", kind: "audio", uri: "D:/owned/vo.wav", duration: 60 }];
  value.tracks[0].clips = [clip("A", "cam", "video-main", 0, 4), clip("B", "cam", "video-main", 4, 4, 10), clip("C", "cam", "video-main", 8, 4, 20)];
  value.tracks[1].clips = [clip("VO1", "vo", "audio-main", 0, 5), clip("VO2", "vo", "audio-main", 5, 4, 5), clip("VO3", "vo", "audio-main", 9, 6, 9)];
  value.captions = [{ id: "in-left", text: "左邊", start: 4.5, duration: 1 }, { id: "later", text: "後面", start: 10, duration: 1 }];
  return validateProject(value);
}
const layout = (value: EditProject) => value.tracks.filter(track => track.kind !== "caption")
  .map(track => track.clips.map(item => `${item.id}[${Math.round(item.timelineStart * FPS)},${Math.round((item.timelineStart + item.duration) * FPS)})@${Math.round(item.sourceStart * FPS)}`).join(" "));
const captions = (value: EditProject) => value.captions.map(item => `${item.id}[${Math.round(item.start * FPS)},${Math.round((item.start + item.duration) * FPS)})`);

describe("Q deletes the part of the clip left of the playhead and closes the gap", () => {
  it("B selected, playhead at 6 s: B's first two seconds go, the rest of 主畫面 moves up 2 s, the voice-over stays; one Undo", () => {
    const before = project();
    const plan = planDeleteToPlayhead(before, 6, "B", "left", "B-rest");
    expect(plan.command.type).toBe("batch");
    expect(plan).toMatchObject({ clipId: "B", start: 4, keptClipId: "B-rest", note: RIPPLE_NOTES.heldAudio,
      message: rippleMessage(DELETE_LEFT_DONE, RIPPLE_NOTES.heldAudio) });
    const history = dispatchCommandSafely(createHistory(before), plan.command);
    expect(history.error).toBeUndefined();
    // The kept piece plays B's source from 12 s (10 s in-point + the 2 s that went) and starts where B started.
    expect(layout(history.state.present)).toEqual(["A[0,120)@0 B-rest[120,180)@360 C[180,300)@600", "VO1[0,150)@0 VO2[150,270)@150 VO3[270,450)@270"]);
    expect(captions(history.state.present)).toEqual(["later[240,270)"]);
    expect(history.state.past).toHaveLength(1);
    expect(undo(history.state).present).toEqual(before);
  });

  // Updated on purpose (P8, 2026-10-22): Q and W now pick exactly the clip Ctrl+B cuts (findSplitTarget), so a selected
  // clip the playhead is outside points at its own track first; before, Q/W jumped straight to 主畫面 (B here).
  it("with nothing selected the clip under the playhead on 主畫面 is the one; a selected clip the playhead is outside points at its own track", () => {
    expect(planDeleteToPlayhead(project(), 2, undefined, "left", "n")).toMatchObject({ clipId: "A", start: 0, keptClipId: "n" });
    expect(planDeleteToPlayhead(project(), 6, "VO1", "left", "n")).toMatchObject({ clipId: "VO2" });
    // A selected sound clip the playhead is inside: that clip, on its own track.
    const plan = planDeleteToPlayhead(project(), 6, "VO2", "left", "VO2-rest");
    expect(layout(applyCommand(project(), plan.command))).toEqual(["A[0,120)@0 B[120,240)@300 C[240,360)@600", "VO1[0,150)@0 VO2-rest[150,240)@180 VO3[240,420)@270"]);
  });
});

describe("W deletes the part of the clip right of the playhead and closes the gap", () => {
  it("B selected, playhead at 6 s: B's last two seconds go and C moves up to 6 s; the voice-over stays; one Undo", () => {
    const before = project();
    const plan = planDeleteToPlayhead(before, 6, "B", "right", "B-tail");
    expect(plan).toMatchObject({ clipId: "B", keptClipId: "B", message: rippleMessage(DELETE_RIGHT_DONE, RIPPLE_NOTES.heldAudio) });
    const history = dispatchCommandSafely(createHistory(before), plan.command);
    expect(layout(history.state.present)).toEqual(["A[0,120)@0 B[120,180)@300 C[180,300)@600", "VO1[0,150)@0 VO2[150,270)@150 VO3[270,450)@270"]);
    expect(captions(history.state.present)).toEqual(["in-left[135,165)", "later[240,270)"]);
    expect(undo(history.state).present).toEqual(before);
  });
});

describe("Q and W refuse in plain words before anything changes", () => {
  it("the playhead on an edge or past the end, and a locked track", () => {
    // At 0 s every clip starts on the edge: nothing to cut. (At 4 s the voice-over VO1 runs across 主畫面's cut, so Q acts on it, as Ctrl+B does.)
    expect(() => planDeleteToPlayhead(project(), 0, undefined, "left", "n")).toThrow(DELETE_SIDE_NOTHING_HERE);
    expect(() => planDeleteToPlayhead(project(), 20, "B", "right", "n")).toThrow(DELETE_SIDE_NOTHING_HERE);
    const locked = project();
    locked.tracks[0].locked = true;
    expect(() => planDeleteToPlayhead(locked, 6, "B", "left", "n")).toThrow(TRACK_LOCKED_MESSAGE);
  });
});

describe("the editor's Q / W and 剪刀 Shift+click actions (no title template involved)", () => {
  const host = (value: EditProject) => ({ getProject: () => value, runCommand: vi.fn((_command: EditorCommand, _message?: string) => true), setStatus: vi.fn() });
  it("Q runs one batch command with its status line, and says why when there is nothing to delete", () => {
    const editor = host(project());
    const run = createTemplateFollowEditActions(editor).deleteToPlayhead("left", 6, "B", "rest");
    expect(run?.ran).toBe(true);
    expect(editor.runCommand).toHaveBeenCalledTimes(1);
    expect(editor.runCommand).toHaveBeenCalledWith(run?.plan.command, rippleMessage(DELETE_LEFT_DONE, RIPPLE_NOTES.heldAudio));
    expect(createTemplateFollowEditActions(editor).deleteToPlayhead("right", 0, undefined, "x")).toBeUndefined();
    expect(editor.setStatus).toHaveBeenCalledWith(DELETE_SIDE_NOTHING_HERE);
    expect(editor.runCommand).toHaveBeenCalledTimes(1);
  });

  it("one cut is the editor's split (the same command and words as 切開); several are one batch of split commands", () => {
    const editor = host(project());
    let next = 0;
    const ids = () => `cut-${next += 1}`;
    expect(createTemplateFollowEditActions(editor).splitMany([{ clipId: "B", at: 6 }], ids)).toBe(true);
    expect(editor.runCommand).toHaveBeenLastCalledWith({ type: "split_clip", clipId: "B", at: 6, newClipId: "cut-1" }, "已在 6.00 秒分割。");
    expect(createTemplateFollowEditActions(editor).splitMany([{ clipId: "B", at: 6 }, { clipId: "VO2", at: 6 }], ids)).toBe(true);
    expect(editor.runCommand).toHaveBeenLastCalledWith({ type: "batch", commands: [{ type: "split_clip", clipId: "B", at: 6, newClipId: "cut-2" },
      { type: "split_clip", clipId: "VO2", at: 6, newClipId: "cut-3" }] }, `${splitManyDone(6, 2)}。`);
    expect(`${splitManyDone(6, 2)}。`).toBe("已在 6.00 秒切開 2 段片段。");
    const history = dispatchCommandSafely(createHistory(project()), editor.runCommand.mock.calls[1][0]);
    expect(history.state.past).toHaveLength(1);
    expect(layout(history.state.present)).toEqual(["A[0,120)@0 B[120,180)@300 cut-2[180,240)@360 C[240,360)@600",
      "VO1[0,150)@0 VO2[150,180)@150 cut-3[180,270)@180 VO3[270,450)@270"]);
  });
});

// P8: one shared fallback. Q and W are a cut plus a ripple delete of one side, so they act on exactly the clip Ctrl+B
// (切開) would cut, or refuse where Ctrl+B refuses (with their own words).
describe("Q and W pick the same clip as Ctrl+B", () => {
  it("everywhere on the timeline, with and without a selection, also next to a locked track", () => {
    const lockedMain = project();
    lockedMain.tracks[0].locked = true;
    for (const value of [project(), lockedMain]) for (const selected of [undefined, "A", "B", "C", "VO1", "VO2", "VO3"]) {
      for (let frame = 0; frame <= 16 * FPS; frame += 5) {
        const at = frame / FPS, cut = findSplitTarget(value, at, selected);
        for (const side of ["left", "right"] as const) {
          if ("target" in cut && !cut.target.track.locked) {
            expect(planDeleteToPlayhead(value, at, selected, side, "n").clipId, `${selected} @${frame}`).toBe(cut.target.clip.id);
          } else {
            const refusal = "target" in cut || cut.refusal === TRACK_LOCKED_MESSAGE ? TRACK_LOCKED_MESSAGE : DELETE_SIDE_NOTHING_HERE;
            expect(() => planDeleteToPlayhead(value, at, selected, side, "n"), `${selected} @${frame}`).toThrow(refusal);
          }
        }
      }
    }
  });

  it("main track locked, nothing selected: Q acts on the unlocked voice-over under the playhead, as Ctrl+B cuts it", () => {
    const value = project();
    value.tracks[0].locked = true;
    expect(planDeleteToPlayhead(value, 6, undefined, "left", "n")).toMatchObject({ clipId: "VO2" });
    expect(findSplitTarget(value, 6, undefined)).toMatchObject({ target: { clip: { id: "VO2" } } });
  });
});
