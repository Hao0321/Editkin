import { describe, expect, it } from "vitest";
import { applyCommand, type EditorCommand } from "../domain/commands";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { styleTemplateAddClipCommandV1, styleTemplateUpdateClipCommandV1 } from "../styleTemplates/slots/clipCommands";
import { compileStyleTemplateClipV1 } from "../styleTemplates/slots/compileClip";
import { styleTemplateClipAssetV1 } from "../styleTemplates/slots/renderTemplateClip";
import { assertDesignDecisionBinding, designEvidenceSchema } from "./autopilotDesignContract";

/**
 * A VA design decision may bind an editable style-template clip (graphic.style_template): add_style_template_clip and
 * update_style_template_clip are visible timeline commands, like the Motion Library clip commands. Renders are stood in by
 * their compiled field and the asset record the renderer would publish (real renders: templateClip.render.test.ts).
 */
function evidence(indexes = [0]) {
  return designEvidenceSchema.parse({
    schema: "editkin.autopilot-design-evidence/v1",
    request: { format: "shorts", domain: "editing", topic: "Editable template clip", duration: 12,
      beats: [{ id: "chapter", role: "chapter", energy: .6, subject: "Chapter card with the keyword" }] },
    projectSha256: "a".repeat(64), sourceSha256: "b".repeat(64), briefSha256: "c".repeat(64),
    decisions: [{ beatId: "chapter", recipeSha256: "d".repeat(64), application: "Bind the template clip that shows this chapter's keyword", commandIndexes: indexes }],
  });
}

const CACHE = "D:/workspace/.editkin-media-cache";
function rendered(keyword: string) {
  const slots = { text: { chapterNumber: "01", chapterLabel: "用 AI 做遊戲", lead: "還有", keyword, tag: "GPT" }, color: {}, image: {} };
  const compiled = compileStyleTemplateClipV1({ templateId: "S1_explainer_ui", slots, frame: { width: 1080, height: 1920, fps: 30 }, images: {}, durationSeconds: 2.2 });
  return { field: compiled.field, asset: styleTemplateClipAssetV1(compiled.field, `${CACHE}/styletpl-clip/S1_explainer_ui/${compiled.field.key}.mov`, { width: 1080, height: 1920, fps: 30 }, "產品教學", []) };
}
function base(): EditProject {
  const project = applyCommand(createEmptyProject("Design binding", { id: "design", width: 1080, height: 1920, fps: 30 }),
    { type: "import_asset", asset: { id: "footage", name: "footage", kind: "video", uri: "footage.mp4", duration: 10, width: 1080, height: 1920 } });
  return applyCommand(project, { type: "add_clip", clip: { id: "base", assetId: "footage", trackId: "video-main", timelineStart: 0, sourceStart: 0, duration: 10, volume: 1,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] } });
}
const templateClip = (project: EditProject) => project.tracks.flatMap(track => track.clips).find(clip => clip.id === "tpl-1")!;

describe("design evidence binds editable style-template clip commands", () => {
  it("accepts add_style_template_clip, and the command really adds a template clip on the timeline", () => {
    const project = base(), before = structuredClone(project);
    const add = styleTemplateAddClipCommandV1(project, rendered("角色立繪"), { clipId: "tpl-1", startFrame: 30 });
    expect(() => assertDesignDecisionBinding(evidence(), [add], ["chapter"])).not.toThrow();
    const after = applyCommand(project, add);
    expect(templateClip(after)).toMatchObject({ timelineStart: 1, styleJob: { template: { id: "S1_explainer_ui" }, slots: { text: { keyword: "角色立繪" } } } });
    expect(project).toEqual(before);
  });

  it("accepts update_style_template_clip, and the command really swaps the clip to the new render", () => {
    const project = base(), first = rendered("角色立繪"), second = rendered("遊戲引擎");
    const added = applyCommand(project, styleTemplateAddClipCommandV1(project, first, { clipId: "tpl-1", startFrame: 0 }));
    const update = styleTemplateUpdateClipCommandV1(added, templateClip(added), second);
    expect(() => assertDesignDecisionBinding(evidence([0, 1]), [styleTemplateAddClipCommandV1(project, first, { clipId: "tpl-1", startFrame: 0 }), update], ["chapter"])).not.toThrow();
    expect(() => assertDesignDecisionBinding(evidence(), [update], ["chapter"])).not.toThrow();
    const updated = applyCommand(added, update);
    expect(templateClip(updated)).toMatchObject({ assetId: second.asset.id, styleJob: { key: second.field.key, slots: { text: { keyword: "遊戲引擎" } } } });
    expect(templateClip(updated).assetId).not.toBe(templateClip(added).assetId);
  });

  it("still refuses a template clip command hidden in a nested batch, metadata beside it, and a missing index", () => {
    const project = base(), add = styleTemplateAddClipCommandV1(project, rendered("角色立繪"), { clipId: "tpl-1", startFrame: 0 });
    expect(() => assertDesignDecisionBinding(evidence(), [{ type: "batch", commands: [add] }], ["chapter"])).toThrow(/nested batches/);
    const rename: EditorCommand = { type: "rename_track", trackId: "video-main", name: "Renamed" };
    expect(() => assertDesignDecisionBinding(evidence([0, 1]), [add, rename], ["chapter"])).toThrow(/metadata/);
    expect(() => assertDesignDecisionBinding(evidence([0, 1]), [add], ["chapter"])).toThrow(/actual visual\/audio commands/);
  });
});
