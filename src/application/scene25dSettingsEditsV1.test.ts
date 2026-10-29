import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { EditorCommand } from "../domain/commandTypes";
import type { Scene25dSettings } from "../domain/types";
import { createDemoProject } from "../domain/demo";
import { applyCommand } from "../domain/commands";
import { dispatchCommandSafely, undo, redo } from "../domain/history";
import { projectSchema } from "../domain/schema";
import { createProjectSession } from "./projectSession";
import { createScene25dSettingsEditActionsV1, SCENE_SETTINGS_EDIT_STALE_V1 } from "./scene25dSettingsEditsV1";

function changed(scene: Scene25dSettings, mutate: (scene: Scene25dSettings) => void): Scene25dSettings {
  const next = structuredClone(scene); mutate(next); return next;
}
function fixture() {
  const project = applyCommand(applyCommand(createDemoProject(), { type: "set_project_color_management", patch: { mode: "aces2" } }),
    { type: "configure_scene_25d", enabled: true });
  const session = createProjectSession(project), commands: EditorCommand[] = [], status: string[] = [];
  const runCommand = (command: EditorCommand) => {
    const result = dispatchCommandSafely(session.getSnapshot().history, command);
    if (result.error) { status.push(result.error); return false; }
    session.setHistory(result.state); commands.push(command); return true;
  };
  const scope = { sessionId: session.getSnapshot().sessionId, projectId: project.id }, expected = project.scene25d!;
  const actions = createScene25dSettingsEditActionsV1({ getSnapshot: session.getSnapshot, runCommand, setStatus: message => status.push(message) });
  const apply = (mutate: (scene: Scene25dSettings) => void) => actions.apply(scope, expected, changed(expected, mutate));
  return { project, session, commands, status, scope, expected, actions, apply, runCommand,
    current: () => session.getSnapshot().history.present.scene25d! };
}

