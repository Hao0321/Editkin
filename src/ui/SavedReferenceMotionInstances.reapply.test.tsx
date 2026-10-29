import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { referenceMotionInstanceSchema } from "../domain/referenceMotionInstance";
import { DEFAULT_REFERENCE_MOTION_STYLE } from "../motion/referenceMotionTemplates";
import { createProjectSession } from "../application/projectSession";
import { isReferenceMotionTemplateReapplyPatch } from "../application/referenceMotionTemplateInstances";
import { TEMPLATE_EDITOR_REQUEST_EVENT } from "./templateEditorRequests";

// The production editor form and manager with stateful hook doubles: handlers are called directly. No mounted browser
// layout, real focus ring or pixels are claimed; focus is observed on element doubles.
const hooks = vi.hoisted(() => ({ active: false, states: [] as { value: unknown }[], refs: [] as { current: unknown }[], effects: [] as Array<() => unknown>,
  stateIndex: 0, refIndex: 0 }));
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual,
    useEffect: (effect: () => unknown, deps?: unknown[]) => hooks.active ? void hooks.effects.push(effect) : actual.useEffect(effect as never, deps),
    useRef: (value: unknown) => {
      if (!hooks.active) return actual.useRef(value);
      const index = hooks.refIndex++;
      return hooks.refs[index] ?? (hooks.refs[index] = { current: value });
    },
    useState: (value: unknown) => {
      if (!hooks.active) return actual.useState(value);
      const index = hooks.stateIndex++;
      const state = hooks.states[index] ?? (hooks.states[index] = { value: typeof value === "function" ? (value as () => unknown)() : value });
      return [state.value, (next: unknown) => { state.value = typeof next === "function" ? (next as (old: unknown) => unknown)(state.value) : next; }];
    } };
});
vi.mock("./i18n/interfacePreferences", async importOriginal => {
  const actual = await importOriginal<typeof import("./i18n/interfacePreferences")>();
  return { ...actual, useI18n: () => ({ ...actual.interfacePreferences.getSnapshot(), t: actual.translateUi }) };
});
import { referenceMotionInstanceDraft, SavedReferenceMotionInstanceForm, SavedReferenceMotionInstances, type ReferenceMotionReapplyCheck } from "./SavedReferenceMotionInstances";

afterEach(() => { vi.unstubAllGlobals(); hooks.active = false; });

function instance() {
  return referenceMotionInstanceSchema.parse({ schema: "editkin.reference-motion-instance/v1", id: "saved-template", authoringGeneration: 2, instanceRevision: 3,
    input: { templateId: "level_bridge", clipId: "clip-demo", startFrame: 15, durationFrames: 300, title: "Own title", sources: [], intent: "standalone_showcase",
      purpose: "Own authored message", evidenceRefs: ["manual:motion-template-input"], style: structuredClone(DEFAULT_REFERENCE_MOTION_STYLE) },
    frameFormat: { width: 1920, height: 1080, fps: 30 }, roles: [{ key: "heading", kind: "graphic", id: "owned-heading" }],
    primaryBefore: { layout: null }, appliedScopeSha256: "1".repeat(64), dependencies: { recipeVersion: "fixture-ui-only", presetHashes: [], fonts: [] } });
}
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
const byTestId = (tree: ReactNode, id: string) => elements(tree).find(element => element.props["data-testid"] === id);
function form(status: "CURRENT" | "EDITED" | "MISSING", reapply?: ReferenceMotionReapplyCheck, withButton = true, busy = false) {
  const saved = instance(), onReapply = vi.fn();
  const tree = SavedReferenceMotionInstanceForm({ instance: saved, assets: [], inspection: { status, reason: "Managed template content or source binding changed" },
    draft: referenceMotionInstanceDraft(saved), busy, onRevise: vi.fn(), onDetach: vi.fn(), onCancel: vi.fn(), onDraftChange: vi.fn(),
    clipName: "旅行.mp4", ...(withButton ? { onReapply } : {}), reapply });
  return { tree, onReapply, html: renderToStaticMarkup(tree) };
}

describe("「依目前片段重新套用」 in the template editor", () => {
  it("offers the button with what it does when the template went out of date and it can be laid out again", () => {
    const f = form("EDITED", { state: "READY" });
    const button = byTestId(f.tree, "reapply-reference-motion-instance")!;
    expect(button.props.disabled).toBe(false);
    expect(f.html).toContain("依目前片段重新套用");
    expect(f.html).toContain("按下後，模板會照目前片段的位置和長度重新排好；文字、字型和配色都保留。");
    (button.props.onClick as () => void)();
    expect(f.onReapply).toHaveBeenCalledTimes(1);
  });
  it("keeps the button but says plainly, on one line, why it cannot when the clip is too short", () => {
    const reason = "片段只有 2.00 秒，這個模板至少要 3.00 秒；先把片段拉長。";
    const f = form("EDITED", { state: "BLOCKED", reason });
    const button = byTestId(f.tree, "reapply-reference-motion-instance")!;
    expect(button.props.disabled).toBe(true);
    (button.props.onClick as () => void)();
    expect(f.onReapply).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(byTestId(f.tree, "saved-template-reapply-reason")!)).toContain(reason);
    expect(byTestId(f.tree, "saved-template-reapply")!.props["data-state"]).toBe("BLOCKED");
  });
  it("says it is checking while the dry run runs, and shows nothing of the kind for an editable template or without a host", () => {
    expect(form("MISSING", { state: "CHECKING" }).html).toContain("正在檢查能不能照目前的片段重新套用…");
    expect(byTestId(form("CURRENT", { state: "READY" }).tree, "saved-template-reapply")).toBeUndefined();
    expect(byTestId(form("EDITED", undefined, false).tree, "saved-template-reapply")).toBeUndefined();
    expect(byTestId(form("EDITED", { state: "READY" }, true, true).tree, "reapply-reference-motion-instance")!.props.disabled).toBe(true);
  });
});

