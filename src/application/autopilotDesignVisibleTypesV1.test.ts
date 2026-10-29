import { describe, expect, it } from "vitest";
import { applyCommand, type EditorCommand } from "../domain/commands";
import { createDemoProject } from "../domain/demo";
import { assertDesignDecisionBinding, designEvidenceSchema } from "./autopilotDesignContract";

function evidence(indexes = [0]) {
  return designEvidenceSchema.parse({
    schema: "editkin.autopilot-design-evidence/v1",
    request: { format: "vlog", domain: "editing", topic: "Command-bound editing", duration: 12,
      beats: [{ id: "proof", role: "proof", energy: .5, subject: "Edited source footage" }] },
    projectSha256: "a".repeat(64), sourceSha256: "b".repeat(64), briefSha256: "c".repeat(64),
    decisions: [{ beatId: "proof", recipeSha256: "d".repeat(64), application: "Bind the actual source-footage edit to this narrative beat", commandIndexes: indexes }],
  });
}

const edits: EditorCommand[] = [
  { type: "trim_clip_start", clipId: "clip-demo", seconds: 1 },
  { type: "trim_clip_end", clipId: "clip-demo", seconds: 1 },
  { type: "smart_cut_clip", clipId: "clip-demo", keepRanges: [{ start: 0, end: 3 }, { start: 5, end: 7 }], segmentIds: ["clip-demo", "clip-kept-2"] },
];

describe("design evidence binds existing trim and smart-cut commands", () => {
  it.each(edits)("accepts $type and its actual timeline edit without mutating the input", command => {
    const project = createDemoProject(), before = structuredClone(project);
    expect(() => assertDesignDecisionBinding(evidence(), [command], ["proof"])).not.toThrow();
    const result = applyCommand(project, command);
    const clips = result.tracks[0].clips;
    if (command.type === "trim_clip_start") {
      expect(clips[0]).toMatchObject({ timelineStart: 0, sourceStart: 1, duration: 11 });
    } else if (command.type === "trim_clip_end") {
      expect(clips[0]).toMatchObject({ timelineStart: 0, sourceStart: 0, duration: 11 });
    } else {
      expect(clips.map(clip => ({ id: clip.id, timelineStart: clip.timelineStart, sourceStart: clip.sourceStart, duration: clip.duration }))).toEqual([
        { id: "clip-demo", timelineStart: 0, sourceStart: 0, duration: 3 },
        { id: "clip-kept-2", timelineStart: 3, sourceStart: 5, duration: 2 },
      ]);
    }
    expect(project).toEqual(before);
  });

  it.each(["trim_clip", "apply_smart_cut"])("rejects obsolete runtime command name %s", type => {
    const command = { type, clipId: "clip-demo", seconds: 1 } as unknown as EditorCommand;
    expect(() => assertDesignDecisionBinding(evidence(), [command], ["proof"])).toThrow(/actual visual\/audio commands/);
  });

  it("refuses track metadata as evidence for a footage edit", () => {
    const command: EditorCommand = { type: "rename_track", trackId: "video-main", name: "Renamed" };
    expect(() => assertDesignDecisionBinding(evidence(), [command], ["proof"])).toThrow(/metadata/);
  });
  it("requires each actual edit rather than accepting a nested batch", () => {
    const command: EditorCommand = { type: "batch", commands: edits };
    expect(() => assertDesignDecisionBinding(evidence(), [command], ["proof"])).toThrow(/nested batches/);
  });
  it("refuses a missing command index even beside an accepted edit", () => {
    expect(() => assertDesignDecisionBinding(evidence([0, 1]), [edits[0]], ["proof"])).toThrow(/actual visual\/audio commands/);
  });
  it("does not give one command duplicate credit within a beat", () => {
    expect(() => assertDesignDecisionBinding(evidence([0, 0]), [edits[0]], ["proof"])).toThrow(/actual visual\/audio commands/);
  });
  it("continues requiring every narrative beat exactly once", () => {
    expect(() => assertDesignDecisionBinding(evidence(), edits, ["proof", "payoff"])).toThrow(/every narrative beat exactly once/);
  });
});
