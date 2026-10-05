import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { referenceMotionInstanceSchema, referenceMotionTemplateRevisionPatchSchema } from "../domain/referenceMotionInstance";
import { DEFAULT_REFERENCE_MOTION_STYLE } from "../motion/referenceMotionTemplates";
import { createProjectSession } from "../application/projectSession";
import type { EditorCommand } from "../domain/commands";
import { referenceMotionInstanceDraft, referenceMotionInstanceDraftPatch, referenceMotionInstanceEditorKey, runReferenceMotionUiPreparation,
  SavedReferenceMotionInstanceForm, type ReferenceMotionUiPreparationOptions } from "./SavedReferenceMotionInstances";

function instance(cadence?: "legacy" | "brisk") {
  return referenceMotionInstanceSchema.parse({ schema: "editkin.reference-motion-instance/v1", id: "cadence-ui-instance", authoringGeneration: 2, instanceRevision: 1,
    input: { templateId: "level_bridge", clipId: "clip-demo", startFrame: 15, durationFrames: 300, title: "Own focus", sources: [],
      intent: "standalone_showcase", purpose: "UI draft control, not compiled artwork", evidenceRefs: ["synthetic:cadence-ui"],
      ...(cadence === undefined ? {} : { graphicCadence: cadence }), style: structuredClone(DEFAULT_REFERENCE_MOTION_STYLE) },
    frameFormat: { width: 1920, height: 1080, fps: 30 }, roles: [{ key: "headline", kind: "graphic", id: "physical-heading" }],
    primaryBefore: { layout: null }, appliedScopeSha256: "1".repeat(64), dependencies: { recipeVersion: "ui-control-only", presetHashes: [], fonts: [] } });
}
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function form(status: "CURRENT" | "EDITED" | "MISSING" | "ENVIRONMENT_CHANGED" = "CURRENT", busy = false) {
  const saved = instance(), revise = vi.fn(), detach = vi.fn(), cancel = vi.fn(); let draft = referenceMotionInstanceDraft(saved);
  const render = () => elements(SavedReferenceMotionInstanceForm({ instance: saved, assets: [], inspection: { status, reason: "actual scope state" },
    draft, busy, onDraftChange: value => { draft = value; }, onRevise: revise, onDetach: detach, onCancel: cancel }));
  const find = (key: string, value: string) => {
    const found = render().find(node => node.props[key] === value); if (!found) throw new Error(`Actual saved cadence control missing: ${value}`); return found;
  };
  const change = (value: string) => (find("aria-label", "已儲存模板圖卡節奏").props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
  const click = () => (find("data-testid", "revise-reference-motion-instance").props.onClick as () => void)();
  return { saved, render, find, change, click, revise, detach, cancel, draft: () => draft };
}

describe("saved reference template explicit cadence drafts and ownership", () => {
  it("prefills an omitted historical cadence as legacy without inserting it in a copy patch or mutating saved input", () => {
    const saved = instance(), before = structuredClone(saved), draft = referenceMotionInstanceDraft(saved);
    expect(draft.graphicCadence).toBe("legacy");
    const patch = referenceMotionTemplateRevisionPatchSchema.parse(referenceMotionInstanceDraftPatch(saved, draft));
    expect(Object.hasOwn(patch, "graphicCadence")).toBe(false); expect(saved).toEqual(before);
    expect(Object.hasOwn(saved.input, "graphicCadence")).toBe(false);
  });
  it("preserves current brisk on unchanged drafts and only sends an explicit changed cadence", () => {
    const saved = instance("brisk"), draft = referenceMotionInstanceDraft(saved);
    expect(draft.graphicCadence).toBe("brisk"); expect(referenceMotionInstanceDraftPatch(saved, draft)).not.toHaveProperty("graphicCadence");
    draft.graphicCadence = "legacy";
    const patch = referenceMotionTemplateRevisionPatchSchema.parse(referenceMotionInstanceDraftPatch(saved, draft));
    expect(patch.graphicCadence).toBe("legacy"); expect(patch).not.toHaveProperty("sources"); expect(patch).not.toHaveProperty("durationFrames");
    expect(patch.style).not.toHaveProperty("animationSpeed"); expect(saved.input.graphicCadence).toBe("brisk");
  });
  it("uses the actual saved form callbacks to choose brisk and submit its supported revision patch", () => {
    const ui = form(); expect(ui.find("aria-label", "已儲存模板圖卡節奏").props.value).toBe("legacy");
    ui.change("brisk"); expect(ui.draft().graphicCadence).toBe("brisk"); ui.click();
    expect(ui.revise).toHaveBeenCalledTimes(1); expect(referenceMotionTemplateRevisionPatchSchema.parse(ui.revise.mock.calls[0][0]).graphicCadence).toBe("brisk");
    expect(ui.saved.input.graphicCadence).toBeUndefined();
  });
  it("rejects busy and drifted cadence callbacks while keeping cancellation and detach boundaries", () => {
    const busy = form("CURRENT", true); busy.change("brisk"); busy.click();
    expect(busy.draft().graphicCadence).toBe("legacy"); expect(busy.revise).not.toHaveBeenCalled();
    expect(busy.find("data-testid", "detach-reference-motion-instance").props.disabled).toBe(true);
    (busy.find("data-testid", "cancel-reference-motion-instance").props.onClick as () => void)(); expect(busy.cancel).toHaveBeenCalledTimes(1);
    for (const status of ["EDITED", "MISSING", "ENVIRONMENT_CHANGED"] as const) {
      const ui = form(status); ui.change("brisk"); ui.click(); expect(ui.draft().graphicCadence).toBe("legacy"); expect(ui.revise).not.toHaveBeenCalled();
      expect(ui.find("data-testid", "detach-reference-motion-instance").props.disabled).toBe(false);
    }
  });
  it("resets cadence draft ownership on same-ID same-revision reopen without changing the saved new session", () => {
    const project = createDemoProject(); project.schemaVersion = 10; project.referenceMotionInstances = [instance()];
    const session = createProjectSession(project), original = project.referenceMotionInstances[0], oldKey = referenceMotionInstanceEditorKey(session, original);
    const oldDraft = referenceMotionInstanceDraft(original); oldDraft.graphicCadence = "brisk";
    session.replaceProject(structuredClone(project)); const current = session.getSnapshot().history.present.referenceMotionInstances![0];
    expect(current.id).toBe(original.id); expect(current.instanceRevision).toBe(original.instanceRevision);
    expect(referenceMotionInstanceEditorKey(session, current)).not.toBe(oldKey); expect(referenceMotionInstanceDraft(current).graphicCadence).toBe("legacy");
    expect(current.input.graphicCadence).toBeUndefined(); expect(oldDraft.graphicCadence).toBe("brisk");
  });
  it("explicit cancellation suppresses a late cadence task result and releases its real preparation consumer", async () => {
    const project = createDemoProject(), session = createProjectSession(project), controller = new AbortController(), dispose = vi.fn(), onCommand = vi.fn();
    const commands: EditorCommand[] = [{ type: "rename_project", name: "Late cadence owner must not commit" }];
    let settle!: (value: { status: "REVIEW_REQUIRED"; commands: EditorCommand[] }) => void;
    const pending = new Promise<{ status: "REVIEW_REQUIRED"; commands: EditorCommand[] }>(resolve => { settle = resolve; });
    const options: ReferenceMotionUiPreparationOptions = { project, session, controller, isMounted: () => true, action: "圖卡節奏準備",
      prepare: () => pending, onCommand, onStatus: vi.fn(), createTextPreparer: () => ({ prepareText: async () => { throw new Error("This UI control does not parse glyphs"); }, dispose }) };
    const result = runReferenceMotionUiPreparation(options); controller.abort(); expect(dispose).not.toHaveBeenCalled();
    settle({ status: "REVIEW_REQUIRED", commands }); expect(await result).toBe("CANCELLED"); expect(onCommand).not.toHaveBeenCalled();
    expect(session.getSnapshot().history.present).toBe(project); expect(dispose).toHaveBeenCalledTimes(1);
  });
});
