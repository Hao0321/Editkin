import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { applyCommand } from "../domain/commands";
import type { EditProject } from "../domain/types";
import { buildAutomaticCaptionCommand } from "./automaticCaptionCommands";
import { isTemplateGeneratedCaption } from "./templateLifecycle";
import { buildShortFormTemplateCommand } from "./shortFormTemplates";
import { buildLoopingMusicPlan } from "./loopingMusic";
import { automaticMusicPreferences, selectAutomaticMusicAsset } from "../creative/musicSelection";
import type { CreativeLibraryAsset } from "./creativeLibrary";

/** Wave 2 defect sweep (W2-3), application regressions: each case failed before its fix. */

describe("B11: automatic captions keep the cues a template owns", () => {
  it("replaces only the clip's ordinary captions", () => {
    let id = 0;
    const source = { ...createDemoProject(), width: 1080, height: 1920 };
    const project = applyCommand(source, buildShortFormTemplateCommand(source, "clean_tutorial", prefix => `${prefix}-${id++}`));
    const owned = project.captions.filter(caption => isTemplateGeneratedCaption(caption));
    expect(owned.length).toBeGreaterThan(0);
    const withOld = applyCommand(project, { type: "add_caption", caption: { id: "old-auto", text: "舊字幕", start: 6, duration: 2 } });
    const clip = withOld.tracks[0].clips[0];
    const planned = buildAutomaticCaptionCommand(withOld, clip, { cues: [{ start: 0.5, end: 1.5, text: "新的第一句" }] }, () => "new-cue");
    expect(planned).toMatchObject({ replaced: 1, keptTemplateCaptions: owned.length, added: 1 });
    const next = applyCommand(withOld, planned.command);
    expect(next.captions.map(caption => caption.id).sort()).toEqual(["new-cue", ...owned.map(caption => caption.id)].sort());
  });
});

describe("B7: the music bed is sized from the picture, not from the previous bed", () => {
  const music = { id: "asset-music", name: "bed", kind: "audio" as const, uri: "creative://music:bed", duration: 30, role: "background-music" as const };
  const bedEnd = (project: EditProject) => Math.max(...project.tracks.filter(track => track.id.startsWith("audio-music-"))
    .flatMap(track => track.clips.map(clip => clip.timelineStart + clip.duration)));
  it("re-running after the video got shorter shrinks the bed", () => {
    let project = createDemoProject(); // 12 s picture
    let plan = buildLoopingMusicPlan(project, music, index => `music-${index}`);
    project = applyCommand(project, { type: "batch", commands: plan.commands });
    expect(bedEnd(project)).toBe(12);
    project = applyCommand(project, { type: "trim_clip_end", clipId: "clip-demo", seconds: 7.8 });
    plan = buildLoopingMusicPlan(project, { ...music, id: "asset-music-2" }, index => `music-again-${index}`);
    expect(plan.targetDuration).toBeCloseTo(4.2, 9);
    project = applyCommand(project, { type: "batch", commands: plan.commands });
    expect(bedEnd(project)).toBeCloseTo(4.2, 9);
  });
});

describe("C: auto_add_music under the `auto` profile stays neutral instead of picking an unrelated genre", () => {
  const track = (id: string, name: string, category: string, use: string, bpm: number, duration: number): CreativeLibraryAsset => ({
    id: `music:${id}`, name, category, role: "background-music", domains: [category, use], mediaKind: "audio", bytes: 1, license: "test",
    provenance: "test", duration, bpm, suggestedUse: use });
  const library = [
    track("camp", "朋友歡樂露營-01", "露營", "general/explain", 107.67, 46),
    track("chill", "chill-01", "_通用", "general/explain", 92.29, 143),
    track("teach", "教學-01", "_通用", "hook/reveal (high energy)", 117.45, 142),
  ];
  it("a tutorial with no topic words gets a neutral bed", () => {
    const picked = selectAutomaticMusicAsset(library, { projectName: "示範專案", duration: 120, targetBpm: 107, ...automaticMusicPreferences("auto") });
    expect(picked?.category).toBe("_通用");
  });
  it("a topic word in the project name still wins", () => {
    const picked = selectAutomaticMusicAsset(library, { projectName: "露營 vlog", duration: 120, targetBpm: 107, ...automaticMusicPreferences("auto") });
    expect(picked?.id).toBe("music:camp");
  });
});
