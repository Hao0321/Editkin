import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createDemoProject } from "../domain/demo";
import { applyCommand } from "../domain/commands";
import { createHistory, dispatchCommand, undo } from "../domain/history";
import { REFERENCE_MOTION_TEMPLATES, REFERENCE_MOTION_VIDEO_TYPES, REFERENCE_MOTION_DESIGN_THEMES } from "../motion/referenceMotionTemplates";
import { referenceMotionCatalogClips, referenceMotionCatalogSources, referenceMotionCatalogThemes, referenceMotionCatalogFamilies,
  referenceMotionCatalogInput, emptyReferenceMotionCatalogDraft, initialReferenceMotionCatalogSelection, type CatalogVideoType } from "./referenceMotionCatalogSelection";
import { inspectReferenceMotionTemplateInstance, prepareReferenceMotionTemplateInstance } from "./referenceMotionTemplateInstances";
import { parseProject } from "./projectCodec";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { preparePhysicalFace, type PreparedGlyphRun } from "../typography/preparedGlyphRun";

// Engine graph fixture plus actual bundled font bytes; this is not a media, native or art acceptance claim.
function fixture() {
  const project = createDemoProject(); project.width = 1080; project.height = 1920; project.schemaVersion = 10;
  project.tracks[0].clips[0].duration = 8; project.assets[0].duration = 30;
  for (let i = 1; i <= 8; i++) project.assets.push({ ...project.assets[0], id: `catalog-source-${i}`, uri: `catalog-source-${i}.mp4` });
  const draft = emptyReferenceMotionCatalogDraft();
  Object.assign(draft, { title: "真實 模板", previousText: "舊的原句", brandMark: "Editkin", primaryLabel: "示範操作" });
  draft.items = Array.from({ length: 4 }, (_, i) => ({ label: `${i + 1}個重點`, detail: `${i + 1}分` }));
  draft.sources = Array.from({ length: 8 }, (_, i) => ({ assetId: `catalog-source-${i + 1}`, sourceStart: "1", label: `素材${i + 1}` }));
  return { project, draft, clipId: project.tracks[0].clips[0].id, selection: initialReferenceMotionCatalogSelection() };
}
const faces = new Map<string, Promise<(text: string) => PreparedGlyphRun>>();
async function physicalText(faceId: string, text: string) {
  let face = faces.get(faceId);
  if (!face) { face = readFile(join(resolve("public/fonts"), bundledFontFaceSpec(faceId).fontFile))
    .then(bytes => preparePhysicalFace(faceId, new Uint8Array(bytes))); faces.set(faceId, face); }
  return (await face)(text);
}
describe("manual themed catalog contract", () => {
  it.each(Object.keys(REFERENCE_MOTION_VIDEO_TYPES) as CatalogVideoType[])("keeps all existing themes/families accessible for %s and ranks its recommendations", type => {
    const selection = initialReferenceMotionCatalogSelection(type);
    expect(referenceMotionCatalogThemes(type)).toHaveLength(8);
    expect(referenceMotionCatalogThemes(type)[0]).toBe(REFERENCE_MOTION_VIDEO_TYPES[type].styles[0]);
    for (const theme of Object.keys(REFERENCE_MOTION_DESIGN_THEMES) as Array<typeof selection.theme>) {
      const families = referenceMotionCatalogFamilies({ ...selection, theme });
      expect(new Set(families.map(item => item.id))).toEqual(new Set(REFERENCE_MOTION_TEMPLATES.map(item => item.id)));
      expect(families[0].id).toBe(REFERENCE_MOTION_VIDEO_TYPES[type].scenes[0]);
    }
  });
  it("accepts every existing family with real copy and complete source slots, without mutating the graph or draft", () => {
    const { project, draft, clipId, selection } = fixture(), before = structuredClone({ project, draft });
    for (const family of REFERENCE_MOTION_TEMPLATES) {
      const input = referenceMotionCatalogInput(project, clipId, { ...selection, family: family.id }, draft);
      expect(input.designSystem).toBe(selection.theme); expect(input.templateId).toBe(family.id);
      expect(input.sources).toHaveLength(family.sourceSlots); expect(input.evidenceRefs[0]).toMatch(/^manual:template-catalog-choice:/);
      for (const key of ["rightsBasis", "aestheticReview", "qaResult", "graphicPresentation", "focusRegion"]) expect(input).not.toHaveProperty(key);
    }
    expect({ project, draft }).toEqual(before);
  });
  it("requires real copy and handles hidden drafts without silently inventing text", () => {
    const { project, clipId, selection, draft } = fixture();
    expect(() => referenceMotionCatalogInput(project, clipId, selection, emptyReferenceMotionCatalogDraft())).toThrow("主標題");
    draft.items[3].label = "🤯"; draft.tag = "🤯";
    expect(referenceMotionCatalogInput(project, clipId, { ...selection, family: "level_bridge" }, draft).title).toBe("真實 模板");
    draft.title = "🤯"; expect(() => referenceMotionCatalogInput(project, clipId, selection, draft)).toThrow("尚未支援");
  });
  it("rejects unlocked graph aliases by normalized source path and by the existing byte pin", () => {
    const { project, clipId, selection, draft } = fixture(); selection.family = "comparison_pair";
    project.assets[1].uri = "file:///D:/Owned/Main.mp4"; project.assets[0].uri = "D:\\Owned\\Main.mp4";
    expect(() => referenceMotionCatalogInput(project, clipId, selection, draft)).toThrow("同一段影片");
    project.assets[1].uri = "other.mp4";
    project.assets[0].derivatives = { sourceSha256: "a".repeat(64), generatedAt: "2026-10-11T00:00:00Z" }; project.assets[1].derivatives = { sourceSha256: "a".repeat(64), generatedAt: "2026-10-11T00:00:00Z" };
    expect(() => referenceMotionCatalogInput(project, clipId, selection, draft)).toThrow("同一段影片");
  });
  it("filters locked, hidden, owned and invalid-color source candidates", () => {
    const { project } = fixture(); const clip = project.tracks[0].clips[0];
    expect(referenceMotionCatalogClips(project).map(item => item.id)).toEqual([clip.id]);
    project.tracks[0].locked = true; expect(referenceMotionCatalogClips(project)).toEqual([]); project.tracks[0].locked = false;
    project.tracks[0].hidden = true; expect(referenceMotionCatalogClips(project)).toEqual([]); project.tracks[0].hidden = false;
    clip.layer = { role: "adjustment", enabled: true, blendMode: "normal" }; expect(referenceMotionCatalogClips(project)).toEqual([]); delete clip.layer;
    project.assets[0].color = { interpretation: "auto" }; expect(referenceMotionCatalogClips(project)).toEqual([]);
    project.assets[0].color = { interpretation: "auto", primaries: "bt2020", transfer: "arib-std-b67", matrix: "bt2020nc", range: "tv" };
    expect(referenceMotionCatalogClips(project)).toHaveLength(1);
    project.assets[0].color.transfer = "smpte2084"; expect(referenceMotionCatalogSources(project).map(item => item.id)).not.toContain(clip.assetId);
  });
  it("rejects stale, fractional, too-short and out-of-source windows before preparation", () => {
    const { project, clipId, selection, draft } = fixture(); const clip = project.tracks[0].clips[0];
    expect(() => referenceMotionCatalogInput(project, "missing", selection, draft)).toThrow("選擇");
    clip.timelineStart = .001; expect(() => referenceMotionCatalogInput(project, clipId, selection, draft)).toThrow("完整影格");
    clip.timelineStart = 0; clip.duration = 1; expect(() => referenceMotionCatalogInput(project, clipId, selection, draft)).toThrow("太短");
    clip.duration = 8; clip.sourceStart = 29; expect(() => referenceMotionCatalogInput(project, clipId, selection, draft)).toThrow("素材範圍");
    clip.sourceStart = 0; project.height = 720; expect(() => referenceMotionCatalogInput(project, clipId, selection, draft)).toThrow("直式");
  });
  it("requires separate extra videos with exact, complete source windows", () => {
    const { project, clipId, selection, draft } = fixture(); selection.family = "focus_wall";
    draft.sourceCount = 8; expect(referenceMotionCatalogInput(project, clipId, selection, draft).sources).toHaveLength(8);
    draft.sources[1].assetId = draft.sources[0].assetId; expect(() => referenceMotionCatalogInput(project, clipId, selection, draft)).toThrow("不能重複");
    draft.sources[1].assetId = "catalog-source-2"; draft.sources[0].sourceStart = ".001";
    expect(() => referenceMotionCatalogInput(project, clipId, selection, draft)).toThrow("起點");
    draft.sources[0].sourceStart = "29"; expect(() => referenceMotionCatalogInput(project, clipId, selection, draft)).toThrow("起點");
  });
  it("rejects semantic copy errors with a product message rather than a schema dump", () => {
    const { project, clipId, selection, draft } = fixture(); draft.accentText = "不在標題";
    expect(() => referenceMotionCatalogInput(project, clipId, selection, draft)).toThrow("必須出現在"); draft.accentText = "";
    draft.items[0].label = "沒有數字"; selection.family = "stat_reveal";
    expect(() => referenceMotionCatalogInput(project, clipId, selection, draft)).toThrow("含數字");
    selection.family = "word_build"; draft.title = "一個詞";
    expect(() => referenceMotionCatalogInput(project, clipId, selection, draft)).toThrow("至少兩個詞");
  });
  it("prepares actual font layouts and a saved owner, remains CURRENT after serialization, and restores in one Undo", async () => {
    const { project, clipId, selection, draft } = fixture(); selection.family = "comparison_pair"; selection.theme = "trip_pop_v1";
    const before = structuredClone(project), input = referenceMotionCatalogInput(project, clipId, selection, draft); let ordinal = 0;
    const prepared = await prepareReferenceMotionTemplateInstance(project, input, (prefix, role) => `catalog-${prefix}-${role?.replaceAll(":", "-")}-${ordinal++}`, { prepareText: physicalText });
    let history = dispatchCommand(createHistory(project), { type: "batch", commands: prepared.commands });
    const reopened = parseProject(JSON.parse(JSON.stringify(history.present)));
    expect((await inspectReferenceMotionTemplateInstance(reopened, prepared.instance.id)).status).toBe("CURRENT");
    expect(reopened.motionGraphics.length).toBeGreaterThan(0); expect(prepared.layouts.length).toBeGreaterThan(0);
    for (const graphic of reopened.motionGraphics.filter(graphic => !graphic.vectorV2)) {
      expect(prepared.layouts.find(layout => layout.graphicId === graphic.id)?.physicalFont).toBeDefined();
    }
    expect(project).toEqual(before); history = undo(history); expect(history.present).toEqual(project);
    expect(applyCommand(project, { type: "batch", commands: prepared.commands }).referenceMotionInstances).toHaveLength(1);
  });
});
