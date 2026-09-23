import { describe, expect, it } from "vitest";
import { applyCommand } from "../domain/commands";
import { createEmptyProject } from "../domain/editGraph";
import { editorCommandSchema } from "../domain/schema";
import { buildRenderPlan } from "../render/planner";
import { compileBeatAlignedMontage, type BeatMontageShotEvidence } from "./beatMontageCompiler";

function fixture() {
  const project = createEmptyProject("Beat montage", { id: "beat-montage", fps: 30 });
  project.assets.push(
    { id: "wide", name: "Wide", kind: "video", uri: "wide.mp4", duration: 12 },
    { id: "detail", name: "Detail", kind: "video", uri: "detail.mp4", duration: 12 },
    { id: "payoff", name: "Payoff", kind: "video", uri: "payoff.mp4", duration: 12 },
    { id: "weak", name: "Weak", kind: "video", uri: "weak.mp4", duration: 12 },
  );
  return project;
}

const candidates: BeatMontageShotEvidence[] = [
  // Deliberately scrambled input: compilation must use storyOrder, not array order.
  { shotId: "payoff", assetId: "payoff", sourceStart: 2, sourceEnd: 8, focusTime: 6, salience: .95, storyOrder: 30 },
  { shotId: "weak", assetId: "weak", sourceStart: 0, sourceEnd: 10, salience: .1, storyOrder: 15 },
  { shotId: "wide", assetId: "wide", sourceStart: 1, sourceEnd: 7, salience: .8, storyOrder: 10 },
  { shotId: "detail", assetId: "detail", sourceStart: 3, sourceEnd: 9, focusTime: 5, salience: .9, storyOrder: 20 },
];

describe("closed-world beat montage compiler", () => {
  it("selects, story-reorders, source-trims and applies renderable clips on beat boundaries", () => {
    const project = fixture();
    const compiled = compileBeatAlignedMontage(project, {
      targetTrackId: "video-main",
      beatTimes: [2, 3.5, 5, 7],
      candidates,
      clipIds: ["montage-a", "montage-b", "montage-c"],
    });
    expect(compiled.selections.map((item) => item.shotId)).toEqual(["wide", "detail", "payoff"]);
    expect(compiled.selections.map((item) => item.timelineStart)).toEqual([2, 3.5, 5]);
    expect(compiled.selections.map((item) => item.duration)).toEqual([1.5, 1.5, 2]);
    expect(compiled.selections.map((item) => item.sourceStart)).toEqual([1, 4.266666666666667, 5]);
    expect(compiled.guarantees).toEqual({
      shotSelection: true,
      reorderByStoryOrder: true,
      sourceTrim: true,
      cutPointsOnBeat: true,
      pairwiseTransitions: false,
      timeRemap: false,
      splitAudioEdits: false,
    });
    expect(() => editorCommandSchema.parse(compiled.command)).not.toThrow();

    const updated = applyCommand(project, compiled.command);
    const clips = updated.tracks.find((track) => track.id === "video-main")!.clips;
    expect(clips.map((clip) => [clip.id, clip.assetId, clip.timelineStart, clip.sourceStart, clip.duration])).toEqual([
      ["montage-a", "wide", 2, 1, 1.5],
      ["montage-b", "detail", 3.5, 4.266666666666667, 1.5],
      ["montage-c", "payoff", 5, 5, 2],
    ]);
    const plan = buildRenderPlan(updated, (uri) => uri);
    expect(plan.videoLayers.flatMap((layer) => layer.segments).filter((segment) => segment.kind === "clip")).toHaveLength(3);
    expect(plan.audioClips.map((item) => [item.clip.assetId, item.clip.timelineStart, item.clip.sourceStart, item.clip.duration])).toEqual([
      ["wide", 2, 1, 1.5],
      ["detail", 3.5, 4.266666666666667, 1.5],
      ["payoff", 5, 5, 2],
    ]);
    expect(plan.duration).toBe(7);
  });

  it("uses globally optimal evidence selection while preserving story order", () => {
    const project = fixture();
    const compiled = compileBeatAlignedMontage(project, {
      targetTrackId: "video-main",
      beatTimes: [0, 2, 4],
      candidates: [
        { shotId: "early-low", assetId: "wide", sourceStart: 0, sourceEnd: 4, salience: .2, storyOrder: 1 },
        { shotId: "early-high", assetId: "detail", sourceStart: 0, sourceEnd: 4, salience: .9, storyOrder: 2 },
        { shotId: "late-high", assetId: "payoff", sourceStart: 0, sourceEnd: 4, salience: .8, storyOrder: 3 },
      ],
    });
    expect(compiled.selections.map((item) => item.shotId)).toEqual(["early-high", "late-high"]);
  });

  it("fails closed for insufficient evidence, occupied output, and invalid beat grids", () => {
    const project = fixture();
    expect(() => compileBeatAlignedMontage(project, {
      targetTrackId: "video-main", beatTimes: [0, 4, 8], candidates: [
        { shotId: "too-short", assetId: "wide", sourceStart: 0, sourceEnd: 2, salience: 1, storyOrder: 1 },
      ],
    })).toThrow(/沒有足夠/);

    const first = compileBeatAlignedMontage(project, { targetTrackId: "video-main", beatTimes: [0, 2], candidates });
    const occupied = applyCommand(project, first.command);
    expect(() => compileBeatAlignedMontage(occupied, { targetTrackId: "video-main", beatTimes: [1, 3], candidates })).toThrow(/重疊/);
    expect(() => compileBeatAlignedMontage(project, { targetTrackId: "video-main", beatTimes: [0, .001, 2], candidates })).toThrow(/逐幀遞增/);
  });

  it("never emits transition, time-remap, or split-audio claims", () => {
    const compiled = compileBeatAlignedMontage(fixture(), { targetTrackId: "video-main", beatTimes: [0, 1, 2], candidates });
    const serialized = JSON.stringify(compiled.command);
    expect(serialized).not.toMatch(/transition|playbackRate|timeRemap|speed|audioSplit/);
    expect(compiled.guarantees.pairwiseTransitions).toBe(false);
    expect(compiled.guarantees.timeRemap).toBe(false);
    expect(compiled.guarantees.splitAudioEdits).toBe(false);
  });
});
