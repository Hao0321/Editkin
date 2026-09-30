import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { applyCommand } from "../domain/commands";
import { buildShortFormTemplateCommand, SHORT_FORM_TEMPLATES } from "./shortFormTemplates";
import { CINEMATIC_LANGUAGE_RECIPES } from "../creative/cinematicLanguage";
import { isTemplateGeneratedCaption, isTemplateGeneratedMarker } from "./templateLifecycle";

describe("short-form template compiler", () => {
  it("uses creator copy, palette, chapter and animation rate without inventing subtitles or changing media speed", () => {
    const source = createDemoProject(); source.width = 1080; source.height = 1920;
    let i = 0;
    const result = applyCommand(source, buildShortFormTemplateCommand(source, "editorial_steps", p => `${p}-${i++}`, {
      title: "實際內容的重點", body: "已核對的補充說明", accentColor: "#966144", surfaceColor: "#F4F0E8", motionSpeed: .7,
      progress: { steps: 4, activeStep: 3 },
    }));
    expect(result.motionGraphics.some(graphic => graphic.text === "實際內容的重點")).toBe(true);
    expect(result.motionGraphics.some(graphic => graphic.text === "已核對的補充說明")).toBe(true);
    const progress = result.motionGraphics.find(graphic => graphic.vectorV2?.kind === "step_progress")?.vectorV2;
    expect(progress?.kind === "step_progress" && progress.activeStep).toBe(3);
    expect(result.motionGraphics.find(graphic => graphic.vectorV2?.kind === "step_progress")?.accentColor).toBe("#966144");
    expect(result.motionGraphics.find(graphic => graphic.vectorV2?.kind === "panel")?.backgroundColor).toBe("#F4F0E8");
    expect(result.captions).toEqual(source.captions);
    expect(result.tracks[0].clips[0].sourceStart).toBe(source.tracks[0].clips[0].sourceStart);
    expect(result.tracks[0].clips[0].duration).toBe(source.tracks[0].clips[0].duration);
    expect(result.motionGraphics.find(graphic => graphic.text === "實際內容的重點")?.motionV2?.entrance.durationFrames).toBe(11);
    expect(() => buildShortFormTemplateCommand(source, "editorial_steps", p => p, { title: " " })).toThrow(/短標題/);
  });
  it("compiles every template to editable EditGraph commands", () => {
    for (const template of SHORT_FORM_TEMPLATES) {
      let nextId = 0;
      const source = applyCommand(createDemoProject(), { type: "split_clip", clipId: "clip-demo", at: 6, newClipId: "clip-demo-b" });
      const command = buildShortFormTemplateCommand(source, template.id, (prefix) => `${prefix}-${nextId++}`);
      const result = applyCommand(source, command);
      expect(result).toMatchObject({ width: source.width, height: source.height });
      expect(result.templateApplication).toMatchObject({ templateId: template.id, format: "short" });
      expect(result.motionGraphics.map((item) => item.kind)).toEqual(expect.arrayContaining(["title", "card", "tag", "counter"]));
      expect(result.motionGraphics).toHaveLength(4);
      expect(result.captions).toHaveLength(1);
      expect(result.captionStyle.color).toBe(template.palette.caption);
      expect(result.director.markers.at(-1)?.title).toContain(template.name);
      expect(result.director.markers.at(-1)?.note).toContain(template.cinematicRecipeId);
      expect(CINEMATIC_LANGUAGE_RECIPES.some((recipe) => recipe.id === template.cinematicRecipeId)).toBe(true);
      const firstClip = result.tracks.flatMap((track) => track.clips)[0];
      expect(firstClip.creative).toMatchObject({ lookPresetId: template.lookPresetId, effectPresetIds: template.effectPresetIds });
      expect(firstClip.creative?.transitionOut?.presetId).toBe(template.transitionPresetId);
    }
    expect(SHORT_FORM_TEMPLATES.find((template) => template.id === "beat_montage")?.cinematicRecipeId).toBe("beat_aligned_montage");
  });

  it("fails closed when there is no visual source", () => {
    const project = createDemoProject();
    project.tracks.find((track) => track.kind === "video")!.clips = [];
    expect(() => buildShortFormTemplateCommand(project, "clean_tutorial", (prefix) => prefix)).toThrow(/至少一段/);
  });

  it("styles existing subtitles instead of duplicating them", () => {
    const project = createDemoProject();
    project.captions.push({ id: "existing-caption", text: "來源字幕", start: 0, duration: 2 });
    const result = applyCommand(project, buildShortFormTemplateCommand(project, "mini_vlog", (prefix) => prefix));
    expect(result.captions).toEqual(project.captions);
    expect(result.captionStyle.presetId).toBe("exp26_location_postcard");
  });

  it("replaces the previous generated template overlay instead of stacking duplicates", () => {
    let id = 0;
    const source = createDemoProject();
    const first = applyCommand(source, buildShortFormTemplateCommand(source, "bold_hook", (prefix) => `${prefix}-${id++}`));
    const second = applyCommand(first, buildShortFormTemplateCommand(first, "mini_vlog", (prefix) => `${prefix}-${id++}`));
    expect(second.motionGraphics).toHaveLength(4);
    expect(second.motionGraphics.every((graphic) => graphic.presetId?.startsWith("editkin.template/short/mini_vlog/"))).toBe(true);
    expect(second.captions.filter(isTemplateGeneratedCaption)).toHaveLength(1);
    expect(second.director.markers.filter(isTemplateGeneratedMarker)).toHaveLength(1);
    expect(second.templateApplication?.templateId).toBe("mini_vlog");
  });

  it("preserves an explicitly selected project ratio", () => {
    const source = createDemoProject();
    source.width = 1080;
    source.height = 1350;
    const result = applyCommand(source, buildShortFormTemplateCommand(source, "clean_tutorial", (prefix) => `${prefix}-ratio`));
    expect(result).toMatchObject({ width: 1080, height: 1350 });
  });
});
