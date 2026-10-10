import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import ReferenceMotionTemplateControls, { type ManualReferenceMotionTemplate } from "./ReferenceMotionTemplateControls";

// Persistent hook slots inspect real component handlers; not a mounted browser or artwork check.
const slots = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useState: (initial: unknown) => {
  const index = slots.cursor++; if (!(index in slots.values)) slots.values[index] = initial;
  return [slots.values[index], (next: unknown) => { slots.values[index] = typeof next === "function"
    ? (next as (value: unknown) => unknown)(slots.values[index]) : next; }];
} }));
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function fixture() {
  const project = createDemoProject(), apply = vi.fn<(input: ManualReferenceMotionTemplate) => void>(), cancel = vi.fn();
  let busy = false;
  function render() {
    slots.cursor = 0;
    return elements(ReferenceMotionTemplateControls({ clip: project.tracks[0].clips[0], assets: project.assets,
      portrait: true, fps: project.fps, onApply: apply, onCancel: cancel, busy }));
  }
  function find(attribute: string, value: string) {
    const found = render().find(element => element.props[attribute] === value);
    if (!found) throw new Error(`Actual cadence control missing: ${attribute}=${value}`);
    return found;
  }
  const change = (label: string, value: string) => (find("aria-label", label).props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
  const click = () => (find("data-testid", "apply-reference-motion-template").props.onClick as () => void)();
  change("模板主標題", "保留真正重點");
  return { render, find, change, click, apply, cancel, setBusy: (value: boolean) => { busy = value; } };
}
beforeEach(() => { slots.values = []; slots.cursor = 0; });

describe("new reference template graphic cadence controls", () => {
  it("submits explicit kinetic (Motion Language) by default alongside the unchanged animation fine setting", () => {
    const ui = fixture(), cadence = ui.find("aria-label", "模板圖卡節奏");
    expect(cadence.props.value).toBe("kinetic");
    expect(elements(cadence.props.children as ReactNode).filter(node => node.type === "option").map(node => [node.props.value, node.props.children]))
      .toEqual([["kinetic", "流暢動態（Motion Language）"], ["brisk", "俐落動態"], ["legacy", "保留舊版節奏"]]);
    expect(ui.find("data-testid", "apply-reference-motion-template").props.disabled).toBe(false);
    ui.click(); expect(ui.apply).toHaveBeenCalledTimes(1);
    expect(ui.apply.mock.calls[0][0]).toMatchObject({ templateId: "level_bridge", graphicCadence: "kinetic", style: { animationSpeed: 1 } });
  });
  it("honors explicit legacy without discarding the separate authored speed adjustment", () => {
    const ui = fixture(); ui.change("模板圖卡節奏", "legacy"); ui.change("模板動畫速度", "1.5"); ui.click();
    expect(ui.apply.mock.calls[0][0]).toMatchObject({ graphicCadence: "legacy", style: { animationSpeed: 1.5 } });
    expect(ui.find("aria-label", "模板圖卡節奏").props.value).toBe("legacy");
  });
  it("keeps the explicit cadence when changing family without forwarding another family presentation", () => {
    const ui = fixture(); ui.change("模板圖卡節奏", "legacy");
    ui.change("參考 Motion 模板", "comparison_pair"); ui.change("比較素材呈現", "legacy_layout");
    ui.change("參考 Motion 模板", "level_bridge"); ui.click();
    const input = ui.apply.mock.calls[0][0]; expect(input.graphicCadence).toBe("legacy");
    expect(Object.hasOwn(input, "mediaPresentation")).toBe(false); expect(input.sources).toEqual([]);
  });
  it("blocks cadence changes and late submission while busy and retains an actual cancel callback", () => {
    const ui = fixture(); ui.setBusy(true);
    expect(ui.render().find(node => node.type === "fieldset")?.props.disabled).toBe(true);
    ui.change("模板圖卡節奏", "legacy"); expect(ui.find("aria-label", "模板圖卡節奏").props.value).toBe("kinetic");
    ui.click(); expect(ui.apply).not.toHaveBeenCalled();
    (ui.find("data-testid", "cancel-reference-motion-template").props.onClick as () => void)(); expect(ui.cancel).toHaveBeenCalledTimes(1);
    ui.setBusy(false); ui.click(); expect(ui.apply.mock.calls[0][0].graphicCadence).toBe("kinetic");
  });
});
