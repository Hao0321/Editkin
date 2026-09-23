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

  it("maps editing and transport keys outside inputs", () => {
    expect(shortcutAction(event("Delete"))).toBe("delete");
    expect(shortcutAction(event("b"))).toBe("split");
    expect(shortcutAction(event(" "))).toBe("play");
    expect(shortcutAction(event("ArrowRight", { shiftKey: true }))).toBe("second-forward");
  });

  it("does not hijack text editing", () => {
    expect(shortcutAction(event("Backspace"), true)).toBeUndefined();
    expect(shortcutAction(event(" "), true)).toBeUndefined();
    expect(shortcutAction(event("s", { ctrlKey: true }), true)).toBe("save");
    expect(shortcutAction(event("z", { ctrlKey: true }), true)).toBeUndefined();
    expect(shortcutAction(event("y", { ctrlKey: true }), true)).toBeUndefined();
  });

  it("does not consume unsupported modified shortcuts", () => {
    expect(shortcutAction(event("b", { ctrlKey: true }))).toBeUndefined();
    expect(shortcutAction(event("s", { ctrlKey: true, altKey: true }))).toBeUndefined();
  });
});
