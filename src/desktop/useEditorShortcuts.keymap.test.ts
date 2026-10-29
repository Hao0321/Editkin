import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const effects = vi.hoisted(() => ({ cleanup: undefined as (() => void) | undefined }));
vi.mock("react", () => ({ useEffect: (effect: () => (() => void)) => { effects.cleanup = effect(); } }));
import { BLOCKED_BROWSER_KEYS, blockedBrowserKey, EDITOR_KEY_BINDINGS, shortcutAction, useEditorShortcuts, type EditorShortcutAction } from "./useEditorShortcuts";
import { printedCombo, usKeyEvent, usKeyPresses } from "./editorKeyboardUs.fixture";

// The editor's whole key map, pinned (P8, 2026-10-22). Every key of a US keyboard with every Ctrl / Alt / Shift combination
// goes through the real shortcutAction; the result must be exactly this table. A key that changes, appears or disappears
// fails here first, so the CapCut conventions Hao relies on cannot regress silently.
const FULL_KEY_MAP: Record<string, EditorShortcutAction> = {
  // CapCut / DaVinci / Final Cut conventions (feedback_editkin_nle_ergonomics): B blade, A select, Ctrl+B split,
  // Delete / Backspace, Q / W, Space, J K L, ← →, Ctrl+Z / Ctrl+Y.
  "B": "blade-tool", "Shift+B": "blade-tool", "A": "select-tool", "Shift+A": "select-tool", "Ctrl+B": "split",
  "Delete": "delete", "Backspace": "delete", "Shift+Delete": "lift", "Shift+Backspace": "lift",
  "Q": "delete-left", "Shift+Q": "delete-left", "W": "delete-right", "Shift+W": "delete-right",
  "Space": "play", "Shift+Space": "play", "J": "shuttle-back", "Shift+J": "shuttle-back", "K": "pause", "Shift+K": "pause",
  "L": "shuttle-forward", "Shift+L": "shuttle-forward",
  "←": "frame-back", "→": "frame-forward", "Shift+←": "second-back", "Shift+→": "second-forward",
  "Ctrl+Z": "undo", "Ctrl+Y": "redo", "Ctrl+Shift+Y": "redo", "Ctrl+Shift+Z": "redo",
  "Esc": "escape-tool", "Shift+Esc": "escape-tool",
  // Selection and clipboard.
  "Ctrl+A": "select-all", "Ctrl+Shift+A": "select-forward", "Ctrl+C": "copy", "Ctrl+X": "cut", "Ctrl+V": "paste", "Ctrl+D": "duplicate",
  "Ctrl+H": "find-captions", "Ctrl+T": "apply-transition",
  // Trims, nudges, markers, in / out, edit points.
  "[": "trim-start", "]": "trim-end",
  "Alt+←": "nudge-back", "Alt+→": "nudge-forward", "Alt+Shift+←": "nudge-back-ten", "Alt+Shift+→": "nudge-forward-ten",
  "M": "add-marker", "Shift+M": "next-marker", "Ctrl+Shift+M": "previous-marker",
  "I": "mark-in", "Shift+I": "go-in", "O": "mark-out", "Shift+O": "go-out", "Alt+X": "clear-marks", "/": "play-range",
  "↑": "previous-edit", "↓": "next-edit", "Home": "go-start", "Shift+Home": "go-start", "End": "go-end", "Shift+End": "go-end",
  // Timeline view.
  "=": "zoom-in", "Shift+=": "zoom-in", "-": "zoom-out", "\\": "fit-timeline", "Shift+Z": "fit-timeline", "N": "toggle-snap",
  // File.
  "Ctrl+S": "save", "Ctrl+Shift+S": "save-as",
};

function keyMap(presses: ReturnType<typeof usKeyPresses>, editable = false) {
  const map: Record<string, EditorShortcutAction> = {};
  for (const press of presses) { const action = shortcutAction(press.event, editable); if (action) map[press.printed] = action; }
  return map;
}

