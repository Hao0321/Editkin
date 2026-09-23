import { describe, expect, it } from "vitest";
import { applyCommand } from "./commands";
import { createEmptyProject, EditGraphError, migrateProject, validateProject } from "./editGraph";
import { projectSchema } from "./schema";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type TimelineClip } from "./types";

function clip(id: string, assetId: string, trackId: string, timelineStart: number, duration: number): TimelineClip {
  return {
    id, assetId, trackId, timelineStart, sourceStart: 0, duration, volume: 1,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], layer: { ...DEFAULT_CLIP_LAYER }, expressions: {},
  };
}

function fixture(): EditProject {
  const project = createEmptyProject("Precomp", { id: "precomp-project", width: 640, height: 360, fps: 30 });
  project.assets.push({ id: "source", name: "Source", kind: "video", uri: "C:/fixture/source.mp4", duration: 6, width: 640, height: 360 });
  project.tracks[0].clips.push(clip("shot", "source", "video-main", 1, 3));
  return project;
}

describe("nested precompositions", () => {
  it("moves selected clips into a persisted composition and replaces them with one reusable clip", () => {
    const result = applyCommand(fixture(), {
      type: "precompose_clips", compositionId: "comp-a", assetId: "asset-comp-a", replacementClipId: "clip-comp-a",
      targetTrackId: "video-main", name: "Hero group", clipIds: ["shot"],
    });
    expect(result.schemaVersion).toBe(8);
    expect(result.compositions).toHaveLength(1);
    expect(result.compositions[0].tracks[0].clips[0]).toMatchObject({ id: "shot", timelineStart: 0, duration: 3 });
    expect(result.assets.find((asset) => asset.id === "asset-comp-a")).toMatchObject({
      kind: "video", uri: "editkin-composition://comp-a", compositionId: "comp-a", duration: 3,
    });
    expect(result.tracks[0].clips).toEqual([expect.objectContaining({ id: "clip-comp-a", assetId: "asset-comp-a", timelineStart: 1, duration: 3 })]);
    expect(projectSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
  });

  it("refuses to sever parent or track-matte dependencies at the composition boundary", () => {
    const project = fixture();
    project.tracks.push({ id: "overlay", name: "Overlay", kind: "video", locked: false, muted: false, clips: [
      { ...clip("child", "source", "overlay", 1, 3), layer: { ...DEFAULT_CLIP_LAYER, parentClipId: "shot" } },
    ] });
    expect(() => applyCommand(project, {
      type: "precompose_clips", compositionId: "comp-a", assetId: "asset-comp-a", replacementClipId: "clip-comp-a",
      targetTrackId: "video-main", name: "Broken group", clipIds: ["shot"],
    })).toThrow(/仍依賴/);
  });

  it("detects nested composition cycles and migrates schema 7 without inventing content", () => {
    const legacy = fixture() as unknown as Record<string, unknown>;
    legacy.schemaVersion = 7;
    delete legacy.compositions;
    expect(migrateProject(legacy)).toMatchObject({ schemaVersion: 8, compositions: [] });

    let project = applyCommand(fixture(), {
      type: "precompose_clips", compositionId: "comp-a", assetId: "asset-comp-a", replacementClipId: "clip-comp-a",
      targetTrackId: "video-main", name: "A", clipIds: ["shot"],
    });
    const composition = project.compositions[0];
    composition.tracks[0].clips[0].assetId = "asset-comp-a";
    expect(() => validateProject(project)).toThrow(EditGraphError);
    expect(() => validateProject(project)).toThrow(/環狀參照/);
  });
});
