import { describe, expect, it } from "vitest";
import { validateProject } from "./editGraph";
import { createDemoProject } from "./demo";
import { createHistory, dispatchCommand, undo } from "./history";
import type { ColorGradeNodeV2, ColorGradeV2 } from "./visualTypes";
import { applyColorGradeV2Rgb, resolveColorGradeV2 } from "../color/gradeV2";
import { setColorQualifierEnabledV1, removeColorQualifierV1, setColorQualifierHueEnabledV1, setColorQualifierInvertedV1,
  setColorQualifierNumberV1, setColorQualifierOutsideWheelV1, clearColorQualifierOutsideV1 } from "./colorQualifierPanelEditsV1";

const source: ColorGradeNodeV2 = { id: "n", label: "作者節點", gain: { r: .04 }, saturation: 1.2, skinProtection: .9 };
const grade = (node: ColorGradeNodeV2): ColorGradeV2 => ({ schema: "editkin.color-grade/v2", nodes: [node] });

describe("manual HSL controls use the existing validated selector", () => {
  it("starts with all colours and does not mutate the original node", () => {
    const before = structuredClone(source), enabled = setColorQualifierEnabledV1(source, true);
    expect(enabled.secondaryHslV1).toMatchObject({ enabled: true, qualifier: { saturation: { minimum: 0, maximum: 1 } } });
    expect(source).toEqual(before); expect(enabled.gain).toEqual(source.gain);
    for (const space of ["rec709_display", "acescct"] as const) for (const rgb of [[0, 0, 0], [1, 1, 1], [1, 0, 0], [.4, .2, .1], [.2, .7, .9]] as [number, number, number][]) {
      expect(applyColorGradeV2Rgb(grade(enabled), space, rgb)).toEqual(applyColorGradeV2Rgb(grade(source), space, rgb));
    }
  });
  it("disabled selection restores the exact historical key, and removing it restores the original node", () => {
    const enabled = setColorQualifierHueEnabledV1(setColorQualifierEnabledV1(source, true), true);
    const disabled = setColorQualifierEnabledV1(enabled, false);
    for (const space of ["rec709_display", "acescct"] as const) expect(resolveColorGradeV2(grade(disabled), space).key).toBe(resolveColorGradeV2(grade(source), space).key);
    expect(removeColorQualifierV1(enabled)).toEqual(source);
    expect(setColorQualifierEnabledV1(source, false)).toEqual(source);
  });
  it("edits all numeric fields and clamps intervals without crossing their opposite endpoints", () => {
    let node = setColorQualifierEnabledV1(source, true);
    for (const [key, value] of [["hue-center", 361], ["hue-width", 200], ["hue-softness", 30], ["sat-min", .4], ["sat-max", .7],
      ["sat-softness", .2], ["light-min", .1], ["light-max", .8], ["light-softness", .3], ["clean-black", .2], ["clean-white", .7]] as const) node = setColorQualifierNumberV1(node, key, value);
    expect(node.secondaryHslV1?.qualifier.hue).toEqual({ centerDegrees: 359.99, halfWidthDegrees: 180, softnessDegrees: 30 });
    expect(setColorQualifierNumberV1(node, "sat-min", .9).secondaryHslV1?.qualifier.saturation?.minimum).toBe(.7);
    expect(setColorQualifierNumberV1(node, "light-max", -.2).secondaryHslV1?.qualifier.lightness?.maximum).toBe(.1);
    const black = setColorQualifierNumberV1(node, "clean-black", 1).secondaryHslV1!.cleanup!;
    expect(black.blackPoint).toBeLessThan(black.whitePoint!);
    const white = setColorQualifierNumberV1(node, "clean-white", 0).secondaryHslV1!.cleanup!;
    expect(white.whitePoint).toBeGreaterThan(white.blackPoint!);
  });
  it("keeps a legal all-colour range when disabling the only hue range and toggles inversion explicitly", () => {
    const onlyHue: ColorGradeNodeV2 = { ...source, secondaryHslV1: { schema: "editkin.secondary-hsl/v1", selectorSpace: "working_rgb_code", qualifier: { hue: { centerDegrees: 5, halfWidthDegrees: 10 } } } };
    const node = setColorQualifierHueEnabledV1(onlyHue, false);
    expect(node.secondaryHslV1?.qualifier).toEqual({ saturation: { minimum: 0, maximum: 1 } });
    expect(setColorQualifierInvertedV1(node, true).secondaryHslV1?.inverted).toBe(true);
    expect(onlyHue.secondaryHslV1?.qualifier.hue).toBeDefined();
  });
  it("independently grades the outside, preserves inside controls and clears only the explicit outside branch", () => {
    let node = setColorQualifierHueEnabledV1(setColorQualifierEnabledV1(source, true), true);
    node = setColorQualifierOutsideWheelV1(node, "offset", { master: .04, b: .02 });
    expect(node.gain).toEqual(source.gain); expect(node.saturation).toBe(source.saturation);
    expect(node.secondaryHslV1?.outside?.offset).toEqual({ master: .04, b: .02 });
    const before = applyColorGradeV2Rgb(grade(setColorQualifierHueEnabledV1(setColorQualifierEnabledV1(source, true), true)), "rec709_display", [0, 0, 1]);
    const after = applyColorGradeV2Rgb(grade(node), "rec709_display", [0, 0, 1]);
    expect(after).not.toEqual(before);
    expect(clearColorQualifierOutsideV1(node).secondaryHslV1?.outside).toBeUndefined();
    expect(node.secondaryHslV1?.outside).toBeDefined();
  });
  it("rejects invalid numbers, fields and wheel data without changing the source", () => {
    const before = structuredClone(source);
    for (const n of [NaN, Infinity, -Infinity]) expect(() => setColorQualifierNumberV1(source, "hue-center", n)).toThrow(/NUMBER/);
    expect(() => setColorQualifierNumberV1(source, "hue-foreign" as "hue-center", 5)).toThrow(/FIELD/);
    expect(() => setColorQualifierOutsideWheelV1(source, "offset", { r: 1000 })).toThrow();
    expect(() => setColorQualifierEnabledV1(source, "false" as unknown as boolean)).toThrow(/BOOLEAN/);
    expect(source).toEqual(before);
  });
  it("uses a normal grade command for one Undo and schema roundtrip, with existing locked-track refusal", () => {
    const project = createDemoProject(); project.tracks[0].clips[0].gradeV2 = grade(source);
    const clip = project.tracks[0].clips[0], next = grade(setColorQualifierHueEnabledV1(setColorQualifierEnabledV1(source, true), true));
    const changed = dispatchCommand(createHistory(project), { type: "set_clip_grade_v2", clipId: clip.id, grade: next });
    expect(changed.past).toHaveLength(1); expect(undo(changed).present.tracks[0].clips[0].gradeV2).toEqual(grade(source));
    expect(validateProject(JSON.parse(JSON.stringify(changed.present))).tracks[0].clips[0].gradeV2).toEqual(next);
    project.tracks[0].locked = true;
    expect(() => dispatchCommand(createHistory(project), { type: "set_clip_grade_v2", clipId: clip.id, grade: next })).toThrow(/鎖定/);
  });
});
