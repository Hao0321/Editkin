import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import type { EditorCommand } from "../domain/commands";
import { dispatchCommand, undo } from "../domain/history";
import { referenceMotionInstanceSchema } from "../domain/referenceMotionInstance";
import type { ReferenceMotionTemplateReuseRequest } from "../application/referenceMotionTemplateReuse";
import { createProjectSession } from "../application/projectSession";
import { DEFAULT_REFERENCE_MOTION_STYLE } from "../motion/referenceMotionTemplates";
import { createMotionGraphic } from "../motion/composition";
import { referenceMotionReuseTargetChoices, runReferenceMotionUiPreparation, SavedReferenceMotionReuseForm,
  type ReferenceMotionUiPreparationOptions } from "./SavedReferenceMotionInstances";

// Source UI callbacks and actual ProjectTask ownership only. The controlled
// inspection/provider below do not establish glyph, native, film or art proof.
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
  const element = elements(tree).find(item => item.props[attribute] === value);
  if (!element) throw new Error(`Actual reuse UI missing ${attribute}=${value}`);
  return element;
}
function change(element: Element, value: string) {
  (element.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
}
function click(element: Element) { (element.props.onClick as () => void)(); }
function fixture(templateId: "strike_reframe" | "comparison_pair" = "strike_reframe") {
  const project = createDemoProject(); project.schemaVersion = 10; project.width = 1080; project.height = 1920;
  const original = project.tracks[0].clips[0]; original.duration = 8;
  project.assets.push({ ...structuredClone(project.assets[0]), id: "new-asset", name: "新的原創示範", uri: "new-source.mp4", duration: 30 },
    { ...structuredClone(project.assets[0]), id: "new-slot", name: "這次的第二份證據", uri: "second-source.mp4", duration: 30 },
    { ...structuredClone(project.assets[0]), id: "old-slot", name: "舊的額外素材", uri: "old-slot.mp4", duration: 30 });
  project.tracks[0].clips.push({ ...structuredClone(original), id: "new-clip", assetId: "new-asset", timelineStart: 10, sourceStart: 2, duration: 8 });
  const saved = referenceMotionInstanceSchema.parse({ schema: "editkin.reference-motion-instance/v1", id: "reuse-old-instance", authoringGeneration: 2,
    instanceRevision: 3, input: { templateId, clipId: original.id, startFrame: 0, durationFrames: 240, title: "已保存的主標題",
      ...(templateId === "strike_reframe" ? { previousText: "已保存的原句", strikePresentation: "semantic_replace_v1", strikeSurface: "source_overlay" } : {}),
      sources: templateId === "comparison_pair" ? [{ assetId: "old-slot", sourceStart: 0, label: "舊的私人槽標籤" }] : [],
      ...(templateId === "comparison_pair" ? { mediaPresentation: "source_soft_v2" } : {}),
      ...(templateId === "comparison_pair" ? { primaryLabel: "已保存的主要文案" } : {}),
      intent: "shortform", purpose: "舊用途不自動複製", evidenceRefs: ["private:old-receipt-never-copied"],
      style: structuredClone(DEFAULT_REFERENCE_MOTION_STYLE) }, frameFormat: { width: 1080, height: 1920, fps: 30 },
    roles: [{ key: "headline", kind: "graphic", id: "old-heading" }], primaryBefore: { layout: null }, appliedScopeSha256: "1".repeat(64),
    dependencies: { recipeVersion: "synthetic-ui-metadata-not-current-scope-proof", presetHashes: [], fonts: [] } });
  project.referenceMotionInstances = [saved];
  return { project, saved };
}
function ui(templateId: "strike_reframe" | "comparison_pair" = "strike_reframe") {
  const { project, saved } = fixture(templateId), before = structuredClone(project);
  const onReuse = vi.fn<(request: ReferenceMotionTemplateReuseRequest) => void>(), onCancel = vi.fn();
  let busy = false, status: "CURRENT" | "EDITED" | "MISSING" | "ENVIRONMENT_CHANGED" = "CURRENT";
  const render = () => {
    slots.cursor = 0;
    return SavedReferenceMotionReuseForm({ project, instance: saved, inspection: { status, reason: "Controlled UI inspection only" },
      busy, onReuse, onCancel });
  };
  const control = (label: string) => find(render(), "aria-label", label);
  const edit = (label: string, value: string) => change(control(label), value);
  const submit = () => click(find(render(), "data-testid", "reuse-reference-motion-instance"));
  const fill = () => { edit("模板重用目標片段", "new-clip"); edit("模板重用新用途", "用新的原創素材說明同一個重點");
    edit("模板重用新內容依據", "這次的原創素材與內容記錄\n這次的已核對說明"); };
  return { project, saved, before, onReuse, onCancel, render, control, edit, submit, fill,
    state: (value: { busy?: boolean; status?: typeof status }) => { if (value.busy !== undefined) busy = value.busy; if (value.status) status = value.status; } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function preparation() {
  const { project } = fixture(), session = createProjectSession(project), controller = new AbortController();
  const commands: EditorCommand[] = [{ type: "rename_project", name: "New reuse UI controlled commit" }];
  const pending = deferred<{ status: "REVIEW_REQUIRED"; commands: EditorCommand[] }>();
  const dispose = vi.fn(), onCommand = vi.fn((command: EditorCommand) => { session.setHistory(history => dispatchCommand(history, command)); return true; });
  let mounted = true;
  const options: ReferenceMotionUiPreparationOptions = { project, session, controller, action: "套用已保存模板", isMounted: () => mounted,
    prepare: () => pending.promise, onCommand, onStatus: vi.fn(),
    createTextPreparer: () => ({ prepareText: async () => { throw new Error("Physical compiler is outside this controlled UI lifecycle scenario"); }, dispose }) };
  return { project, session, controller, commands, pending, dispose, onCommand, options, unmount: () => { mounted = false; } };
}
beforeEach(() => { slots.values = []; slots.cursor = 0; });

describe("saved template reuse actual UI and operation ownership (not full product acceptance)", () => {
  it("shows exact target timing and filters locked, muted, missing, owned and occupied candidates", () => {
    const { project, saved } = fixture(), original = project.tracks[0].clips[1];
    project.tracks.push({ ...structuredClone(project.tracks[0]), id: "locked", name: "Locked", locked: true, clips: [{ ...original, id: "locked-clip", trackId: "locked" }] },
      { ...structuredClone(project.tracks[0]), id: "muted", name: "Muted", muted: true, clips: [{ ...original, id: "muted-clip", trackId: "muted" }] });
    project.tracks[0].clips.push({ ...original, id: "missing-clip", assetId: "absent", timelineStart: 20 },
      { ...original, id: "short-clip", duration: 1, timelineStart: 30 }, { ...original, id: "fractional-clip", timelineStart: 40.001 },
      { ...original, id: "occupied-clip", timelineStart: 50 });
    project.motionGraphics.push(createMotionGraphic("existing", "card", "Other owner", 50, 1));
    const choices = referenceMotionReuseTargetChoices(project, saved);
    expect(choices.map(item => item.clip.id)).toEqual(["new-clip"]);
    const view = ui(), html = renderToStaticMarkup(view.render());
    expect(html).toContain("新的原創示範"); expect(html).toContain("10.00 秒起 · 8.00 秒");
    expect(html).toContain("套用已保存版本，不含未保存修改"); expect(html).not.toContain("private:old-receipt-never-copied");
    expect(view.project).toEqual(view.before);
  });
  it("requires fresh purpose and evidence and dispatches exact existing clip/revisions without old evidence or draft copy", () => {
    const view = ui(); view.submit(); expect(view.onReuse).not.toHaveBeenCalled();
    view.edit("模板重用目標片段", "new-clip"); view.submit(); expect(view.onReuse).not.toHaveBeenCalled();
    view.fill(); view.submit(); expect(view.onReuse).toHaveBeenCalledTimes(1);
    expect(view.onReuse.mock.calls[0][0]).toEqual({ sourceInstanceId: "reuse-old-instance", expectedInstanceRevision: 3,
      expectedProjectRevision: view.project.revision, targetClipId: "new-clip", purpose: "用新的原創素材說明同一個重點",
      evidenceRefs: ["這次的原創素材與內容記錄", "這次的已核對說明"], sources: [] });
    for (const field of ["title", "style", "focusRegion", "rightsBasis", "aestheticReview", "appliedScopeSha256", "sourceStart", "durationFrames"])
      expect(view.onReuse.mock.calls[0][0]).not.toHaveProperty(field);
    expect(view.project).toEqual(view.before);
  });
  it("requires the complete new multi-source slot and rejects primary aliases, fractional or short windows", () => {
    const view = ui("comparison_pair"); view.fill(); view.submit(); expect(view.onReuse).not.toHaveBeenCalled();
    expect(view.control("模板重用素材 1").props.value).toBe(""); expect(view.control("模板重用入點 1").props.value).toBe("");
    view.edit("模板重用素材 1", "new-asset"); view.edit("模板重用入點 1", "0"); view.edit("模板重用標籤 1", "新的核對素材"); view.submit();
    expect(view.onReuse).not.toHaveBeenCalled();
    view.edit("模板重用素材 1", "new-slot"); view.edit("模板重用入點 1", "0.001"); view.submit(); expect(view.onReuse).not.toHaveBeenCalled();
    view.edit("模板重用入點 1", "29"); view.submit(); expect(view.onReuse).not.toHaveBeenCalled();
    view.edit("模板重用入點 1", "1"); view.submit();
    expect(view.onReuse.mock.calls[0][0].sources).toEqual([{ assetId: "new-slot", sourceStart: 1, label: "新的核對素材" }]);
    expect(view.project).toEqual(view.before);
  });
  it("blocks actual edit/submit callbacks when busy or not CURRENT and keeps cancellation usable", () => {
    const view = ui(); view.fill(); const beforeDraft = structuredClone(slots.values);
    for (const state of [{ busy: true, status: "CURRENT" as const }, { busy: false, status: "EDITED" as const },
      { busy: false, status: "MISSING" as const }, { busy: false, status: "ENVIRONMENT_CHANGED" as const }]) {
      view.state(state); view.edit("模板重用新用途", "Unaccepted change"); view.edit("模板重用目標片段", "clip-demo");
      view.edit("模板重用新內容依據", "Unaccepted evidence"); view.submit();
      expect(slots.values).toEqual(beforeDraft); expect(view.onReuse).not.toHaveBeenCalled();
      expect(elements(view.render()).find(item => item.type === "fieldset")?.props.disabled).toBe(true);
    }
    view.state({ busy: true }); click(find(view.render(), "data-testid", "cancel-reference-motion-reuse")); expect(view.onCancel).toHaveBeenCalledOnce();
  });
  it("commits preparation through one actual ProjectSession batch with a single Undo and unchanged original saved owner", async () => {
    const operation = preparation(), saved = structuredClone(operation.project.referenceMotionInstances);
    const running = runReferenceMotionUiPreparation(operation.options);
    operation.pending.resolve({ status: "REVIEW_REQUIRED", commands: operation.commands });
    expect(await running).toBe("APPLIED"); expect(operation.onCommand).toHaveBeenCalledTimes(1);
    expect(operation.onCommand.mock.calls[0][0]).toEqual({ type: "batch", commands: operation.commands });
    expect(operation.session.getSnapshot().history.present.referenceMotionInstances).toEqual(saved);
    expect(operation.session.getSnapshot().history.past).toHaveLength(1);
    const committedRevision = operation.session.getSnapshot().history.present.revision;
    operation.session.setHistory(history => undo(history));
    expect(operation.session.getSnapshot().history.present).toEqual({ ...operation.project, revision: committedRevision });
    expect(operation.dispose).toHaveBeenCalledOnce();
  });
  it("does not commit late preparation after cancellation, a real project revision change or unmount", async () => {
    for (const action of ["cancel", "stale", "unmount"] as const) {
      const operation = preparation(), running = runReferenceMotionUiPreparation(operation.options);
      if (action === "cancel") operation.controller.abort();
      if (action === "stale") operation.session.setHistory(history => dispatchCommand(history, { type: "rename_project", name: "Other owner" }));
      if (action === "unmount") operation.unmount();
      operation.pending.resolve({ status: "REVIEW_REQUIRED", commands: operation.commands });
      expect(await running).toBe(action === "stale" ? "STALE" : "CANCELLED");
      expect(operation.onCommand).not.toHaveBeenCalled(); expect(operation.dispose).toHaveBeenCalledOnce();
    }
  });
});
