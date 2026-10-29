import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createEmptyProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { referenceMotionInstanceSchema, referenceMotionTemplateRevisionPatchSchema, type ReferenceMotionTemplateInstance } from "../domain/referenceMotionInstance";
import { DEFAULT_REFERENCE_MOTION_STYLE, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { preparePhysicalFace, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { parseProject } from "../application/projectCodec";
import { prepareReferenceMotionTemplateInstance, prepareReferenceMotionTemplateRevision } from "../application/referenceMotionTemplateInstances";
import { plainReferenceMotionInspection, REFERENCE_MOTION_TEXT_POSITIONS, referenceMotionAccentConflict, referenceMotionInstanceDraft, referenceMotionInstanceDraftPatch,
  referenceMotionTextPosition, SavedReferenceMotionInstanceForm, type ReferenceMotionInstanceDraft } from "./SavedReferenceMotionInstances";

// The real editor form and draft/patch functions, plus the real saved-template compiler for the fields it now sends.
// Static React markup and direct handler calls; no mounted browser layout or rendered pixels are claimed.
vi.mock("./i18n/interfacePreferences", async importOriginal => {
  const actual = await importOriginal<typeof import("./i18n/interfacePreferences")>();
  return { ...actual, useI18n: () => ({ ...actual.interfacePreferences.getSnapshot(), t: actual.translateUi }) };
});

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
const byLabel = (tree: ReactNode, label: string) => elements(tree).find(element => element.props["aria-label"] === label);
const byTestId = (tree: ReactNode, id: string) => elements(tree).find(element => element.props["data-testid"] === id);

function instance(input: Partial<ReferenceMotionTemplateInput>): ReferenceMotionTemplateInstance {
  return referenceMotionInstanceSchema.parse({ schema: "editkin.reference-motion-instance/v1", id: "saved", authoringGeneration: 2, instanceRevision: 1,
    input: { templateId: "strike_reframe", clipId: "primary", startFrame: 45, durationFrames: 330, title: "其實是來看水簾", previousText: "來看蝙蝠",
      sources: [], intent: "shortform", purpose: "Owned UI control", evidenceRefs: ["owned:ui"], style: structuredClone(DEFAULT_REFERENCE_MOTION_STYLE), ...input },
    frameFormat: { width: 1080, height: 1920, fps: 30 }, roles: [{ key: "headline", kind: "graphic", id: "heading" }], primaryBefore: { layout: null },
    appliedScopeSha256: "1".repeat(64), dependencies: { recipeVersion: "ui-only", presetHashes: [], fonts: [] } });
}
const design = () => instance({ designSystem: "trip_pop_v1", accentText: "水簾", tag: "沒有蝙蝠", brandMark: "Hao0321 Studio", kicker: "桃園復興｜三民蝙蝠洞" });
function form(saved: ReferenceMotionTemplateInstance, status: "CURRENT" | "EDITED" = "CURRENT", draft = referenceMotionInstanceDraft(saved), reason = "Managed template scope and compiled dependencies match") {
  const onDraftChange = vi.fn((next: ReferenceMotionInstanceDraft) => { draft = next; }), onRevise = vi.fn();
  const render = () => SavedReferenceMotionInstanceForm({ instance: saved, assets: [], inspection: { status, reason }, draft, onDraftChange, busy: false,
    onRevise, onDetach: () => {}, onCancel: () => {}, clipName: "蝙蝠洞.mov" });
  return { render, onDraftChange, onRevise, draft: () => draft };
}
function edit(tree: ReactNode, label: string, value: string) {
  (byLabel(tree, label)!.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
}

describe("2.4 design-theme template fields: highlight word, image label, brand, no menus that error", () => {
  it("shows the highlight word, image label and brand fields, and hides the two strike menus that a design theme rejects", () => {
    const tree = form(design()).render();
    expect(byLabel(tree, "已儲存模板重點字")?.props.value).toBe("水簾");
    expect(byLabel(tree, "已儲存模板圖片標籤")?.props.value).toBe("沒有蝙蝠");
    expect(byLabel(tree, "已儲存模板品牌短字")?.props.value).toBe("Hao0321 Studio");
    expect(byLabel(tree, "已儲存模板刪線呈現")).toBeUndefined();
    expect(byLabel(tree, "已儲存刪線畫面用途")).toBeUndefined();
    expect(byLabel(tree, "已儲存模板刪線原句")?.props.value).toBe("來看蝙蝠");
    expect(byTestId(tree, "saved-template-position")).toBeUndefined();
    // Seconds and the clip's name, not frame counts and IDs.
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("蝙蝠洞.mov"); expect(html).toContain("從 1.50 秒開始，長 11.00 秒"); expect(html).not.toContain("primary");
  });
  it("sends only the changed design fields, never strike presentation fields", () => {
    const saved = design(), draft = referenceMotionInstanceDraft(saved);
    expect(draft).not.toHaveProperty("strikePresentation");
    expect(referenceMotionInstanceDraftPatch(saved, draft)).not.toHaveProperty("accentText");
    draft.accentText = "來看水簾"; draft.tag = ""; draft.brandMark = "Hao 工作室";
    const patch = referenceMotionTemplateRevisionPatchSchema.parse(referenceMotionInstanceDraftPatch(saved, draft));
    expect(patch).toMatchObject({ accentText: "來看水簾", tag: null, brandMark: "Hao 工作室" });
    expect(patch).not.toHaveProperty("strikePresentation"); expect(patch).not.toHaveProperty("strikeSurface"); expect(patch).not.toHaveProperty("textRegion");
  });
  it("warns before a title change drops the highlight word, blocks the update, and drops it only when asked", () => {
    const saved = design(), ui = form(saved);
    edit(ui.render(), "已儲存模板主標題", "其實是來看瀑布");
    expect(referenceMotionAccentConflict(saved, ui.draft())).toBe("水簾");
    let tree = ui.render();
    expect(renderToStaticMarkup(byTestId(tree, "saved-template-accent-warning")!)).toContain("重點字「水簾」不在標題裡");
    expect(byTestId(tree, "revise-reference-motion-instance")?.props.disabled).toBe(true);
    expect(() => referenceMotionInstanceDraftPatch(saved, ui.draft())).toThrow(/重點字「水簾」不在標題裡/);
    (byTestId(tree, "saved-template-drop-accent")!.props.onClick as () => void)();
    tree = ui.render();
    expect(byTestId(tree, "saved-template-accent-warning")).toBeUndefined();
    expect(byTestId(tree, "revise-reference-motion-instance")?.props.disabled).toBe(false);
    (byTestId(tree, "revise-reference-motion-instance")!.props.onClick as () => void)();
    expect(ui.onRevise.mock.calls[0][0]).toMatchObject({ title: "其實是來看瀑布", accentText: null });
  });
  it("keeps the highlight word when the new title still contains it", () => {
    const saved = design(), draft = referenceMotionInstanceDraft(saved); draft.title = "原來是看水簾的";
    expect(referenceMotionAccentConflict(saved, draft)).toBeUndefined();
    expect(referenceMotionInstanceDraftPatch(saved, draft)).not.toHaveProperty("accentText");
  });
});

describe("2.4 text position for on-footage text", () => {
  const overlay = (textRegion?: ReferenceMotionTemplateInput["textRegion"]) => instance({ strikePresentation: "semantic_replace_v1", strikeSurface: "source_overlay_v2",
    ...(textRegion ? { textRegion } : {}) });
  it("offers four plain positions and sends the chosen region, or null to go back", () => {
    const saved = overlay(), ui = form(saved);
    const group = byTestId(ui.render(), "saved-template-position")!;
    expect(elements(group.props.children as ReactNode).filter(element => element.type === "button").map(element => element.props["data-testid"]))
      .toEqual(["saved-template-position-default", "saved-template-position-top", "saved-template-position-middle", "saved-template-position-bottom"]);
    (byTestId(ui.render(), "saved-template-position-top")!.props.onClick as () => void)();
    expect(byTestId(ui.render(), "saved-template-position-top")?.props["aria-pressed"]).toBe(true);
    expect(referenceMotionTemplateRevisionPatchSchema.parse(referenceMotionInstanceDraftPatch(saved, ui.draft())).textRegion).toEqual(REFERENCE_MOTION_TEXT_POSITIONS.top);
    const placed = overlay(REFERENCE_MOTION_TEXT_POSITIONS.bottom), back = referenceMotionInstanceDraft(placed);
    expect(back.textPosition).toBe("bottom"); back.textPosition = "default";
    expect(referenceMotionInstanceDraftPatch(placed, back).textRegion).toBeNull();
  });
  it("keeps an observed custom region unless the creator picks another position", () => {
    const custom = { x: .1, y: .2, width: .6, height: .3 };
    expect(referenceMotionTextPosition(custom)).toBe("custom");
    const saved = overlay(custom), draft = referenceMotionInstanceDraft(saved);
    expect(draft.textPosition).toBe("custom"); expect(referenceMotionInstanceDraftPatch(saved, draft)).not.toHaveProperty("textRegion");
    expect(byTestId(form(saved).render(), "saved-template-position-custom")?.props["aria-pressed"]).toBe(true);
  });
  it("does not offer a position on templates that cannot move their words", () => {
    expect(byTestId(form(instance({ strikePresentation: "semantic_replace_v1", strikeSurface: "standalone" })).render(), "saved-template-position")).toBeUndefined();
    expect(byTestId(form(instance({ templateId: "level_bridge", previousText: undefined, overlayPresentation: "source_editorial_v1" })).render(), "saved-template-position")).toBeDefined();
  });
});

describe("2.5 plain status instead of engine wording", () => {
  it("explains an edited template in plain words and keeps the engine reason out of sight", () => {
    const html = renderToStaticMarkup(form(design(), "EDITED", undefined, "Managed template content or source binding changed").render());
    expect(html).toContain(plainReferenceMotionInspection({ status: "EDITED", reason: "Managed template content or source binding changed" }));
    expect(html).toContain("主片段或模板裡的字和圖被改過"); expect(html).toContain("要重新套用才能改字");
    // The engine's reason is kept for support in an attribute, never shown as text.
    expect(html).toContain('data-engine-reason="Managed template content or source binding changed"');
    expect(html.replace(/data-engine-reason="[^"]*"/, "")).not.toContain("Managed template content"); expect(html).not.toContain("技術細節");
    expect(plainReferenceMotionInspection({ status: "CURRENT", reason: "x" })).toBe("可以修改文字、字型和配色。");
    expect(plainReferenceMotionInspection({ status: "EDITED", reason: "EDITED: primary template visuals contain an external keyframe or enabled mask" }))
      .toBe("主片段上另外加了動畫或遮罩，模板暫時不能改字。");
  });
});

// The fields this editor now sends are accepted by the real compiler with real glyph bytes.
const faces = new Map<string, Promise<(text: string) => PreparedGlyphRun>>();
async function physicalText(faceId: string, text: string) {
  let face = faces.get(faceId);
  if (!face) {
    face = readFile(join(resolve("public/fonts"), bundledFontFaceSpec(faceId).fontFile)).then(bytes => preparePhysicalFace(faceId, new Uint8Array(bytes)));
    if (faces.size >= 6) faces.delete(faces.keys().next().value!);
    faces.set(faceId, face);
  }
  return (await face)(text);
}
function ids() { let next = 0; return (prefix: string, role?: string) => `${prefix}-${role?.replaceAll(":", "-") ?? ""}-${next++}`; }
async function savedProject(input: Partial<ReferenceMotionTemplateInput>, durationFrames = 330) {
  const project = createEmptyProject("Fields", { id: "fields", width: 1080, height: 1920, fps: 30 });
  project.assets = [{ id: "media-0", name: "蝙蝠洞.mov", kind: "video", uri: "D:/owned/cave.mov", duration: 30, width: 1080, height: 1920, displayAspectRatio: 9 / 16,
    color: { interpretation: "rec709" } }];
  project.tracks[0].clips = [{ id: "primary", trackId: project.tracks[0].id, assetId: "media-0", timelineStart: 1, sourceStart: 1, duration: durationFrames / 30,
    volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }];
  const full = { templateId: "strike_reframe", clipId: "primary", startFrame: 30, durationFrames, graphicCadence: "kinetic", intent: "shortform", sources: [],
    previousText: "來看蝙蝠", title: "其實是來看水簾", evidenceRefs: ["owned:fixture"], purpose: "Owned fields control", ...input } as ReferenceMotionTemplateInput;
  const packet = await prepareReferenceMotionTemplateInstance(parseProject(project), full, ids(), { prepareText: physicalText });
  return { packet, current: applyCommand(parseProject(project), { type: "batch", commands: packet.commands }) };
}

describe("the new fields go through the real recompile", () => {
  it("a design-theme highlight word and image label change recompile into the saved template", async () => {
    const { packet, current } = await savedProject({ designSystem: "trip_pop_v1", accentText: "水簾", tag: "沒有蝙蝠", kicker: "桃園復興｜三民蝙蝠洞" });
    const draft = referenceMotionInstanceDraft(packet.instance); draft.accentText = "來看水簾"; draft.tag = "看水簾";
    const revised = await prepareReferenceMotionTemplateRevision(current, packet.instance.id, referenceMotionInstanceDraftPatch(packet.instance, draft),
      { expectedInstanceRevision: 1, prepareText: physicalText, idFactory: ids() });
    expect(revised.status).toBe("REVIEW_REQUIRED");
    expect(revised.instance.input).toMatchObject({ accentText: "來看水簾", tag: "看水簾", title: "其實是來看水簾" });
    const applied = applyCommand(current, { type: "batch", commands: revised.commands });
    expect(applied.referenceMotionInstances![0].instanceRevision).toBe(2);
  }, 120_000);
  it("a text position moves on-footage words into the chosen region through the real recompile", async () => {
    const style = { ...structuredClone(DEFAULT_REFERENCE_MOTION_STYLE), palette: { surface: "#111111", text: "#FFFFFF", accent: "#FFD400", muted: "#D0D0D0", separator: "#444444" } };
    const { packet, current } = await savedProject({ strikePresentation: "semantic_replace_v1", strikeSurface: "source_overlay_v2", kicker: "三民蝙蝠洞", style });
    const draft = referenceMotionInstanceDraft(packet.instance); draft.textPosition = "bottom";
    const revised = await prepareReferenceMotionTemplateRevision(current, packet.instance.id, referenceMotionInstanceDraftPatch(packet.instance, draft),
      { expectedInstanceRevision: 1, prepareText: physicalText, idFactory: ids() });
    expect(revised.instance.input.textRegion).toEqual(REFERENCE_MOTION_TEXT_POSITIONS.bottom);
    const applied = applyCommand(current, { type: "batch", commands: revised.commands });
    const heading = packet.instance.roles.filter(role => role.kind === "graphic").map(role => applied.motionGraphics.find(graphic => graphic.id === role.id)!)
      .filter(graphic => graphic.text);
    expect(Math.min(...heading.map(graphic => graphic.y))).toBeGreaterThanOrEqual(REFERENCE_MOTION_TEXT_POSITIONS.bottom.y - .02);
  }, 120_000);
});
