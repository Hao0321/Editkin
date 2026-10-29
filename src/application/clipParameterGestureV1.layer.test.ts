import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { EditorCommand } from "../domain/commandTypes";
import type { LayerBlendMode } from "../domain/types";
import { createDemoProject } from "../domain/demo";
import { dispatchCommandSafely, undo } from "../domain/history";
import { findClip } from "../domain/editGraph";
import { createProjectSession } from "./projectSession";
import { createTimelineEditingState } from "./timelineEditingState";
import { createGraphicEditingSelectionV1 } from "./graphicEditingSelectionV1";
import { createClipParameterGestureV1 } from "./clipParameterGestureV1";
import { createBlendHoverPreviewV1 } from "../ui/clipBlendModesV1";

// P6 (2026-10-23): hovering 混合模式 options previews through the transient owner (no history); choosing commits once.
function fixture() {
  const project = createDemoProject(), clip = project.tracks[0].clips[0];
  const session = createProjectSession(project), timeline = createTimelineEditingState(session), selection = createGraphicEditingSelectionV1(session, timeline);
  const off = selection.subscribe(() => {}); timeline.setSelectedClipId(clip.id);
  const owner = createClipParameterGestureV1({ session, getSelectionSnapshot: selection.getSnapshot, subscribeSelection: selection.subscribe });
  const release = owner.subscribe(() => {});
  const calls: EditorCommand[] = [];
  const run = (command: EditorCommand) => { calls.push(command); const result = dispatchCommandSafely(session.getSnapshot().history, command, "c" + calls.length); session.setHistory(result.state); return !result.error; };
  const begin = () => owner.beginLayer({ clipId: clip.id, selection: selection.getSnapshot(), parameterId: "layer.blendMode", initial: findClip(session.getSnapshot().history.present, clip.id).layer?.blendMode ?? "normal",
    plan: (mode: LayerBlendMode) => ({ command: { type: "set_clip_layer", clipId: clip.id, patch: { blendMode: mode } } }),
    commit: (mode: LayerBlendMode) => run({ type: "set_clip_layer", clipId: clip.id, patch: { blendMode: mode } }) });
  const present = () => session.getSnapshot().history.present;
  return { clip, session, owner, calls, run, begin, present, selection: selection.getSnapshot, close() { release(); off(); } };
}

describe("混合模式 hover preview and commit", () => {
  it("previews each hovered mode without a history step, then commits the chosen one as one Undo", () => {
    const f = fixture(), hover = createBlendHoverPreviewV1(), pastBefore = f.session.getSnapshot().history.past.length;
    for (const mode of ["multiply", "screen", "overlay"] as const) {
      assert(hover.hover(mode, f.begin));
      assert.equal(findClip(f.owner.getSnapshot().preview!.project, f.clip.id).layer?.blendMode, mode);
      assert.equal(f.session.getSnapshot().history.past.length, pastBefore);
    }
    assert.equal(findClip(f.present(), f.clip.id).layer?.blendMode ?? "normal", "normal");
    assert(hover.choose("screen", () => assert.fail("a current lease commits itself")));
    assert.equal(f.calls.length, 1);
    assert.equal(f.session.getSnapshot().history.past.length, pastBefore + 1);
    assert.equal(findClip(f.present(), f.clip.id).layer?.blendMode, "screen");
    assert.equal(f.owner.getSnapshot().preview, undefined);
    f.session.setHistory(undo(f.session.getSnapshot().history));
    assert.equal(findClip(f.present(), f.clip.id).layer?.blendMode ?? "normal", "normal");
    f.close();
  });
  it("restores the committed mode when the pointer leaves or Esc is pressed (nothing reaches the history)", () => {
    const f = fixture(), hover = createBlendHoverPreviewV1();
    assert(hover.hover("difference", f.begin)); hover.restore();
    assert.equal(f.owner.getSnapshot().preview, undefined); assert.equal(f.calls.length, 0);
    assert.equal(f.session.getSnapshot().history.past.length, 0);
    f.close();
  });
  it("choosing the current mode is not an edit", () => {
    const f = fixture(), hover = createBlendHoverPreviewV1();
    assert(hover.hover("multiply", f.begin)); assert(hover.choose("normal", () => assert.fail("no fallback")));
    assert.equal(f.calls.length, 0); f.close();
  });
  it("offers no preview on a locked track or for a mode the project schema does not know", () => {
    const f = fixture();
    assert.equal(f.owner.beginLayer({ clipId: f.clip.id, selection: f.selection(), parameterId: "layer.blendMode", initial: "vivid_light" as LayerBlendMode,
      plan: () => ({}), commit: () => true }), undefined);
    f.run({ type: "toggle_track_lock", trackId: f.clip.trackId });
    assert.equal(f.begin(), undefined);
    f.close();
  });
  it("refuses a preview plan that touches anything but this clip's layer", () => {
    const f = fixture();
    const lease = f.owner.beginLayer({ clipId: f.clip.id, selection: f.selection(), parameterId: "layer.blendMode", initial: "normal",
      plan: () => ({ command: { type: "update_clip_transform", clipId: f.clip.id, patch: { x: 40 } } }), commit: () => true })!;
    assert(lease);
    assert.equal(lease.update("multiply"), false);
    assert.equal(f.owner.getSnapshot().preview, undefined);
    assert.equal(f.calls.length, 0);
    f.close();
  });
});
