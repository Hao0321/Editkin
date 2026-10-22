import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const effects = vi.hoisted(() => ({ cleanup: undefined as (() => void) | undefined }));
vi.mock("react", () => ({ useEffect: (effect: () => (() => void)) => { effects.cleanup = effect(); } }));
import { useEditorShortcuts, type EditorShortcutAction } from "./useEditorShortcuts";

// A focused element double: tag/type plus whether it sits inside the preview transport.
class Target extends EventTarget {
  readonly isContentEditable = false;
  constructor(readonly tagName: string, readonly type = "", readonly inTransport = true) { super(); }
  closest(selector: string) {
    if (selector === ".playback-controls") return this.inTransport ? this : null;
    if (selector === "button") return this.tagName === "BUTTON" ? this : null;
    if (selector.startsWith("input,textarea,select")) return ["INPUT", "TEXTAREA", "SELECT"].includes(this.tagName) ? this : null;
    return null;
  }
}
let host: EventTarget;
let handlers: Record<EditorShortcutAction, ReturnType<typeof vi.fn>>;
function press(key: string, target: Target, patch: Record<string, unknown> = {}) {
  const event = new Event("keydown", { cancelable: true });
  for (const [name, value] of Object.entries({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, repeat: false, isComposing: false, target, ...patch })) Object.defineProperty(event, name, { value });
  host.dispatchEvent(event);
  return event;
}
const calls = () => Object.fromEntries(Object.entries(handlers).filter(([, handler]) => handler.mock.calls.length).map(([name, handler]) => [name, handler.mock.calls.length]));
beforeEach(() => {
  host = new EventTarget();
  vi.stubGlobal("window", host);
  vi.stubGlobal("HTMLElement", Target);
  vi.stubGlobal("document", { querySelector: () => null });
  handlers = Object.fromEntries(["save", "save-as", "undo", "redo", "delete", "split", "play", "pause", "shuttle-back", "shuttle-forward", "frame-back", "frame-forward", "second-back", "second-forward",
    "nudge-back", "nudge-forward", "nudge-back-ten", "nudge-forward-ten", "go-start", "go-end", "blade-tool", "select-tool", "escape-tool", "delete-left",
    "delete-right"].map(name => [name, vi.fn()])) as typeof handlers;
  useEditorShortcuts(handlers);
});
afterEach(() => { effects.cleanup?.(); vi.unstubAllGlobals(); });

describe("transport keys after using the speed menu or seek slider (U03 keyboard)", () => {
  it.each([["speed select", new Target("SELECT")], ["seek slider", new Target("INPUT", "range")]])("%s keeps J/K/L, Space and the arrows on playback", (_name, target) => {
    for (const key of ["j", "k", "l", " ", "ArrowLeft", "ArrowRight"]) expect(press(key, target).defaultPrevented).toBe(true);
    expect(press("ArrowRight", target, { shiftKey: true }).defaultPrevented).toBe(true);
    expect(calls()).toEqual({ "shuttle-back": 1, pause: 1, "shuttle-forward": 1, play: 1, "frame-back": 1, "frame-forward": 1, "second-forward": 1 });
    expect(press("z", target, { ctrlKey: true }).defaultPrevented).toBe(true); expect(handlers.undo).toHaveBeenCalledTimes(1);
  });

  // Rewritten on purpose (2026-10-11): after parking the playhead with the seek slider (or picking a speed), B and
  // Delete used to do nothing until something else was clicked. Editing keys now work there too, like everywhere else.
  // Rewritten again on purpose (2026-10-11, the 剪刀 tool): B picks the blade and Ctrl+B cuts at the playhead; Q and W too.
  it("B, Ctrl+B, Q, W and Delete still work after the speed menu or seek slider was used", () => {
    for (const target of [new Target("SELECT"), new Target("INPUT", "range")]) {
      for (const key of ["Delete", "Backspace", "b", "q", "w", "Home", "End"]) expect(press(key, target).defaultPrevented).toBe(true);
      expect(press("b", target, { ctrlKey: true }).defaultPrevented).toBe(true);
    }
    expect(calls()).toEqual({ delete: 4, "blade-tool": 2, split: 2, "delete-left": 2, "delete-right": 2, "go-start": 2, "go-end": 2 });
  });

  it("still leaves real text fields and other menus to the user", () => {
    for (const target of [new Target("INPUT", "text"), new Target("TEXTAREA"), new Target("SELECT", "", false), new Target("INPUT", "range", false)]) {
      for (const key of ["j", "k", "l", " ", "ArrowLeft", "Delete"]) expect(press(key, target).defaultPrevented).toBe(false);
    }
    expect(calls()).toEqual({});
  });
});
