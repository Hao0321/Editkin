import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const effects = vi.hoisted(() => ({ cleanup: undefined as (() => void) | undefined }));
vi.mock("react", () => ({ useEffect: (effect: () => (() => void)) => { effects.cleanup = effect(); } }));
import { useEditorShortcuts, type EditorShortcutAction } from "./useEditorShortcuts";

class Target extends EventTarget {
  constructor(readonly kind: "none" | "text" | "button" = "none", readonly isContentEditable = false) { super(); }
  closest(selector: string) {
    if (this.kind === "text" && selector.includes("input")) return this;
    if (this.kind === "button" && selector === "button") return this;
    return null;
  }
}
let host: EventTarget;
let modal: boolean;
let handlers: Record<EditorShortcutAction, ReturnType<typeof vi.fn>>;
function press(key: string, patch: Record<string, unknown> = {}, target = new Target()) {
  const event = new Event("keydown", { cancelable: true });
  for (const [name, value] of Object.entries({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, repeat: false, isComposing: false, target, ...patch })) Object.defineProperty(event, name, { value });
  host.dispatchEvent(event);
  return event;
}
beforeEach(() => {
  modal = false;
  host = new EventTarget();
  vi.stubGlobal("window", host);
  vi.stubGlobal("HTMLElement", Target);
  vi.stubGlobal("document", { querySelector: () => modal ? {} : null });
  handlers = Object.fromEntries(["save", "save-as", "undo", "redo", "delete", "split", "play", "frame-back", "frame-forward", "second-back", "second-forward"].map(name => [name, vi.fn()])) as typeof handlers;
  useEditorShortcuts(handlers);
});
afterEach(() => { effects.cleanup?.(); vi.unstubAllGlobals(); });

describe("one global editing shortcut owner", () => {
  it.each([
    ["s", { ctrlKey: true }, "save"], ["S", { metaKey: true, shiftKey: true }, "save-as"],
    ["z", { ctrlKey: true }, "undo"], ["Z", { metaKey: true, shiftKey: true }, "redo"],
    ["Delete", {}, "delete"], ["b", {}, "split"], [" ", {}, "play"],
    ["ArrowLeft", {}, "frame-back"], ["ArrowRight", { shiftKey: true }, "second-forward"],
  ] as const)("dispatches %s exactly once", (key, modifiers, action) => {
    expect(press(key, modifiers).defaultPrevented).toBe(true);
    expect(handlers[action]).toHaveBeenCalledTimes(1);
    expect(Object.values(handlers).reduce((count, handler) => count + handler.mock.calls.length, 0)).toBe(1);
  });

  it("does not steal typing or native text undo", () => {
    for (const target of [new Target("text"), new Target("none", true)]) {
      for (const key of [" ", "b", "Delete", "Backspace", "ArrowLeft"]) expect(press(key, {}, target).defaultPrevented).toBe(false);
      expect(press("z", { ctrlKey: true }, target).defaultPrevented).toBe(false);
    }
    expect(Object.values(handlers).every(handler => handler.mock.calls.length === 0)).toBe(true);
    press("s", { ctrlKey: true }, new Target("text"));
    expect(handlers.save).toHaveBeenCalledTimes(1);
  });

  it("keeps native focused-button controls but permits history after a timeline drag", () => {
    const button = new Target("button");
    for (const key of [" ", "b", "Delete", "Backspace", "ArrowLeft"]) expect(press(key, {}, button).defaultPrevented).toBe(false);
    expect(press("z", { ctrlKey: true }, button).defaultPrevented).toBe(true);
    expect(handlers.undo).toHaveBeenCalledTimes(1);
    expect(press("y", { ctrlKey: true }, button).defaultPrevented).toBe(true);
    expect(handlers.redo).toHaveBeenCalledTimes(1);
  });

  it("blocks background edits and saving while a guide/modal is active", () => {
    modal = true;
    for (const key of ["s", "z", " ", "b", "Delete"]) press(key, { ctrlKey: key === "s" || key === "z" });
    expect(Object.values(handlers).every(handler => handler.mock.calls.length === 0)).toBe(true);
    modal = false;
    press("s", { ctrlKey: true });
    expect(handlers.save).toHaveBeenCalledTimes(1);
  });

  it("ignores consumed, composing and repeated events and removes the listener", () => {
    for (const patch of [{ defaultPrevented: true }, { isComposing: true }, { repeat: true }]) press("s", { ctrlKey: true, ...patch });
    expect(handlers.save).not.toHaveBeenCalled();
    effects.cleanup?.();
    press("s", { ctrlKey: true });
    expect(handlers.save).not.toHaveBeenCalled();
  });

  it("does not run editing actions before startup recovery is ready", () => {
    effects.cleanup?.();
    useEditorShortcuts({});
    for (const key of ["s", "z", " ", "b", "Delete"]) press(key, { ctrlKey: key === "s" || key === "z" });
    expect(Object.values(handlers).every(handler => handler.mock.calls.length === 0)).toBe(true);
    effects.cleanup?.();
    useEditorShortcuts(handlers);
    press("s", { ctrlKey: true });
    expect(handlers.save).toHaveBeenCalledTimes(1);
  });

  it("keeps real App as editing owner and removes duplicate dispatch from shell", () => {
    const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
    const shell = readFileSync(new URL("../ui/EditorShell.tsx", import.meta.url), "utf8");
    expect(app.match(/useEditorShortcuts\(/g)).toHaveLength(1);
    expect(app).toContain("useEditorShortcuts(recovery.ready ? shortcutHandlers : {})");
    expect(app).toContain('if (!recovery.ready) return <main className="app-loading" aria-busy="true" data-shortcuts-blocked="true">');
    const shellListener = shell.slice(shell.indexOf("const handleShortcut ="), shell.indexOf("const runAutoRoto ="));
    expect(shellListener).not.toMatch(/saveProject|undoEdit|redoEdit|setPlaying|splitSelected|deleteSelected/);
    expect(shellListener).toContain('event.key === "Escape"');
    expect(shellListener).toContain('event.key === "?"');
    expect(shell).toContain("data-shortcuts-blocked={shortcutsBlocked}");
  });
});
