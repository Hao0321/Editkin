import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectSession } from "../application/projectSession";
import { instanceOf, oldTitlesProject } from "../application/oldTitleTemplatesFixture";
import { registerTemplatesUpdateRunner } from "../application/templatesUpdateRuns";

// The production editor form and manager with stateful hook doubles (as in SavedReferenceMotionInstances.reapply.test):
// handlers are called directly; the old titles are real (compiled, inspected and hashed for real).
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
import { referenceMotionInstanceDraft, SavedReferenceMotionInstanceForm, SavedReferenceMotionInstances } from "./SavedReferenceMotionInstances";

let stops: Array<() => void> = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); vi.unstubAllGlobals(); hooks.active = false; });

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
const byTestId = (tree: ReactNode, id: string) => elements(tree).find(element => element.props["data-testid"] === id);

describe("「把標題更新到新版」 in the template editor", () => {
  async function form(updateAll: { count: number; running: boolean } | undefined, status: "ENVIRONMENT_CHANGED" | "CURRENT" = "ENVIRONMENT_CHANGED", busy = false) {
    const f = await oldTitlesProject(), saved = instanceOf(f.project, f.ids.fresh), onUpdate = vi.fn();
    const tree = SavedReferenceMotionInstanceForm({ instance: saved, assets: [], inspection: { status, reason: "ENVIRONMENT_CHANGED: template recipe contract changed" },
      draft: referenceMotionInstanceDraft(saved), busy, onRevise: vi.fn(), onDetach: vi.fn(), onCancel: vi.fn(), onDraftChange: vi.fn(), onReapply: vi.fn(),
      reapply: { state: "READY" }, ...(updateAll ? { updateAll: { ...updateAll, onUpdate } } : {}) });
    return { tree, onUpdate, html: renderToStaticMarkup(tree) };
  }
  it("is offered on an old title's message, for all old titles, with what it keeps", async () => {
    const f = await form({ count: 3, running: false });
    expect(f.html).toContain("把標題更新到新版");
    expect(f.html).toContain("專案裡 3 個舊版標題會一起更新；文字、字型和配色都保留。");
    // The single-title re-apply stays next to it.
    expect(f.html).toContain("依目前片段重新套用");
    (byTestId(f.tree, "update-reference-motion-templates")!.props.onClick as () => void)();
    expect(f.onUpdate).toHaveBeenCalledTimes(1);
    expect((await form({ count: 1, running: false })).html).toContain("這個標題會照新版重新排好；文字、字型和配色都保留。");
  }, 120_000);
  it("cannot be pressed while an update runs or the editor is busy, and is not offered on a current title or without a runner", async () => {
    const running = await form({ count: 2, running: true });
    expect(running.html).toContain("正在更新…");
    (byTestId(running.tree, "update-reference-motion-templates")!.props.onClick as () => void)();
    expect(running.onUpdate).not.toHaveBeenCalled();
    expect(byTestId((await form({ count: 2, running: false }, "ENVIRONMENT_CHANGED", true)).tree, "update-reference-motion-templates")!.props.disabled).toBe(true);
    expect(byTestId((await form({ count: 2, running: false }, "CURRENT")).tree, "saved-template-update")).toBeUndefined();
    expect(byTestId((await form(undefined)).tree, "saved-template-update")).toBeUndefined();
  }, 120_000);
});

describe("the template editor finds the old titles and runs the window's one update", () => {
  async function manager(selectedId?: (ids: Awaited<ReturnType<typeof oldTitlesProject>>["ids"]) => string) {
    hooks.active = true; hooks.states = []; hooks.refs = []; hooks.effects = [];
    vi.stubGlobal("document", { activeElement: null, body: { name: "body" } });
    const f = await oldTitlesProject();
    const session = createProjectSession(f.project), onRevise = vi.fn();
    const render = () => { hooks.stateIndex = 0; hooks.refIndex = 0; hooks.effects = [];
      return SavedReferenceMotionInstances({ project: f.project, session, busy: false, onRevise, onDetach: vi.fn(), onCancel: vi.fn() }) as ReactNode; };
    let tree = render();
    // Open the editor (as the footer button does), choose a template, then let the editor look for old titles.
    (elements(tree).find(item => item.props["data-testid"] === "saved-reference-motion-instances")!.props.onToggle as (event: object) => void)({ currentTarget: { open: true } });
    if (selectedId) hooks.states[0].value = selectedId(f.ids);
    tree = render();
    const stop = hooks.effects[3]() as (() => void) | undefined;
    if (stop) stops.push(stop);
    return { f, render, onRevise };
  }
  const editorProps = (tree: ReactNode) => elements(tree).find(item => typeof item.props.onReapply === "function")!.props;

  it("offers it on an old title with the number of old titles nobody changed, and runs the window's update", async () => {
    const runner = vi.fn(async () => undefined);
    stops.push(registerTemplatesUpdateRunner(runner));
    const m = await manager();
    await vi.waitFor(() => expect(editorProps(m.render()).updateAll).toBeDefined(), { timeout: 30_000 });
    const updateAll = editorProps(m.render()).updateAll as { count: number; running: boolean; onUpdate: () => void };
    // FOCUS and BATS; RIVER was changed by hand afterwards and is left to 「依目前片段重新套用」.
    expect([updateAll.count, updateAll.running]).toEqual([2, false]);
    updateAll.onUpdate();
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
    expect(m.onRevise).not.toHaveBeenCalled();
  }, 120_000);
  it("is not offered on a title changed by hand afterwards, nor when no runner is there to run it", async () => {
    stops.push(registerTemplatesUpdateRunner(async () => undefined));
    const edited = await manager(ids => ids.edited);
    await vi.waitFor(() => expect(hooks.states.some(state => state.value && typeof state.value === "object" && "ids" in (state.value as object))).toBe(true), { timeout: 30_000 });
    expect(editorProps(edited.render()).updateAll).toBeUndefined();
    for (const stop of stops.splice(0)) stop();
    const unhosted = await manager();
    await vi.waitFor(() => expect(hooks.states.some(state => state.value && typeof state.value === "object" && "ids" in (state.value as object))).toBe(true), { timeout: 30_000 });
    expect(editorProps(unhosted.render()).updateAll).toBeUndefined();
  }, 120_000);
});
