import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const effects = vi.hoisted(() => ({ cleanup: undefined as (() => void) | undefined }));
vi.mock("react", () => ({ useEffect: (effect: () => (() => void)) => { effects.cleanup = effect(); } }));
import { useEditorShortcuts, type EditorShortcutAction } from "./useEditorShortcuts";

class Target extends EventTarget {
  constructor(readonly kind: "none" | "text" | "button" | "timeline" | "transport" | "notice-summary" | "menu-item" = "none", readonly isContentEditable = false) { super(); }
  // Like Element.closest, a selector list matches when any of its selectors does.
  closest(selector: string) {
    const list = selector.split(",").map(item => item.trim());
    if (this.kind === "text" && selector.includes("input")) return this;
    if ((this.kind === "button" || this.kind === "timeline" || this.kind === "transport" || this.kind === "menu-item") && list.includes("button")) return this;
    if (this.kind === "notice-summary" && list.includes("summary")) return this;
    if (this.kind === "timeline" && list.includes(".timeline-clip")) return this;
    // The playback notices, and so their 查看原因 <summary>, sit inside the transport.
    if ((this.kind === "transport" || this.kind === "notice-summary") && list.includes(".playback-controls")) return this;
    // A track's ⋯ options are a menu (role="menu") that owns the keys while it is open.
    if (this.kind === "menu-item" && list.includes('[role="menu"]')) return this;
    return null;
  }
}
let host: EventTarget;
let modal: boolean;
let openMenu: boolean;
let nativeDialog: boolean;
let handlers: Record<EditorShortcutAction, ReturnType<typeof vi.fn>>;
function press(key: string, patch: Record<string, unknown> = {}, target = new Target(), type = "keydown") {
  const event = new Event(type, { cancelable: true });
  for (const [name, value] of Object.entries({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, repeat: false, isComposing: false, target, ...patch })) Object.defineProperty(event, name, { value });
  host.dispatchEvent(event);
  return event;
}
const ACTIONS = ["save", "save-as", "undo", "redo", "delete", "split", "play", "pause", "shuttle-back", "shuttle-forward", "frame-back", "frame-forward", "second-back", "second-forward",
  "nudge-back", "nudge-forward", "nudge-back-ten", "nudge-forward-ten", "go-start", "go-end", "blade-tool", "select-tool", "escape-tool", "delete-left", "delete-right"];
const calls = () => Object.fromEntries(Object.entries(handlers).filter(([, handler]) => handler.mock.calls.length).map(([name, handler]) => [name, handler.mock.calls.length]));
beforeEach(() => {
  modal = false;
  openMenu = false;
  nativeDialog = false;
  host = new EventTarget();
  vi.stubGlobal("window", host);
  vi.stubGlobal("HTMLElement", Target);
  // The owner asks one selector list for modal dialogs, the start-up check and open menus.
  vi.stubGlobal("document", { querySelector: (selector: string) => modal || (openMenu && selector.includes('[role="menu"]'))
    || (nativeDialog && selector.split(",").map(item => item.trim()).includes("dialog[open]")) ? {} : null });
  handlers = Object.fromEntries(ACTIONS.map(name => [name, vi.fn()])) as typeof handlers;
  useEditorShortcuts(handlers);
});
afterEach(() => { effects.cleanup?.(); vi.unstubAllGlobals(); });