describe("the editor's full key map", () => {
  it("is exactly the pinned table on a US keyboard", () => {
    expect(keyMap(usKeyPresses())).toEqual(FULL_KEY_MAP);
  });

  it("answers Cmd exactly like Ctrl", () => {
    expect(keyMap(usKeyPresses("meta"))).toEqual(FULL_KEY_MAP);
  });

  it("leaves every key to a text field except Ctrl+S and Ctrl+Shift+S", () => {
    expect(keyMap(usKeyPresses(), true)).toEqual({ "Ctrl+S": "save", "Ctrl+Shift+S": "save-as" });
  });

  it("matches the printed key table (EDITOR_KEY_BINDINGS) that the 快捷鍵 page is made from", () => {
    const actions = Object.keys(EDITOR_KEY_BINDINGS) as EditorShortcutAction[];
    for (const action of actions) {
      expect(EDITOR_KEY_BINDINGS[action].length, action).toBeGreaterThan(0);
      for (const combo of EDITOR_KEY_BINDINGS[action]) expect(FULL_KEY_MAP[printedCombo(combo)], `${action}: ${combo.join("+")}`).toBe(action);
    }
    // Every action the keyboard reaches has printed keys (the table may leave out quiet aliases such as Shift+B).
    expect(new Set(Object.values(FULL_KEY_MAP))).toEqual(new Set(actions));
  });

  it("is wired in App: every action has a handler in the one global owner", () => {
    const source = ts.createSourceFile("App.tsx", readFileSync(new URL("../App.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let wired: string[] | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.name.getText(source) === "actions" && node.initializer && ts.isArrayLiteralExpression(node.initializer)
        && node.type?.getText(source) === "EditorShortcutAction[]") wired = node.initializer.elements.map(element => (element as ts.StringLiteral).text);
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(new Set(wired)).toEqual(new Set(Object.keys(EDITOR_KEY_BINDINGS)));
  });
});

describe("WebView keys that would reload, print or cover the editor", () => {
  const blocked = ["F5", "Shift+F5", "Ctrl+F5", "Ctrl+R", "Ctrl+Shift+R", "Ctrl+F", "Ctrl+Shift+F", "Ctrl+G", "Ctrl+Shift+G", "Ctrl+P", "Ctrl+Shift+P"];
  const kept = ["Ctrl+C", "Ctrl+V", "Ctrl+X", "Ctrl+Z", "Ctrl+Y", "Ctrl+Shift+Z", "Ctrl+A", "Ctrl+S", "Ctrl+B", "R", "F", "G", "P", "U", "Ctrl+Alt+R", "Ctrl+Alt+F", "Ctrl+=", "Ctrl+-"];
  it("are taken everywhere, also in a text field; Ctrl+U only outside text fields", () => {
    for (const editable of [false, true]) {
      for (const printed of blocked) expect(blockedBrowserKey(usKeyEvent(printed), editable), `${printed} editable=${editable}`).toBe(true);
      for (const printed of kept) expect(blockedBrowserKey(usKeyEvent(printed), editable), `${printed} editable=${editable}`).toBe(false);
      expect(blockedBrowserKey({ ...usKeyEvent("Ctrl+F"), ctrlKey: false, metaKey: true }, editable)).toBe(true);
    }
    expect(blockedBrowserKey(usKeyEvent("Ctrl+U"))).toBe(true);
    expect(blockedBrowserKey(usKeyEvent("Ctrl+U"), true)).toBe(false);
    for (const combo of BLOCKED_BROWSER_KEYS) expect(blockedBrowserKey(usKeyEvent(printedCombo(combo))), combo.join("+")).toBe(true);
  });

  it("never collide with an editor shortcut", () => {
    for (const press of usKeyPresses()) if (blockedBrowserKey(press.event)) expect(shortcutAction(press.event), press.printed).toBeUndefined();
  });
});

// The real listener owner with window / document doubles (as in useEditorShortcuts.listener.test.ts).
class Target extends EventTarget {
  constructor(readonly kind: "none" | "text" | "button" | "timeline" = "none") { super(); }
  isContentEditable = false;
  closest(selector: string) {
    const list = selector.split(",").map(item => item.trim());
    if (this.kind === "text" && selector.includes("input")) return this;
    if ((this.kind === "button" || this.kind === "timeline") && list.includes("button")) return this;
    if (this.kind === "timeline" && (list.includes(".timeline-clip") || list.includes(".timeline-shell"))) return this;
    return null;
  }
}
let host: EventTarget, modal: boolean, menu: boolean;
let handlers: Record<EditorShortcutAction, ReturnType<typeof vi.fn>>;
function press(printed: string, target = new Target()) {
  const event = new Event("keydown", { cancelable: true });
  for (const [name, value] of Object.entries({ ...usKeyEvent(printed), repeat: false, isComposing: false, target })) Object.defineProperty(event, name, { value });
  host.dispatchEvent(event);
  return event;
}
const called = () => Object.fromEntries(Object.entries(handlers).filter(([, handler]) => handler.mock.calls.length).map(([name, handler]) => [name, handler.mock.calls.length]));

describe("the shortcut owner in the app", () => {
  beforeEach(() => {
    modal = false; menu = false;
    host = new EventTarget();
    vi.stubGlobal("window", host);
    vi.stubGlobal("HTMLElement", Target);
    vi.stubGlobal("document", { querySelector: (selector: string) => modal || (menu && selector.includes('[role="menu"]')) ? {} : null });
    handlers = Object.fromEntries((Object.keys(EDITOR_KEY_BINDINGS) as EditorShortcutAction[]).map(action => [action, vi.fn()])) as typeof handlers;
    useEditorShortcuts(handlers);
  });
  afterEach(() => { effects.cleanup?.(); vi.unstubAllGlobals(); });

  it.each(["none", "button", "timeline"] as const)("runs every CapCut convention once, focus on %s, and keeps the key from the browser", kind => {
    const conventions: Array<[string, EditorShortcutAction]> = [["B", "blade-tool"], ["A", "select-tool"], ["Ctrl+B", "split"], ["Delete", "delete"],
      ["Backspace", "delete"], ["Q", "delete-left"], ["W", "delete-right"], ["Space", "play"], ["J", "shuttle-back"], ["K", "pause"],
      ["L", "shuttle-forward"], ["←", "frame-back"], ["→", "frame-forward"], ["Ctrl+Z", "undo"], ["Ctrl+Y", "redo"], ["Ctrl+Shift+Z", "redo"]];
    for (const [printed, action] of conventions) {
      for (const handler of Object.values(handlers)) handler.mockClear();
      expect(press(printed, new Target(kind)).defaultPrevented, printed).toBe(true);
      expect(called(), printed).toEqual({ [action]: 1 });
    }
  });

  it("takes the browser keys before anything else, also while typing or while a dialog or menu owns the keys", () => {
    for (const target of [new Target(), new Target("text"), new Target("button")]) {
      for (const printed of ["F5", "Ctrl+R", "Ctrl+Shift+R", "Ctrl+F", "Ctrl+G", "Ctrl+P"]) expect(press(printed, target).defaultPrevented, printed).toBe(true);
    }
    modal = true;
    expect(press("Ctrl+P").defaultPrevented).toBe(true);
    modal = false; menu = true;
    expect(press("F5").defaultPrevented).toBe(true);
    expect(called()).toEqual({});
  });

  it("leaves copy, paste, cut, undo and redo to a text field, and keeps the editor's keys working outside it", () => {
    const text = new Target("text");
    for (const printed of ["Ctrl+C", "Ctrl+V", "Ctrl+X", "Ctrl+Z", "Ctrl+Y", "Ctrl+A", "Ctrl+U", "B", "Space", "Delete"]) expect(press(printed, text).defaultPrevented, printed).toBe(false);
    expect(called()).toEqual({});
    expect(press("Ctrl+S", text).defaultPrevented).toBe(true);
    expect(press("Ctrl+C").defaultPrevented).toBe(true);
    expect(press("Ctrl+U").defaultPrevented).toBe(true);
    expect(called()).toEqual({ save: 1, copy: 1 });
  });
});
