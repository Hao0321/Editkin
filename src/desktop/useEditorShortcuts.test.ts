import { describe, expect, it } from "vitest";
import { shortcutAction } from "./useEditorShortcuts";

const event = (key: string, patch: Partial<KeyboardEvent> = {}) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...patch } as KeyboardEvent);

describe("editor shortcuts", () => {
  it("maps save, save-as, undo and redo on either command modifier", () => {
    expect(shortcutAction(event("s", { ctrlKey: true }))).toBe("save");
    expect(shortcutAction(event("S", { metaKey: true, shiftKey: true }))).toBe("save-as");
    expect(shortcutAction(event("z", { ctrlKey: true }))).toBe("undo");
    expect(shortcutAction(event("z", { metaKey: true, shiftKey: true }))).toBe("redo");
  });

  // Rewritten on purpose (2026-10-11): B used to cut at the playhead. As in CapCut, DaVinci and Final Cut, B now picks the
  // 剪刀 (blade) tool and Ctrl+B cuts at the playhead (the 切開 button).
  it("maps editing and transport keys outside inputs", () => {
    expect(shortcutAction(event("Delete"))).toBe("delete");
    expect(shortcutAction(event("b"))).toBe("blade-tool");
    expect(shortcutAction(event("b", { ctrlKey: true }))).toBe("split");
    expect(shortcutAction(event(" "))).toBe("play");
    expect(shortcutAction(event("j"))).toBe("shuttle-back");
    expect(shortcutAction(event("K"))).toBe("pause");
    expect(shortcutAction(event("l"))).toBe("shuttle-forward");
    expect(shortcutAction(event("ArrowRight", { shiftKey: true }))).toBe("second-forward");
  });

  it("does not hijack text editing", () => {
    expect(shortcutAction(event("Backspace"), true)).toBeUndefined();
    expect(shortcutAction(event(" "), true)).toBeUndefined();
    for (const key of ["j", "k", "l"]) expect(shortcutAction(event(key), true)).toBeUndefined();
    expect(shortcutAction(event("s", { ctrlKey: true }), true)).toBe("save");
    expect(shortcutAction(event("z", { ctrlKey: true }), true)).toBeUndefined();
    expect(shortcutAction(event("y", { ctrlKey: true }), true)).toBeUndefined();
  });

  it("maps Alt+← → to nudges (Alt+Shift: ten frames) and Home/End to the start and end; ← → alone always step", () => {
    expect(shortcutAction(event("ArrowLeft", { altKey: true }))).toBe("nudge-back");
    expect(shortcutAction(event("ArrowRight", { altKey: true }))).toBe("nudge-forward");
    expect(shortcutAction(event("ArrowLeft", { altKey: true, shiftKey: true }))).toBe("nudge-back-ten");
    expect(shortcutAction(event("ArrowRight", { altKey: true, shiftKey: true }))).toBe("nudge-forward-ten");
    expect(shortcutAction(event("ArrowLeft"))).toBe("frame-back");
    expect(shortcutAction(event("Home"))).toBe("go-start");
    expect(shortcutAction(event("End"))).toBe("go-end");
    for (const key of ["ArrowLeft", "Home", "End"]) expect(shortcutAction(event(key, { altKey: true }), true)).toBeUndefined();
    expect(shortcutAction(event("ArrowLeft", { altKey: true, ctrlKey: true }))).toBeUndefined();
  });

  it("maps the timeline's tools and the CapCut-style cuts: B 剪刀, A 選取, Esc, Ctrl+B, Q and W", () => {
    expect(["b", "B", "a", "A", "Escape", "q", "Q", "w", "W"].map(key => shortcutAction(event(key))))
      .toEqual(["blade-tool", "blade-tool", "select-tool", "select-tool", "escape-tool", "delete-left", "delete-left", "delete-right", "delete-right"]);
    expect(shortcutAction(event("b", { ctrlKey: true }))).toBe("split");
    expect(shortcutAction(event("B", { metaKey: true }))).toBe("split");
    // Typing keeps every letter and Esc (Ctrl+B is bold in rich text), and Ctrl+Shift+B / Alt+B are not ours.
    for (const key of ["b", "a", "q", "w", "Escape"]) expect(shortcutAction(event(key), true)).toBeUndefined();
    expect(shortcutAction(event("b", { ctrlKey: true }), true)).toBeUndefined();
    expect(shortcutAction(event("b", { ctrlKey: true, shiftKey: true }))).toBeUndefined();
    expect(shortcutAction(event("b", { altKey: true }))).toBeUndefined();
    expect(shortcutAction(event("q", { ctrlKey: true }))).toBeUndefined();
  });

  it("does not consume unsupported modified shortcuts", () => {
    expect(shortcutAction(event("s", { ctrlKey: true, altKey: true }))).toBeUndefined();
    expect(shortcutAction(event("j", { ctrlKey: true }))).toBeUndefined();
    expect(shortcutAction(event("l", { altKey: true }))).toBeUndefined();
  });
});
