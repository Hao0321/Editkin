import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const effects = vi.hoisted(() => ({ cleanups: [] as Array<() => void> }));
vi.mock("react", () => ({ useEffect: (effect: () => (() => void) | void) => { const cleanup = effect(); if (cleanup) effects.cleanups.push(cleanup); } }));
import { NOTHING_TO_REDO, NOTHING_TO_UNDO, useEditorShortcuts, useHistoryShortcutGuard } from "./useEditorShortcuts";

class Target extends EventTarget {
  constructor(readonly kind: "none" | "text" = "none", readonly isContentEditable = false) { super(); }
  closest(selector: string) { return this.kind === "text" && selector.includes("input") ? this : null; }
}
let host: EventTarget;
let modal: boolean;
let undo: ReturnType<typeof vi.fn>, redo: ReturnType<typeof vi.fn>, status: ReturnType<typeof vi.fn>;
function press(key: string, patch: Record<string, unknown> = {}, target = new Target()) {
  const event = new Event("keydown", { cancelable: true });
  for (const [name, value] of Object.entries({ key, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, repeat: false, isComposing: false, target, ...patch })) Object.defineProperty(event, name, { value });
  host.dispatchEvent(event);
  return event;
}
// The shell mounts the guard; App's single shortcut owner then runs the real handlers.
function mount(canUndo: boolean, canRedo: boolean) {
  useHistoryShortcutGuard(canUndo, canRedo, status);
  useEditorShortcuts({ undo, redo });
}
beforeEach(() => {
  modal = false;
  host = new EventTarget();
  vi.stubGlobal("window", host);
  vi.stubGlobal("HTMLElement", Target);
  vi.stubGlobal("document", { querySelector: () => modal ? {} : null });
  undo = vi.fn(); redo = vi.fn(); status = vi.fn();
});
afterEach(() => { for (const cleanup of effects.cleanups.splice(0)) cleanup(); vi.unstubAllGlobals(); });

describe("Undo/Redo shortcuts with an empty history", () => {
  it("say that nothing can be undone or redone and never reach the success handlers", () => {
    mount(false, false);
    expect(press("z").defaultPrevented).toBe(true);
    expect(press("Z", { shiftKey: true }).defaultPrevented).toBe(true);
    expect(press("y").defaultPrevented).toBe(true);
    expect(undo).not.toHaveBeenCalled();
    expect(redo).not.toHaveBeenCalled();
    expect(status.mock.calls).toEqual([[NOTHING_TO_UNDO], [NOTHING_TO_REDO], [NOTHING_TO_REDO]]);
    expect(NOTHING_TO_UNDO).toBe("沒有可以復原的步驟。");
  });

  it("let a real step through to the global owner", () => {
    mount(true, true);
    press("z"); press("y");
    expect(undo).toHaveBeenCalledTimes(1);
    expect(redo).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
  });

  it("guard each direction separately", () => {
    mount(true, false);
    press("z"); press("y");
    expect(undo).toHaveBeenCalledTimes(1);
    expect(redo).not.toHaveBeenCalled();
    expect(status.mock.calls).toEqual([[NOTHING_TO_REDO]]);
  });

  it("leave native text undo, open dialogs and repeated keys alone", () => {
    mount(false, false);
    expect(press("z", {}, new Target("text")).defaultPrevented).toBe(false);
    modal = true;
    expect(press("z").defaultPrevented).toBe(false);
    modal = false;
    expect(press("z", { repeat: true }).defaultPrevented).toBe(false);
    expect(status).not.toHaveBeenCalled();
  });

  it("stops guarding when unmounted", () => {
    mount(false, false);
    for (const cleanup of effects.cleanups.splice(0)) cleanup();
    expect(press("z").defaultPrevented).toBe(false);
    expect(status).not.toHaveBeenCalled();
  });
});
