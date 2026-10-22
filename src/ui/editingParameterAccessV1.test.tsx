import assert from "node:assert/strict";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { applyCommand } from "../domain/commands";
import { createHistory, dispatchCommand, dispatchCommandSafely, undo, redo } from "../domain/history";
import { projectSchema } from "../domain/schema";
import { editingLayerSelectionChangeV1, reconcileEditingGraphicSelectionV1 } from "./editingLayerSelectionV1";
import { renderScene25dCameraControlsV1, Scene25dCameraControlsV1 } from "./Scene25dCameraControlsV1";
import { interfacePreferences } from "./i18n/interfacePreferences";
import { NumberEditFieldV1, renderNumberEditFieldV1 } from "./NumberEditFieldV1";

type Target = { value: string; valueAsNumber: number };
type Control = ReactElement<{ children?: ReactNode; "data-testid"?: string; value?: number; defaultValue?: number;
  onChange?: (event: { currentTarget: Target }) => void; onBlur?: (event: { currentTarget: Target }) => void }>;
function inputs(node: ReactNode, found: Control[] = []): Control[] {
  if (Array.isArray(node)) node.forEach(child => inputs(child, found));
  else if (isValidElement<Control["props"]>(node)) {
    if (node.type === NumberEditFieldV1) return inputs(renderNumberEditFieldV1(node.props as Parameters<typeof renderNumberEditFieldV1>[0]), found);
    if (node.type === "input") found.push(node);
    inputs(node.props.children, found);
  }
  return found;
}
function enter(input: Control, value: number) {
  const event = { currentTarget: { value: String(value), valueAsNumber: value } };
  input.props.onChange!(event); input.props.onBlur!(event); return event.currentTarget;
}
function sceneProject() { return applyCommand(createDemoProject(), { type: "configure_scene_25d", enabled: true }); }

describe("selected-object parameter access through existing owners", () => {
  it("produces mutually exclusive clip, caption and session-scoped graphic selections", () => {
    assert.deepEqual(editingLayerSelectionChangeV1({ kind: "graphic", id: "g" }, 4), { graphic: { id: "g", sessionId: 4 }, workspace: "effects" });
    assert.deepEqual(editingLayerSelectionChangeV1({ kind: "caption", id: "c" }, 4), { captionId: "c", workspace: "edit" });
    assert.deepEqual(editingLayerSelectionChangeV1({ kind: "clip", id: "v" }, 4), { clipId: "v" });
  });
  it("retains the same graphic object only while its real session and exclusive selection remain current", () => {
    const selected = { id: "g", sessionId: 4 }, context = { sessionId: 4, exists: true };
    assert.equal(reconcileEditingGraphicSelectionV1(selected, context), selected);
    for (const changed of [{ ...context, sessionId: 5 }, { ...context, clipId: "v" }, { ...context, captionId: "c" }, { ...context, exists: false }]) {
      assert.equal(reconcileEditingGraphicSelectionV1(selected, changed), undefined);
    }
    const retired = reconcileEditingGraphicSelectionV1(selected, { ...context, exists: false });
    assert.equal(reconcileEditingGraphicSelectionV1(retired, context), undefined);
  });
  it("exposes every camera numeric field and commits each actual handler through canonical history and JSON restore", () => {
    const original = sceneProject(), before = JSON.stringify(original);
    const ids = ["position", "target", "up"].flatMap(key => ["X", "Y", "Z"].map(axis => `camera-${key}-${axis}`)).concat(["camera-fov", "camera-near", "camera-far"]);
    const initial = inputs(renderScene25dCameraControlsV1({ scene: original.scene25d!, onChange: () => {} }));
    assert.deepEqual(initial.map(input => input.props["data-testid"]), ids);
    for (const id of ids) {
      let history = createHistory(original);
      const tree = renderScene25dCameraControlsV1({ scene: original.scene25d!, onChange: settings => {
        history = dispatchCommand(history, { type: "set_scene_25d_settings", settings });
      } });
      const input = inputs(tree).find(input => input.props["data-testid"] === id)!;
      enter(input, input.props.defaultValue! + .25);
      assert.notDeepEqual(history.present.scene25d!.camera, original.scene25d!.camera, id);
      assert.deepEqual(history.present.scene25d!.ambientLight, original.scene25d!.ambientLight);
      assert.deepEqual(history.present.scene25d!.directionalLight, original.scene25d!.directionalLight);
      assert.deepEqual(history.present.scene25d!.depthOfField, original.scene25d!.depthOfField);
      assert.deepEqual(history.present.tracks, original.tracks);
      assert.deepEqual(history.present.scene25d!.camera.keyframes, original.scene25d!.camera.keyframes);
      assert.deepEqual(projectSchema.parse(JSON.parse(JSON.stringify(history.present))), history.present);
      assert.deepEqual(undo(history).present, original);
      assert.deepEqual(redo(undo(history)).present, history.present);
    }
    assert.equal(JSON.stringify(original), before);
  });
  it("ignores incomplete/nonfinite numeric input before any command dispatch", () => {
    const project = sceneProject(), changes: unknown[] = [];
    const tree = renderScene25dCameraControlsV1({ scene: project.scene25d!, onChange: scene => { changes.push(scene); } });
    for (const input of inputs(tree)) for (const value of [Number.NaN, Infinity, -Infinity]) enter(input, value);
    assert.deepEqual(changes, []);
  });
  it("retains canonical refusal of invalid camera/lens values without mutating the history", () => {
    const original = sceneProject(), state = JSON.stringify(original);
    for (const [id, value] of [["camera-fov", 0], ["camera-near", 0], ["camera-far", 0]] as const) {
      const history = createHistory(original);
      let refused = 0;
      const tree = renderScene25dCameraControlsV1({ scene: original.scene25d!, onChange: settings => {
        const result = dispatchCommandSafely(history, { type: "set_scene_25d_settings", settings });
        if (result.error) { refused++; return false; }
        throw Error("Invalid fixture unexpectedly accepted");
      } });
      const input = inputs(tree).find(input => input.props["data-testid"] === id)!;
      const target = enter(input, value);
      assert.equal(refused, 1); assert.equal(target.value, String(input.props.defaultValue));
      assert.equal(JSON.stringify(original), state);
    }
  });
  it("renders12actual numeric controls with translated labels in all five locales", async () => {
    const project = sceneProject();
    try {
      for (const locale of ["zh-TW", "en", "es", "ja", "ko"] as const) {
        await interfacePreferences.setLocale(locale);
        const html = renderToStaticMarkup(<Scene25dCameraControlsV1 scene={project.scene25d!} onChange={() => {}} />);
        assert.equal((html.match(/type="number"/g) ?? []).length, 12, locale);
        assert(!html.includes("{axis}"));
        if (locale === "en") { assert(html.includes("Camera position X")); assert(html.includes("Near clipping distance")); }
        if (locale !== "zh-TW") { assert(!html.includes("相機位置")); assert(!html.includes("遠裁切距離")); }
      }
    } finally { await interfacePreferences.setLocale("zh-TW"); }
  });
});
