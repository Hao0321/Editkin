import { describe, expect, it } from "vitest";
import { applyCommand } from "../domain/commands";
import { createDemoProject } from "../domain/demo";
import { buildLongFormTemplateCommand, LONG_FORM_TEMPLATES, LONG_FORM_WHITE_CAPTION_STYLE } from "./longFormTemplates";
import { CINEMATIC_LANGUAGE_RECIPES } from "../creative/cinematicLanguage";
import { isTemplateGeneratedGraphic, isTemplateGeneratedMarker } from "./templateLifecycle";

describe("long-form template compiler", () => {
  it("applies long-form narrative settings without injecting slides, invented subtitles or changing source footage", () => {
    for (const template of LONG_FORM_TEMPLATES) {
      let id = 0;
      const source = applyCommand(createDemoProject(), { type: "split_clip", clipId: "clip-demo", at: 6, newClipId: "clip-demo-b" });
      const result = applyCommand(source, buildLongFormTemplateCommand(source, template.id, (prefix) => `${prefix}-${id++}`));
      expect(result).toMatchObject({ width: source.width, height: source.height });
      expect(result.templateApplication).toMatchObject({ templateId: template.id, format: "long" });
      expect(result.motionGraphics).toEqual(source.motionGraphics);
      expect(result.captions).toEqual(source.captions);
      expect(result.captionStyle).toMatchObject(LONG_FORM_WHITE_CAPTION_STYLE);
      expect(result.captionStyle.color).toBe("#FFFFFF");
      expect(result.captionStyle.translationColor).toBe("#FFFFFF");
      expect(result.director.markers).toHaveLength(3);
      expect(result.director.markers[0].note).toContain(template.cinematicRecipeId);
      expect(CINEMATIC_LANGUAGE_RECIPES.some((recipe) => recipe.id === template.cinematicRecipeId)).toBe(true);
      expect(result.tracks).toEqual(source.tracks);
    }
  });

  it("never recolors existing long-form subtitles", () => {
    const source = createDemoProject();
    source.captions.push({ id: "caption-real", text: "真實逐句字幕", start: 0, duration: 2 });
    const result = applyCommand(source, buildLongFormTemplateCommand(source, "hao_tutorial", (prefix) => prefix));
    expect(result.captions).toEqual(source.captions);
    expect(new Set([result.captionStyle.color, result.captionStyle.translationColor])).toEqual(new Set(["#FFFFFF"]));
  });

  it("replaces a prior short or long template overlay without deleting user-authored graphics", () => {
    let id = 0;
    const source = createDemoProject();
    const userGraphic = {
      schema: "hao.motion-composition/v1" as const, id: "user-card", name: "我的字卡", kind: "card" as const,
      text: "保留我", timelineStart: 0, duration: 2, x: .1, y: .5, width: .4, fontSize: 40,
      textColor: "#FFFFFF", backgroundColor: "#111111DD", accentColor: "#FFFFFF", animation: "fade" as const,
      offsetX: 0, offsetY: 0,
    };
    source.motionGraphics.push(userGraphic);
    const first = applyCommand(source, buildLongFormTemplateCommand(source, "hao_tutorial", (prefix) => `${prefix}-${id++}`));
    const second = applyCommand(first, buildLongFormTemplateCommand(first, "interview_story", (prefix) => `${prefix}-${id++}`));
    expect(second.motionGraphics.filter((graphic) => graphic.id === "user-card")).toHaveLength(1);
    expect(second.motionGraphics.filter(isTemplateGeneratedGraphic)).toHaveLength(0);
    expect(second.director.markers.filter(isTemplateGeneratedMarker)).toHaveLength(3);
    expect(second.director.markers).toHaveLength(3);
  });

  it("does not overwrite a portrait project ratio", () => {
    const source = createDemoProject();
    source.width = 1080;
    source.height = 1920;
    const result = applyCommand(source, buildLongFormTemplateCommand(source, "hao_tutorial", (prefix) => `${prefix}-portrait`));
    expect(result).toMatchObject({ width: 1080, height: 1920 });
  });
});
