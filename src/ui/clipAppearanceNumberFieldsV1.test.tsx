import assert from "node:assert/strict";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import type { ParameterGestureLeaseV1 } from "../application/transientParameterGestureV1";
import { ClipTransformNumberFieldsV1, ClipColorNumberFieldsV1 } from "./ClipAppearanceNumberFieldsV1";
import { NumberEditFieldV1, createNumberEditDraftV1, renderNumberEditFieldV1 } from "./NumberEditFieldV1";

type Field = ReactElement<Parameters<typeof renderNumberEditFieldV1>[0] & { "data-appearance-field"?: string; children?: ReactNode }>;
function fields(node: ReactNode, found: Field[] = []): Field[] {
  if (Array.isArray(node)) node.forEach(child => fields(child, found));
  else if (isValidElement<Field["props"]>(node)) { if (node.type === NumberEditFieldV1) found.push(node); fields(node.props.children, found); }
  return found;
}
function fixture(group: "transform" | "color", factory?: (field: string) => ParameterGestureLeaseV1 | undefined) {
  const clip = createDemoProject().tracks[0].clips[0], scope = {}, changes: unknown[] = [];
  const common = { editScope: scope, onChange: (patch: unknown) => { changes.push(patch); return true; }, onGestureStart: factory };
  return { scope, changes, fields: fields(group === "transform"
    ? ClipTransformNumberFieldsV1({ ...common, values: clip.transform })
    : ClipColorNumberFieldsV1({ ...common, values: clip.color })) };
}
function mount(field: Field) {
  const input = renderNumberEditFieldV1({ ...field.props, draft: createNumberEditDraftV1() });
  const target = { value: String(field.props.value), get valueAsNumber() { return this.value.trim() ? Number(this.value) : NaN; } };
  return { input, target, change(value: string | number) { target.value = String(value); input.props.onChange?.({ currentTarget: target }); },
    blur() { return input.props.onBlur?.({ currentTarget: target }); },
    escape() { input.props.onKeyDown?.({ currentTarget: target, key: "Escape", preventDefault() {}, stopPropagation() {} } as never); } };
}
describe("the nine original clip numeric fields adopt optional preview without another owner", () => {
  for (const group of ["transform", "color"] as const) {
    const keys = group === "transform" ? ["x", "y", "scale", "rotation", "opacity"] : ["brightness", "contrast", "saturation", "hue"];
    for (const key of keys) {
      it(group + "." + key + " retains no-factory confirmation compatibility", () => {
        const f = fixture(group), field = f.fields.find(field => field.props["data-appearance-field"] === key)!;
        assert.equal(field.props.scope, f.scope); assert.equal(field.props.onGestureStart, undefined);
        const x = mount(field), next = field.props.value + .1;
        x.change(next); assert.equal(f.changes.length, 0); x.blur();
        assert.deepEqual(f.changes, [{ [key]: next }]);
      });
      it(group + "." + key + " routes samples and confirms the captured field lease", () => {
        const updates: number[] = [], started: string[] = []; let commits = 0;
        const f = fixture(group, field => { started.push(field); return { update: value => { updates.push(value); return true; },
          commit: () => { commits++; return true; }, cancel() {} }; });
        const field = f.fields.find(field => field.props["data-appearance-field"] === key)!, x = mount(field), next = field.props.value + .1;
        x.change(next); assert.deepEqual(started, [key]); assert.equal(updates.at(-1), next); assert.equal(commits, 0);
        x.blur(); assert.equal(commits, 1); assert.deepEqual(f.changes, []);
      });
      it(group + "." + key + " cancels without writing the canonical fallback", () => {
        let cancels = 0, commits = 0;
        const f = fixture(group, () => ({ update: () => true, commit: () => { commits++; return true; }, cancel() { cancels++; } }));
        const field = f.fields.find(field => field.props["data-appearance-field"] === key)!, x = mount(field);
        x.change(field.props.value + .1); x.escape(); x.blur();
        assert.equal(cancels, 1); assert.equal(commits, 0); assert.deepEqual(f.changes, []);
      });
      it(group + "." + key + " never falls back after a refused preview factory", () => {
        const f = fixture(group, () => undefined), field = f.fields.find(field => field.props["data-appearance-field"] === key)!, x = mount(field);
        x.change(field.props.value + .1); x.blur();
        assert.deepEqual(f.changes, []); assert.equal(x.target.value, String(field.props.value));
      });
    }
    it(group + " preserves original controls and their bounds", () => {
      const f = fixture(group);
      assert.deepEqual(f.fields.map(field => field.props["data-appearance-field"]), keys);
      if (group === "transform") {
        assert.equal(f.fields[2].props.min, "0.01"); assert.equal(f.fields[2].props.step, "0.05");
        assert.equal(f.fields[4].props.max, "1");
      } else {
        assert.equal(f.fields[0].props.min, "-1"); assert.equal(f.fields[3].props.min, "-180");
        assert.equal(f.fields[3].props.max, "180");
      }
    });
  }
});
