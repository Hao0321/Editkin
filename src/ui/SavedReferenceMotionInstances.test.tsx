import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { dispatchCommand, redo, undo } from "../domain/history";
import type { EditorCommand } from "../domain/commands";
import { referenceMotionInstanceSchema, referenceMotionTemplateRevisionPatchSchema } from "../domain/referenceMotionInstance";
import { createProjectSession } from "../application/projectSession";
import { DEFAULT_REFERENCE_MOTION_STYLE } from "../motion/referenceMotionTemplates";
import { bundledFontFamilies } from "../typography/fontFaces";
import { referenceMotionInstanceDraft, referenceMotionInstanceDraftPatch, referenceMotionInstanceEditorKey, runReferenceMotionUiPreparation,
  SavedReferenceMotionInstanceForm, SavedReferenceMotionInstances, type ReferenceMotionUiPreparationOptions } from "./SavedReferenceMotionInstances";

function instance() {
  return referenceMotionInstanceSchema.parse({ schema: "editkin.reference-motion-instance/v1", id: "saved-template", authoringGeneration: 2, instanceRevision: 1,
    input: { templateId: "context_stack", clipId: "clip-demo", startFrame: 15, durationFrames: 300, title: "Own title", kicker: "Own kicker", subtitle: "Own subtitle",
      items: [{ label: "A", detail: "Detail A" }, { label: "B" }], sources: [], intent: "standalone_showcase", purpose: "Own authored message",
      evidenceRefs: ["manual:motion-template-input"], style: structuredClone(DEFAULT_REFERENCE_MOTION_STYLE) },
    frameFormat: { width: 1920, height: 1080, fps: 30 }, roles: [{ key: "heading", kind: "graphic", id: "owned-heading" }],
    primaryBefore: { layout: null }, appliedScopeSha256: "1".repeat(64), dependencies: { recipeVersion: "fixture-ui-only", presetHashes: [], fonts: [] } });
}
function elementProps(node: ReactNode, testId: string): Record<string, unknown> {
  if (Array.isArray(node)) {
    for (const child of node) { try { return elementProps(child, testId); } catch { /* try next */ } }
  } else if (isValidElement<Record<string, unknown>>(node)) {
    if (node.props["data-testid"] === testId) return node.props;
    if (node.props.children) return elementProps(node.props.children as ReactNode, testId);
  }
  throw new Error(`Actual editor element missing: ${testId}`);
}
function form(status: "CURRENT" | "EDITED" | "MISSING" | "ENVIRONMENT_CHANGED", busy = false) {
  const saved = instance(), onRevise = vi.fn(), onDetach = vi.fn(), onCancel = vi.fn(), onDraftChange = vi.fn();
  const tree = SavedReferenceMotionInstanceForm({ instance: saved, assets: [], inspection: { status, reason: "actual inspection reason" },
    draft: referenceMotionInstanceDraft(saved), busy, onRevise, onDetach, onCancel, onDraftChange });
  return { saved, tree, onRevise, onDetach, onCancel, html: renderToStaticMarkup(tree) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function operationFixture() {
  const project = createDemoProject(), session = createProjectSession(project), controller = new AbortController();
  const commands: EditorCommand[] = [{ type: "rename_project", name: "After preparation" }, { type: "rename_project", name: "Committed once" }];
  const packet = { status: "REVIEW_REQUIRED" as const, commands }, waiting = deferred<typeof packet>();
  const dispose = vi.fn(), prepareText = vi.fn(async () => { throw new Error("Glyph parsing is outside this UI ownership control"); });
  const createTextPreparer = vi.fn(() => ({ prepareText, dispose }));
  const onStatus = vi.fn(), onCommand = vi.fn((command: EditorCommand) => {
    session.setHistory(current => dispatchCommand(current, command)); return true;
  });
  const options: ReferenceMotionUiPreparationOptions = { project, session, controller, isMounted: () => true, action: "Motion 模板準備",
    prepare: () => waiting.promise, createTextPreparer, onStatus, onCommand };
  return { project, session, controller, packet, waiting, dispose, createTextPreparer, onStatus, onCommand, options };
}

describe("saved Motion instance UI boundaries (static/ownership controls, not art or browser observation)", () => {
  it("keeps the root manager reachable with metadata when every clip and asset is missing", () => {
    const project = createDemoProject(); project.schemaVersion = 10; project.referenceMotionInstances = [instance()];
    project.assets = []; project.tracks.forEach(track => { track.clips = []; });
    const html = renderToStaticMarkup(<SavedReferenceMotionInstances project={project} session={createProjectSession(project)} busy={false}
      onRevise={() => {}} onDetach={() => {}} onCancel={() => {}} />);
    expect(html).toContain('data-testid="saved-reference-motion-instances"');
    expect(html).toContain('data-testid="detach-reference-motion-instance"');
    expect(html).toContain("clip-demo"); expect(html).toContain("第 15 格起，300 格");
  });
  it("reopen with the same instance ID/revision changes the actual editor reconciliation key and draft owner", () => {
    const project = createDemoProject(); project.schemaVersion = 10; project.referenceMotionInstances = [instance()];
    const session = createProjectSession(project), original = project.referenceMotionInstances[0];
    const oldKey = referenceMotionInstanceEditorKey(session, original), oldDraft = referenceMotionInstanceDraft(original); oldDraft.title = "Unsubmitted old draft";
    session.setHistory(current => dispatchCommand(current, { type: "rename_project", name: "Same session edit" }));
    expect(referenceMotionInstanceEditorKey(session, original)).toBe(oldKey);
    const reopened = structuredClone(project); reopened.referenceMotionInstances![0].input.title = "Reopened saved title";
    session.replaceProject(reopened);
    const current = session.getSnapshot().history.present.referenceMotionInstances![0];
    expect(current.id).toBe(original.id); expect(current.instanceRevision).toBe(original.instanceRevision);
    expect(referenceMotionInstanceEditorKey(session, current)).not.toBe(oldKey);
    expect(referenceMotionInstanceDraft(current).title).toBe("Reopened saved title"); expect(oldDraft.title).toBe("Unsubmitted old draft");
    // This is the production key/draft factory control; mounted browser remount remains a separate observation.
  });
  it("renders current copy/fonts/palette controls without source, clock or topology replacement", () => {
    const f = form("CURRENT");
    expect(elementProps(f.tree, "revise-reference-motion-instance").disabled).toBe(false);
    expect(f.html).toContain('aria-label="已儲存模板標題字型"'); expect(f.html).toContain('aria-label="已儲存模板內文字型"');
    for (const family of bundledFontFamilies()) expect(f.html).toContain(family);
    expect(f.html).not.toMatch(/aria-label="(?:模板素材|模板重點數|模板動畫速度|點群排列種子)/);
    expect(f.html).toContain("重新編譯後須重新審看成片");
  });
  it.each(["EDITED", "MISSING", "ENVIRONMENT_CHANGED"] as const)("%s blocks update but permits metadata detach", status => {
    const f = form(status);
    const update = elementProps(f.tree, "revise-reference-motion-instance"), detach = elementProps(f.tree, "detach-reference-motion-instance");
    expect(update.disabled).toBe(true); expect(detach.disabled).toBe(false);
    (update.onClick as () => void)(); (detach.onClick as () => void)();
    expect(f.onRevise).not.toHaveBeenCalled(); expect(f.onDetach).toHaveBeenCalledTimes(1);
  });
  it("pending preparation disables revision/detach while exposing an actual cancel callback", () => {
    const f = form("CURRENT", true);
    expect(elementProps(f.tree, "revise-reference-motion-instance").disabled).toBe(true);
    const detach = elementProps(f.tree, "detach-reference-motion-instance"); expect(detach.disabled).toBe(true);
    (detach.onClick as () => void)(); expect(f.onDetach).not.toHaveBeenCalled();
    (elementProps(f.tree, "cancel-reference-motion-instance").onClick as () => void)(); expect(f.onCancel).toHaveBeenCalledTimes(1);
  });
  it("optional clearing produces explicit null and own palette/font copies without changing saved input", () => {
    const saved = instance(), before = structuredClone(saved), draft = referenceMotionInstanceDraft(saved);
    draft.kicker = ""; draft.subtitle = ""; draft.items[0].detail = "";
    draft.typography.bodyFamily = "Noto Serif TC"; draft.palette.accent = "#123456";
    const patch = referenceMotionTemplateRevisionPatchSchema.parse(referenceMotionInstanceDraftPatch(saved, draft));
    expect(patch.kicker).toBeNull(); expect(patch.subtitle).toBeNull(); expect(patch.items?.[0].detail).toBeNull();
    expect(patch.style?.typography?.bodyFamily).toBe("Noto Serif TC"); expect(patch.style?.palette?.accent).toBe("#123456");
    expect(patch).not.toHaveProperty("sources"); expect(patch).not.toHaveProperty("durationFrames"); expect(patch.style).not.toHaveProperty("animationSpeed");
    expect(saved).toEqual(before);
  });
  it("rejects a draft changing item count and a partially cleared network label tuple", () => {
    const saved = instance(), draft = referenceMotionInstanceDraft(saved); draft.items.pop();
    expect(() => referenceMotionInstanceDraftPatch(saved, draft)).toThrow(/重點數/);
    const network = instance(); network.input.templateId = "kinetic_network"; network.input.network = { seed: 32021, points: 32, labels: ["A", "B", "C"] };
    const partial = referenceMotionInstanceDraft(network); partial.networkLabels[1] = "";
    expect(() => referenceMotionInstanceDraftPatch(network, partial)).toThrow(/三個/);
  });
  it("commits one real batch with one Undo/Redo entry and releases the preparation consumer", async () => {
    const f = operationFixture(), run = runReferenceMotionUiPreparation(f.options); f.waiting.resolve(f.packet);
    expect(await run).toBe("APPLIED"); expect(f.onCommand).toHaveBeenCalledTimes(1); expect(f.onCommand.mock.calls[0][0].type).toBe("batch");
    expect(f.session.getSnapshot().history.past).toHaveLength(1); expect(f.session.getSnapshot().history.present.name).toBe("Committed once");
    f.session.setHistory(undo); expect(f.session.getSnapshot().history.present.name).toBe(f.project.name);
    f.session.setHistory(redo); expect(f.session.getSnapshot().history.present.name).toBe("Committed once"); expect(f.dispose).toHaveBeenCalledTimes(1);
  });
  it("UNCHANGED preserves project/history and releases the consumer without issuing a command", async () => {
    const f = operationFixture(); f.options.prepare = async () => ({ status: "UNCHANGED", commands: [] });
    expect(await runReferenceMotionUiPreparation(f.options)).toBe("UNCHANGED"); expect(f.onCommand).not.toHaveBeenCalled();
    expect(f.session.getSnapshot().history.present).toBe(f.project); expect(f.session.getSnapshot().history.past).toHaveLength(0); expect(f.dispose).toHaveBeenCalledTimes(1);
  });
  it("a real edit cancels the old content owner even when project revision stays unchanged", async () => {
    const f = operationFixture(), run = runReferenceMotionUiPreparation(f.options);
    f.session.setHistory(current => dispatchCommand(current, { type: "rename_project", name: "New user edit" }));
    expect(f.session.getSnapshot().history.present.revision).toBe(f.project.revision); expect(f.controller.signal.aborted).toBe(true);
    f.waiting.resolve(f.packet); expect(await run).toBe("STALE"); expect(f.onCommand).not.toHaveBeenCalled();
    expect(f.session.getSnapshot().history.present.name).toBe("New user edit"); expect(f.dispose).toHaveBeenCalledTimes(1);
  });
  it("a replacement session with the same ID/revision rejects the old result and old status", async () => {
    const f = operationFixture(), run = runReferenceMotionUiPreparation(f.options), replacement = structuredClone(f.project);
    f.session.replaceProject(replacement); f.waiting.resolve(f.packet);
    expect(await run).toBe("STALE"); expect(f.onCommand).not.toHaveBeenCalled(); expect(f.onStatus).not.toHaveBeenCalled();
    expect(f.session.getSnapshot().history.present).toBe(replacement); expect(f.dispose).toHaveBeenCalledTimes(1);
  });
  it("explicit cancellation and unmount suppress late commands until the real promise settles", async () => {
    const f = operationFixture(), run = runReferenceMotionUiPreparation(f.options); f.controller.abort();
    expect(f.dispose).not.toHaveBeenCalled(); f.waiting.resolve(f.packet);
    expect(await run).toBe("CANCELLED"); expect(f.onCommand).not.toHaveBeenCalled(); expect(f.dispose).toHaveBeenCalledTimes(1);
    const unmounted = operationFixture(), pending = runReferenceMotionUiPreparation(unmounted.options); unmounted.options.isMounted = () => false;
    unmounted.waiting.resolve(unmounted.packet); expect(await pending).toBe("CANCELLED"); expect(unmounted.onCommand).not.toHaveBeenCalled(); expect(unmounted.dispose).toHaveBeenCalledTimes(1);
  });
  it("real preparation failure retains the graph and releases the consumer", async () => {
    const f = operationFixture(); f.options.prepare = async () => { throw new Error("FONT_BYTES_REQUIRED"); };
    expect(await runReferenceMotionUiPreparation(f.options)).toBe("FAILED"); expect(f.onStatus).toHaveBeenCalledWith("FONT_BYTES_REQUIRED");
    expect(f.onCommand).not.toHaveBeenCalled(); expect(f.session.getSnapshot().history.present).toBe(f.project); expect(f.dispose).toHaveBeenCalledTimes(1);
  });
  it("an old rendered project cannot acquire a provider or start preparation after a content change", async () => {
    const f = operationFixture(); f.session.setHistory(current => dispatchCommand(current, { type: "rename_project", name: "Current" }));
    expect(await runReferenceMotionUiPreparation(f.options)).toBe("STALE"); expect(f.createTextPreparer).not.toHaveBeenCalled(); expect(f.onCommand).not.toHaveBeenCalled();
  });
});
