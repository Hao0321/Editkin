import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectSession } from "../application/projectSession";
import { createTimelineEditingState } from "../application/timelineEditingState";
import { createGraphicEditingSelectionV1 } from "../application/graphicEditingSelectionV1";
import { createClipGradeEditsV1 } from "../application/clipGradeEditsV1";
import { dispatchCommandSafely } from "../domain/history";
import type { EditProject, TimelineClip } from "../domain/types";
import { createDemoProject } from "../domain/demo";
import { addGradeNodeV1 } from "../domain/colorGradePanelEditsV1";
import { TRACK_LOCKED_MESSAGE } from "../domain/trackLock";
// Execute just the actual JSX prop expressions; this is source wiring, not a native desktop render.
const text = readFileSync(new URL("./EditorShell.tsx", import.meta.url), "utf8"), source = ts.createSourceFile("EditorShell.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let tag: ts.JsxOpeningLikeElement | undefined;
function visit(node: ts.Node) { if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === "ColorWorkspace") tag = node; ts.forEachChild(node, visit); } visit(source);
const stops: Array<() => void> = [];
afterEach(() => { while (stops.length) stops.pop()!(); });
function prop(name: string, project: EditProject, selectedClip: TimelineClip, runCommand = vi.fn(), props: unknown = {}) {
  const attr = tag!.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(source) === name) as ts.JsxAttribute;
  const expression = (attr.initializer as ts.JsxExpression).expression!;
  const code = ts.transpileModule(`const value = ${expression.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const session = createProjectSession(project), timeline = createTimelineEditingState(session), selection = createGraphicEditingSelectionV1(session, timeline);
  stops.push(selection.subscribe(() => {})); timeline.setSelectedClipId(selectedClip.id);
  const clipGradeEdits = createClipGradeEditsV1({ getSnapshot: session.getSnapshot, getSelectionSnapshot: selection.getSnapshot, setStatus: () => {},
    runCommand: (command, message) => { runCommand(command, message); const result = dispatchCommandSafely(session.getSnapshot().history, command, "wiring"); session.setHistory(result.state); return !result.error; } },
    { project, clipId: selectedClip.id, selection: selection.getSnapshot() });
  return new Function("project", "selectedClip", "runCommand", "props", "clipGradeEdits", `${code}\nreturn value;`)(project, selectedClip, runCommand, props, clipGradeEdits);
}
describe("actual color-workspace command wiring", () => {
  it("submits one real grade command with the selected clip ID", () => {
    const p = createDemoProject(), clip = p.tracks[0].clips[0], run = vi.fn(), callback = prop("onGradeV2Change", p, clip, run), grade = addGradeNodeV1();
    callback(grade); expect(run).toHaveBeenCalledExactlyOnceWith({ type: "set_clip_grade_v2", clipId: clip.id, grade }, "已更新 v2 調色。");
    expect(prop("gradeReadOnlyReason", p, clip)).toBeUndefined();
  });
  it("removes the editing handler and gives the real lock message on a locked track", () => {
    const p = createDemoProject(); p.tracks[0].locked = true; const clip = p.tracks[0].clips[0];
    expect(prop("onGradeV2Change", p, clip)).toBeUndefined(); expect(prop("gradeReadOnlyReason", p, clip)).toBe(TRACK_LOCKED_MESSAGE);
  });
  it("binds draft editing to the actual ProjectSession instance and session ID", () => {
    const p = createDemoProject(), session = { getSnapshot: () => ({ sessionId: 7 }) };
    expect(prop("gradeEditScope", p, p.tracks[0].clips[0], vi.fn(), { projectSession: session })).toEqual({ owner: session, sessionId: 7 });
  });
});
