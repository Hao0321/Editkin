import assert from "node:assert/strict";
import { isValidElement, type ReactNode, type ReactElement } from "react";
import { describe, it } from "vitest";
import type { NativeEffectInstance } from "../domain/types";
import type { EditorCommand } from "../domain/commandTypes";
import type { PluginRegistrySummary } from "../desktop/pluginTypes";
import { createDemoProject } from "../domain/demo";
import { applyCommand } from "../domain/commands";
import { dispatchCommandSafely, undo, redo } from "../domain/history";
import { projectSchema } from "../domain/schema";
import { createTransformMotionBlurInstance } from "../domain/transformMotionBlur";
import { createProjectSession } from "./projectSession";
import { createNativeEffectParameterEditActionsV1 } from "./nativeEffectParameterEditsV1";
import { nativeEffectParameterViewV1 } from "./nativeEffectParametersV1";
import { renderNativeEffectParameterControlsV1 } from "../ui/NativeEffectParameterControlsV1";

export function currentEffectEditFixtureV1() {
  const instance: NativeEffectInstance = { id: "selected", pluginId: "editkin.atomic-parameters", capabilityId: "adjust", pluginVersion: "1.0.0",
    manifestSha256: "c".repeat(64), runtimeType: "gpu_effect_graph", enabled: true, parameters: { gain: 0, mix: .5, legacy_saved: "Keep" } };
  const registry: PluginRegistrySummary = { schema: "editkin.plugin-registry/v1", diagnostics: [], plugins: [{ id: instance.pluginId, version: instance.pluginVersion,
    name: "Atomic parameter fixture", publisher: "Source controls only", manifestSha256: instance.manifestSha256, permissions: ["render.effect"], capabilities: [{
      id: instance.capabilityId, name: "Parameters", description: "Synthetic metadata, no native plugin", kind: "effect", automation: "manual", automationReady: false,
      planningReady: false, readiness: "RUNTIME_READY", readinessDetail: "Source fixture", semanticRoles: [], formats: [], requires: [], avoidWhen: [],
      runtimeType: "gpu_effect_graph", commandScopes: ["clip"], parameters: [
        { id: "gain", name: "Gain", type: "number", default: 0, min: 0, max: 1 },
        { id: "mix", name: "Mix", type: "number", default: .5, min: 0, max: 1 },
        { id: "tint", name: "Tint", type: "color", default: "#11223344" },
      ],
    }] }] };
  let project = applyCommand(createDemoProject(), { type: "add_native_effect", clipId: "clip-demo", instance });
  project = applyCommand(project, { type: "add_native_effect", clipId: "clip-demo", instance: { ...structuredClone(instance), id: "neighbor" } });
  const session = createProjectSession(project), status: string[] = [], commands: EditorCommand[] = [];
  const runCommand = (command: EditorCommand, message?: string) => {
    commands.push(command);
    const result = dispatchCommandSafely(session.getSnapshot().history, command, `control-${commands.length}`);
    session.setHistory(result.state); status.push(result.error ?? message ?? ""); return !result.error;
  };
  const actions = createNativeEffectParameterEditActionsV1({ getSnapshot: session.getSnapshot, getRegistry: () => registry, runCommand, setStatus: message => status.push(message) });
  const scope = { sessionId: session.getSnapshot().sessionId, projectId: project.id, clipId: "clip-demo" };
  const expected = session.getSnapshot().history.present.tracks[0].clips[0].creative!.nativeEffectInstances![0];
  const current = () => session.getSnapshot().history.present.tracks[0].clips[0].creative!.nativeEffectInstances!.find(effect => effect.id === expected.id)!;
  return { instance, registry, session, scope, expected, current, actions, runCommand, status, commands };
}
type Control = ReactElement<{ children?: ReactNode; type?: string; "aria-label"?: string; defaultValue?: unknown;
  onChange?: (event: { currentTarget: { valueAsNumber: number } }) => void; onBlur?: (event: { currentTarget: { value: string; valueAsNumber?: number } }) => void; onClick?: () => void }>;
