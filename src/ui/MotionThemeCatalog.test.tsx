import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import MotionThemeCatalog from "./MotionThemeCatalog";
import { referenceMotionManualReuseRequest } from "./referenceMotionManualReuse";

// Controlled source UI callbacks; actual effects, browser, saved CURRENT and font evidence are tested separately.
const slots = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock("./i18n/interfacePreferences", async importOriginal => {
  const actual = await importOriginal<typeof import("./i18n/interfacePreferences")>();
  return { ...actual, useI18n: () => ({ ...actual.interfacePreferences.getSnapshot(), t: actual.translateUi }) };
});
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useEffect: () => {}, useState: (initial: unknown) => {
  const index = slots.cursor++;
  if (!(index in slots.values)) slots.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
  return [slots.values[index], (next: unknown) => { slots.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(slots.values[index]) : next; }];
} }));
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function fixture() {
  const project = createDemoProject(); project.width = 1080; project.height = 1920; project.tracks[0].clips[0].duration = 8;
  const onApply = vi.fn(), onCancel = vi.fn(); let busy = false;
  const render = () => { slots.cursor = 0; return MotionThemeCatalog({ project, selectedClipId: "clip-demo", onApply, onCancel, busy }); };
  const control = (attribute: string, value: string) => { const found = elements(render()).find(item => item.props[attribute] === value); if (!found) throw new Error(`Missing catalog control ${value}`); return found; };
  const edit = (label: string, value: string) => (control("aria-label", label).props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
  const apply = () => (control("data-testid", "apply-motion-theme-catalog").props.onClick as () => void)();
  return { project, onApply, onCancel, render, control, edit, apply, busy: (value: boolean) => { busy = value; } };
}
beforeEach(() => { slots.values = []; slots.cursor = 0; });
describe("manual themed catalog source UI", () => {
  it("keeps copy across the real type/theme/family callbacks, requires actual fields and submits the selected target window", () => {
    const view = fixture(); view.apply(); expect(view.onApply).not.toHaveBeenCalled();
    view.edit("題材模板主標題", "自己的主標題"); view.edit("題材模板原句", "自己的原句");
    view.edit("模板影片類型", "travel"); view.edit("模板視覺主題", "reel_night_v1"); view.edit("模板動態編排", "level_bridge");
    expect(view.control("aria-label", "題材模板主標題").props.value).toBe("自己的主標題");
    view.apply(); expect(view.onApply).toHaveBeenCalledOnce();
    expect(view.onApply.mock.calls[0][0]).toMatchObject({ templateId: "level_bridge", designSystem: "reel_night_v1", title: "自己的主標題", clipId: "clip-demo", startFrame: 0, durationFrames: 240 });
    expect(view.onApply.mock.calls[0][0]).not.toHaveProperty("previousText");
  });
  it("does not dispatch when the target changes or disappears and keeps the authored text", () => {
    const view = fixture(); view.edit("題材模板主標題", "自己的主標題"); view.edit("模板動態編排", "level_bridge");
    view.project.tracks[0].locked = true; view.apply(); expect(view.onApply).not.toHaveBeenCalled();
    expect(view.control("aria-label", "題材模板主標題").props.value).toBe("自己的主標題");
    view.project.tracks[0].locked = false; view.edit("題材模板影片片段", "missing"); view.apply(); expect(view.onApply).not.toHaveBeenCalled();
  });
  it("blocks callbacks while busy and offers cancellation without erasing the draft", () => {
    const view = fixture(); view.edit("題材模板主標題", "原始文案"); view.edit("模板動態編排", "level_bridge"); view.busy(true);
    view.edit("題材模板主標題", "不應進入的文案"); view.edit("模板影片類型", "game"); view.apply();
    expect(view.onApply).not.toHaveBeenCalled(); expect(view.control("aria-label", "題材模板主標題").props.value).toBe("原始文案");
    expect(elements(view.render()).find(item => item.type === "fieldset")?.props.disabled).toBe(true);
    (elements(view.render()).find(item => item.type === "button" && item.props.className === "secondary-action")!.props.onClick as () => void)();
    expect(view.onCancel).toHaveBeenCalledOnce();
  });
  it("records only the current manual selection and rejects a stale project request without adding legal, observation or art approvals", () => {
    const project = createDemoProject(), request = { sourceInstanceId: "old-instance", expectedInstanceRevision: 1,
      expectedProjectRevision: project.revision, targetClipId: "new-clip", purpose: "套用已保存文案", sources: [] };
    const result = referenceMotionManualReuseRequest(project, request);
    expect(result.evidenceRefs).toEqual([`manual:template-reuse-choice:${project.revision}:new-clip`]);
    expect(Object.keys(result).sort()).toEqual([...Object.keys(request), "evidenceRefs"].sort());
    project.revision++; expect(() => referenceMotionManualReuseRequest(project, request)).toThrow("重新開啟");
  });
});