function element(name: string) {
  return { name, isConnected: true, focus: vi.fn(), contains: () => false };
}
function manager() {
  hooks.active = true; hooks.states = []; hooks.refs = []; hooks.effects = [];
  const project = createDemoProject(); project.schemaVersion = 10; project.referenceMotionInstances = [instance()];
  const session = createProjectSession(project), onRevise = vi.fn();
  const render = () => { hooks.stateIndex = 0; hooks.refIndex = 0; hooks.effects = [];
    return SavedReferenceMotionInstances({ project, session, busy: false, onRevise, onDetach: vi.fn(), onCancel: vi.fn() }) as ReactNode; };
  return { render, onRevise };
}
const details = (tree: ReactNode) => elements(tree).find(item => item.props["data-testid"] === "saved-reference-motion-instances")!;
const escape = () => ({ key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() });

describe("the template editor popover and the keyboard", () => {
  it("Escape closes it and gives focus back to the footer button that opened it", () => {
    const summary = element("summary"), body = element("body");
    vi.stubGlobal("document", { activeElement: summary, body });
    const f = manager();
    (details(f.render()).props.onToggle as (event: object) => void)({ currentTarget: { open: true } });
    let tree = f.render();
    expect(details(tree).props.open).toBe(true);
    const key = escape();
    (details(tree).props.onKeyDown as (event: object) => void)(key);
    expect(key.preventDefault).toHaveBeenCalled(); expect(key.stopPropagation).toHaveBeenCalled();
    tree = f.render();
    expect(details(tree).props.open).toBe(false);
    expect(summary.focus).toHaveBeenCalledTimes(1);
    // Closed, Escape is left for the rest of the editor.
    const ignored = escape();
    (details(tree).props.onKeyDown as (event: object) => void)(ignored);
    expect(ignored.stopPropagation).not.toHaveBeenCalled();
  });
  it("opened from a timeline block, Escape and the close button both return focus to that block", () => {
    const target = new EventTarget(), fakeDocument = Object.assign(target, { activeElement: null as unknown, body: element("body") });
    // Focusing the block makes it the active element again, as in the browser.
    const block = element("timeline template block");
    block.focus.mockImplementation(() => { fakeDocument.activeElement = block; });
    fakeDocument.activeElement = block;
    vi.stubGlobal("document", fakeDocument);
    vi.stubGlobal("requestAnimationFrame", undefined);
    const f = manager();
    f.render();
    const unsubscribe = hooks.effects[0]() as () => void;
    target.dispatchEvent(new CustomEvent(TEMPLATE_EDITOR_REQUEST_EVENT, { detail: { instanceId: "saved-template", source: "timeline" } }));
    let tree = f.render();
    expect(details(tree).props.open).toBe(true);
    // The editor took focus for typing; Escape still knows where the creator came from.
    fakeDocument.activeElement = element("title field");
    (details(tree).props.onKeyDown as (event: object) => void)(escape());
    expect(block.focus).toHaveBeenCalledTimes(1);
    target.dispatchEvent(new CustomEvent(TEMPLATE_EDITOR_REQUEST_EVENT, { detail: { instanceId: "saved-template", source: "timeline" } }));
    tree = f.render();
    fakeDocument.activeElement = element("title field");
    const close = elements(tree).find(item => item.props["data-testid"] === "close-saved-template-editor")!;
    (close.props.onClick as () => void)();
    expect(details(f.render()).props.open).toBe(false);
    expect(block.focus).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
  it("the editor's button sends the re-apply request through the ordinary revise channel", () => {
    vi.stubGlobal("document", { activeElement: null, body: element("body") });
    const f = manager();
    const editor = elements(f.render()).find(item => typeof item.props.onReapply === "function")!;
    (editor.props.onReapply as () => void)();
    expect(f.onRevise).toHaveBeenCalledTimes(1);
    const [id, patch, revision] = f.onRevise.mock.calls[0];
    expect([id, revision]).toEqual(["saved-template", 3]);
    expect(isReferenceMotionTemplateReapplyPatch(patch)).toBe(true);
  });
});
