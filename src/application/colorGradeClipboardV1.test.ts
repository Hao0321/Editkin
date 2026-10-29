import { DEFAULT_COLOR_MANAGEMENT } from "../domain/types";
import { describe, expect, it } from "vitest";
import { createProjectSession } from "./projectSession";
import { createColorGradeClipboardV1 } from "./colorGradeClipboardV1";
import { createDemoProject } from "../domain/demo";
import { applyCommand } from "../domain/commands";
import { createHistory, dispatchCommand } from "../domain/history";
import { DEFAULT_COLOR } from "../domain/types";
function setup() { const p = createDemoProject(), source = p.tracks[0].clips[0]; source.duration = 4; source.color = { ...DEFAULT_COLOR, exposure: .5 }; p.tracks[0].clips.push({ ...structuredClone(source), id: "target", timelineStart: 4, color: { ...DEFAULT_COLOR } }); const session = createProjectSession(p), clipboard = createColorGradeClipboardV1(session), detach = clipboard.attach(); return { session, clipboard, detach, sourceId: source.id }; }
describe("window-local project grade clipboard", () => {
  it("copy is read-only and survives source edits as an immutable snapshot", () => {
    const { session, clipboard, sourceId, detach } = setup(), before = session.getSnapshot(); clipboard.copy(sourceId, 0);
    expect(session.getSnapshot()).toBe(before); expect(clipboard.getSnapshot().hasCopy).toBe(true);
    session.setHistory(dispatchCommand(before.history, { type: "set_clip_color", clipId: sourceId, patch: { exposure: 1 } }));
    const command = clipboard.planPaste("target") as Extract<ReturnType<typeof clipboard.planPaste>, { type: "paste_clip_grade_v1" }>;
    expect(command.snapshot.color.exposure).toBe(.5); command.snapshot.color.exposure = 2;
    expect((clipboard.planPaste("target") as typeof command).snapshot.color.exposure).toBe(.5); detach();
  });
  it("clears on another project session even with identical project and clip IDs", () => {
    const { session, clipboard, sourceId, detach } = setup(); clipboard.copy(sourceId, 0); session.replaceProject(structuredClone(session.getSnapshot().history.present));
    expect(clipboard.getSnapshot().hasCopy).toBe(false); expect(clipboard.canPaste("target")).toBe(false); expect(() => clipboard.planPaste("target")).toThrow(/尚未複製/); detach();
  });
  it("clears when working color management changes, even if it is later switched back", () => {
    const { session, clipboard, sourceId, detach } = setup(); clipboard.copy(sourceId, 0);
    const p = structuredClone(session.getSnapshot().history.present); p.colorManagement = { ...DEFAULT_COLOR_MANAGEMENT, mode: "aces2", outputTransform: "rec709_sdr" }; session.setHistory(createHistory(p));
    expect(clipboard.getSnapshot().hasCopy).toBe(false); p.colorManagement = { ...DEFAULT_COLOR_MANAGEMENT, mode: "rec709", outputTransform: "rec709_sdr" }; session.setHistory(createHistory(p)); expect(clipboard.canPaste("target")).toBe(false); detach();
  });
  it("allows copy from locked source, refuses paste on locked target and does not write anything", () => {
    const { session, clipboard, sourceId, detach } = setup(); const p = session.getSnapshot().history.present; p.tracks[0].locked = true; clipboard.copy(sourceId, 0);
    expect(clipboard.canPaste("target")).toBe(false); const before = JSON.stringify(p); expect(() => clipboard.planPaste("target")).toThrow(/軌道已鎖定/); expect(JSON.stringify(p)).toBe(before); detach();
  });
  it("paste admission still checks the live session when no UI listener is attached", () => {
    const { session, clipboard, sourceId, detach } = setup(); detach(); clipboard.copy(sourceId, 0); session.replaceProject(createDemoProject());
    expect(() => clipboard.planPaste("target")).toThrow(/尚未複製/);
  });
});