describe("one global editing shortcut owner", () => {
  it.each([
    ["s", { ctrlKey: true }, "save"], ["S", { metaKey: true, shiftKey: true }, "save-as"],
    ["z", { ctrlKey: true }, "undo"], ["Z", { metaKey: true, shiftKey: true }, "redo"],
    ["Delete", {}, "delete"], ["b", { ctrlKey: true }, "split"], ["b", {}, "blade-tool"], ["a", {}, "select-tool"], ["q", {}, "delete-left"],
    ["w", {}, "delete-right"], [" ", {}, "play"],
    ["ArrowLeft", {}, "frame-back"], ["ArrowRight", { shiftKey: true }, "second-forward"],
  ] as const)("dispatches %s exactly once", (key, modifiers, action) => {
    expect(press(key, modifiers).defaultPrevented).toBe(true);
    expect(handlers[action]).toHaveBeenCalledTimes(1);
    expect(Object.values(handlers).reduce((count, handler) => count + handler.mock.calls.length, 0)).toBe(1);
  });

  it("does not steal typing or native text undo", () => {
    for (const target of [new Target("text"), new Target("none", true)]) {
      for (const key of [" ", "j", "k", "l", "b", "Delete", "Backspace", "ArrowLeft"]) expect(press(key, {}, target).defaultPrevented).toBe(false);
      expect(press("z", { ctrlKey: true }, target).defaultPrevented).toBe(false);
    }
    expect(Object.values(handlers).every(handler => handler.mock.calls.length === 0)).toBe(true);
    press("s", { ctrlKey: true }, new Target("text"));
    expect(handlers.save).toHaveBeenCalledTimes(1);
  });

  // Rewritten on purpose (2026-10-11): a focused button used to keep B, Delete, ← → and Space for itself, so after any
  // click (a clip, 切開, a toolbar button) those keys silently stopped working. They now always reach the editor, and
  // the key is consumed so the focused button is never pressed by it.
  it("works whatever button has focus — a clicked clip or a toolbar button — and never presses that button", () => {
    const button = new Target("button");
    for (const key of [" ", "b", "Delete", "Backspace", "ArrowLeft", "ArrowRight", "Home", "End", "j", "k", "l"]) expect(press(key, {}, button).defaultPrevented).toBe(true);
    // Rewritten on purpose (2026-10-11, the 剪刀 tool): B picks the blade now; Ctrl+B cuts at the playhead.
    expect(calls()).toEqual({ play: 1, "blade-tool": 1, delete: 2, "frame-back": 1, "frame-forward": 1, "go-start": 1, "go-end": 1, "shuttle-back": 1, pause: 1, "shuttle-forward": 1 });
    expect(press("b", { ctrlKey: true }, button).defaultPrevented).toBe(true);
    expect(handlers.split).toHaveBeenCalledTimes(1);
    expect(press("z", { ctrlKey: true }, button).defaultPrevented).toBe(true);
    expect(handlers.undo).toHaveBeenCalledTimes(1);
    expect(press("y", { ctrlKey: true }, button).defaultPrevented).toBe(true);
    expect(handlers.redo).toHaveBeenCalledTimes(1);
  });

  it("Space never clicks the focused button: its release is consumed too, and Enter stays the button's own key", () => {
    const button = new Target("button");
    expect(press(" ", {}, button).defaultPrevented).toBe(true);
    expect(press(" ", {}, button, "keyup").defaultPrevented).toBe(true);
    expect(handlers.play).toHaveBeenCalledTimes(1);
    // Only a Space the editor took is consumed on release; Enter is never the editor's.
    expect(press(" ", {}, button, "keyup").defaultPrevented).toBe(false);
    expect(press("Enter", {}, button).defaultPrevented).toBe(false);
    expect(press(" ", {}, new Target("text"), "keyup").defaultPrevented).toBe(false);
  });

  it("Space on a notice's 查看原因 <summary> plays or pauses like on any button; Enter still opens the reason", () => {
    const summary = new Target("notice-summary");
    for (const key of [" ", "b", "Delete", "k", "ArrowRight"]) expect(press(key, {}, summary).defaultPrevented).toBe(true);
    expect(calls()).toEqual({ play: 1, "blade-tool": 1, delete: 1, pause: 1, "frame-forward": 1 });
    expect(press("Enter", {}, summary).defaultPrevented).toBe(false);
  });

  it("an open menu (a track's ⋯ options) and alert dialogs own the keys; nothing reaches the editor", () => {
    for (const key of [" ", "b", "Delete", "ArrowDown", "Home"]) expect(press(key, {}, new Target("menu-item")).defaultPrevented).toBe(false);
    openMenu = true;
    for (const key of [" ", "b", "Delete"]) expect(press(key, {}, new Target("button")).defaultPrevented).toBe(false);
    expect(calls()).toEqual({});
    openMenu = false;
    expect(press("b", {}, new Target("button")).defaultPrevented).toBe(true);
    expect(handlers["blade-tool"]).toHaveBeenCalledTimes(1);
  });

  it("a native modal <dialog> (showModal, e.g. the title text dialog) owns the keys: Space presses its focused button", () => {
    nativeDialog = true;
    for (const key of [" ", "b", "Delete", "ArrowRight", "Home", "j"]) expect(press(key, {}, new Target("button")).defaultPrevented).toBe(false);
    expect(press("z", { ctrlKey: true }, new Target("button")).defaultPrevented).toBe(false);
    expect(calls()).toEqual({});
    nativeDialog = false;
    expect(press(" ", {}, new Target("button")).defaultPrevented).toBe(true);
    expect(handlers.play).toHaveBeenCalledTimes(1);
  });

  it("blocks background edits and saving while a guide/modal is active", () => {
    modal = true;
    for (const key of ["s", "z", " ", "j", "k", "l", "b", "Delete"]) press(key, { ctrlKey: key === "s" || key === "z" });
    expect(Object.values(handlers).every(handler => handler.mock.calls.length === 0)).toBe(true);
    modal = false;
    press("s", { ctrlKey: true });
    expect(handlers.save).toHaveBeenCalledTimes(1);
  });

  // Rewritten on purpose (2026-10-11): ← → on a focused clip used to move the clip. They now always step the playhead
  // one frame (Shift: one second); Alt+← → nudge the selected clip, caption or title (Alt+Shift: ten frames).
  it("on a focused clip ← → step the playhead and Alt+← → nudge the selection", () => {
    const clip = new Target("timeline");
    expect(press(" ", {}, clip).defaultPrevented).toBe(true);
    expect(press("ArrowLeft", {}, clip).defaultPrevented).toBe(true);
    expect(press("ArrowRight", { shiftKey: true }, clip).defaultPrevented).toBe(true);
    for (const [key, shiftKey] of [["ArrowLeft", false], ["ArrowRight", false], ["ArrowLeft", true], ["ArrowRight", true]] as const) {
      expect(press(key, { altKey: true, shiftKey }, clip).defaultPrevented).toBe(true);
    }
    expect(calls()).toEqual({ play: 1, "frame-back": 1, "second-forward": 1, "nudge-back": 1, "nudge-forward": 1, "nudge-back-ten": 1, "nudge-forward-ten": 1 });
    expect(handlers["nudge-forward"]).toHaveBeenCalledWith({ repeat: false });
    // Alt with any other editing key is not the editor's (B, Delete, Space stay unbound with Alt).
    for (const key of ["b", "Delete", " "]) expect(press(key, { altKey: true }, clip).defaultPrevented).toBe(false);
  });

  it("a held ← → keeps stepping and a held Alt+← → keeps nudging; a held Space, B or Delete acts once", () => {
    const clip = new Target("timeline");
    for (const repeat of [false, true, true]) {
      press("ArrowRight", { repeat }, clip);
      press("ArrowLeft", { altKey: true, repeat }, clip);
      expect(press(" ", { repeat }, clip).defaultPrevented).toBe(true);
      press("b", { repeat }, clip); press("Delete", { repeat }, clip);
    }
    expect(calls()).toEqual({ "frame-forward": 3, "nudge-back": 3, play: 1, "blade-tool": 1, delete: 1 });
    expect(handlers["nudge-back"].mock.calls.map(([press]) => press.repeat)).toEqual([false, true, true]);
  });

  it("Esc is the editor's only when it took 剪刀 back to 選取; otherwise it stays with whoever else uses it", () => {
    const clip = new Target("timeline");
    handlers["escape-tool"].mockReturnValueOnce(true).mockReturnValueOnce(false);
    expect(press("Escape", {}, clip).defaultPrevented).toBe(true);
    expect(press("Escape", {}, clip).defaultPrevented).toBe(false);
    expect(press("Escape", {}, clip).defaultPrevented).toBe(false);
    expect(handlers["escape-tool"]).toHaveBeenCalledTimes(3);
    // A drag being cancelled already took it, a held Esc repeats nothing, and typing, menus and dialogs keep their Esc.
    handlers["escape-tool"].mockReturnValue(true);
    expect(press("Escape", { defaultPrevented: true }, clip).defaultPrevented).toBe(true);
    expect(press("Escape", { repeat: true }, clip).defaultPrevented).toBe(false);
    expect(press("Escape", {}, new Target("text")).defaultPrevented).toBe(false);
    expect(press("Escape", {}, new Target("menu-item")).defaultPrevented).toBe(false);
    nativeDialog = true;
    expect(press("Escape", {}, clip).defaultPrevented).toBe(false);
    expect(handlers["escape-tool"]).toHaveBeenCalledTimes(3);
  });

  it("B, A, Q and W act once per press and never while typing", () => {
    const clip = new Target("timeline");
    for (const repeat of [false, true]) for (const key of ["b", "a", "q", "w"]) press(key, { repeat }, clip);
    expect(calls()).toEqual({ "blade-tool": 1, "select-tool": 1, "delete-left": 1, "delete-right": 1 });
    for (const key of ["b", "a", "q", "w"]) expect(press(key, {}, new Target("text")).defaultPrevented).toBe(false);
    expect(calls()).toEqual({ "blade-tool": 1, "select-tool": 1, "delete-left": 1, "delete-right": 1 });
  });

  it("shuttles and pauses after toolbar focus without native key double dispatch", () => {
    const target = new Target("button");
    for (const [key, action] of [["j", "shuttle-back"], ["k", "pause"], ["l", "shuttle-forward"]] as const) {
      expect(press(key, {}, target).defaultPrevented).toBe(true);
      expect(handlers[action]).toHaveBeenCalledTimes(1);
    }
    expect(handlers.play).not.toHaveBeenCalled();
    expect(press("ArrowRight", {}, new Target("transport")).defaultPrevented).toBe(true);
    expect(handlers["frame-forward"]).toHaveBeenCalledTimes(1);
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
