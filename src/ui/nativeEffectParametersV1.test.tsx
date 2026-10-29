import assert from "node:assert/strict";
import { isValidElement, type ReactNode, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import type { PluginRegistrySummary } from "../desktop/pluginTypes";
import type { NativeEffectInstance } from "../domain/types";
import { createDemoProject } from "../domain/demo";
import { createHistory, dispatchCommand, undo, redo } from "../domain/history";
import { projectSchema } from "../domain/schema";
import { createTransformMotionBlurInstance } from "../domain/transformMotionBlur";
import { nativeEffectParameterViewV1, nativeEffectParameterPatchV1, nativeEffectParameterResetV1 } from "./nativeEffectParametersV1";
import { NativeEffectParameterControlsV1, renderNativeEffectParameterControlsV1 } from "./NativeEffectParameterControlsV1";
import { interfacePreferences } from "./i18n/interfacePreferences";

export function effectParameterFixtureV1() {
  const instance: NativeEffectInstance = { id: "selected-effect", pluginId: "editkin.test-parameters", capabilityId: "parameters", pluginVersion: "1.2.3",
    manifestSha256: "a".repeat(64), runtimeType: "gpu_effect_graph", enabled: true, parameters: { gain: 0, enabled: false, title: "", legacy_saved: "Keep" } };
  const registry: PluginRegistrySummary = { schema: "editkin.plugin-registry/v1", diagnostics: [], plugins: [{ id: instance.pluginId, name: "Parameter test", version: instance.pluginVersion,
    publisher: "Source controls only", manifestSha256: instance.manifestSha256, permissions: ["render.effect"], capabilities: [{ id: instance.capabilityId, name: "Test effect", description: "Source fixture",
      kind: "effect", automation: "manual", automationReady: false, planningReady: false, readiness: "RUNTIME_READY", readinessDetail: "Synthetic descriptor only", semanticRoles: [], formats: [],
      requires: [], avoidWhen: [], runtimeType: "gpu_effect_graph", commandScopes: ["clip"], parameters: [
        { id: "gain", name: "Gain", type: "number", default: .123456789, min: 0, max: 1, step: .0001 },
        { id: "enabled", name: "Enabled", type: "boolean", default: true },
        { id: "title", name: "Title", type: "string", default: "Default", maxLength: 12 },
        { id: "mode", name: "Mode", type: "enum", default: "soft", options: [{ value: "soft", label: "Soft" }, { value: "hard", label: "Hard" }] },
        { id: "tint", name: "Tint", type: "color", default: "#ABCDEF7F" },
        { id: "unbounded", name: "Unbounded", type: "number", default: 4 },
      ] }] }] };
  return { instance, registry };
}
type Event = { currentTarget: { value?: string; valueAsNumber?: number; checked?: boolean; blur?: () => void }; key?: string; preventDefault?: () => void;
  nativeEvent?: { isComposing?: boolean; keyCode?: number } };
type Control = ReactElement<{ children?: ReactNode; type?: string; "aria-label"?: string; value?: unknown; defaultValue?: unknown; maxLength?: number;
  onChange?: (event: Event) => void; onBlur?: (event: Event) => void; onKeyDown?: (event: Event) => void; onClick?: () => void }>;
function elements(node: ReactNode, found: Control[] = []): Control[] {
  if (Array.isArray(node)) node.forEach(child => elements(child, found));
  else if (isValidElement<Control["props"]>(node)) { found.push(node); elements(node.props.children, found); }
  return found;
}
function control(node: ReactNode, name: string, type: string): Control {
  const matches = elements(node).filter(node => node.props["aria-label"] === name && (node.props.type ?? node.type) === type);
  assert.equal(matches.length, 1, `${name}/${type}`); return matches[0];
}

describe("selected effect parameters through canonical owners", () => {
  it("shows omitted defaults and retains saved false,zero,empty and unknown values without mutating the project", () => {
    const { instance, registry } = effectParameterFixtureV1(), before = JSON.stringify({ instance, registry });
    const view = nativeEffectParameterViewV1(instance, registry);
    assert.equal(view.matched, true); assert.equal(view.rows.length, 7);
    assert.deepEqual(view.rows.map(row => [row.id, row.value]), [["gain", 0], ["enabled", false], ["title", ""], ["mode", "soft"], ["tint", "#ABCDEF7F"], ["unbounded", 4], ["legacy_saved", "Keep"]]);
    renderToStaticMarkup(<NativeEffectParameterControlsV1 instance={instance} registry={registry} scopeKey="session:clip" onChange={() => assert.fail("render must not dispatch")} />);
    assert.equal(JSON.stringify({ instance, registry }), before);
  });
  it("does not borrow definitions/defaults from a different plugin,capability,version,hash,runtime or kind", () => {
    const changes: Array<(registry: PluginRegistrySummary) => void> = [
      registry => { registry.plugins[0].id = "other.plugin"; }, registry => { registry.plugins[0].version = "2.0.0"; },
      registry => { registry.plugins[0].manifestSha256 = "b".repeat(64); }, registry => { registry.plugins[0].capabilities[0].id = "other"; },
      registry => { registry.plugins[0].capabilities[0].runtimeType = "native_effect"; }, registry => { registry.plugins[0].capabilities[0].kind = "analysis"; },
    ];
    for (const change of changes) {
      const { instance, registry } = effectParameterFixtureV1(); change(registry);
      const view = nativeEffectParameterViewV1(instance, registry);
      assert.equal(view.matched, false); assert.equal(view.defaults, undefined);
      assert.deepEqual(view.rows.map(row => row.id), Object.keys(instance.parameters));
      assert.equal(nativeEffectParameterResetV1(instance, view), undefined);
    }
  });
  it("uses the original GPU-module runtime normalization and refuses malformed or duplicated defaults", () => {
    const { instance, registry } = effectParameterFixtureV1(); registry.plugins[0].capabilities[0].runtimeType = "gpu_effect_module";
    assert(nativeEffectParameterViewV1(instance, registry).matched);
    const params = registry.plugins[0].capabilities[0].parameters;
    params.push(structuredClone(params[0])); assert.equal(nativeEffectParameterViewV1(instance, registry).matched, false); params.pop();
    Object.assign(params[0], { default: 2 }); assert.equal(nativeEffectParameterViewV1(instance, registry).matched, false);
  });
  it("executes real number,boolean,enum,string,color and unbounded control callbacks through history,JSON,Undo/Redo", () => {
    const { instance, registry } = effectParameterFixtureV1();
    let initial = createHistory(createDemoProject()); initial = dispatchCommand(initial, { type: "add_native_effect", clipId: "clip-demo", instance });
    initial = dispatchCommand(initial, { type: "add_native_effect", clipId: "clip-demo", instance: { ...structuredClone(instance), id: "neighbor" } });
    const choices: Array<[string, string, Event, string, unknown]> = [
      ["Gain", "number", { currentTarget: { valueAsNumber: .876543219 } }, "gain", .876543219],
      ["Enabled", "checkbox", { currentTarget: { checked: true } }, "enabled", true],
      ["Mode", "select", { currentTarget: { value: "hard" } }, "mode", "hard"],
      ["Title", "text", { currentTarget: { value: "Updated" } }, "title", "Updated"],
      ["Tint", "color", { currentTarget: { value: "#123456" } }, "tint", "#1234567F"],
      ["Unbounded", "number", { currentTarget: { valueAsNumber: -2.123456789 } }, "unbounded", -2.123456789],
    ];
    for (const [name, type, event, key, expected] of choices) {
      let history = initial;
      const tree = renderNativeEffectParameterControlsV1({ instance, registry, scopeKey: "session:clip", onChange: parameters => {
        history = dispatchCommand(history, { type: "update_native_effect", clipId: "clip-demo", instanceId: instance.id, patch: { parameters } });
      } });
      const input = control(tree, name, type);
      (type === "number" ? input.props.onBlur : input.props.onChange)!(event);
      const effects = history.present.tracks[0].clips[0].creative!.nativeEffectInstances!;
      assert.equal(effects[0].parameters[key], expected); assert.equal(effects[0].parameters.legacy_saved, "Keep");
      assert.deepEqual(effects[1], { ...instance, id: "neighbor" });
      for (const identity of ["id", "pluginId", "capabilityId", "pluginVersion", "manifestSha256", "runtimeType", "enabled"] as const) assert.equal(effects[0][identity], instance[identity]);
      assert.deepEqual(projectSchema.parse(JSON.parse(JSON.stringify(history.present))), history.present);
      assert.deepEqual(undo(history).present, initial.present); assert.deepEqual(redo(undo(history)).present, history.present);
    }
  });
  it("validates actual invalid inputs without dispatching and keeps scalar precision", () => {
    const { instance, registry } = effectParameterFixtureV1(), view = nativeEffectParameterViewV1(instance, registry);
    const cases = { gain: [Number.NaN, Infinity, -1, 2, "0.5"], enabled: [1, "true"], title: ["a".repeat(13), 1], mode: ["missing", 1], tint: ["#123", "not-a-color", 1] };
    for (const [id, bad] of Object.entries(cases)) for (const value of bad) assert.equal(nativeEffectParameterPatchV1(instance, view.rows.find(row => row.id === id)!, value), undefined, id);
    const tree = renderNativeEffectParameterControlsV1({ instance, registry, scopeKey: "s:c", onChange: () => assert.fail("invalid value dispatched") });
    control(tree, "Gain", "number").props.onBlur!({ currentTarget: { value: "-", valueAsNumber: Number.NaN } });
    control(tree, "Mode", "select").props.onChange!({ currentTarget: { value: "bad" } });
    const precise = { ...instance, parameters: { ...instance.parameters, gain: .123456789 } };
    const rendered = renderNativeEffectParameterControlsV1({ instance: precise, registry, scopeKey: "s:c", onChange: () => {} });
    assert.equal(control(rendered, "Gain", "number").props.defaultValue, .123456789);
  });
  it("keeps partial numeric text as a draft and commits a completed negative decimal only on blur", () => {
    const { instance, registry } = effectParameterFixtureV1(), changes: Array<NativeEffectInstance["parameters"]> = [];
    const tree = renderNativeEffectParameterControlsV1({ instance, registry, scopeKey: "s:c", onChange: parameters => changes.push(parameters) });
    const input = control(tree, "Unbounded", "number");
    assert.equal(input.props.value, undefined); assert.equal(input.props.defaultValue, 4); assert.equal(input.props.onChange, undefined);
    const node = { value: "", valueAsNumber: Number.NaN };
    // The field has no onChange (asserted above): partial text stays in the DOM draft until blur.
    for (const value of ["", "-", "-2", "-2.", "-2.125"]) { node.value = value; node.valueAsNumber = value === "" ? Number.NaN : Number(value); }
    assert.equal(changes.length, 0); input.props.onBlur!({ currentTarget: node });
    assert.equal(changes.length, 1); assert.equal(changes[0].unbounded, -2.125); assert.equal(changes[0].legacy_saved, "Keep");
  });
  it("uses Enter to commit a number once and Escape to cancel without submitting a form", () => {
    const { instance, registry } = effectParameterFixtureV1(), changes: Array<NativeEffectInstance["parameters"]> = [];
    const tree = renderNativeEffectParameterControlsV1({ instance, registry, scopeKey: "s:c", onChange: parameters => changes.push(parameters) });
    const input = control(tree, "Gain", "number"); let blurs = 0, prevented = 0;
    const node = { value: ".5", valueAsNumber: .5, blur() { blurs++; node.valueAsNumber = node.value === "" ? Number.NaN : Number(node.value); input.props.onBlur!({ currentTarget: node }); } };
    input.props.onKeyDown!({ key: "Escape", currentTarget: node, preventDefault() { prevented++; } });
    assert.equal(node.value, "0"); assert.equal(changes.length, 0); assert.equal(blurs, 1); assert.equal(prevented, 1);
    node.value = ".125"; node.valueAsNumber = .125;
    input.props.onKeyDown!({ key: "Enter", currentTarget: node, preventDefault() { prevented++; } });
    assert.equal(changes.length, 1); assert.equal(changes[0].gain, .125); assert.equal(blurs, 2); assert.equal(prevented, 2);
    input.props.onKeyDown!({ key: "ArrowUp", currentTarget: node, preventDefault() { prevented++; } });
    assert.equal(blurs, 2); assert.equal(prevented, 2);
  });
  it("leaves composition Enter and Escape to the IME without blurring,cancelling or committing", () => {
    const { instance, registry } = effectParameterFixtureV1();
    const tree = renderNativeEffectParameterControlsV1({ instance, registry, scopeKey: "s:c", onChange: () => assert.fail("IME must not commit") });
    const input = control(tree, "Gain", "number");
    for (const event of [{ key: "Enter", isComposing: true, keyCode: 13 }, { key: "Escape", isComposing: true, keyCode: 27 }, { key: "Enter", isComposing: false, keyCode: 229 }]) {
      const node = { value: ".125", valueAsNumber: .125, blur: () => assert.fail("IME must not blur") };
      input.props.onKeyDown!({ key: event.key, nativeEvent: { isComposing: event.isComposing, keyCode: event.keyCode }, currentTarget: node, preventDefault: () => assert.fail("IME owns this key") });
      assert.equal(node.value, ".125");
    }
  });
  it("restores invalid or refused number drafts without a whole-record fallback", () => {
    const { instance, registry } = effectParameterFixtureV1(), edits: unknown[] = [];
    const tree = renderNativeEffectParameterControlsV1({ instance, registry, scopeKey: "s:c", onEdit: value => { edits.push(value); return false; }, onChange: () => assert.fail("no fallback") });
    const input = control(tree, "Gain", "number");
    for (const number of [Number.NaN, Infinity, -1, 2]) { const node = { value: String(number), valueAsNumber: number }; input.props.onBlur!({ currentTarget: node }); assert.equal(node.value, "0"); }
    assert.equal(edits.length, 0);
    const refused = { value: ".75", valueAsNumber: .75 }; input.props.onBlur!({ currentTarget: refused });
    assert.equal(refused.value, "0"); assert.deepEqual(edits, [{ gain: .75 }]);
  });
  it("keys numeric drafts to the current saved value and selection scope", () => {
    const { instance, registry } = effectParameterFixtureV1();
    const make = (current: NativeEffectInstance, scopeKey: string) => control(renderNativeEffectParameterControlsV1({ instance: current, registry, scopeKey, onChange: () => {} }), "Gain", "number");
    const first = make(instance, "session:clip");
    assert.notEqual(make({ ...instance, parameters: { ...instance.parameters, gain: .75 } }, "session:clip").key, first.key);
    assert.notEqual(make(instance, "new-session:clip").key, first.key);
    assert.equal(make(instance, "session:clip").key, first.key);
  });
  it("allows partial RGBA text drafts,commits once at blur,and preserves or cancels complete codes", () => {
    const { instance, registry } = effectParameterFixtureV1(), changes: Array<NativeEffectInstance["parameters"]> = [];
    const tree = renderNativeEffectParameterControlsV1({ instance, registry, scopeKey: "session:clip", onChange: value => changes.push(value) });
    const input = elements(tree).find(node => node.type === "input" && node.props.defaultValue === "#ABCDEF7F")!;
    assert(input); assert.equal(input.props.onChange, undefined); assert.equal(changes.length, 0);
    const invalid = { currentTarget: { value: "#12" } }; input.props.onBlur!(invalid); assert.equal(invalid.currentTarget.value, "#ABCDEF7F"); assert.equal(changes.length, 0);
    input.props.onBlur!({ currentTarget: { value: "#10203040" } }); assert.equal(changes.length, 1); assert.equal(changes[0].tint, "#10203040");
    let blurs = 0; const cancel = { key: "Escape", currentTarget: { value: "#1", blur: () => { blurs++; } } }; input.props.onKeyDown!(cancel);
    assert.equal(cancel.currentTarget.value, "#ABCDEF7F"); assert.equal(blurs, 1);
    input.props.onKeyDown!({ key: "Enter", currentTarget: { blur: () => { blurs++; } } }); assert.equal(blurs, 2); assert.equal(changes.length, 1);
  });
  it("restores only matching defaults for the selected instance and preserves unknown saved keys", () => {
    const { instance, registry } = effectParameterFixtureV1(), before = JSON.stringify(instance), view = nativeEffectParameterViewV1(instance, registry);
    const reset = nativeEffectParameterResetV1(instance, view)!;
    assert.equal(reset.gain, .123456789); assert.equal(reset.enabled, true); assert.equal(reset.title, "Default"); assert.equal(reset.legacy_saved, "Keep");
    assert.equal(JSON.stringify(instance), before);
    const tree = renderNativeEffectParameterControlsV1({ instance, registry, scopeKey: "s:c", onChange: parameters => assert.deepEqual(parameters, reset) });
    const resetButton = elements(tree).find(node => node.type === "button")!; assert(resetButton); resetButton.props.onClick!();
  });
  it("uses original builtin motion-blur identity and validation,including integer samples and fractional shutter angles", () => {
    const instance = createTransformMotionBlurInstance(), view = nativeEffectParameterViewV1(instance);
    assert(view.matched); assert.equal(view.rows.length, 2);
    const samples = view.rows.find(row => row.id === "samples")!, shutter = view.rows.find(row => row.id === "shutter_angle")!;
    assert.equal(nativeEffectParameterPatchV1(instance, samples, 3.5), undefined); assert.equal(nativeEffectParameterPatchV1(instance, samples, 9), undefined);
    assert.equal(nativeEffectParameterPatchV1(instance, shutter, 0), undefined); assert.equal(nativeEffectParameterPatchV1(instance, shutter, .5)!.shutter_angle, .5);
    assert.equal(nativeEffectParameterViewV1({ ...instance, manifestSha256: "b".repeat(64) }).matched, false);
  });
  it("renders the real five parameter types and correct nonmatching-version fallback in all five locales", async () => {
    const { instance, registry } = effectParameterFixtureV1();
    try { for (const locale of ["zh-TW", "en", "es", "ja", "ko"] as const) {
      await interfacePreferences.setLocale(locale);
      const html = renderToStaticMarkup(<NativeEffectParameterControlsV1 instance={instance} registry={registry} scopeKey="session:clip" onChange={() => {}} />);
      for (const type of ["number", "range", "checkbox", "text", "color"]) assert(html.includes(`type="${type}"`), `${locale}/${type}`);
      assert(html.includes("<select")); assert(html.includes("#ABCDEF7F")); assert(!html.includes("{name}"));
      const fallback = renderToStaticMarkup(<NativeEffectParameterControlsV1 instance={instance} scopeKey="s:c" onChange={() => {}} />);
      assert(!fallback.includes("<select")); assert(!fallback.includes('type="color"')); assert(!fallback.includes("<button"));
    } } finally { await interfacePreferences.setLocale("zh-TW"); }
  });
});
