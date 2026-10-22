import { useEffect } from "react";

export type EditorShortcutAction = "save" | "save-as" | "undo" | "redo" | "delete" | "split" | "play" | "pause" | "shuttle-back" | "shuttle-forward"
  | "frame-back" | "frame-forward" | "second-back" | "second-forward" | "nudge-back" | "nudge-forward" | "nudge-back-ten" | "nudge-forward-ten"
  | "go-start" | "go-end" | "blade-tool" | "select-tool" | "escape-tool" | "delete-left" | "delete-right"
  | "lift" | "select-all" | "select-forward" | "copy" | "cut" | "paste" | "duplicate"
  | "add-marker" | "next-marker" | "previous-marker" | "mark-in" | "mark-out" | "clear-marks" | "go-in" | "go-out" | "play-range"
  | "previous-edit" | "next-edit" | "zoom-in" | "zoom-out" | "fit-timeline" | "toggle-snap" | "trim-start" | "trim-end" | "find-captions" | "apply-transition";

/** What a handler is told about the key press. */
export interface EditorShortcutPress {
  /** The operating system is repeating a held key. Only steps and nudges act on repeats. */
  repeat: boolean;
}

/** A handler may say whether it acted; only Esc (escape-tool) uses the answer: Esc is the editor's only when it did something. */
export type EditorShortcutHandlers = Partial<Record<EditorShortcutAction, (press: EditorShortcutPress) => void | boolean>>;

/** A held ← → keeps stepping the playhead, a held Alt+← → keeps nudging (as one Undo step). Every other key acts once. */
const REPEATS: ReadonlySet<EditorShortcutAction> = new Set<EditorShortcutAction>(["frame-back", "frame-forward", "second-back", "second-forward",
  "nudge-back", "nudge-forward", "nudge-back-ten", "nudge-forward-ten"]);
/** Held keys whose own browser action would still reach the focused control (press a button, scroll a list): consumed. */
const SWALLOWED_REPEATS: ReadonlySet<EditorShortcutAction> = new Set<EditorShortcutAction>(["play", "go-start", "go-end",
  "lift", "select-all", "select-forward", "copy", "cut", "paste", "duplicate",
  "add-marker", "next-marker", "previous-marker", "mark-in", "mark-out", "clear-marks", "go-in", "go-out", "play-range",
  "previous-edit", "next-edit", "zoom-in", "zoom-out", "fit-timeline", "toggle-snap", "trim-start", "trim-end", "find-captions", "apply-transition"]);

export function shortcutAction(input: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">, editable = false): EditorShortcutAction | undefined {
  const key = input.key.toLowerCase();
  const command = input.ctrlKey || input.metaKey;
  if (command && !input.altKey && key === "s") return input.shiftKey ? "save-as" : "save";
  if (editable) return undefined;
  if (command && !input.altKey && key === "z") return input.shiftKey ? "redo" : "undo";
  if (command && !input.altKey && key === "y") return "redo";
  // Ctrl+B cuts at the playhead (the 切開 button); B alone picks the blade, as in CapCut, DaVinci and Final Cut.
  if (command && !input.altKey && !input.shiftKey && key === "b") return "split";
  if (command && !input.altKey) {
    if (key === "a") return input.shiftKey ? "select-forward" : "select-all";
    if (key === "m" && input.shiftKey) return "previous-marker";
    if (!input.shiftKey) {
      if (key === "c") return "copy";
      if (key === "x") return "cut";
      if (key === "v") return "paste";
      if (key === "d") return "duplicate";
      if (key === "h") return "find-captions";
      // Ctrl+T: the last used transition on the cut nearest the playhead (Motion Library GUI).
      if (key === "t") return "apply-transition";
    }
  }
  // WebView2 zoom accelerators are not explicitly disabled, so Ctrl+= / Ctrl+- remain with the browser.
  if (command) return undefined;
  // Alt+← → nudge the selected clip, caption or title one frame (with Shift ten); ← → alone always step the playhead.
  if (input.altKey) {
    if (key === "x" && !input.shiftKey) return "clear-marks";
    if (key === "arrowleft") return input.shiftKey ? "nudge-back-ten" : "nudge-back";
    if (key === "arrowright") return input.shiftKey ? "nudge-forward-ten" : "nudge-forward";
    return undefined;
  }
  if (key === "delete" || key === "backspace") return input.shiftKey ? "lift" : "delete";
  // The timeline's two tools: B 剪刀 (blade), A 選取 (pointer); Esc goes back to 選取 when nothing else wants it.
  if (key === "b") return "blade-tool";
  if (key === "a") return "select-tool";
  if (key === "escape") return "escape-tool";
  if (key === "m") return input.shiftKey ? "next-marker" : "add-marker";
  if (key === "i") return input.shiftKey ? "go-in" : "mark-in";
  if (key === "o") return input.shiftKey ? "go-out" : "mark-out";
  if (key === "/" && !input.shiftKey) return "play-range";
  if (key === "arrowup" && !input.shiftKey) return "previous-edit";
  if (key === "arrowdown" && !input.shiftKey) return "next-edit";
  if (key === "=" || key === "+") return "zoom-in";
  if (key === "-" && !input.shiftKey) return "zoom-out";
  if (key === "\\" || (key === "z" && input.shiftKey)) return "fit-timeline";
  if (key === "n" && !input.shiftKey) return "toggle-snap";
  if (key === "[" && !input.shiftKey) return "trim-start";
  if (key === "]" && !input.shiftKey) return "trim-end";
  // Q and W delete the part of a clip left or right of the playhead and close the gap.
  if (key === "q") return "delete-left";
  if (key === "w") return "delete-right";
  if (key === " ") return "play";
  if (key === "j") return "shuttle-back";
  if (key === "k") return "pause";
  if (key === "l") return "shuttle-forward";
  if (key === "arrowleft") return input.shiftKey ? "second-back" : "frame-back";
  if (key === "arrowright") return input.shiftKey ? "second-forward" : "frame-forward";
  if (key === "home") return "go-start";
  if (key === "end") return "go-end";
  return undefined;
}

