import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { referenceMotionInstanceSchema, referenceMotionTemplateRevisionPatchSchema } from "../domain/referenceMotionInstance";
import { createProjectSession } from "../application/projectSession";
import { parseProject } from "../application/projectFiles";
import { DEFAULT_REFERENCE_MOTION_STYLE, referenceMotionTemplateInputSchema } from "../motion/referenceMotionTemplates";
import ReferenceMotionTemplateControls, { type ManualReferenceMotionTemplate } from "./ReferenceMotionTemplateControls";
import { referenceMotionInstanceDraft, referenceMotionInstanceDraftPatch, referenceMotionInstanceEditorKey,
  SavedReferenceMotionInstanceForm, type ReferenceMotionInstanceDraft } from "./SavedReferenceMotionInstances";

// Retained hook slots invoke real component callbacks. React DOM renders the real
// returned tree. These are source UI controls, not mounted/native/pixel/art proof.
const slots = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useState: (initial: unknown) => {
  const index = slots.cursor++;
  if (!(index in slots.values)) slots.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
  return [slots.values[index], (next: unknown) => { slots.values[index] = typeof next === "function"
    ? (next as (value: unknown) => unknown)(slots.values[index]) : next; }];
} }));

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function find(tree: ReactNode, attribute: string, value: string): Element {
  const result = elements(tree).find(element => element.props[attribute] === value);
  if (!result) throw new Error(`Actual source-surface UI control missing: ${attribute}=${value}`);
  return result;
}
function change(element: Element, value: string): void {
  (element.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
}
function click(element: Element): void { (element.props.onClick as () => void)(); }
function createUi() {
  const project = createDemoProject(), before = structuredClone(project), apply = vi.fn<(input: ManualReferenceMotionTemplate) => void>(), cancel = vi.fn();
  let busy = false;
  function render() {
    slots.cursor = 0;
    return ReferenceMotionTemplateControls({ clip: project.tracks[0].clips[0], assets: project.assets,
      portrait: true, fps: project.fps, busy, onApply: apply, onCancel: cancel });
  }
  const control = (label: string) => find(render(), "aria-label", label);
  const edit = (label: string, value: string) => change(control(label), value);
  const submit = () => click(find(render(), "data-testid", "apply-reference-motion-template"));
  edit("參考 Motion 模板", "strike_reframe"); edit("模板主標題", "先看清真正重點"); edit("刪線原句", "只會堆疊特效");
  return { project, before, apply, cancel, render, control, edit, submit, setBusy: (value: boolean) => { busy = value; } };
}
function savedInstance(surface?: "standalone" | "source_overlay", presentation?: "legacy_layout" | "semantic_replace_v1") {
  const project = createDemoProject();
  return referenceMotionInstanceSchema.parse({ schema: "editkin.reference-motion-instance/v1", id: "surface-ui-instance", instanceRevision: 3,
    authoringGeneration: 2, input: { templateId: "strike_reframe", clipId: project.tracks[0].clips[0].id,
      startFrame: 0, durationFrames: 240, title: "先看清真正重點", previousText: "只會堆疊特效", sources: [],
      intent: "shortform", purpose: "Synthetic UI metadata only, not a compiled or observed film", evidenceRefs: ["synthetic:surface-ui"],
      ...(presentation === undefined ? {} : { strikePresentation: presentation }), ...(surface === undefined ? {} : { strikeSurface: surface }),
      style: structuredClone(DEFAULT_REFERENCE_MOTION_STYLE) }, frameFormat: { width: 1080, height: 1920, fps: 30 },
    roles: [{ key: "headline", kind: "graphic", id: "saved-heading" }], primaryBefore: { layout: null }, appliedScopeSha256: "1".repeat(64),
    dependencies: { recipeVersion: "ui-only-not-artwork-evidence", presetHashes: [], fonts: [] } });
}
function savedUi(saved = savedInstance(undefined, "semantic_replace_v1"), status: "CURRENT" | "EDITED" | "MISSING" | "ENVIRONMENT_CHANGED" = "CURRENT", busy = false) {
  const revise = vi.fn(), detach = vi.fn(), cancel = vi.fn(); let draft = referenceMotionInstanceDraft(saved);
  const render = () => SavedReferenceMotionInstanceForm({ instance: saved, assets: [], inspection: { status, reason: "Explicit UI status fixture, not physical scope verification" },
    draft, busy, onDraftChange: value => { draft = value; }, onRevise: revise, onDetach: detach, onCancel: cancel });
  const control = (label: string) => find(render(), "aria-label", label);
  const edit = (label: string, value: string) => change(control(label), value);
  const submit = () => click(find(render(), "data-testid", "revise-reference-motion-instance"));
  return { saved, revise, detach, cancel, render, control, edit, submit, draft: () => draft };
}
beforeEach(() => { slots.values = []; slots.cursor = 0; });

describe("explicit semantic source-surface create and saved UI contract", () => {
  it("renders the two distinct Chinese composition responsibilities and submits standalone by default", () => {
    const ui = createUi(), selector = ui.control("刪線畫面用途");
    expect(selector.props.value).toBe("standalone");
    expect(elements(selector.props.children as ReactNode).filter(element => element.type === "option")
      .map(element => [element.props.value, element.props.children])).toEqual([["standalone", "原創圖形場景"], ["source_overlay", "在原素材上提示"]]);
    const html = renderToStaticMarkup(ui.render());
    expect(html).toContain("畫面用途"); expect(html).toContain("保留目前完整畫面與原片時鐘");
    ui.submit(); expect(ui.apply).toHaveBeenCalledTimes(1);
    expect(ui.apply.mock.calls[0][0]).toMatchObject({ templateId: "strike_reframe", strikePresentation: "semantic_replace_v1", strikeSurface: "standalone", graphicCadence: "brisk" });
    expect(ui.project).toEqual(ui.before);
  });
  it("dispatches explicit overlay together with the authored copy, cadence and text wordmark without source clocks", () => {
    const ui = createUi(); ui.edit("刪線畫面用途", "source_overlay"); ui.edit("模板圖卡節奏", "legacy");
    (ui.control("加入文字字標").props.onChange as (event: { target: { checked: boolean } }) => void)({ target: { checked: true } });
    ui.edit("模板文字字標", "Editkin"); ui.submit();
    const input = ui.apply.mock.calls[0][0];
    expect(input).toMatchObject({ strikeSurface: "source_overlay", strikePresentation: "semantic_replace_v1", graphicCadence: "legacy", brandMark: "Editkin", sources: [] });
    expect(input).not.toHaveProperty("clipId"); expect(input).not.toHaveProperty("startFrame"); expect(input).not.toHaveProperty("durationFrames");
    expect(referenceMotionTemplateInputSchema.parse({ ...input, clipId: ui.project.tracks[0].clips[0].id, startFrame: 0, durationFrames: 240,
      evidenceRefs: ["synthetic:manual-ui-surface"] }).strikeSurface).toBe("source_overlay");
    expect(renderToStaticMarkup(ui.render())).toContain("不是圖片 Logo"); expect(ui.project).toEqual(ui.before);
  });
  it("never forwards the new surface or hidden wordmark when legacy presentation is selected", () => {
    const ui = createUi(); ui.edit("刪線畫面用途", "source_overlay"); ui.edit("刪線呈現", "legacy_layout"); ui.submit();
    expect(ui.apply.mock.calls[0][0]).toMatchObject({ strikePresentation: "legacy_layout" });
    expect(ui.apply.mock.calls[0][0]).not.toHaveProperty("strikeSurface"); expect(ui.apply.mock.calls[0][0]).not.toHaveProperty("brandMark");
    expect(elements(ui.render()).some(element => element.props["aria-label"] === "刪線畫面用途")).toBe(false);
  });
  it("never leaks a strike surface into another family after a user changes family", () => {
    const ui = createUi(); ui.edit("刪線畫面用途", "source_overlay"); ui.edit("參考 Motion 模板", "level_bridge"); ui.submit();
    expect(ui.apply.mock.calls[0][0]).toMatchObject({ templateId: "level_bridge" });
    expect(ui.apply.mock.calls[0][0]).not.toHaveProperty("strikeSurface"); expect(ui.apply.mock.calls[0][0]).not.toHaveProperty("strikePresentation");
    expect(elements(ui.render()).some(element => element.props["aria-label"] === "刪線畫面用途")).toBe(false);
  });
  it("rejects invalid selector values and blocks actual editing/submission callbacks while busy, retaining cancellation", () => {
    const ui = createUi(); ui.edit("刪線畫面用途", "not-a-surface"); expect(ui.control("刪線畫面用途").props.value).toBe("standalone");
    ui.setBusy(true); expect(elements(ui.render()).find(element => element.type === "fieldset")?.props.disabled).toBe(true);
    ui.edit("刪線畫面用途", "source_overlay"); ui.edit("刪線呈現", "legacy_layout"); ui.edit("模板圖卡節奏", "legacy");
    ui.edit("模板主標題", "忙碌時不可改"); ui.edit("參考 Motion 模板", "level_bridge"); ui.edit("模板動畫速度", "2"); ui.submit();
    expect(ui.control("刪線畫面用途").props.value).toBe("standalone"); expect(ui.control("刪線呈現").props.value).toBe("semantic_replace_v1");
    expect(ui.control("模板主標題").props.value).toBe("先看清真正重點"); expect(ui.apply).not.toHaveBeenCalled();
    click(find(ui.render(), "data-testid", "cancel-reference-motion-template")); expect(ui.cancel).toHaveBeenCalledTimes(1);
    ui.setBusy(false); ui.submit(); expect(ui.apply.mock.calls[0][0]).toMatchObject({ strikeSurface: "standalone", graphicCadence: "brisk", style: { animationSpeed: 1 } });
  });
  it("preserves both historical omission and stored explicit standalone without manufacturing surface patches", () => {
    for (const surface of [undefined, "standalone"] as const) {
      const saved = savedInstance(surface, "semantic_replace_v1"), before = structuredClone(saved), ui = savedUi(saved);
      expect(ui.control("已儲存刪線畫面用途").props.value).toBe("standalone");
      expect(Object.hasOwn(ui.draft(), "strikeSurface")).toBe(surface !== undefined);
      ui.edit("已儲存模板主標題", "新的同源重點"); ui.edit("已儲存刪線畫面用途", "standalone"); ui.submit();
      expect(referenceMotionTemplateRevisionPatchSchema.parse(ui.revise.mock.calls[0][0])).not.toHaveProperty("strikeSurface");
      expect(saved).toEqual(before); expect(Object.hasOwn(saved.input, "strikeSurface")).toBe(surface !== undefined);
    }
  });
  it("keeps an omitted historical presentation unchanged until explicit semantic and overlay choices", () => {
    const saved = savedInstance(), before = structuredClone(saved), ui = savedUi(saved);
    expect(ui.draft().strikePresentation).toBe("legacy_layout"); expect(ui.draft()).not.toHaveProperty("strikeSurface");
    expect(referenceMotionInstanceDraftPatch(saved, ui.draft())).not.toHaveProperty("strikePresentation");
    expect(elements(ui.render()).some(element => element.props["aria-label"] === "已儲存刪線畫面用途")).toBe(false);
    ui.edit("已儲存模板刪線呈現", "semantic_replace_v1"); ui.edit("已儲存刪線畫面用途", "source_overlay"); ui.submit();
    const patch = referenceMotionTemplateRevisionPatchSchema.parse(ui.revise.mock.calls[0][0]);
    expect(patch).toMatchObject({ strikePresentation: "semantic_replace_v1", strikeSurface: "source_overlay" }); expect(saved).toEqual(before);
  });
  it("uses an explicit saved overlay-to-standalone patch and keeps copy/source/style clocks outside the revision vocabulary", () => {
    const ui = savedUi(savedInstance("source_overlay", "semantic_replace_v1"));
    expect(referenceMotionInstanceDraftPatch(ui.saved, ui.draft())).not.toHaveProperty("strikeSurface");
    ui.edit("已儲存刪線畫面用途", "standalone"); ui.edit("已儲存模板圖卡節奏", "brisk"); ui.edit("已儲存模板品牌短字", "Editkin"); ui.submit();
    const patch = referenceMotionTemplateRevisionPatchSchema.parse(ui.revise.mock.calls[0][0]);
    expect(patch).toMatchObject({ strikeSurface: "standalone", graphicCadence: "brisk", brandMark: "Editkin" });
    for (const key of ["sources", "clipId", "startFrame", "durationFrames", "primaryBefore", "roles", "dependencies"]) expect(patch).not.toHaveProperty(key);
    expect(patch.style).not.toHaveProperty("animationSpeed"); expect(ui.saved.input.strikeSurface).toBe("source_overlay");
    expect(renderToStaticMarkup(ui.render())).toContain("不是圖片 Logo");
  });
  it("suppresses hidden surface and wordmark drafts on a saved legacy transition", () => {
    const ui = savedUi(savedInstance("source_overlay", "semantic_replace_v1"));
    ui.edit("已儲存模板品牌短字", "Editkin"); ui.edit("已儲存模板刪線呈現", "legacy_layout"); ui.submit();
    expect(ui.revise.mock.calls[0][0]).toMatchObject({ strikePresentation: "legacy_layout" });
    expect(ui.revise.mock.calls[0][0]).not.toHaveProperty("strikeSurface"); expect(ui.revise.mock.calls[0][0]).not.toHaveProperty("brandMark");
    expect(elements(ui.render()).some(element => element.props["aria-label"] === "已儲存刪線畫面用途")).toBe(false);
  });
  it("keeps generation1 and unrelated saved families outside the new surface editor", () => {
    // Persisted metadata remains strict generation 2. This separately typed
    // counterfeit only exercises the UI's defensive presentation boundary.
    const generation1: Omit<ReturnType<typeof savedInstance>, "authoringGeneration"> & { authoringGeneration: 1 } = {
      ...savedInstance(), authoringGeneration: 1,
    };
    expect(() => referenceMotionInstanceSchema.parse(generation1)).toThrow();
    // @ts-expect-error Deliberate unsupported UI metadata; never admitted by the project codec.
    const legacy = savedUi(generation1);
    legacy.edit("已儲存模板刪線呈現", "semantic_replace_v1");
    expect(elements(legacy.render()).some(element => element.props["aria-label"] === "已儲存刪線畫面用途")).toBe(false);
    const forgedDraft: ReferenceMotionInstanceDraft = { ...legacy.draft(), strikeSurface: "source_overlay" };
    // @ts-expect-error Deliberate unsupported presentation-only input checks the defensive guard.
    expect(referenceMotionInstanceDraftPatch(generation1, forgedDraft)).not.toHaveProperty("strikeSurface");
    const other = savedInstance(); other.input.templateId = "level_bridge"; delete other.input.previousText;
    const otherUi = savedUi(other); expect(otherUi.draft()).not.toHaveProperty("strikeSurface");
    expect(elements(otherUi.render()).some(element => element.props["aria-label"] === "已儲存刪線畫面用途")).toBe(false);
    expect(referenceMotionInstanceDraftPatch(other, { ...otherUi.draft(), strikePresentation: "semantic_replace_v1", strikeSurface: "source_overlay" })).not.toHaveProperty("strikeSurface");
  });
  it("blocks saved surface, copy, font, palette and revision callbacks while busy or nonCURRENT, retaining cancellation", () => {
    for (const state of [{ status: "CURRENT" as const, busy: true }, ...(["EDITED", "MISSING", "ENVIRONMENT_CHANGED"] as const).map(status => ({ status, busy: false }))]) {
      const ui = savedUi(savedInstance(undefined, "semantic_replace_v1"), state.status, state.busy), before = structuredClone(ui.draft());
      expect(elements(ui.render()).find(element => element.type === "fieldset")?.props.disabled).toBe(true);
      ui.edit("已儲存刪線畫面用途", "source_overlay"); ui.edit("已儲存模板刪線呈現", "legacy_layout");
      ui.edit("已儲存模板主標題", "不可修改"); ui.edit("已儲存模板品牌短字", "不可修改"); ui.edit("已儲存模板圖卡節奏", "brisk");
      ui.edit("已儲存模板標題字型", "Noto Sans TC"); ui.edit("已儲存模板配色 accent", "#FFFFFF"); ui.submit();
      expect(ui.draft()).toEqual(before); expect(ui.revise).not.toHaveBeenCalled();
      if (state.busy) { click(find(ui.render(), "data-testid", "cancel-reference-motion-instance")); expect(ui.cancel).toHaveBeenCalledTimes(1); }
    }
  });
  it("retains stored omission through real project codec normalization and creates a fresh draft owner on reopen", () => {
    const project = createDemoProject(); project.schemaVersion = 10; project.referenceMotionInstances = [savedInstance(undefined, "semantic_replace_v1")];
    const session = createProjectSession(project), original = project.referenceMotionInstances[0], key = referenceMotionInstanceEditorKey(session, original);
    const abandonedDraft = referenceMotionInstanceDraft(original); abandonedDraft.strikeSurface = "source_overlay";
    const reopened = parseProject(JSON.parse(JSON.stringify(project))); session.replaceProject(reopened);
    const current = session.getSnapshot().history.present.referenceMotionInstances![0];
    expect(current.id).toBe(original.id); expect(current.instanceRevision).toBe(original.instanceRevision);
    expect(referenceMotionInstanceEditorKey(session, current)).not.toBe(key); expect(current.input).not.toHaveProperty("strikeSurface");
    expect(referenceMotionInstanceDraft(current)).not.toHaveProperty("strikeSurface");
    expect(referenceMotionInstanceDraftPatch(current, referenceMotionInstanceDraft(current))).not.toHaveProperty("strikeSurface");
    expect(abandonedDraft.strikeSurface).toBe("source_overlay");
  });
});
