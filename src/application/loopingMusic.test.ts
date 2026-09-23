import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { buildLoopingMusicPlan } from "./loopingMusic";

describe("looping music plan", () => {
  it("creates alternating editable music clips and rejects zero-length media", () => {
    const project = createDemoProject();
    const asset = { id: "music", name: "Music", kind: "audio" as const, uri: "music.wav", duration: 5 };
    const plan = buildLoopingMusicPlan(project, asset, (index) => `music-${index}`);
    expect(plan.targetDuration).toBe(12);
    expect(plan.commands.filter((command) => command.type === "add_clip")).toHaveLength(3);
    expect(plan.lastClipId).toBe("music-2");
    expect(() => buildLoopingMusicPlan(project, { ...asset, duration: 0 }, String)).toThrow(/一個 frame/);
  });
});
