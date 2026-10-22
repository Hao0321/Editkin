import assert from "node:assert/strict";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createDemoProject } from "../domain/demo";
import { applyCommand } from "../domain/commands";
import { dispatchCommandSafely, undo, redo } from "../domain/history";
import { projectSchema } from "../domain/schema";
import type { EditorCommand } from "../domain/commandTypes";
import { createProjectSession } from "../application/projectSession";
import { createClipPresetEffectEditActionsV1, presetEffectOrderPatchV1, type PresetEffectEditV1 } from "../application/clipPresetEffectEditsV1";
import { AppliedPresetEffectStackV1, renderAppliedPresetEffectStackV1, submitPresetEffectEditV1 } from "./AppliedPresetEffectStackV1";
import { interfacePreferences } from "./i18n/interfacePreferences";
import { EFFECT_PRESETS, previewEffectFilter } from "../creative/corePack";
import { effectFilters } from "../render/creativeFilters";
import { buildEngineRenderGraph } from "../render/engineGraph";
import { commonVideoEffectStackSupported } from "../render/gpuCompositorAdmission";

export function presetEffectEditFixtureV1(ids = ["high_key_bloom", "mono_halftone", "film_grain_soft"]) {
  const base = createDemoProject();
  base.tracks[0].clips.push({ ...structuredClone(base.tracks[0].clips[0]), id: "neighbor", timelineStart: 12 });
  const project = applyCommand(base, { type: "set_clip_creative", clipId: "clip-demo", patch: { effectPresetIds: [...ids] } });
  const session = createProjectSession(project), commands: EditorCommand[] = [], statuses: string[] = [];
  const runCommand = (command: EditorCommand, message?: string) => {
    commands.push(command);
    const result = dispatchCommandSafely(session.getSnapshot().history, command, `preset-control-${commands.length}`);
    session.setHistory(result.state); statuses.push(result.error ?? message ?? ""); return !result.error;
  };
  const actions = createClipPresetEffectEditActionsV1({ getSnapshot: session.getSnapshot, runCommand, setStatus: message => statuses.push(message) });
  const scope = { sessionId: session.getSnapshot().sessionId, projectId: project.id, clipId: "clip-demo" };
  const clip = () => session.getSnapshot().history.present.tracks[0].clips.find(item => item.id === "clip-demo")!;
  const current = () => clip().creative!.effectPresetIds;
  return { project, session, scope, actions, runCommand, commands, statuses, current, clip };
}
type Node = ReactElement<{ children?: ReactNode; disabled?: boolean; onClick?: () => void; "data-effect-id"?: string; "aria-label"?: string }>;
function nodes(node: ReactNode, output: Node[] = []): Node[] {
  if (Array.isArray(node)) node.forEach(child => nodes(child, output));
  else if (isValidElement<Node["props"]>(node)) { output.push(node); nodes(node.props.children, output); }
  return output;
}
function view(f: ReturnType<typeof presetEffectEditFixtureV1>, disabled = false, fallback = () => assert.fail("Production owner must handle the intent")) {
  return renderAppliedPresetEffectStackV1({ effectIds: f.current(), disabled, onEdit: (expected, edit) => f.actions.apply(f.scope, expected, edit), onChange: fallback });
}
function rowButtons(tree: ReactNode, effectId: string) {
  const row = nodes(tree).find(node => node.props["data-effect-id"] === effectId)!;
  return nodes(row).filter(node => node.type === "button");
}

