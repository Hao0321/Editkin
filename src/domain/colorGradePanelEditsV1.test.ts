import { describe, expect, it } from "vitest";
import { addCurvePointV1, addGradeNodeV1, beginGradePanelGestureV1, editGradeNodeV1, identityCurveV1, moveCurvePointV1, moveGradeNodeV1, removeGradeNodeV1, settleGradePanelGestureV1, wheelFromPointV1, wheelPointV1 } from "./colorGradePanelEditsV1";
import type { ColorGradeV2 } from "./visualTypes";
import { createDemoProject } from "./demo";
import { createHistory, dispatchCommand, dispatchCommandSafely, undo, redo } from "./history";
import { colorGradeV2Schema } from "./colorGradeV2Schema";
import { resolveColorGradeV2, applyResolvedColorGradeV2 } from "../color/gradeV2";
const authored: ColorGradeV2 = { schema: "editkin.color-grade/v2", nodes: [{ id: "a", offset: { r: .05 }, curves: { b: [{ x: 0, y: 0 }, { x: 1, y: 1 }] } }, { id: "b", gain: { r: .3 } }], look: { id: "hfl2_food_warm_appetite", strength: .4 }, finishing: { grain: { amount: .1 }, vignette: { amount: .2 } } };
describe("authored grade panel operations", () => {
  it("adds up to four neutral nodes without replacing look, finishing or source grade", () => {
    const before = JSON.stringify(authored);
    const added = addGradeNodeV1(authored);
    expect(added.nodes?.at(-1)).toEqual({ id: "grade1" }); expect(added.look).toEqual(authored.look); expect(added.finishing).toEqual(authored.finishing);
    expect(() => addGradeNodeV1(addGradeNodeV1(added))).toThrow(/LIMIT/);
    expect(addGradeNodeV1({ schema: authored.schema, nodes: [{ id: "grade1" }] }).nodes?.at(-1)?.id).toBe("grade2");
    expect(JSON.stringify(authored)).toBe(before);
  });
  it("updates one node, preserves all unrelated fields, and removes only that node", () => {
    const changed = editGradeNodeV1(authored, "a", node => ({ ...node, mix: .5 }));
    expect(changed.nodes?.[0].curves).toEqual(authored.nodes?.[0].curves); expect(changed.nodes?.[1]).toEqual(authored.nodes?.[1]);
    expect(changed.look).toEqual(authored.look); expect(changed.finishing).toEqual(authored.finishing);
    expect(removeGradeNodeV1(changed, "a").nodes).toEqual([authored.nodes![1]]);
    expect(() => editGradeNodeV1(authored, "missing", n => n)).toThrow(/MISSING/);
    expect(() => editGradeNodeV1(authored, "a", n => ({ ...n, mix: NaN }))).toThrow();
  });
  it("changes actual serial color output when noncommuting nodes reorder", () => {
    const grade = { schema: authored.schema, nodes: authored.nodes };
    const reversed = moveGradeNodeV1(grade, "a", 1);
    const sample = (g: ColorGradeV2) => applyResolvedColorGradeV2(resolveColorGradeV2(g, "rec709_display"), [.2, .4, .6]);
    expect(Math.abs(sample(grade)[0] - sample(reversed)[0])).toBeGreaterThan(.001);
    expect(() => moveGradeNodeV1(grade, "a", -1)).toThrow(/ORDER/);
    const bypassed = editGradeNodeV1(grade, "a", n => ({ ...n, enabled: false }));
    expect(sample(bypassed)).toEqual(sample({ schema: authored.schema, nodes: [authored.nodes![1]] }));
  });
  it.each(["offset", "lift", "gamma", "gain"] as const)("bounds %s wheel coordinates and preserves the master/common bias", kind => {
    const wheel = wheelFromPointV1({ r: .01, g: .01, b: .01, master: .07 }, kind, 100, 0);
    expect(wheel.master).toBe(.07); expect(wheel.r).toBeCloseTo(.26); expect(wheel.g).toBeCloseTo(-.115); expect(wheel.b).toBeCloseTo(-.115);
    expect(wheelPointV1(wheel).x).toBeCloseTo(1); expect(wheelPointV1(wheel).y).toBeCloseTo(0);
    expect(colorGradeV2Schema.safeParse({ schema: authored.schema, nodes: [{ id: "x", [kind]: wheel }] }).success).toBe(true);
    expect(() => wheelFromPointV1(wheel, kind, NaN, 0)).toThrow(/POINT/);
  });
  it("adds a point on the current curve and clamps an interior drag without crossing neighbors", () => {
    const points = addCurvePointV1(identityCurveV1()); expect(points).toEqual([{ x: 0, y: 0 }, { x: .5, y: .5 }, { x: 1, y: 1 }]);
    const moved = moveCurvePointV1(points, 1, 2, 2); expect(moved[1].x).toBeLessThan(1); expect(moved[1].y).toBe(1);
    expect(points[1]).toEqual({ x: .5, y: .5 }); expect(moveCurvePointV1(points, 0, .7, .1)[0]).toEqual({ x: 0, y: .1 });
    expect(() => addCurvePointV1(Array.from({ length: 16 }, (_, i) => ({ x: i / 15, y: i / 15 })))).toThrow(/LIMIT/);
    expect(() => moveCurvePointV1(points, 5, .5, .5)).toThrow(/POINT/);
  });
  it("commits many local changes once, preserves look/finishing and supports one Undo/Redo", () => {
    const project = createDemoProject(), clip = project.tracks[0].clips[0]; clip.gradeV2 = structuredClone(authored);
    const history = createHistory(project), g = beginGradePanelGestureV1(clip.id, clip.gradeV2);
    for (const master of [.01, .02, .03, .04]) g.draft = editGradeNodeV1(g.draft, "a", n => ({ ...n, gain: { master } }));
    expect(history.past).toHaveLength(0);
    const grade = settleGradePanelGestureV1(g, clip.id, clip.gradeV2, true)!;
    const next = dispatchCommand(history, { type: "set_clip_grade_v2", clipId: clip.id, grade });
    expect(next.past).toHaveLength(1); expect(next.present.tracks[0].clips[0].gradeV2?.look).toEqual(authored.look);
    expect(undo(next).present.tracks[0].clips[0].gradeV2).toEqual(authored); expect(redo(undo(next)).present.tracks[0].clips[0].gradeV2).toEqual(grade);
    const reopened = JSON.parse(JSON.stringify(next.present)); expect(reopened.tracks[0].clips[0].gradeV2).toEqual(grade);
  });
  it("cancels a stale clip/grade, read-only handler and no-op instead of overwriting newer state", () => {
    const g = beginGradePanelGestureV1("c", authored); expect(settleGradePanelGestureV1(g, "c", authored, true)).toBeUndefined();
    g.draft = editGradeNodeV1(g.draft, "a", n => ({ ...n, contrast: 1.2 }));
    expect(settleGradePanelGestureV1(g, "other", authored, true)).toBeUndefined();
    expect(settleGradePanelGestureV1(g, "c", editGradeNodeV1(authored, "b", n => ({ ...n, contrast: 1.3 })), true)).toBeUndefined();
    expect(settleGradePanelGestureV1(g, "c", authored, false)).toBeUndefined();
  });
  it("uses the real domain lock refusal with no history/project mutation", () => {
    const project = createDemoProject(); project.tracks[0].locked = true; const history = createHistory(project);
    const result = dispatchCommandSafely(history, { type: "set_clip_grade_v2", clipId: project.tracks[0].clips[0].id, grade: addGradeNodeV1() });
    expect(result.state).toBe(history); expect(result.error).toContain("軌道已鎖定"); expect(history.past).toHaveLength(0);
  });
  it("rejects another project session even when clip IDs and grade bytes are identical", () => {
    const owner = {}, scope = { owner, sessionId: 1 }, g = beginGradePanelGestureV1("same-clip", authored, scope);
    g.draft = editGradeNodeV1(g.draft, "a", n => ({ ...n, contrast: 1.2 }));
    expect(settleGradePanelGestureV1(g, "same-clip", authored, true, { owner, sessionId: 2 })).toBeUndefined();
    expect(settleGradePanelGestureV1(g, "same-clip", authored, true, { owner: {}, sessionId: 1 })).toBeUndefined();
    expect(settleGradePanelGestureV1(g, "same-clip", authored, true, scope)).toBeDefined();
  });
});