function controls(node: ReactNode, result: Control[] = []): Control[] {
  if (Array.isArray(node)) node.forEach(child => controls(child, result));
  else if (isValidElement<Control["props"]>(node)) { result.push(node); controls(node.props.children, result); }
  return result;
}

describe("current-owner parameter edits with real project session and canonical history", () => {
  it("merges a single field into the latest other parameters,unknown values,enable state and effect order", () => {
    const f = currentEffectEditFixtureV1();
    f.runCommand({ type: "update_native_effect", clipId: "clip-demo", instanceId: f.expected.id,
      patch: { enabled: false, parameters: { ...f.expected.parameters, mix: .9, legacy_saved: "Newer", added_by_va: 42 } } });
    f.runCommand({ type: "reorder_native_effect", clipId: "clip-demo", instanceId: f.expected.id, toIndex: 1 });
    const before = f.session.getSnapshot().history;
    assert(f.actions.apply(f.scope, f.expected, { gain: .7 }));
    const after = f.session.getSnapshot().history, effects = after.present.tracks[0].clips[0].creative!.nativeEffectInstances!;
    assert.deepEqual(effects.map(effect => effect.id), ["neighbor", "selected"]);
    assert.equal(effects[1].enabled, false); assert.deepEqual(effects[1].parameters, { gain: .7, mix: .9, legacy_saved: "Newer", added_by_va: 42 });
    assert.deepEqual(effects[0], before.present.tracks[0].clips[0].creative!.nativeEffectInstances![0]);
    assert.equal(after.past.length, before.past.length + 1);
    assert.deepEqual(projectSchema.parse(JSON.parse(JSON.stringify(after.present))), after.present);
    assert.deepEqual(undo(after).present, before.present); assert.deepEqual(redo(undo(after)).present, after.present);
  });
  it("refuses a stale same-field edit without changing current history", () => {
    const f = currentEffectEditFixtureV1();
    f.runCommand({ type: "update_native_effect", clipId: "clip-demo", instanceId: f.expected.id, patch: { parameters: { ...f.expected.parameters, gain: .4 } } });
    const before = f.session.getSnapshot(), count = f.commands.length;
    assert.equal(f.actions.apply(f.scope, f.expected, { gain: .8 }), false);
    assert.equal(f.session.getSnapshot(), before); assert.equal(f.commands.length, count); assert.equal(f.current().parameters.gain, .4);
  });
  it("compares raw presence as well as values for omitted defaults and removed keys", () => {
    for (const added of [true, false]) {
      const f = currentEffectEditFixtureV1();
      const old = { ...f.expected, parameters: { ...f.expected.parameters } };
      if (added) {
        delete old.parameters.gain;
        f.runCommand({ type: "update_native_effect", clipId: "clip-demo", instanceId: old.id, patch: { parameters: old.parameters } });
        f.runCommand({ type: "update_native_effect", clipId: "clip-demo", instanceId: old.id, patch: { parameters: { ...old.parameters, gain: 0 } } });
      } else {
        const changed = { ...old.parameters }; delete changed.gain;
        f.runCommand({ type: "update_native_effect", clipId: "clip-demo", instanceId: old.id, patch: { parameters: changed } });
      }
      const before = f.session.getSnapshot(); assert.equal(f.actions.apply(f.scope, old, { gain: .6 }), false); assert.equal(f.session.getSnapshot(), before);
    }
  });
  it("refuses a reloaded same-ID project,wrong project scope and deleted effect", () => {
    const f = currentEffectEditFixtureV1();
    f.session.replaceProject(structuredClone(f.session.getSnapshot().history.present));
    const reloaded = f.session.getSnapshot(); assert.equal(f.actions.apply(f.scope, f.expected, { gain: .6 }), false); assert.equal(f.session.getSnapshot(), reloaded);
    const g = currentEffectEditFixtureV1(); assert.equal(g.actions.apply({ ...g.scope, projectId: "other" }, g.expected, { gain: .6 }), false);
    g.runCommand({ type: "remove_native_effect", clipId: "clip-demo", instanceId: g.expected.id });
    const missing = g.session.getSnapshot(); assert.equal(g.actions.apply(g.scope, g.expected, { gain: .6 }), false); assert.equal(g.session.getSnapshot(), missing);
  });
  it("refuses a replaced effect with changed plugin/capability/version/hash/runtime identity", () => {
    const changes: Array<Partial<NativeEffectInstance>> = [{ pluginId: "other.plugin" }, { capabilityId: "other" }, { pluginVersion: "2.0.0" },
      { manifestSha256: "d".repeat(64) }, { runtimeType: "native_effect" }];
    for (const patch of changes) {
      const f = currentEffectEditFixtureV1();
      assert(f.runCommand({ type: "batch", commands: [
        { type: "remove_native_effect", clipId: "clip-demo", instanceId: "selected" }, { type: "remove_native_effect", clipId: "clip-demo", instanceId: "neighbor" },
        { type: "add_native_effect", clipId: "clip-demo", instance: { ...structuredClone(f.expected), ...patch } },
      ] }));
      const before = f.session.getSnapshot(); assert.equal(f.actions.apply(f.scope, f.expected, { gain: .6 }), false); assert.equal(f.session.getSnapshot(), before);
    }
  });
  it("restores matching defaults as one edit while keeping current unknown keys and refuses a reset conflict", () => {
    const f = currentEffectEditFixtureV1();
    f.runCommand({ type: "update_native_effect", clipId: "clip-demo", instanceId: f.expected.id, patch: { parameters: { ...f.expected.parameters, gain: .3 } } });
    const expected = f.current(), defaults = nativeEffectParameterViewV1(expected, f.registry).defaults!;
    f.runCommand({ type: "update_native_effect", clipId: "clip-demo", instanceId: f.expected.id,
      patch: { enabled: false, parameters: { ...expected.parameters, legacy_saved: "Newer", added_by_va: true } } });
    const before = f.session.getSnapshot().history;
    assert(f.actions.apply(f.scope, expected, defaults));
    const after = f.session.getSnapshot().history; assert.equal(after.past.length, before.past.length + 1);
    assert.deepEqual(f.current().parameters, { ...f.expected.parameters, ...defaults, legacy_saved: "Newer", added_by_va: true }); assert.equal(f.current().enabled, false);
    assert.deepEqual(undo(after).present, before.present);
    const g = currentEffectEditFixtureV1();
    g.runCommand({ type: "update_native_effect", clipId: "clip-demo", instanceId: g.expected.id, patch: { parameters: { ...g.expected.parameters, mix: .9 } } });
    const changed = g.session.getSnapshot(); assert.equal(g.actions.apply(g.scope, g.expected, defaults), false); assert.equal(g.session.getSnapshot(), changed);
  });
  it("accepted no-op and invalid numeric/unknown/raw values never create history or dirty state", () => {
    const f = currentEffectEditFixtureV1(), before = f.session.getSnapshot();
    assert(f.actions.apply(f.scope, f.expected, { gain: 0 })); assert(f.actions.apply(f.scope, f.expected, {}));
    assert.equal(f.session.getSnapshot(), before); assert.equal(before.dirty, false); assert.equal(f.commands.length, 0);
    const invalid: NativeEffectInstance["parameters"][] = [{ gain: Number.NaN }, { gain: 2 }, { not_in_capability: 1 }, { gain: "bad" }, { gain: Infinity }];
    for (const values of invalid) {
      assert.equal(f.actions.apply(f.scope, f.expected, values), false); assert.equal(f.session.getSnapshot(), before); assert.equal(f.commands.length, 0);
    }
  });
  it("preserves canonical current-track lock refusal through the original command runner", () => {
    const f = currentEffectEditFixtureV1(); f.runCommand({ type: "toggle_track_lock", trackId: f.session.getSnapshot().history.present.tracks[0].id });
    const before = f.session.getSnapshot(); assert.equal(f.actions.apply(f.scope, f.expected, { gain: .6 }), false); assert.equal(f.session.getSnapshot(), before);
  });
  it("refuses a reentrant owner change between planning and canonical commit", () => {
    const f = currentEffectEditFixtureV1();
    const actions = createNativeEffectParameterEditActionsV1({ getSnapshot: f.session.getSnapshot, getRegistry: () => {
      f.runCommand({ type: "update_native_effect", clipId: "clip-demo", instanceId: f.expected.id, patch: { parameters: { ...f.expected.parameters, mix: .8 } } });
      return f.registry;
    }, runCommand: f.runCommand, setStatus: message => f.status.push(message) });
    assert.equal(actions.apply(f.scope, f.expected, { gain: .6 }), false); assert.equal(f.current().parameters.gain, 0); assert.equal(f.current().parameters.mix, .8); assert.equal(f.commands.length, 1);
  });
  it("retains original builtin integer/shutter validation for combined parameter intents", () => {
    const f = currentEffectEditFixtureV1(), builtin = createTransformMotionBlurInstance();
    f.runCommand({ type: "add_native_effect", clipId: "clip-demo", instance: builtin });
    const before = f.session.getSnapshot(); assert.equal(f.actions.apply(f.scope, builtin, { samples: 3.5 }), false); assert.equal(f.session.getSnapshot(), before);
    assert(f.actions.apply(f.scope, builtin, { samples: 4, shutter_angle: .5 }));
    const result = f.session.getSnapshot().history.present.tracks[0].clips[0].creative!.nativeEffectInstances!.find(effect => effect.id === builtin.id)!;
    assert.deepEqual(result.parameters, { samples: 4, shutter_angle: .5 });
  });
  it("production widget emits only changed keys or known reset defaults and never falls back on refusal", () => {
    const f = currentEffectEditFixtureV1(), intents: Array<NativeEffectInstance["parameters"]> = [];
    const instance = { ...f.expected, parameters: { ...f.expected.parameters, gain: .2 } };
    const tree = renderNativeEffectParameterControlsV1({ instance, registry: f.registry, scopeKey: "session:clip",
      onEdit: values => { intents.push(values); return false; }, onChange: () => assert.fail("refused intent must not use whole-record fallback") });
    const all = controls(tree);
    all.find(node => node.props.type === "number" && node.props["aria-label"] === "Gain")!.props.onBlur!({ currentTarget: { value: ".6", valueAsNumber: .6 } });
    assert.deepEqual(intents[0], { gain: .6 });
    const color = all.find(node => node.type === "input" && node.props.defaultValue === "#11223344")!;
    const event = { currentTarget: { value: "#AABBCCDD" } }; color.props.onBlur!(event); assert.equal(event.currentTarget.value, "#11223344");
    all.find(node => node.type === "button")!.props.onClick!(); assert.deepEqual(intents.at(-1), { gain: 0, mix: .5, tint: "#11223344" });
    assert.equal(Object.hasOwn(intents.at(-1)!, "legacy_saved"), false); assert.equal(f.commands.length, 0);
  });
  it("commits a completed numeric draft as one Undo while retaining newer unrelated parameters", () => {
    const f = currentEffectEditFixtureV1();
    const tree = renderNativeEffectParameterControlsV1({ instance: f.expected, registry: f.registry, scopeKey: "session:clip", onEdit: values => f.actions.apply(f.scope, f.expected, values), onChange: () => assert.fail("no fallback") });
    const input = controls(tree).find(node => node.props.type === "number" && node.props["aria-label"] === "Gain")!;
    for (const number of [Number.NaN, .1, .12, .125]) input.props.onChange?.({ currentTarget: { valueAsNumber: number } });
    assert.equal(f.commands.length, 0); assert.equal(f.session.getSnapshot().dirty, false);
    f.runCommand({ type: "update_native_effect", clipId: "clip-demo", instanceId: f.expected.id, patch: { parameters: { ...f.expected.parameters, mix: .9, added_by_va: 42 } } });
    const before = f.session.getSnapshot().history;
    input.props.onBlur!({ currentTarget: { value: ".125", valueAsNumber: .125 } });
    const after = f.session.getSnapshot().history;
    assert.equal(after.past.length, before.past.length + 1); assert.equal(f.commands.length, 2);
    assert.deepEqual(f.current().parameters, { gain: .125, mix: .9, legacy_saved: "Keep", added_by_va: 42 });
    assert.deepEqual(projectSchema.parse(JSON.parse(JSON.stringify(after.present))), after.present);
    assert.deepEqual(undo(after).present, before.present); assert.deepEqual(redo(undo(after)).present, after.present);
  });
});
