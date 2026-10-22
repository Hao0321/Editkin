import { describe, expect, it } from "vitest";
import { applyCommand } from "./commands";
import { createHistory, dispatchCommand, redo, undo } from "./history";
import { projectSchema, editorCommandSchema } from "./schema";
import { validateProject } from "./editGraph";
import { TRACK_LOCKED_MESSAGE } from "./trackLock";
import { pairFixtureV1 } from "./timelineTransitionV1.fixture";
import { buildRenderPlan } from "../render/planner";
import { buildEngineRenderGraph } from "../render/engineGraph";

describe("serialized paired transition editor commands", () => {
  it("performs one immutable history commit and literal Undo/Redo/save-reopen", () => {
    const { project, transition } = pairFixtureV1(), before = structuredClone(project), initial = createHistory(project);
    const command = editorCommandSchema.parse({ type: "set_timeline_transition", transition });
    const changed = dispatchCommand(initial, command, "add-transition");
    expect(changed.present.timelineTransitions).toEqual([transition]); expect(project).toEqual(before);
    const reopened = projectSchema.parse(JSON.parse(JSON.stringify(changed.present))); expect(reopened.timelineTransitions).toEqual([transition]);
    expect(undo(changed).present).toEqual(before); expect(redo(undo(changed)).present).toEqual(changed.present);
    expect(changed.journal).toHaveLength(1);
  });
  it("upserts the same identity and deletes it as ordinary immutable edits", () => {
    const { project, transition } = pairFixtureV1();
    const first = applyCommand(project, { type: "set_timeline_transition", transition });
    const second = applyCommand(first, { type: "set_timeline_transition", transition: { ...transition, kernel: "dip" } });
    expect(second.timelineTransitions).toHaveLength(1); expect(second.timelineTransitions?.[0].kernel).toBe("dip");
    expect(first.timelineTransitions?.[0].kernel).toBe("dissolve");
    const deleted = applyCommand(second, { type: "delete_timeline_transition", transitionId: "cut" });
    expect(deleted.timelineTransitions).toEqual([]); expect(second.timelineTransitions).toHaveLength(1);
  });
  it("refuses adding/updating/removing on a locked track, including a forged track reference", () => {
    const { project, transition } = pairFixtureV1(); project.timelineTransitions = [transition]; project.tracks[0].locked = true;
    const before = structuredClone(project);
    for (const command of [{ type: "set_timeline_transition" as const, transition }, { type: "set_timeline_transition" as const, transition: { ...transition, trackId: "unlocked-other" } },
      { type: "delete_timeline_transition" as const, transitionId: "cut" }]) expect(() => applyCommand(project, command)).toThrow(TRACK_LOCKED_MESSAGE);
    expect(project).toEqual(before);
  });
  it("removes a broken cut after the fast move and restores it with that same Undo", () => {
    const { project, transition } = pairFixtureV1(); project.timelineTransitions = [transition];
    const initial = createHistory(project), moved = dispatchCommand(initial, { type: "move_clip", clipId: "incoming", timelineStart: 3 }, "move");
    expect(moved.present.timelineTransitions).toEqual([]); expect(project.timelineTransitions).toEqual([transition]);
    expect(undo(moved).present).toEqual(project);
  });
  it("keeps a valid binding when picture properties change", () => {
    const { project, transition } = pairFixtureV1(); project.timelineTransitions = [transition];
    const changed = applyCommand(project, { type: "update_clip_transform", clipId: "incoming", patch: { x: 12 } });
    expect(changed.timelineTransitions).toEqual([transition]); expect(project.tracks[0].clips[1].transform.x).toBe(0);
  });
  it("rejects insufficient handles and malformed persisted bindings before mutation", () => {
    const { project, transition } = pairFixtureV1(); project.tracks[0].clips[1].sourceStart = 0;
    expect(() => applyCommand(project, { type: "set_timeline_transition", transition })).toThrow(/SOURCE_HANDLE_MISSING/);
    expect(() => projectSchema.parse({ ...project, timelineTransitions: [transition] })).toThrow(/SOURCE_HANDLE_MISSING/);
    expect(() => validateProject({ ...project, timelineTransitions: [transition] })).toThrow(/SOURCE_HANDLE_MISSING/);
    expect(project).not.toHaveProperty("timelineTransitions");
  });
  it("preserves omission on original projects while the render plan binds actual paired source windows", () => {
    const { project, transition } = pairFixtureV1();
    expect(projectSchema.parse(project)).not.toHaveProperty("timelineTransitions");
    expect(buildRenderPlan(project, p => p)).not.toHaveProperty("pairTransitions");
    const added = applyCommand(project, { type: "set_timeline_transition", transition }), plan = buildRenderPlan(added, p => p);
    expect(plan.pairTransitions?.[0]).toMatchObject({ cutFrame: 60, startFrame: 48, endFrame: 72 });
    expect(plan.pairTransitions?.[0].to.sourceStartSeconds).toBeCloseTo(3.6, 12);
  });
  it("does not silently present old native output until the shared GPU renderer is connected", () => {
    const { project, transition } = pairFixtureV1(), added = applyCommand(project, { type: "set_timeline_transition", transition });
    expect(() => buildEngineRenderGraph(added)).toThrow(/TIMELINE_TRANSITION_NATIVE_SHADER_NOT_CONNECTED/);
  });
});