// The transport's speed menu and seek slider are not text fields. After a mouse
// choice they keep focus, and every editing key still works there.
function isTransportControl(target: HTMLElement): boolean {
  return Boolean(target.closest(".playback-controls")) && (target.tagName === "SELECT"
    || (target.tagName === "INPUT" && (target as HTMLInputElement).type === "range"));
}

function isTextEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && !isTransportControl(target) && (target.isContentEditable
    || Boolean(target.closest("input,textarea,select,[contenteditable]:not([contenteditable='false'])")));
}

/** A modal dialog (ARIA or a native <dialog> opened with showModal), the start-up check or an open menu (a track's ⋯
 * options) owns the keyboard while it is there: Space then presses the dialog's focused button, as it should. */
function keysOwnedElsewhere(target: EventTarget | null): boolean {
  if (document.querySelector('[data-shortcuts-blocked="true"], [role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"], dialog[open], [role="menu"]')) return true;
  return target instanceof HTMLElement && Boolean(target.closest('[role="menu"],[role="menubar"],[role="listbox"]'));
}

/**
 * The one owner of editing and playback keys. They work whatever has focus — a clip just clicked, a toolbar button, the
 * transport — except while typing (text fields, contenteditable) and while a dialog or menu owns the keyboard. A key it
 * handles never also does the focused control's own thing: Space plays or pauses and never presses the focused button.
 */
export function useEditorShortcuts(handlers: EditorShortcutHandlers) {
  useEffect(() => {
    // Space pressed on a button would "click" it on release; once Space played or paused, its release is ours too.
    let spaceTaken = false;
    const handle = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (keysOwnedElsewhere(event.target)) return;
      const action = shortcutAction(event, isTextEditable(event.target));
      const handler = action ? handlers[action] : undefined;
      if (!action || !handler) return;
      if (action === "find-captions" && (!(event.target instanceof HTMLElement)
        || !event.target.closest(".timeline-shell, .caption-delivery, .caption-search-open, [data-testid=caption-inspector]"))) return;
      // A held key repeats only steps and nudges; a held Space, B or Delete acts once, and a held Space never clicks a button.
      if (event.repeat && !REPEATS.has(action)) {
        if (SWALLOWED_REPEATS.has(action)) event.preventDefault();
        return;
      }
      // Esc stays with whoever else uses it (a drag being cancelled already took it) unless it changed the tool back.
      if (action === "escape-tool") {
        if (handler({ repeat: false }) === true) event.preventDefault();
        return;
      }
      event.preventDefault();
      if (action === "play") spaceTaken = true;
      handler({ repeat: event.repeat });
    };
    const release = (event: KeyboardEvent) => {
      if (event.key !== " " || !spaceTaken) return;
      spaceTaken = false;
      event.preventDefault();
    };
    window.addEventListener("keydown", handle);
    window.addEventListener("keyup", release);
    return () => {
      window.removeEventListener("keydown", handle);
      window.removeEventListener("keyup", release);
    };
  }, [handlers]);
}

export const NOTHING_TO_UNDO = "沒有可以復原的步驟。";
export const NOTHING_TO_REDO = "沒有可以重做的步驟。";

/** Undo/Redo shortcuts with an empty history never reach the handler that reports
 * success: this capture listener runs first, consumes the key and says so honestly.
 * The same text-field and dialog exceptions as the global owner apply. */
export function useHistoryShortcutGuard(canUndo: boolean, canRedo: boolean, onStatus: (message: string) => void) {
  useEffect(() => {
    const guard = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      if (keysOwnedElsewhere(event.target)) return;
      const action = shortcutAction(event, isTextEditable(event.target));
      if ((action !== "undo" || canUndo) && (action !== "redo" || canRedo)) return;
      event.preventDefault();
      onStatus(action === "undo" ? NOTHING_TO_UNDO : NOTHING_TO_REDO);
    };
    window.addEventListener("keydown", guard, { capture: true });
    return () => window.removeEventListener("keydown", guard, { capture: true });
  }, [canUndo, canRedo, onStatus]);
}
