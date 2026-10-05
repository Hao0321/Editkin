import { describe, expect, it } from "vitest";
import { applyCommand } from "../domain/commands";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { floatingVideoFramePreset } from "./floatingVideoFrame";
import { floatingFrameSceneCommands } from "./floatingFrameScenes";

function fixture() {
  const project = createEmptyProject("Owned mixed-aspect scene", { width: 360, height: 640, fps: 30 });
  project.assets.push(...[
    { id: "landscape", width: 640, height: 360, displayAspectRatio: 16 / 9 },
    { id: "square", width: 512, height: 512, displayAspectRatio: 1 },
    { id: "portrait", width: 360, height: 640, displayAspectRatio: 9 / 16 },
  ].map(geometry => ({ ...geometry, name: geometry.id, kind: "video" as const, uri: `${geometry.id}.mp4`, duration: 5,
    color: { interpretation: "rec709" as const } })));
  project.tracks[0].clips.push({ id: "source", trackId: "video-main", assetId: "landscape", timelineStart: .5,
    sourceStart: .4, duration: 2, volume: .8, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
    layer: { ...DEFAULT_CLIP_LAYER }, expressions: {} });
  return project;
}

describe("new editable v2 floating scenes", () => {
  it("compiles three real mixed-aspect sources into source-contain planes without changing offsets, duration or source audio", () => {
    const project = fixture(), before = structuredClone(project);
    const commands = floatingFrameSceneCommands(project, "source", "portrait_stack", {
      rearRight: { assetId: "square", sourceStart: .8 }, front: { assetId: "portrait", sourceStart: 1 },
    });
    const applied = applyCommand(project, { type: "batch", commands });
    const clips = applied.tracks.flatMap(track => track.clips);
    expect(commands).toHaveLength(5); expect(clips).toHaveLength(3);
    expect(clips.map(clip => clip.assetId)).toEqual(["landscape", "square", "portrait"]);
    expect(clips.map(clip => clip.sourceStart)).toEqual([.4, .8, 1]);
    expect(clips.map(clip => clip.volume)).toEqual([.8, 0, 0]);
    for (const clip of clips) {
      expect(clip.timelineStart).toBe(.5); expect(clip.duration).toBe(2);
      expect(clip.floatingFrame).toMatchObject({ schema: "editkin.floating-video-frame/v2", aspect: "source", mediaFit: "contain",
        motion: { entranceFrames: 6, exitFrames: 6, travelY: .012 } });
    }
    expect(project).toEqual(before);
  });

  it("rejects a source with no stored display geometry before handing out editable commands", () => {
    const project = fixture(); delete project.assets[1].displayAspectRatio; delete project.assets[1].width; delete project.assets[1].height;
    expect(() => floatingFrameSceneCommands(project, "source", "portrait_duo", {
      rearRight: { assetId: "square", sourceStart: .8 }, front: { assetId: "portrait", sourceStart: 1 },
    })).toThrow(/顯示比例|尺寸/);
  });

  it("does not upgrade an unrelated saved v1 frame when creating a new scene", () => {
    const project = fixture();
    const legacy = { ...structuredClone(project.tracks[0].clips[0]), id: "legacy", timelineStart: 3,
      duration: 1, floatingFrame: floatingVideoFramePreset("matte") };
    project.tracks[0].clips.push(legacy);
    const before = structuredClone(legacy);
    const applied = applyCommand(project, { type: "batch", commands: floatingFrameSceneCommands(project, "source", "portrait_duo") });
    expect(applied.tracks[0].clips.find(clip => clip.id === "legacy")).toEqual(before);
  });
});
