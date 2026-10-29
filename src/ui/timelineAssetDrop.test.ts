import { describe, expect, it } from "vitest";
import { resolveTimelineAssetDrop, timelineAssetDuration } from "./timelineAssetDrop";
import { createDemoProject } from "../domain/demo";
import { applyCommand } from "../domain/commands";
import { parseProject } from "../application/projectFiles";

describe("project asset placement on the timeline", () => {
  const base = { fps: 30, pixelsPerSecond: 80, duration: 2, occupied: [] as Array<{ timelineStart: number; duration: number }>, magnetEnabled: true };

  it("shows and commits one frame-aligned position even when the source duration is fractional", () => {
    const value = resolveTimelineAssetDrop({ ...base, duration: 2.017, rawTime: 1.014, snapCandidates: [] });
    expect(value.start).toBeCloseTo(1);
    expect(value.duration).toBeCloseTo(60 / 30);
    expect(value.allowed).toBe(true);
  });

  it("snaps an asset edge to an existing clip or playhead and bypasses with Alt", () => {
    const input = { ...base, rawTime: 1.96, snapCandidates: [4], occupied: [{ timelineStart: 4, duration: 2 }] };
    expect(resolveTimelineAssetDrop(input)).toMatchObject({ start: 2, snappedTo: 4, allowed: true });
    expect(resolveTimelineAssetDrop({ ...input, magnetEnabled: false })).toMatchObject({ start: 1.9666666666666666, allowed: true });
    expect(resolveTimelineAssetDrop({ ...base, rawTime: 4.04, snapCandidates: [4.033333333333333], occupied: [] })).toMatchObject({ start: 4.033333333333333, snappedTo: 4.033333333333333 });
  });

  it("rejects overlap and keeps fractional frame rates exact", () => {
    expect(resolveTimelineAssetDrop({ ...base, rawTime: 3, snapCandidates: [], occupied: [{ timelineStart: 4, duration: 2 }] }).allowed).toBe(false);
    const fps = 30000 / 1001;
    const result = resolveTimelineAssetDrop({ ...base, fps, rawTime: 1.52, snapCandidates: [] });
    expect(result.start * fps).toBeCloseTo(Math.round(result.start * fps), 8);
    expect(result.duration * fps).toBeCloseTo(Math.round(result.duration * fps), 8);
  });
  it("preserves collision time only for explicit new-layer policy, without moving neighbors", () => {
    const occupied = [{ timelineStart: 4, duration: 2 }], input = { ...base, occupied, rawTime: 4.5, snapCandidates: [], magnetEnabled: false };
    expect(resolveTimelineAssetDrop(input)).toMatchObject({ start: 4.5, allowed: false, newLayer: false });
    expect(resolveTimelineAssetDrop({ ...input, collisionPolicy: "new-layer" })).toMatchObject({ start: 4.5, duration: 2, allowed: true, newLayer: true });
    expect(occupied).toEqual([{ timelineStart: 4, duration: 2 }]);
  });
  it("rejects sub-frame source duration and caps still images at their measured positive duration", () => {
    expect(timelineAssetDuration({ kind: "video", duration: 0.02 }, 30)).toBe(0);
    expect(resolveTimelineAssetDrop({ ...base, duration: 0.02, rawTime: 1, snapCandidates: [] })).toMatchObject({ allowed: false, duration: 0, newLayer: false });
    expect(timelineAssetDuration({ kind: "image", duration: 5 }, 30)).toBe(3);
    expect(timelineAssetDuration({ kind: "image", duration: 2.017 }, 30)).toBe(2);
    expect(timelineAssetDuration({ kind: "image", duration: 0 }, 30)).toBe(0);
  });
  it("applies and reparses the exact fractional source placement through real graph validation", () => {
    const project = createDemoProject(), source = { ...project.assets[0]!, id: "source-fractional", uri: "fractional.mp4", duration: 2.017 };
    const placement = resolveTimelineAssetDrop({ ...base, duration: source.duration, rawTime: 15.014, snapCandidates: [] });
    const prepared = applyCommand(project, { type: "batch", commands: [
      { type: "import_asset", asset: source }, { type: "add_clip", clip: { ...structuredClone(project.tracks[0]!.clips[0]!), id: "clip-fractional", assetId: source.id,
        timelineStart: placement.start, sourceStart: 0, duration: placement.duration } },
    ] });
    const reopened = parseProject(JSON.parse(JSON.stringify(prepared)));
    const clip = reopened.tracks[0]!.clips.find(item => item.id === "clip-fractional")!;
    expect(clip.timelineStart).toBe(15); expect(clip.duration).toBe(2); expect(clip.sourceStart + clip.duration).toBeLessThanOrEqual(source.duration);
    expect(project.assets).not.toContainEqual(source);
  });
});
