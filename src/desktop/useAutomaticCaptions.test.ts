import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { applyCommand } from "../domain/commands";
import { findClip } from "../domain/editGraph";
import { buildAutomaticCaptionCommand } from "../application/automaticCaptionCommands";

describe("automatic caption EditGraph integration", () => {
  it("replaces overlapping cues in one Undoable batch and aligns to frames", () => {
    let project = createDemoProject();
    project = applyCommand(project, { type: "add_caption", caption: { id: "old", text: "舊字幕", start: 0.2, duration: 2 } });
    const clip = findClip(project, "clip-demo");
    let id = 0;
    const planned = buildAutomaticCaptionCommand(project, clip, { cues: [
      { start: 0.011, end: 1.044, text: "第一句", translation: { text: "First line", language: "en" } },
      { start: 1.05, end: 2.08, text: "第二句" },
    ] }, () => `auto-${++id}`);
    expect(planned).toMatchObject({ added: 2, replaced: 1, command: { type: "batch" } });
    const updated = applyCommand(project, planned.command);
    expect(updated.captions.map(({ id: cueId, text }) => ({ cueId, text }))).toEqual([
      { cueId: "auto-1", text: "第一句" }, { cueId: "auto-2", text: "第二句" },
    ]);
    expect(updated.captions[0].start * project.fps).toBeCloseTo(0, 10);
    expect(updated.captions[0].duration * project.fps).toBeCloseTo(31, 10);
    expect(updated.captions[0].translation).toEqual({ text: "First line", language: "en" });
    expect(updated.captions[1].start * project.fps).toBeCloseTo(32, 10);
    expect(updated.captions[1].duration * project.fps).toBeCloseTo(30, 10);
  });
});
