import { describe, expect, it } from "vitest";
import { applyCommand } from "../domain/commands";
import { createDemoProject } from "../domain/demo";
import { createEmptyProject } from "../domain/editGraph";
import { createHistory, dispatchCommand, undo } from "../domain/history";
import { DEFAULT_CAPTION_STYLE, type MediaAsset } from "../domain/types";
import { sameCaptionStyle, shortsCaptionStyle } from "../creative/shortsCaptionStyle";
import { parseProject } from "./projectFiles";
import { planImportedMediaTimeline } from "./timelineImport";

const video = (id: string, width: number, height: number): MediaAsset => ({ id, name: `${id}.mov`, kind: "video", uri: `${id}.mov`, duration: 4, width, height });
const ids = () => { let n = 0; return (prefix: string) => `${prefix}-${++n}`; };

describe("a 9:16 project starts with Shorts captions (roadmap 1.7)", () => {
  it("first vertical import sets the Shorts white style in the same undoable import", () => {
    const project = createDemoProject();
    const plan = planImportedMediaTimeline(project, [video("vertical", 1080, 1920)], undefined, ids());
    const history = dispatchCommand(createHistory(project), plan.command);
    const imported = history.present;
    expect([imported.width, imported.height]).toEqual([1080, 1920]);
    expect(imported.captionStyle).toMatchObject({ fontSize: 95, marginV: 300, maxLineEm: 11, color: "#FFFFFF", shadowColor: "#00000099" });
    expect(parseProject(JSON.parse(JSON.stringify(imported))).captionStyle.marginV).toBe(300);
    expect(undo(history).present).toEqual(project);
  });

  it("uses the handbook face when the project is already travel or food", () => {
    const project = createEmptyProject("旅遊", { width: 1920, height: 1080 });
    project.editorialProfile = "food";
    const imported = applyCommand(project, planImportedMediaTimeline(project, [video("food", 1080, 1920)], undefined, ids()).command);
    expect(imported.captionStyle.fontFamily).toBe("LXGW WenKai TC");
  });

  it("keeps horizontal and square imports on the existing caption style", () => {
    for (const [width, height] of [[1920, 1080], [1080, 1080]]) {
      const project = createDemoProject();
      const imported = applyCommand(project, planImportedMediaTimeline(project, [video(`clip-${width}`, width, height)], undefined, ids()).command);
      expect(sameCaptionStyle(imported.captionStyle, DEFAULT_CAPTION_STYLE)).toBe(true);
    }
  });

  it("never overrides a style the creator already chose", () => {
    const project = applyCommand(createDemoProject(), { type: "set_caption_style", patch: { fontSize: 72, color: "#FFE066" } });
    const imported = applyCommand(project, planImportedMediaTimeline(project, [video("vertical", 1080, 1920)], undefined, ids()).command);
    expect(imported.captionStyle).toEqual(project.captionStyle);
  });

  it("persists the soft-shadow fields and rejects a malformed shadow colour on open", () => {
    const project = createEmptyProject("persist", { width: 1080, height: 1920 });
    project.captionStyle = shortsCaptionStyle(project, "gaming");
    expect(parseProject(JSON.parse(JSON.stringify(project))).captionStyle).toEqual(project.captionStyle);
    expect(() => parseProject({ ...JSON.parse(JSON.stringify(project)), captionStyle: { ...project.captionStyle, shadowColor: "black" } })).toThrow();
    expect(() => parseProject({ ...JSON.parse(JSON.stringify(project)), captionStyle: { ...project.captionStyle, shadowBlur: -1 } })).toThrow();
  });

  it("an untouched Shorts default returns to the legacy default when the first picture becomes horizontal", () => {
    const project = createEmptyProject("swap", { width: 1080, height: 1920 });
    project.captionStyle = shortsCaptionStyle(project);
    const imported = applyCommand(project, planImportedMediaTimeline(project, [video("wide", 1920, 1080)], undefined, ids()).command);
    expect([imported.width, imported.height]).toEqual([1920, 1080]);
    expect(sameCaptionStyle(imported.captionStyle, DEFAULT_CAPTION_STYLE)).toBe(true);
  });
});
