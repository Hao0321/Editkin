import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import ReferenceMotionTemplateControls, { type ManualReferenceMotionTemplate } from "./ReferenceMotionTemplateControls";

// Persistent hook slots exercise the real production component callbacks and
// element props. This is not mounted React, browser input, or artwork evidence.
const slots = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = slots.cursor++;
    if (!(index in slots.values)) slots.values[index] = initial;
    return [slots.values[index], (next: unknown) => {
      slots.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(slots.values[index]) : next;
    }];
  },
}));

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}

function controls() {
  const project = createDemoProject(), clip = project.tracks[0].clips[0];
  project.assets.push({ ...project.assets[0], id: "independent-source", name: "第二份自有素材", uri: "independent-source.mp4" });
  const apply = vi.fn<(input: ManualReferenceMotionTemplate) => void>(), cancel = vi.fn();
  let busy = false;
  function render() {
    slots.cursor = 0;
    return elements(ReferenceMotionTemplateControls({ clip, assets: project.assets, portrait: true, fps: project.fps,
      onApply: apply, busy, onCancel: cancel }));
  }
  function find(attribute: string, value: string) {
    const element = render().find(node => node.props[attribute] === value);
    if (!element) throw new Error(`Missing real control: ${attribute}=${value}`);
    return element;
  }
  function change(label: string, value: string) {
    (find("aria-label", label).props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
  }
  function click() {
    (find("data-testid", "apply-reference-motion-template").props.onClick as () => void)();
  }
  function comparison() {
    change("參考 Motion 模板", "comparison_pair");
    change("模板主標題", "同一基準比較");
    change("模板原片標籤", "原始畫面");
    change("模板素材 2", "independent-source");
    change("模板素材標籤 2", "另一份畫面");
  }
  return { render, find, change, click, comparison, apply, cancel, setBusy: (value: boolean) => { busy = value; } };
}

beforeEach(() => { slots.values = []; slots.cursor = 0; });

describe("comparison template media presentation controls (actual callbacks)", () => {
  it("defaults new comparison creation to complete-source soft v2 without changing other family controls", () => {
    const ui = controls();
    expect(ui.render().some(node => node.props["aria-label"] === "比較素材呈現")).toBe(false);
    ui.comparison();
    const presentation = ui.find("aria-label", "比較素材呈現");
    expect(presentation.props.value).toBe("source_soft_v2");
    expect(elements(presentation.props.children as ReactNode).filter(node => node.type === "option")
      .map(node => [node.props.value, node.props.children])).toEqual([
      ["source_soft_v2", "完整素材・柔邊"], ["legacy_layout", "保留舊版取景"],
    ]);
    expect(ui.find("data-testid", "apply-reference-motion-template").props.disabled).toBe(false);
    ui.click();
    expect(ui.apply).toHaveBeenCalledTimes(1);
    expect(ui.apply.mock.calls[0][0]).toMatchObject({ templateId: "comparison_pair", mediaPresentation: "source_soft_v2",
      primaryLabel: "原始畫面", sources: [{ assetId: "independent-source", sourceStart: 0, label: "另一份畫面" }] });
  });

  it("submits an explicit legacy-layout choice without substituting the new default", () => {
    const ui = controls(); ui.comparison();
    ui.change("比較素材呈現", "legacy_layout");
    expect(ui.find("aria-label", "比較素材呈現").props.value).toBe("legacy_layout");
    ui.click();
    expect(ui.apply).toHaveBeenCalledTimes(1);
    expect(ui.apply.mock.calls[0][0]).toMatchObject({ templateId: "comparison_pair", mediaPresentation: "legacy_layout" });
  });

  it("omits the presentation field after switching to another family rather than silently forwarding it", () => {
    const ui = controls(); ui.comparison(); ui.change("比較素材呈現", "legacy_layout");
    ui.change("參考 Motion 模板", "level_bridge");
    expect(ui.render().some(node => node.props["aria-label"] === "比較素材呈現")).toBe(false);
    expect(ui.find("data-testid", "apply-reference-motion-template").props.disabled).toBe(false);
    ui.click();
    const input = ui.apply.mock.calls[0][0];
    expect(input.templateId).toBe("level_bridge");
    expect(Object.hasOwn(input, "mediaPresentation")).toBe(false);
    expect(input.sources).toEqual([]);
  });

  it("blocks busy presentation edits and submission while preserving a separate cancellation control", () => {
    const ui = controls(); ui.comparison(); ui.setBusy(true);
    expect(ui.render().find(node => node.type === "fieldset")?.props.disabled).toBe(true);
    expect(ui.find("data-testid", "apply-reference-motion-template").props.disabled).toBe(true);
    ui.change("比較素材呈現", "legacy_layout");
    expect(ui.find("aria-label", "比較素材呈現").props.value).toBe("source_soft_v2");
    ui.click(); expect(ui.apply).not.toHaveBeenCalled();
    const cancel = ui.find("data-testid", "cancel-reference-motion-template");
    expect(cancel.props.disabled).toBe(false);
    (cancel.props.onClick as () => void)(); expect(ui.cancel).toHaveBeenCalledTimes(1);
    ui.setBusy(false); ui.click();
    expect(ui.apply).toHaveBeenCalledTimes(1);
    expect(ui.apply.mock.calls[0][0]).toMatchObject({ mediaPresentation: "source_soft_v2" });
  });
});
