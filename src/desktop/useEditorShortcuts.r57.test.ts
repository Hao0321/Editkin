import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const effects = vi.hoisted(() => ({ cleanup: undefined as (() => void) | undefined }));
vi.mock("react", () => ({ useEffect: (effect: () => (() => void)) => { effects.cleanup = effect(); } }));
import { shortcutAction, useEditorShortcuts, type EditorShortcutAction, type EditorShortcutHandlers } from "./useEditorShortcuts";

type Modifiers = Partial<Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey" | "altKey">>;
const keys: readonly [string, Modifiers, EditorShortcutAction][] = [
  ["Delete", { shiftKey: true }, "lift"],
  ["a", { ctrlKey: true }, "select-all"], ["a", { ctrlKey: true, shiftKey: true }, "select-forward"],
  ["c", { ctrlKey: true }, "copy"], ["x", { ctrlKey: true }, "cut"],
  ["v", { ctrlKey: true }, "paste"], ["d", { ctrlKey: true }, "duplicate"],
  ["m", {}, "add-marker"], ["m", { shiftKey: true }, "next-marker"],
  ["m", { ctrlKey: true, shiftKey: true }, "previous-marker"],
  ["i", {}, "mark-in"], ["o", {}, "mark-out"], ["x", { altKey: true }, "clear-marks"],
  ["i", { shiftKey: true }, "go-in"], ["o", { shiftKey: true }, "go-out"], ["/", {}, "play-range"],
  ["ArrowUp", {}, "previous-edit"], ["ArrowDown", {}, "next-edit"],
  ["=", {}, "zoom-in"], ["+", { shiftKey: true }, "zoom-in"], ["-", {}, "zoom-out"],
  ["\\", {}, "fit-timeline"], ["z", { shiftKey: true }, "fit-timeline"],
  ["n", {}, "toggle-snap"], ["[", {}, "trim-start"], ["]", {}, "trim-end"],
];
class Target extends EventTarget {
  constructor(readonly tagName = "BUTTON", readonly isContentEditable = false) { super(); }
  closest(selector: string) { return selector.includes(this.tagName.toLowerCase()) && ["INPUT", "TEXTAREA", "SELECT"].includes(this.tagName) ? this : null; }
}
let host: EventTarget;
let block: "none" | "modal" | "menu" | "native-dialog" | "startup";
let handlers: EditorShortcutHandlers;
function press(key: string, modifiers: Modifiers, target = new Target(), repeat = false) {
  const event = new Event("keydown", { cancelable: true });
  for (const [name, value] of Object.entries({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
    isComposing: false, target, repeat, ...modifiers })) Object.defineProperty(event, name, { value });
  host.dispatchEvent(event);
  return event;
}
beforeEach(() => {
  block = "none"; host = new EventTarget();
  vi.stubGlobal("window", host); vi.stubGlobal("HTMLElement", Target);
  vi.stubGlobal("document", { querySelector: (selector: string) => {
    const match = block === "modal" ? '[role="dialog"][aria-modal="true"]' : block === "menu" ? '[role="menu"]'
      : block === "native-dialog" ? "dialog[open]" : block === "startup" ? '[data-shortcuts-blocked="true"]' : undefined;
    return match && selector.includes(match) ? {} : null;
  } });
  handlers = Object.fromEntries(keys.map(([, , action]) => [action, vi.fn()]));
  useEditorShortcuts(handlers);
});
afterEach(() => { effects.cleanup?.(); vi.unstubAllGlobals(); });

describe("r57 keyboard contract", () => {
  it.each(keys)("dispatches %s %j to %s once and consumes the default action", (key, modifiers, action) => {
    expect(shortcutAction({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...modifiers })).toBe(action);
    expect(press(key, modifiers).defaultPrevented).toBe(true);
    expect(handlers[action]).toHaveBeenCalledExactlyOnceWith({ repeat: false });
    expect(Object.values(handlers).reduce((total, handler) => total + vi.mocked(handler!).mock.calls.length, 0)).toBe(1);
  });
  it("keeps every new editing key with text fields and contenteditable", () => {
    for (const target of [new Target("INPUT"), new Target("TEXTAREA"), new Target("SELECT"), new Target("DIV", true)]) {
      for (const [key, modifiers] of keys) expect(press(key, modifiers, target).defaultPrevented).toBe(false);
    }
    expect(Object.values(handlers).every(handler => vi.mocked(handler!).mock.calls.length === 0)).toBe(true);
  });
  it.each(["modal", "menu", "native-dialog", "startup"] as const)("does not edit behind %s", active => {
    block = active;
    for (const [key, modifiers] of keys) expect(press(key, modifiers).defaultPrevented).toBe(false);
    expect(Object.values(handlers).every(handler => vi.mocked(handler!).mock.calls.length === 0)).toBe(true);
  });
  it("held selection, paste, duplicate and arrows never fall through to browser actions", () => {
    const held = keys.filter(([, , action]) => ["select-all", "select-forward", "copy", "cut", "paste", "duplicate", "previous-edit", "next-edit"].includes(action));
    for (const [key, modifiers, action] of held) {
      press(key, modifiers);
      for (let i = 0; i < 3; i++) expect(press(key, modifiers, new Target(), true).defaultPrevented, action).toBe(true);
      expect(handlers[action]).toHaveBeenCalledTimes(1);
    }
  });
  it("uses Command too while leaving WebView zoom accelerators untouched", () => {
    for (const [key, modifiers, action] of keys.filter(([, modifiers]) => modifiers.ctrlKey)) {
      expect(press(key, { ...modifiers, ctrlKey: false, metaKey: true }).defaultPrevented).toBe(true);
      expect(handlers[action]).toHaveBeenCalledTimes(1);
    }
    for (const key of ["=", "+", "-"]) for (const modifiers of [{ ctrlKey: true }, { metaKey: true }]) {
      expect(press(key, modifiers).defaultPrevented).toBe(false);
    }
  });
});
