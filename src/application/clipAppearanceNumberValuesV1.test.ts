import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { animatedClipState, alignTime } from "../domain/editGraph";
import { dispatchCommandSafely, undo } from "../domain/history";
import { createProjectSession } from "./projectSession";
import { createTimelineEditingState } from "./timelineEditingState";
import { createGraphicEditingSelectionV1 } from "./graphicEditingSelectionV1";
import { createClipAppearanceEditsV1, clipAppearanceNumberValuesV1, CLIP_APPEARANCE_EXPRESSION_V1 } from "./clipAppearanceEditsV1";
import { createClipParameterGestureV1 } from "./clipParameterGestureV1";
import type { EditorCommand } from "../domain/commandTypes";

function fixture(fps = 60, playhead = .117, expression = false) {
  const project = createDemoProject(), clip = project.tracks[0].clips[0];
  project.fps = fps; clip.duration = 3;
  clip.keyframes = [0, 2].map((time, i) => ({ id: "k" + i, time, easing: "linear" as const,
    transform: { ...clip.transform, x: 20 + i * 40, y: 10 + i * 20, scale: 1.2 + i * .2, rotation: 10 + i * 20, opacity: .8 - i * .2 },
    color: { ...clip.color, brightness: i * .2, contrast: 1 + i * .2, saturation: 1 + i * .4, hue: i * 20 } }));
  if (expression) { clip.keyframes = []; clip.expressions = { x: "hao.expression/v1:frame" }; }
  const session = createProjectSession(project), timeline = createTimelineEditingState(session);
  const selection = createGraphicEditingSelectionV1(session, timeline), detach = selection.subscribe(() => {});
  timeline.setSelectedClipId(clip.id);
  const selected = selection.getSnapshot(), calls: EditorCommand[] = [], statuses: string[] = [];
  const transport = { playhead, seekRevision: 0 };
  const edits = createClipAppearanceEditsV1({
    getSnapshot: session.getSnapshot, getSelectionSnapshot: selection.getSnapshot, getTransport: () => transport,
    runCommand: command => { const result = dispatchCommandSafely(session.getSnapshot().history, command);
      if (result.error) return false; calls.push(command); session.setHistory(result.state); return true; },
    setStatus: message => statuses.push(message), makeId: prefix => prefix + "-number-fixture",
  }, { project, clipId: clip.id, selection: selected, transport: { ...transport } });
  const owner = createClipParameterGestureV1({ session, getSelectionSnapshot: selection.getSnapshot, subscribeSelection: selection.subscribe });
  const release = owner.subscribe(() => {});
  return { project, clip, session, edits, owner, calls, statuses, selected, transport, close() { release(); detach(); } };
}

describe("clip numeric editing-frame values use the original canonical planner", () => {
  for (const fps of [24, 60]) for (const field of ["x", "y", "scale", "rotation", "opacity", "brightness", "contrast", "saturation", "hue"] as const) {
    it(fps + "/" + field + " starts with a literal no-op and can preview then confirm once", () => {
      const f = fixture(fps);
      try {
        const transform = ["x", "y", "scale", "rotation", "opacity"].includes(field);
        const values = clipAppearanceNumberValuesV1(f.clip, f.transport.playhead, fps);
        const initial = transform ? values.transform[field as keyof typeof values.transform] : values.color[field as keyof typeof values.color];
        assert.equal(typeof initial, "number");
        const plan = (value: number) => transform ? f.edits.planTransform({ [field]: value }) : f.edits.planColor({ [field]: value });
        const commit = (value: number) => transform ? f.edits.transform({ [field]: value }) : f.edits.color({ [field]: value });
        assert.deepEqual(plan(initial as number), {});
        const lease = f.owner.begin({ clipId: f.clip.id, selection: f.selected, parameterId: (transform ? "transform." : "color.") + field,
          initial: initial as number, plan, commit });
        assert(lease);
        const next = field === "opacity" ? .4 : (initial as number) + .2;
        const before = JSON.stringify(f.project);
        assert(lease.update(next)); assert.equal(f.calls.length, 0);
        assert.equal(JSON.stringify(f.session.getSnapshot().history.present), before);
        assert(lease.commit()); assert.equal(f.calls.length, 1);
        assert.deepEqual(undo(f.session.getSnapshot().history).present, f.project);
      } finally { f.close(); }
    });
  }
  it("retains exact base values outside the selected clip", () => {
    const f = fixture();
    try { for (const time of [-1, 4]) assert.equal(clipAppearanceNumberValuesV1(f.clip, time, 60), f.clip); }
    finally { f.close(); }
  });
  it("uses the existing frame rounding and explicit project fps, not the display default", () => {
    const f = fixture();
    try {
      const values = clipAppearanceNumberValuesV1(f.clip, .117, 60);
      assert.deepEqual(values, animatedClipState(f.clip, alignTime(.117, 60), 60));
      assert.notEqual(values.transform.x, animatedClipState(f.clip, .117).transform.x);
    } finally { f.close(); }
  });
  it("displays a no-keyframe expression with project fps but preserves its edit refusal", () => {
    const f = fixture(60, .117, true);
    try {
      const value = clipAppearanceNumberValuesV1(f.clip, .117, 60).transform.x;
      assert.equal(value, 7);
      assert.equal(f.edits.planTransform({ x: value + 1 }), undefined);
      assert.equal(f.statuses.at(-1), CLIP_APPEARANCE_EXPRESSION_V1);
      assert.equal(f.calls.length, 0);
    } finally { f.close(); }
  });
  it("samples are not a new durable project revision", () => {
    const f = fixture(), initial = clipAppearanceNumberValuesV1(f.clip, .117, 60).transform.x;
    try {
      const lease = f.owner.begin({ clipId: f.clip.id, selection: f.selected, parameterId: "transform.x", initial,
        plan: value => f.edits.planTransform({ x: value }), commit: value => f.edits.transform({ x: value }) });
      assert(lease); assert(lease.update(initial + 1));
      const projected = f.owner.getSnapshot().preview!.project;
      assert.equal(projected.revision, f.project.revision); assert.equal(projected.updatedAt, f.project.updatedAt);
      lease.cancel(); assert.equal(f.owner.getSnapshot().preview, undefined); assert.equal(f.calls.length, 0);
    } finally { f.close(); }
  });
});
