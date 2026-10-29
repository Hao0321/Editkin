import { describe, expect, it } from "vitest";
import { createDemoProject } from "./demo";
import { createHistory, dispatchCommand, dispatchCommandSafely, redo, undo } from "./history";

// A held Alt+← → sends one command per key repeat. Commands carrying the same key, one right after another, make ONE
// Undo step, so holding a key never floods the 100-step history; a new press or any other edit starts a new step.
const move = (seconds: number) => ({ type: "move_clip" as const, clipId: "clip-demo", timelineStart: seconds });
const start = (history: ReturnType<typeof createHistory>) => history.present.tracks[0].clips[0].timelineStart;

describe("a held nudge is one Undo step", () => {
  it("merges the repeats of one press and undoes the whole hold at once", () => {
    const base = createHistory(createDemoProject());
    let history = base;
    for (let frame = 1; frame <= 40; frame += 1) history = dispatchCommand(history, move(frame / 30), `cmd-${frame}`, undefined, "nudge:1");
    expect(start(history)).toBeCloseTo(40 / 30, 9);
    expect(history.past).toHaveLength(1);
    expect(history.journal).toHaveLength(40);
    const undone = undo(history);
    expect(start(undone)).toBe(0);
    expect(undone.past).toHaveLength(0);
    expect(start(redo(undone))).toBeCloseTo(40 / 30, 9);
  });

  it("a new press, a plain edit or an Undo in between starts a new step", () => {
    let history = createHistory(createDemoProject());
    history = dispatchCommand(history, move(1 / 30), "a", undefined, "nudge:1");
    history = dispatchCommand(history, move(2 / 30), "b", undefined, "nudge:2");
    expect(history.past).toHaveLength(2);
    history = dispatchCommand(history, { type: "set_clip_volume", clipId: "clip-demo", volume: 0.5 }, "c");
    history = dispatchCommand(history, move(3 / 30), "d", undefined, "nudge:2");
    expect(history.past).toHaveLength(4);
    history = undo(history);
    history = dispatchCommand(history, move(4 / 30), "e", undefined, "nudge:2");
    expect(history.past).toHaveLength(4);
    expect(start(undo(history))).toBeCloseTo(2 / 30, 9);
  });

  it("never merges across a change made outside the gesture (the present changed under it)", () => {
    let history = dispatchCommand(createHistory(createDemoProject()), move(1 / 30), "a", undefined, "nudge:1");
    history = { ...history, present: { ...history.present, revision: history.present.revision + 1 } };
    history = dispatchCommand(history, move(2 / 30), "b", undefined, "nudge:1");
    expect(history.past).toHaveLength(2);
  });

  it("a refused step changes nothing and keeps the gesture's step", () => {
    let history = dispatchCommand(createHistory(createDemoProject()), move(1 / 30), "a", undefined, "nudge:1");
    const refused = dispatchCommandSafely(history, move(-1), "b", undefined, "nudge:1");
    expect(refused.error).toBeTruthy();
    expect(refused.state).toBe(history);
    history = dispatchCommand(history, move(2 / 30), "c", undefined, "nudge:1");
    expect(history.past).toHaveLength(1);
  });
});
