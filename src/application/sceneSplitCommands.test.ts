import { describe, expect, it } from "vitest";
import { applyCommand } from "../domain/commands";
import { createDemoProject } from "../domain/demo";
import { findClip } from "../domain/editGraph";
import { buildSceneSplitCommand } from "./sceneSplitCommands";

describe("scene split command", () => {
  it("splits the evolving right-hand clip in one Undoable batch", () => {
    const project = createDemoProject();
    const clip = findClip(project, "clip-demo");
    let id = 0;
    const planned = buildSceneSplitCommand(project, clip, [{ time: 2 }, { time: 4 }], () => `scene-${++id}`);
    const updated = applyCommand(project, planned.command);
    expect(planned.splitCount).toBe(2);
    expect(updated.tracks[0].clips.map((item) => ({ id: item.id, timelineStart: item.timelineStart, sourceStart: item.sourceStart, duration: item.duration }))).toEqual([
      { id: "clip-demo", timelineStart: 0, sourceStart: 0, duration: 2 },
      { id: "scene-1", timelineStart: 2, sourceStart: 2, duration: 2 },
      { id: "scene-2", timelineStart: 4, sourceStart: 4, duration: 8 },
    ]);
  });
});