describe("current-owner scene settings without stale full-record writes", () => {
  it("commits every supported base camera/lens/light field through one command, Undo/Redo and JSON restore", () => {
    const edits: Array<(scene: Scene25dSettings) => void> = [
      ...(["position", "target", "up"] as const).flatMap(key => [0, 1, 2].map(index => (s: Scene25dSettings) => { s.camera[key][index] += .25; })),
      s => { s.camera.verticalFovDegrees = 65; }, s => { s.camera.near = .2; }, s => { s.camera.far = 30; },
      s => { s.depthOfField.enabled = true; }, s => { s.depthOfField.focusDistance = 5; },
      s => { s.depthOfField.aperture = 4; }, s => { s.depthOfField.maxBlurRadius = 16; },
      s => { s.ambientLight.intensity = .4; }, s => { s.directionalLight.intensity = .5; },
      ...(["color", "direction"] as const).flatMap(key => [0, 1, 2].map(index => (s: Scene25dSettings) => { s.directionalLight[key][index] += .1; })),
    ];
    assert.equal(edits.length, 24);
    for (const edit of edits) {
      const f = fixture(), before = JSON.stringify(f.project), next = changed(f.expected, edit);
      assert(f.actions.apply(f.scope, f.expected, next));
      const history = f.session.getSnapshot().history;
      assert.equal(f.commands.length, 1); assert.equal(history.past.length, 1); assert.deepEqual(f.current(), next);
      assert.deepEqual(undo(history).present, f.project); assert.deepEqual(redo(undo(history)).present, history.present);
      assert.deepEqual(projectSchema.parse(JSON.parse(JSON.stringify(history.present))), history.present);
      assert.equal(JSON.stringify(f.project), before); assert.deepEqual(history.present.tracks, f.project.tracks);
    }
  });
  it("retains edits to all other scene groups from before the next render", () => {
    const f = fixture();
    assert(f.apply(s => { s.camera.verticalFovDegrees = 70; }));
    assert(f.apply(s => { s.depthOfField.aperture = 4; }));
    assert(f.apply(s => { s.ambientLight.intensity = .4; }));
    assert(f.apply(s => { s.directionalLight.color[0] = .8; }));
    assert.equal(f.current().camera.verticalFovDegrees, 70); assert.equal(f.current().depthOfField.aperture, 4);
    assert.equal(f.current().ambientLight.intensity, .4); assert.equal(f.current().directionalLight.color[0], .8);
    assert.equal(f.commands.length, 4);
  });
  it("merges numeric tuples per component rather than restoring stale axes", () => {
    for (const group of ["position", "target", "up"] as const) {
      const f = fixture(); assert(f.apply(s => { s.camera[group][0] += .1; })); assert(f.apply(s => { s.camera[group][1] += .2; }));
      assert.equal(f.current().camera[group][0], f.expected.camera[group][0] + .1);
      assert.equal(f.current().camera[group][1], f.expected.camera[group][1] + .2);
    }
    for (const group of ["color", "direction"] as const) {
      const f = fixture(); assert(f.apply(s => { s.directionalLight[group][0] += .1; })); assert(f.apply(s => { s.directionalLight[group][1] += .2; }));
      assert.equal(f.current().directionalLight[group][0], f.expected.directionalLight[group][0] + .1);
      assert.equal(f.current().directionalLight[group][1], f.expected.directionalLight[group][1] + .2);
    }
  });
  it("refuses a scalar conflict without changing the accepted state or history", () => {
    const f = fixture(); assert(f.apply(s => { s.camera.verticalFovDegrees = 70; })); const before = f.session.getSnapshot();
    assert.equal(f.apply(s => { s.camera.verticalFovDegrees = 80; }), false); assert.equal(f.session.getSnapshot(), before);
    assert.equal(f.commands.length, 1); assert.equal(f.status.at(-1), SCENE_SETTINGS_EDIT_STALE_V1);
  });
  it("refuses a tuple-axis conflict without applying other fields from the same edit", () => {
    const f = fixture(); assert(f.apply(s => { s.camera.position[0] = .1; })); const before = f.session.getSnapshot();
    assert.equal(f.apply(s => { s.camera.position[0] = .2; s.directionalLight.intensity = .5; }), false);
    assert.equal(f.session.getSnapshot(), before); assert.equal(f.commands.length, 1);
  });
  it("does not manufacture dirty state, a command or Undo entry for unchanged settings", () => {
    const f = fixture(), before = f.session.getSnapshot(); assert(f.actions.apply(f.scope, f.expected, structuredClone(f.expected)));
    assert.equal(f.session.getSnapshot(), before); assert.equal(f.commands.length, 0); assert.equal(before.dirty, false);
  });
  it("keeps a no-op against old settings from resetting newer unrelated fields", () => {
    const f = fixture(); assert(f.apply(s => { s.ambientLight.intensity = .5; })); const before = f.session.getSnapshot();
    assert(f.actions.apply(f.scope, f.expected, structuredClone(f.expected))); assert.equal(f.session.getSnapshot(), before);
  });
  it("rejects a reopened same-ID project and a wrong project scope", () => {
    const f = fixture(); f.session.replaceProject(structuredClone(f.project)); const before = f.session.getSnapshot();
    assert.equal(f.apply(s => { s.camera.verticalFovDegrees = 70; }), false); assert.equal(f.session.getSnapshot(), before);
    const g = fixture(); assert.equal(g.actions.apply({ ...g.scope, projectId: "other" }, g.expected, changed(g.expected, s => { s.camera.verticalFovDegrees = 70; })), false);
    assert.equal(g.commands.length, 0);
  });
  it("rejects edits after scene deactivation", () => {
    const f = fixture(); f.runCommand({ type: "configure_scene_25d", enabled: false }); const before = f.session.getSnapshot();
    assert.equal(f.apply(s => { s.camera.verticalFovDegrees = 70; }), false); assert.equal(f.session.getSnapshot(), before);
  });
  it("rejects a callback from before a disable/re-enable cycle even when scene values match again", () => {
    for (const batch of [false, true]) {
      const f = fixture();
      const commands: EditorCommand[] = [{ type: "configure_scene_25d", enabled: false }, { type: "configure_scene_25d", enabled: true }];
      if (batch) f.runCommand({ type: "batch", commands }); else commands.forEach(f.runCommand);
      assert.deepEqual(f.current(), f.expected); const before = f.session.getSnapshot();
      assert.equal(f.apply(s => { s.camera.verticalFovDegrees = 70; }), false); assert.equal(f.session.getSnapshot(), before);
    }
  });
  it("treats each authored keyframe list atomically while preserving unrelated live scalar edits", () => {
    const f = fixture(); assert(f.apply(s => { s.directionalLight.intensity = .5; }));
    assert(f.apply(s => { s.camera.keyframes = [{ id: "cam", time: 1, position: [0, 0, 4], target: [0, 0, 0], verticalFovDegrees: 65, easing: "linear" }]; }));
    assert.equal(f.current().directionalLight.intensity, .5); assert.equal(f.current().camera.keyframes.length, 1);
    const before = f.session.getSnapshot();
    assert.equal(f.apply(s => { s.camera.keyframes = [{ id: "different", time: 2, position: [0, 0, 4], target: [0, 0, 0], verticalFovDegrees: 75, easing: "linear" }]; s.ambientLight.intensity = .5; }), false);
    assert.equal(f.session.getSnapshot(), before);
  });
  it("retains all four independently authored keyframe lists without guessing list-index merges", () => {
    const f = fixture();
    assert(f.apply(s => { s.camera.keyframes = [{ id: "cam", time: 1, position: [0, 0, 4], target: [0, 0, 0], verticalFovDegrees: 65, easing: "linear" }]; }));
    assert(f.apply(s => { s.depthOfField.keyframes = [{ id: "lens", time: 1, focusDistance: 4, aperture: 4, maxBlurRadius: 12, easing: "linear" }]; }));
    assert(f.apply(s => { s.ambientLight.keyframes = [{ id: "ambient", time: 1, intensity: .5, easing: "linear" }]; }));
    assert(f.apply(s => { s.directionalLight.keyframes = [{ id: "directional", time: 1, color: [1, 1, 1], direction: [0, 0, 1], intensity: .5, easing: "linear" }]; }));
    for (const group of ["camera", "depthOfField", "ambientLight", "directionalLight"] as const) assert.equal(f.current()[group].keyframes.length, 1);
  });
  it("keeps canonical cross-field rejection when the live near plane changed", () => {
    const f = fixture(); assert(f.apply(s => { s.camera.near = 3; })); const before = f.session.getSnapshot();
    assert.equal(f.apply(s => { s.depthOfField.focusDistance = 2; }), false); assert.equal(f.session.getSnapshot(), before);
    assert.equal(f.commands.length, 1);
  });
  it("rejects malformed and nonfinite settings before dispatch", () => {
    const f = fixture(), before = f.session.getSnapshot();
    for (const value of [NaN, Infinity, -Infinity]) assert.equal(f.apply(s => { s.camera.position[0] = value; }), false);
    const malformed = changed(f.expected, () => {}); malformed.camera.position = [0, 0] as unknown as [number, number, number];
    assert.equal(f.actions.apply(f.scope, f.expected, malformed), false); assert.equal(f.session.getSnapshot(), before); assert.equal(f.commands.length, 0);
  });
  it("does not allow activation/deactivation to bypass the configure command", () => {
    const f = fixture(), before = f.session.getSnapshot(); assert.equal(f.apply(s => { s.enabled = false; }), false);
    assert.equal(f.session.getSnapshot(), before); assert.equal(f.commands.length, 0);
  });
  it("retains canonical invalid camera, lens and light refusal without partial history", () => {
    const mutations: Array<(scene: Scene25dSettings) => void> = [s => { s.camera.near = 0; }, s => { s.camera.far = .05; },
      s => { s.camera.verticalFovDegrees = 180; }, s => { s.depthOfField.aperture = 17; }, s => { s.directionalLight.direction = [0, 0, 0]; },
      s => { s.ambientLight.intensity = -.1; }, s => { s.camera.keyframes = [{ id: "late", time: 99, position: [0, 0, 4], target: [0, 0, 0], verticalFovDegrees: 65, easing: "linear" }]; }];
    for (const mutate of mutations) { const f = fixture(), before = f.session.getSnapshot(); assert.equal(f.apply(mutate), false); assert.equal(f.session.getSnapshot(), before); }
  });
  it("checks the live owner again immediately before dispatch", () => {
    const f = fixture(); let reads = 0, armed = false;
    const actions = createScene25dSettingsEditActionsV1({ getSnapshot: () => {
      if (armed && ++reads === 2) f.session.replaceProject(structuredClone(f.project)); return f.session.getSnapshot();
    }, runCommand: f.runCommand, setStatus: message => f.status.push(message) });
    armed = true;
    assert.equal(actions.apply(f.scope, f.expected, changed(f.expected, s => { s.camera.verticalFovDegrees = 70; })), false);
    assert.equal(f.commands.length, 0); assert.deepEqual(f.current(), f.expected);
  });
  it("propagates runner refusal and handles runner exceptions without reporting acceptance", () => {
    for (const throws of [false, true]) {
      const f = fixture(), before = f.session.getSnapshot(), messages: string[] = [];
      const actions = createScene25dSettingsEditActionsV1({ getSnapshot: f.session.getSnapshot,
        runCommand: () => { if (throws) throw new Error("canonical runner refused"); return false; }, setStatus: message => messages.push(message) });
      assert.equal(actions.apply(f.scope, f.expected, changed(f.expected, s => { s.camera.verticalFovDegrees = 70; })), false);
      assert.equal(f.session.getSnapshot(), before); if (throws) assert.equal(messages.at(-1), "canonical runner refused");
    }
  });
});
