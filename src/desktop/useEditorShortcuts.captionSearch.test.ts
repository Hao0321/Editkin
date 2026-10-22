import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const effects = vi.hoisted(() => ({ cleanup: undefined as (() => void) | undefined }));
vi.mock("react", () => ({ useEffect: (run: () => () => void) => { effects.cleanup = run(); } }));
import { shortcutAction, useEditorShortcuts } from "./useEditorShortcuts";

class Target extends EventTarget {
  constructor(readonly scope = "outside", readonly tagName = "BUTTON", readonly isContentEditable = false) { super(); }
  closest(selector: string) {
    if (this.tagName === "INPUT" && selector.includes("input")) return this;
    if (this.scope === "timeline" && selector.includes(".timeline-shell")) return this;
    if (this.scope === "caption" && selector.includes(".caption-delivery")) return this;
    return null;
  }
}
let host: EventTarget, blocked: boolean;
const open = vi.fn();
function press(target: Target, extra: Record<string, unknown> = {}) {
  const event = new Event("keydown", { cancelable: true });
  for (const [key, value] of Object.entries({ key: "h", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false,
    repeat: false, isComposing: false, target, ...extra })) Object.defineProperty(event, key, { value });
  host.dispatchEvent(event); return event;
}
beforeEach(() => {
  open.mockClear(); blocked = false; host = new EventTarget();
  vi.stubGlobal("window", host); vi.stubGlobal("HTMLElement", Target);
  vi.stubGlobal("document", { querySelector: () => blocked ? {} : null });
  useEditorShortcuts({ "find-captions": open });
});
afterEach(() => { effects.cleanup?.(); vi.unstubAllGlobals(); });

describe("Ctrl+H remains with the existing global keyboard owner", () => {
  it("opens only from timeline or caption scope and consumes exactly that key", () => {
    expect(press(new Target("timeline")).defaultPrevented).toBe(true);
    expect(press(new Target("caption")).defaultPrevented).toBe(true);
    expect(press(new Target("outside")).defaultPrevented).toBe(false);
    expect(open).toHaveBeenCalledTimes(2);
  });
  it("leaves typing, composition, dialogs, extra modifiers and held repeats alone", () => {
    expect(press(new Target("caption", "INPUT")).defaultPrevented).toBe(false);
    press(new Target("timeline"), { isComposing: true });
    press(new Target("timeline"), { altKey: true }); press(new Target("timeline"), { shiftKey: true });
    blocked = true; press(new Target("timeline")); blocked = false;
    expect(press(new Target("timeline"), { repeat: true }).defaultPrevented).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });
  it("retains the historical text-input save exception and removes listeners when the owner unmounts", () => {
    expect(shortcutAction({ key: "s", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }, true)).toBe("save");
    effects.cleanup?.(); press(new Target("timeline")); expect(open).not.toHaveBeenCalled();
  });
});
