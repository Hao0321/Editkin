import { describe, expect, it } from "vitest";
import { applyCommand } from "../domain/commands";
import { createEmptyProject } from "../domain/editGraph";
import { createDemoProject } from "../domain/demo";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { motionClipPresetCommands } from "../motion/motionClipPresets";
import { floatingFrameSceneCommands } from "../motion/floatingFrameScenes";
import { assertMotionGraphicPresetBinding } from "../creative/motionGraphicPresets";
import { buildShortFormTemplateCommand } from "./shortFormTemplates";

describe("original motion recipes for spatial and editorial reels", () => {
  it("applies the portrait chapter template as actual editable geometry and removes it cleanly when changing templates", () => {
    let id = 0;
    const source = { ...createDemoProject(), width: 1080, height: 1920 };
    const added = applyCommand(source, buildShortFormTemplateCommand(source, "editorial_steps", p => `${p}-${id++}`));
    expect(added.motionGraphics.filter(g => g.vectorV2)).toHaveLength(5);
    const switched = applyCommand(added, buildShortFormTemplateCommand(added, "clean_tutorial", p => `${p}-${id++}`));
    expect(switched.motionGraphics.some(g => g.vectorV2)).toBe(false);
    expect(switched.tracks.flatMap(t => t.clips)).toHaveLength(1);
  });
  it("authors frame-accurate 2D camera gestures without altering the source clip", () => {
    const clip = createDemoProject().tracks[0].clips[0];
    const untouched = structuredClone(clip);
    const gallery = motionClipPresetCommands(clip, 30, "gallery_drift");
    const chapter = motionClipPresetCommands(clip, 30, "chapter_snap");
    expect(gallery).toHaveLength(3);
    expect(gallery.map(command => command.type)).toEqual(["add_keyframe", "add_keyframe", "add_keyframe"]);
    expect(gallery[0]).toMatchObject({ keyframe: { time: 0, transform: { x: clip.transform.x - 20, rotation: clip.transform.rotation - 1.2 } } });
    expect(chapter.map(command => command.type === "add_keyframe" ? command.keyframe.time : undefined)).toEqual([0, 8 / 30, 12 / 30]);
    expect(clip).toEqual(untouched);
  });

  it("builds three editable portrait video planes with different positions and a moving foreground", () => {
    let project = createEmptyProject("Gallery", { width: 360, height: 640, fps: 30 });
    project = applyCommand(project, { type: "import_asset", asset: {
      id: "owned-video", name: "Owned video", kind: "video", uri: "owned.mp4", duration: 3, width: 360, height: 640,
      color: { interpretation: "rec709" },
    } });
    project = applyCommand(project, { type: "add_clip", clip: {
      id: "owned-clip", assetId: "owned-video", trackId: "video-main", timelineStart: 0, sourceStart: 0,
      duration: 3, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
    } });
    const original = structuredClone(project);
    const commands = floatingFrameSceneCommands(project, "owned-clip", "portrait_stack");
    const applied = applyCommand(project, { type: "batch", commands });
    const cards = applied.tracks.flatMap(track => track.clips).filter(clip => clip.floatingFrame);
    expect(commands).toHaveLength(5);
    expect(cards).toHaveLength(3);
    expect(new Set(cards.map(clip => clip.floatingFrame!.centerX)).size).toBe(3);
    expect(cards.filter(clip => clip.floatingFrame?.orbit)).toHaveLength(1);
    expect(cards.filter(clip => clip.volume > 0)).toHaveLength(1);
    expect(project).toEqual(original);
  });

  it.each([
    ["spatial_gallery", "reel_spatial_headline"],
    ["editorial_steps", "reel_editorial_step"],
  ] as const)("applies %s as an editable v2 title with replaceable copy", (templateId, presetId) => {
    let next = 0;
    const source = createDemoProject();
    const applied = applyCommand(source, buildShortFormTemplateCommand(source, templateId, prefix => `${prefix}-${next++}`));
    const title = applied.motionGraphics.find(graphic => graphic.kind === "title")!;
    expect(title.schema).toBe("hao.motion-composition/v2");
    expect(title.motionV2?.entrance.durationFrames).toBeGreaterThan(0);
    expect(assertMotionGraphicPresetBinding(title, presetId).id).toBe(presetId);
    expect(applied.templateApplication?.templateId).toBe(templateId);
    expect(applied.director.markers.at(-1)?.note).toContain("逐格 Motion");
  });
});
