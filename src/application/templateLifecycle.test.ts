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
    expect(second.motionGraphics.filter(isTemplateGeneratedGraphic)).toHaveLength(4);
    expect(second.captions.filter(isTemplateGeneratedCaption)).toHaveLength(1);
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
