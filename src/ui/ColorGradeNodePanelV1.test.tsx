import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ColorGradeNodePanelV1 } from "./ColorGradeNodePanelV1";
import { ColorGradeWheelV1 } from "./ColorGradeWheelV1";
import { ColorGradeCurveV1 } from "./ColorGradeCurveV1";
import type { ColorGradeV2 } from "../domain/visualTypes";
// Direct source callbacks; actual React/pointer/GPU/Undo is a separate browser fixture.
const refs = vi.hoisted(() => [] as Array<{ current: any }>);
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useEffect: () => {}, useState: (value: unknown) => [value, () => {}], useRef: (value: unknown) => { const ref = { current: value }; refs.push(ref); return ref; } }));
vi.mock("./i18n/interfacePreferences", async original => ({ ...await original<typeof import("./i18n/interfacePreferences")>(), useI18n: () => ({}) }));
type Element = ReactElement<Record<string, any>>;
function all(node: ReactNode): Element[] { if (Array.isArray(node)) return node.flatMap(all); if (!isValidElement(node)) return []; const e = node as Element; return [e, ...all(e.props.children)]; }
const grade: ColorGradeV2 = { schema: "editkin.color-grade/v2", nodes: [{ id: "authored", label: "作者節點原文", curves: { b: [{ x: 0, y: 0 }, { x: 1, y: 1 }] } }], look: { id: "hfl2_food_warm_appetite", strength: .4 } };
describe("node panel source handlers", () => {
  it("refuses old node actions after the component now represents another clip", () => {
    const change = vi.fn(), items = all(ColorGradeNodePanelV1({ clipId: "old", grade, onChange: change }));
    refs[0].current = { clipId: "new", grade, onChange: change };
    items.find(e => e.props["data-testid"] === "grade-node-bypass")!.props.onClick();
    expect(change).not.toHaveBeenCalled();
  });
  it("refuses an old draft callback instead of beginning on the latest other clip", () => {
    const change = vi.fn(), items = all(ColorGradeNodePanelV1({ clipId: "old", grade, onChange: change }));
    const input = items.find(e => e.props["data-testid"] === "grade-node-mix")!;
    refs[0].current = { clipId: "new", grade, onChange: change };
    const target = { valueAsNumber: .2 };
    input.props.onPointerDown({ currentTarget: target, pointerId: 1, button: 0, preventDefault: () => {} });
    input.props.onChange({ currentTarget: target }); input.props.onPointerUp({ currentTarget: target, pointerId: 1 });
    expect(change).not.toHaveBeenCalled();
  });
  it("an identical clip and grade still require the original selection occurrence at release", () => {
    const change = vi.fn(), original = {}, items = all(ColorGradeNodePanelV1({ clipId: "c", grade, onChange: change, editOccurrence: original }));
    const input = items.find(e => e.props["data-testid"] === "grade-node-mix")!;
    const target = { valueAsNumber: .2 };
    input.props.onPointerDown({ currentTarget: target, pointerId: 1, button: 0, preventDefault: () => {} });
    input.props.onChange({ currentTarget: target });
    refs[0].current = { clipId: "c", grade, onChange: change, editOccurrence: {} };
    input.props.onPointerUp({ currentTarget: target, pointerId: 1 }); expect(change).not.toHaveBeenCalled();
  });
  beforeEach(() => { refs.length = 0; });
  it("adds/removes/bypasses through the one existing grade callback", () => {
    const change = vi.fn(), items = all(ColorGradeNodePanelV1({ clipId: "c", grade, onChange: change }));
    items.find(e => e.props["data-testid"] === "grade-node-add")!.props.onClick(); expect(change.mock.lastCall![0].nodes).toHaveLength(2);
    items.find(e => e.props["data-testid"] === "grade-node-bypass")!.props.onClick(); expect(change.mock.lastCall![0].nodes[0].enabled).toBe(false);
    items.find(e => e.props["data-testid"] === "grade-node-remove")!.props.onClick(); expect(change.mock.lastCall![0].nodes).toEqual([]);
    expect(change.mock.lastCall![0].look).toEqual(grade.look);
  });
  it("drafts multiple wheel changes and submits exactly once at release", () => {
    const change = vi.fn(), items = all(ColorGradeNodePanelV1({ clipId: "c", grade, onChange: change }));
    const wheel = items.find(e => e.type === ColorGradeWheelV1 && e.props.kind === "gain")!;
    wheel.props.onDraft({ r: .1 }); wheel.props.onDraft({ r: .2 }); expect(change).not.toHaveBeenCalled();
    wheel.props.onCommit(); wheel.props.onCommit(); expect(change).toHaveBeenCalledTimes(1); expect(change.mock.lastCall![0].nodes[0].gain).toEqual({ r: .2 });
  });
  it("cancels a pointer draft and preserves another curve channel when adding Y points", () => {
    const change = vi.fn(), items = all(ColorGradeNodePanelV1({ clipId: "c", grade, onChange: change }));
    const curve = items.find(e => e.type === ColorGradeCurveV1)!;
    curve.props.onDraft([{ x: 0, y: .1 }, { x: 1, y: 1 }]); curve.props.onCancel(); curve.props.onCommit(); expect(change).not.toHaveBeenCalled();
    curve.props.onAction([{ x: 0, y: 0 }, { x: .5, y: .6 }, { x: 1, y: 1 }]); expect(change.mock.lastCall![0].nodes[0].curves.b).toEqual(grade.nodes![0].curves!.b);
  });
  it("disables mutation in view-only mode and preserves author labels", () => {
    const items = all(ColorGradeNodePanelV1({ clipId: "c", grade, readOnlyReason: "這個軌道已鎖定，先解鎖才能修改。" }));
    expect(items.find(e => e.props["data-testid"] === "grade-node-add")!.props.disabled).toBe(true);
    expect(items.filter(e => e.type === ColorGradeWheelV1).every(e => e.props.disabled)).toBe(true);
    expect(items.some(e => e.props.children === "作者節點原文")).toBe(true);
  });
  it("does not rebase a still-held gesture after external grade or project-session replacement", () => {
    const change = vi.fn(), owner = {}, scope = { owner, sessionId: 1 };
    const items = all(ColorGradeNodePanelV1({ clipId: "c", grade, onChange: change, editScope: scope }));
    const wheel = items.find(e => e.type === ColorGradeWheelV1 && e.props.kind === "gain")!;
    wheel.props.onDraft({ r: .1 });
    refs[0].current = { clipId: "c", grade, onChange: change, editScope: { owner, sessionId: 2 } };
    wheel.props.onDraft({ r: .2 }); wheel.props.onCommit(); expect(change).not.toHaveBeenCalled();
    refs[0].current = { clipId: "c", grade, onChange: change, editScope: scope };
    wheel.props.onDraft({ r: .1 }); refs[0].current = { clipId: "c", grade: { ...grade, finishing: { vignette: { amount: .2 } } }, onChange: change, editScope: scope };
    wheel.props.onDraft({ r: .3 }); wheel.props.onCommit(); expect(change).not.toHaveBeenCalled();
  });
});