describe("applied preset effect stack and current project owner", () => {
  it("moves the actual saved effect order as one canonical history step with exact schema and Undo/Redo", () => {
    const f = presetEffectEditFixtureV1(), expected = f.current(), before = f.session.getSnapshot().history;
    assert(f.actions.apply(f.scope, expected, { type: "move", effectId: expected[2], direction: "earlier" }));
    const after = f.session.getSnapshot().history;
    assert.deepEqual(f.current(), [expected[0], expected[2], expected[1]]);
    assert.equal(after.past.length, before.past.length + 1); assert.equal(f.commands.length, 1);
    assert.deepEqual(after.present.tracks[0].clips[1], before.present.tracks[0].clips[1]);
    assert.deepEqual(projectSchema.parse(JSON.parse(JSON.stringify(after.present))), after.present);
    assert.deepEqual(undo(after).present, before.present); assert.deepEqual(redo(undo(after)).present, after.present);
    assert.deepEqual(expected, ["high_key_bloom", "mono_halftone", "film_grain_soft"]);
  });
  it("adds at the tail and removes only the requested effect through the original command", () => {
    const f = presetEffectEditFixtureV1(), added = EFFECT_PRESETS.find(preset => !f.current().includes(preset.id))!.id;
    assert(f.actions.apply(f.scope, f.current(), { type: "add", effectId: added }));
    assert.deepEqual(f.current(), ["high_key_bloom", "mono_halftone", "film_grain_soft", added]);
    assert(f.actions.apply(f.scope, f.current(), { type: "remove", effectId: "mono_halftone" }));
    assert.deepEqual(f.current(), ["high_key_bloom", "film_grain_soft", added]); assert.equal(f.commands.length, 2);
  });
  it("keeps newer look,transition and native effect data when editing only the preset order", () => {
    const f = presetEffectEditFixtureV1(), expected = f.current();
    assert(f.runCommand({ type: "set_clip_creative", clipId: f.scope.clipId, patch: { lookPresetId: "clean_neutral", transitionOut: { presetId: "luma_fade", duration: .5 } } }));
    assert(f.runCommand({ type: "add_native_effect", clipId: f.scope.clipId, instance: { id: "native-neighbor", pluginId: "editkin.source-control", capabilityId: "test", pluginVersion: "1.0.0",
      manifestSha256: "c".repeat(64), enabled: true, runtimeType: "native_effect", parameters: { gain: .7 } } }));
    const current = structuredClone(f.clip().creative!);
    assert(f.actions.apply(f.scope, expected, { type: "move", effectId: expected[1], direction: "earlier" }));
    assert.deepEqual(f.clip().creative, { ...current, effectPresetIds: [expected[1], expected[0], expected[2]] });
  });
  it("refuses a stale saved-order callback after another edit or insertion without a replacement write", () => {
    for (const insertion of [false, true]) {
      const f = presetEffectEditFixtureV1(), expected = f.current();
      const next = insertion ? [...expected, EFFECT_PRESETS.find(preset => !expected.includes(preset.id))!.id] : [...expected].reverse();
      f.runCommand({ type: "set_clip_creative", clipId: f.scope.clipId, patch: { effectPresetIds: next } });
      const before = f.session.getSnapshot(), count = f.commands.length;
      assert.equal(f.actions.apply(f.scope, expected, { type: "remove", effectId: expected[0] }), false);
      assert.equal(f.session.getSnapshot(), before); assert.equal(f.commands.length, count); assert.deepEqual(f.current(), next);
    }
  });
  it("refuses a reloaded same-ID project,wrong scope and deleted target", () => {
    const f = presetEffectEditFixtureV1(), expected = f.current();
    f.session.replaceProject(structuredClone(f.session.getSnapshot().history.present));
    const before = f.session.getSnapshot();
    assert.equal(f.actions.apply(f.scope, expected, { type: "remove", effectId: expected[0] }), false); assert.equal(f.session.getSnapshot(), before);
    const currentScope = { ...f.scope, sessionId: before.sessionId };
    assert.equal(f.actions.apply({ ...currentScope, projectId: "other-project" }, expected, { type: "remove", effectId: expected[0] }), false);
    f.runCommand({ type: "delete_clip", clipId: f.scope.clipId });
    const deleted = f.session.getSnapshot(), count = f.commands.length;
    assert.equal(f.actions.apply(currentScope, expected, { type: "remove", effectId: expected[0] }), false);
    assert.equal(f.session.getSnapshot(), deleted); assert.equal(f.commands.length, count);
  });
  it("preserves the canonical current-track lock refusal", () => {
    const f = presetEffectEditFixtureV1(), expected = f.current(); f.runCommand({ type: "toggle_track_lock", trackId: f.clip().trackId });
    const before = f.session.getSnapshot();
    assert.equal(f.actions.apply(f.scope, expected, { type: "move", effectId: expected[1], direction: "earlier" }), false);
    assert.equal(f.session.getSnapshot(), before); assert.deepEqual(f.current(), expected);
  });
  it("accepts boundary/duplicate no-ops without history and refuses invalid IDs,directions and original capacity overflow", () => {
    const f = presetEffectEditFixtureV1(), expected = f.current(), before = f.session.getSnapshot();
    assert(f.actions.apply(f.scope, expected, { type: "move", effectId: expected[0], direction: "earlier" }));
    assert(f.actions.apply(f.scope, expected, { type: "move", effectId: expected[2], direction: "later" }));
    assert(f.actions.apply(f.scope, expected, { type: "add", effectId: expected[0] }));
    assert.equal(f.session.getSnapshot(), before); assert.equal(f.commands.length, 0); assert.equal(before.dirty, false);
    for (const edit of [{ type: "add", effectId: "not-a-preset" }, { type: "remove", effectId: "not-selected" }, { type: "move", effectId: expected[0], direction: "sideways" }]) {
      assert.equal(f.actions.apply(f.scope, expected, edit as PresetEffectEditV1), false); assert.equal(f.session.getSnapshot(), before);
    }
    const added = EFFECT_PRESETS.find(preset => !expected.includes(preset.id))!.id;
    assert(f.actions.apply(f.scope, expected, { type: "add", effectId: added }));
    const full = f.session.getSnapshot(), extra = EFFECT_PRESETS.find(preset => !f.current().includes(preset.id))!.id, count = f.commands.length;
    assert.equal(f.actions.apply(f.scope, f.current(), { type: "add", effectId: extra }), false);
    assert.equal(f.session.getSnapshot(), full); assert.equal(f.commands.length, count); assert.equal(f.current().length, 4);
  });
  it("actual applied-row buttons move both ways and remove in the displayed saved order", () => {
    const f = presetEffectEditFixtureV1(), original = [...f.current()], before = f.session.getSnapshot().history;
    assert.deepEqual(nodes(view(f)).filter(node => node.props["data-effect-id"]).map(node => node.props["data-effect-id"]), original);
    assert.equal(rowButtons(view(f), original[0])[0].props.disabled, true);
    assert.equal(rowButtons(view(f), original[2])[1].props.disabled, true);
    rowButtons(view(f), original[1])[0].props.onClick!(); assert.deepEqual(f.current(), [original[1], original[0], original[2]]);
    rowButtons(view(f), original[1])[1].props.onClick!(); assert.deepEqual(f.current(), original);
    rowButtons(view(f), original[1])[2].props.onClick!(); assert.deepEqual(f.current(), [original[0], original[2]]);
    assert.equal(f.commands.length, 3); assert.deepEqual(undo(undo(undo(f.session.getSnapshot().history))).present, before.present);
  });
  it("old displayed stack callbacks refuse stale order without fallback and locked controls cannot dispatch", () => {
    const f = presetEffectEditFixtureV1(), oldTree = view(f), expected = [...f.current()];
    f.runCommand({ type: "set_clip_creative", clipId: f.scope.clipId, patch: { effectPresetIds: [...expected].reverse() } });
    const before = f.session.getSnapshot(), count = f.commands.length;
    rowButtons(oldTree, expected[1])[2].props.onClick!(); assert.equal(f.session.getSnapshot(), before); assert.equal(f.commands.length, count);
    const disabled = view(f, true);
    for (const button of nodes(disabled).filter(node => node.type === "button")) { assert.equal(button.props.disabled, true); button.props.onClick!(); }
    assert.equal(f.commands.length, count);
  });
  it("one shared submit port has explicit legacy fallback and never downgrades an owner refusal", () => {
    const ids = ["high_key_bloom", "mono_halftone"], patches: { effectPresetIds: string[] }[] = [];
    assert(submitPresetEffectEditV1(ids, { type: "move", effectId: ids[1], direction: "earlier" }, undefined, patch => patches.push(patch)));
    assert.deepEqual(patches, [{ effectPresetIds: [ids[1], ids[0]] }]); assert.deepEqual(ids, ["high_key_bloom", "mono_halftone"]);
    assert.equal(submitPresetEffectEditV1(ids, { type: "remove", effectId: ids[0] }, () => false, () => assert.fail("Refusal must not fall back")), false);
    assert.equal(presetEffectOrderPatchV1(ids, { type: "move", effectId: "missing", direction: "earlier" }), undefined);
  });
  it("all six saved three-effect permutations reach actual ordered CSS/formal-filter and DAG source consumers", () => {
    const ids = ["high_key_bloom", "mono_halftone", "film_grain_soft"], filters = new Set<string>(), css = new Set<string>(), dags = new Set<string>();
    for (const first of ids) for (const second of ids.filter(id => id !== first)) {
      const order = [first, second, ids.find(id => id !== first && id !== second)!], f = presetEffectEditFixtureV1([]);
      for (const effectId of order) assert(f.actions.apply(f.scope, f.current(), { type: "add", effectId }));
      const clip = f.clip(), graph = buildEngineRenderGraph(f.session.getSnapshot().history.present);
      const effects = graph.nodes.filter(node => node.kind === "effect" && node.id.startsWith("effect:clip-demo:"));
      assert.deepEqual(effects.map(node => node.kind === "effect" ? node.pluginId : ""), order.map(id => `editkin.builtin.${id}`));
      for (let i = 1; i < effects.length; i++) assert.deepEqual(effects[i].inputs, [effects[i - 1].id]);
      const filter = effectFilters(clip), style = previewEffectFilter([...f.current()]);
      assert.deepEqual(filter, order.flatMap(id => effectFilters({ ...clip, creative: { effectPresetIds: [id] } })));
      assert.equal(style, order.map(id => previewEffectFilter([id])).join(" "));
      filters.add(JSON.stringify(filter)); css.add(style); dags.add(JSON.stringify(effects.map(node => ({ id: node.id, inputs: node.inputs }))));
    }
    assert.equal(filters.size, 6); assert.equal(css.size, 6); assert.equal(dags.size, 6);
    assert.equal(commonVideoEffectStackSupported(["mono_halftone", "xerox_pulse"], 0), false);
    assert.equal(commonVideoEffectStackSupported(["mono_halftone"], 0), true);
  });
  it("actual React SSR renders applied order and accessible controls in all five locales without dispatching", async () => {
    const effectIds = ["high_key_bloom", "mono_halftone", "film_grain_soft"];
    try { for (const locale of ["zh-TW", "en", "es", "ja", "ko"] as const) {
      await interfacePreferences.setLocale(locale);
      const html = renderToStaticMarkup(<AppliedPresetEffectStackV1 effectIds={effectIds} onChange={() => assert.fail("Render must not dispatch")} />);
      assert(html.includes(interfacePreferences.translate("已套用的畫面特效")), locale);
      assert(html.includes(interfacePreferences.translate("由上往下依序執行")), locale);
      assert.deepEqual([...html.matchAll(/data-effect-id="([^"]+)"/g)].map(match => match[1]), effectIds);
      assert.equal((html.match(/<button /g) ?? []).length, 9); assert.equal((html.match(/disabled=""/g) ?? []).length, 2);
      assert.equal(renderToStaticMarkup(<AppliedPresetEffectStackV1 effectIds={[]} onChange={() => assert.fail("Render must not dispatch")} />), "");
    } } finally { await interfacePreferences.setLocale("zh-TW"); }
  });
});
