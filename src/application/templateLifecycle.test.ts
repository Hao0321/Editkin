import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { applyCommand } from "../domain/commands";
import { buildLongFormTemplateCommand } from "./longFormTemplates";
import { buildShortFormTemplateCommand } from "./shortFormTemplates";
import { parseProject } from "./projectFiles";
import {
  isTemplateGeneratedCaption,
  isTemplateGeneratedGraphic,
  isTemplateGeneratedMarker,
  templateApplicationCleanupCommands,
  templateOwnedElementCount,
} from "./templateLifecycle";

function ids() {
  let next = 0;
  return (prefix: string) => `${prefix}-${next++}`;
}

describe("template application lifecycle", () => {
  it("replaces three-source gallery templates and restores geometry without deleting user-added clips", () => {
    const source = createDemoProject(); source.width = 1080; source.height = 1920;
    const original = source.assets[0];
    source.assets.push({ ...original, id: "source-two" }, { ...original, id: "source-three" });
    const content = { title: "我的三個角度", sources: { rearRight: { assetId: "source-two", sourceStart: 0 }, front: { assetId: "source-three", sourceStart: 0 } } };
    const makeId = ids();
    const applied = parseProject(JSON.parse(JSON.stringify(applyCommand(source, buildShortFormTemplateCommand(source, "spatial_gallery", makeId, content)))));
    expect(applied.templateApplication?.generatedClips).toHaveLength(2);
    expect(applied.tracks.flatMap(track => track.clips)).toHaveLength(3);
    expect(new Set(applied.tracks.flatMap(track => track.clips).map(clip => clip.assetId)).size).toBe(3);
    const replaced = applyCommand(applied, buildShortFormTemplateCommand(applied, "spatial_gallery", makeId, { ...content, title: "替換後的標題" }));
    expect(replaced.tracks.flatMap(track => track.clips)).toHaveLength(3);
    expect(replaced.motionGraphics.map(graphic => graphic.text)).toEqual(["替換後的標題"]);
    expect(replaced.captions).toEqual(source.captions);
    const track = replaced.tracks.find(row => row.id === replaced.templateApplication!.generatedClips![0].trackId)!;
    const userClip = { ...structuredClone(source.tracks[0].clips[0]), id: "user-added", trackId: track.id, timelineStart: 15, duration: 1 };
    const withUser = applyCommand(replaced, { type: "add_clip", clip: userClip });
    const restored = applyCommand(withUser, { type: "clear_template_application" });
    expect(restored.tracks.flatMap(row => row.clips).map(clip => clip.id)).toEqual([source.tracks[0].clips[0].id, "user-added"]);
    expect(restored.tracks[0].clips[0].floatingFrame).toEqual(source.tracks[0].clips[0].floatingFrame);
    expect(restored.motionGraphics).toEqual(source.motionGraphics);
    expect(() => buildShortFormTemplateCommand(source, "spatial_gallery", ids(), { ...content, sources: { rearRight: content.sources.front, front: content.sources.front } })).toThrow(/三個不同/);
  });
  it("uses explicit ownership and never treats user copy or ID prefixes as ownership", () => {
    const source = createDemoProject();
    source.captions.push({ id: "template-caption-user", text: "真人字幕", start: 0, duration: 1 });
    source.director.markers.push({
      id: "template-receipt-user", time: 0, title: "短影音模板 · 我的手動筆記", note: "保留",
      kind: "note", status: "open", createdAt: source.updatedAt,
    });
    source.motionGraphics.push({
      schema: "hao.motion-composition/v1", id: "template-title-user", presetId: "editkin.template/short/fake/title",
      name: "手動字卡", kind: "title", text: "保留", timelineStart: 0, duration: 1, x: .1, y: .1, width: .4,
      fontSize: 40, textColor: "#FFFFFF", backgroundColor: "#000000", accentColor: "#FFFFFF", animation: "fade", offsetX: 0, offsetY: 0,
    });
    expect(templateOwnedElementCount(source)).toBe(0);
    expect(templateApplicationCleanupCommands(source)).toEqual([]);
    expect(isTemplateGeneratedCaption(source.captions[0])).toBe(false);
    expect(isTemplateGeneratedMarker(source.director.markers[0])).toBe(false);
    expect(isTemplateGeneratedGraphic(source.motionGraphics[0])).toBe(false);
    const templated = applyCommand(source, buildShortFormTemplateCommand(source, "clean_tutorial", ids()));
    const cleared = applyCommand(templated, { type: "clear_template_application" });
    expect(cleared.captions).toEqual(source.captions);
    expect(cleared.director.markers).toEqual(source.director.markers);
    expect(cleared.motionGraphics).toEqual(source.motionGraphics);
  });

  it("rolls back all template-owned project settings and elements in one undoable command", () => {
    const source = createDemoProject();
    source.width = 1080;
    source.height = 1350;
    source.captionStyle.fontSize = 61;
    source.tracks[0].clips[0].creative = { lookPresetId: "clean_neutral", effectPresetIds: ["film_grain_soft"] };
    const original = structuredClone(source);
    const templated = applyCommand(source, buildShortFormTemplateCommand(source, "clean_tutorial", ids()));
    expect(templateOwnedElementCount(templated)).toBe(6);
    expect(templated.templateApplication).toBeDefined();
    const reopened = parseProject(JSON.parse(JSON.stringify(templated)));
    expect(reopened.templateApplication).toEqual(templated.templateApplication);
    expect(reopened.director.markers.filter(isTemplateGeneratedMarker)).toHaveLength(1);
    const cleared = applyCommand(templated, { type: "batch", commands: templateApplicationCleanupCommands(templated) });
    expect(templateOwnedElementCount(cleared)).toBe(0);
    expect(cleared.templateApplication).toBeUndefined();
    expect(cleared).toMatchObject({ width: 1080, height: 1350, editorialProfile: original.editorialProfile });
    expect(cleared.captionStyle).toEqual(original.captionStyle);
    expect(cleared.aestheticSystem).toEqual(original.aestheticSystem);
    expect(cleared.tracks[0].clips[0].creative).toEqual(original.tracks[0].clips[0].creative);
  });

  it("reapply is idempotent across short and long templates, then restores the original baseline", () => {
    const source = createDemoProject();
    source.captionStyle.fontSize = 63;
    const makeId = ids();
    const first = applyCommand(source, buildShortFormTemplateCommand(source, "bold_hook", makeId));
    const second = applyCommand(first, buildLongFormTemplateCommand(first, "interview_story", makeId));
    expect(second.motionGraphics.filter(isTemplateGeneratedGraphic)).toHaveLength(0);
    expect(second.captions.filter(isTemplateGeneratedCaption)).toHaveLength(0);
    expect(second.director.markers.filter(isTemplateGeneratedMarker)).toHaveLength(3);
    expect(second.templateApplication).toMatchObject({ templateId: "interview_story", format: "long" });
    const cleared = applyCommand(second, { type: "clear_template_application" });
    expect(cleared.captionStyle).toEqual(source.captionStyle);
    expect(cleared.editorialProfile).toBe(source.editorialProfile);
    expect(cleared.aestheticSystem).toEqual(source.aestheticSystem);
    expect(cleared.tracks[0].clips[0].creative).toEqual(source.tracks[0].clips[0].creative);
  });

  it("preserves fields the user changed after applying a template", () => {
    const source = createDemoProject();
    const templated = applyCommand(source, buildShortFormTemplateCommand(source, "mini_vlog", ids()));
    const customized = applyCommand(templated, { type: "batch", commands: [
      { type: "set_caption_style", patch: { fontSize: 77 } },
      { type: "set_clip_creative", clipId: "clip-demo", patch: { lookPresetId: "clean_neutral" } },
      { type: "set_project_resolution", width: 1080, height: 1920 },
    ] });
    const cleared = applyCommand(customized, { type: "clear_template_application" });
    expect(cleared.captionStyle.fontSize).toBe(77);
    expect(cleared.captionStyle.color).toBe(source.captionStyle.color);
    expect(cleared.tracks[0].clips[0].creative?.lookPresetId).toBe("clean_neutral");
    expect(cleared).toMatchObject({ width: 1080, height: 1920 });
  });
});
