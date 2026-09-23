import { describe, expect, it } from "vitest";
import { applyCommand } from "../domain/commands";
import { createDemoProject } from "../domain/demo";
import { findClip } from "../domain/editGraph";
import { buildSemanticAutoEditCommand } from "./semanticAutoEditCommands";
import { planSemanticAutoEdit } from "./semanticAutoEdit";

const fixture = {
  duration: 20,
  fps: 30,
  targetRatio: 0.4,
  cuts: [{ time: 4, score: 55 }, { time: 8, score: 63 }, { time: 12, score: 61 }, { time: 16, score: 52 }],
  cues: [
    { start: 0.2, end: 3.5, text: "嗯 那個 就是 然後" },
    { start: 4.2, end: 7.7, text: "第一個關鍵方法可以省下百分之三十時間！" },
    { start: 8.3, end: 11.6, text: "呃 嗯 那個" },
    { start: 12.1, end: 15.8, text: "最後總結：最重要的結果是保留故事重點。" },
    { start: 16.4, end: 19.5, text: "嗯 好 然後 就是" },
  ],
} as const;

describe("semantic automatic editing", () => {
  it("rejects subframe inputs and does not round the reported original duration upward", () => {
    expect(() => planSemanticAutoEdit({ duration: .01, fps: 30, cues: [{ start: 0, end: .01, text: "短" }] })).toThrow("完整影格");
    const plan = planSemanticAutoEdit({ duration: 21.95, fps: 30, cues: [{ start: 0, end: 21.95, text: "完整語句" }], targetRatio: 1 });
    expect(plan.originalDuration).toBe(21.95);
    expect(plan.keepRanges).toEqual([{ start: 0, end: 658 / 30 }]);
    expect(plan.keptDuration + plan.removedDuration).toBeCloseTo(21.95, 10);
  });
  it("selects independently annotated highlights and explains the score", () => {
    const plan = planSemanticAutoEdit(fixture);
    expect(plan.keepRanges).toEqual([{ start: 4, end: 8 }, { start: 12, end: 16 }]);
    expect(plan.keptDuration).toBe(8);
    expect(plan.removedDuration).toBe(12);
    expect(plan.segments.filter((segment) => segment.selected).every((segment) => segment.reasons.includes("包含重點語句"))).toBe(true);
  });

  it("writes captions and edit ranges through one atomic EditGraph command", () => {
    const project = createDemoProject();
    const clip = findClip(project, "clip-demo");
    const cues = fixture.cues.filter((cue) => cue.start < clip.duration).map((cue) => ({ ...cue }));
    const plan = planSemanticAutoEdit({ ...fixture, duration: clip.duration, cuts: fixture.cuts.filter((cut) => cut.time < clip.duration), cues, targetRatio: 0.5 });
    const built = buildSemanticAutoEditCommand(project, clip, { cues }, plan, (kind, index) => `${kind}-${index}`);
    const updated = applyCommand(project, built.command);
    const clips = updated.tracks.find((track) => track.id === clip.trackId)?.clips ?? [];
    expect(built.command.type).toBe("batch");
    expect(clips.length).toBe(plan.keepRanges.length);
    expect(updated.captions.length).toBeGreaterThan(0);
    expect(clips.reduce((sum, item) => sum + item.duration, 0)).toBe(plan.keptDuration);
  });

  it("fails closed without actual transcript content", () => {
    expect(() => planSemanticAutoEdit({ duration: 10, fps: 30, cues: [] })).toThrow("沒有可用來判斷重點");
  });

  it("rejects malformed transcript and scene evidence instead of scoring it", () => {
    expect(() => planSemanticAutoEdit({ duration: 10, fps: 30, cues: [{ start: -1, end: 2, text: "invalid" }] })).toThrow("cue 不合法");
    expect(() => planSemanticAutoEdit({ duration: 10, fps: 30, cues: [{ start: 0, end: 2, text: "valid" }], cuts: [{ time: 11, score: 50 }] })).toThrow("場景切點不合法");
  });

  it("is deterministic for unsorted cues and does not mutate caller evidence", () => {
    const cues = [{ start: 8, end: 10, text: "最後總結結果" }, { start: 0, end: 3, text: "先建立方法" }];
    const snapshot = structuredClone(cues);
    const left = planSemanticAutoEdit({ duration: 12, fps: 30, cues, cuts: [{ time: 6, score: 50 }], targetRatio: .5 });
    const right = planSemanticAutoEdit({ duration: 12, fps: 30, cues: [...cues].reverse(), cuts: [{ time: 6, score: 50 }], targetRatio: .5 });
    expect(left.keepRanges).toEqual(right.keepRanges);
    expect(cues).toEqual(snapshot);
  });
});
