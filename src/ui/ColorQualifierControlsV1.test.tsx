import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ColorGradeV2 } from "../domain/visualTypes";
import { setColorQualifierEnabledV1 } from "../domain/colorQualifierPanelEditsV1";
const hooks = vi.hoisted(() => ({ refs: [] as Array<{ current: any }>, outside: false }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useEffect: () => {},
  useState: (value: unknown) => [value === false ? hooks.outside : value, () => {}],
  useRef: (value: unknown) => { const ref = { current: value }; hooks.refs.push(ref); return ref; } }));
vi.mock("./i18n/interfacePreferences", async original => {
  const actual = await original<typeof import("./i18n/interfacePreferences")>();
  return { ...actual, useI18n: () => ({ ...actual.interfacePreferences.getSnapshot(), t: actual.translateUi }) };
});
import { ColorQualifierControlsV1, type ColorQualifierControlsPropsV1 } from "./ColorQualifierControlsV1";
import { ColorGradeNodePanelV1 } from "./ColorGradeNodePanelV1";
import { ColorGradeWheelV1 } from "./ColorGradeWheelV1";
import { interfacePreferences } from "./i18n/interfacePreferences";
type Element = ReactElement<Record<string, any>>;
function all(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(all); if (!isValidElement(node)) return [];
  const element = node as Element; return [element, ...all(element.props.children)];
}
const grade: ColorGradeV2 = { schema: "editkin.color-grade/v2", nodes: [setColorQualifierEnabledV1({ id: "n", gain: { r: .03 } }, true)], look: { id: "hfl2_food_warm_appetite", strength: .4 } };
function form(readonly = false) {
  const change = vi.fn(), scope = { owner: {}, sessionId: 1 };
  const props = { clipId: "clip", grade, onChange: readonly ? undefined : change, editScope: scope };
  const node = all(ColorGradeNodePanelV1(props)).find(e => e.type === ColorQualifierControlsV1)!;
  const items = all(ColorQualifierControlsV1(node.props as ColorQualifierControlsPropsV1));
  return { change, props, controls: node.props as ColorQualifierControlsPropsV1, items };
}
beforeEach(() => { hooks.refs.length = 0; hooks.outside = false; });
afterEach(async () => { await interfacePreferences.setLocale("zh-TW"); });

describe("manual HSL controls wired into the real node-panel gesture owner", () => {
  it("submits the final range only once on release while preserving look and original inside grade", () => {
    const ui = form(), range = ui.items.find(e => e.props["data-testid"] === "qualifier-sat-min")!;
    const target = { valueAsNumber: .1 };
    range.props.onPointerDown({ currentTarget: target, pointerId: 1, button: 0, preventDefault: () => {} });
    for (const value of [.1, .2, .3]) { target.valueAsNumber = value; range.props.onChange({ currentTarget: target }); }
    expect(ui.change).not.toHaveBeenCalled(); range.props.onPointerUp({ currentTarget: target, pointerId: 1 });
    expect(ui.change).toHaveBeenCalledTimes(1);
    expect(ui.change.mock.lastCall![0].nodes[0].secondaryHslV1.qualifier.saturation.minimum).toBe(.3);
    expect(ui.change.mock.lastCall![0].look).toEqual(grade.look);
    expect(ui.change.mock.lastCall![0].nodes[0].gain).toEqual(grade.nodes![0].gain);
  });
  it("cancels a range gesture without committing and refuses read-only callbacks", () => {
    const ui = form(), range = ui.items.find(e => e.props["data-testid"] === "qualifier-sat-min")!;
    const target = { valueAsNumber: .4 };
    range.props.onPointerDown({ currentTarget: target, pointerId: 1, button: 0, preventDefault: () => {} });
    range.props.onChange({ currentTarget: target }); range.props.onPointerCancel({ currentTarget: target, pointerId: 1 }); range.props.onBlur({ currentTarget: target });
    expect(ui.change).not.toHaveBeenCalled();
    hooks.refs.length = 0; const locked = form(true);
    expect(locked.controls.disabled).toBe(true);
    locked.controls.onAction(n => ({ ...n, enabled: false })); locked.controls.onDraft(n => ({ ...n, saturation: 2 })); locked.controls.onCommit();
    expect(locked.change).not.toHaveBeenCalled();
  });
  it("refuses a stale new-control action after a project/session replacement, even with the same clip and grade", () => {
    const ui = form(); hooks.refs[0].current = { ...ui.props, editScope: { ...ui.props.editScope, sessionId: 2 } };
    ui.controls.onAction(n => ({ ...n, enabled: false }));
    ui.controls.onDraft(n => ({ ...n, saturation: 2 })); ui.controls.onCommit();
    expect(ui.change).not.toHaveBeenCalled();
  });
  it("uses the existing outside wheels through one final grade callback", () => {
    hooks.outside = true;
    const ui = form(), wheel = ui.items.find(e => e.type === ColorGradeWheelV1 && e.props.kind === "offset")!;
    wheel.props.onDraft({ master: .03 }); wheel.props.onDraft({ master: .05 }); wheel.props.onCommit();
    expect(ui.change).toHaveBeenCalledTimes(1);
    expect(ui.change.mock.lastCall![0].nodes[0].secondaryHslV1.outside.offset.master).toBe(.05);
    expect(ui.change.mock.lastCall![0].nodes[0].gain).toEqual(grade.nodes![0].gain);
  });
  it("renders all eleven bounded controls and new labels in the five supported languages", async () => {
    for (const [locale, label] of [["zh-TW", "選色 HSL"], ["en", "HSL qualifier"], ["es", "Selector HSL"], ["ja", "HSL 選択"], ["ko", "HSL 선택"]] as const) {
      await interfacePreferences.setLocale(locale); hooks.outside = false;
      const markup = renderToStaticMarkup(<ColorQualifierControlsV1 node={grade.nodes![0]} onDraft={() => {}} onAction={() => {}} onCommit={() => {}} onCancel={() => {}} />);
      expect(markup).toContain(label); expect(markup.match(/data-testid="qualifier-/g)).toHaveLength(11);
    }
  });
});
