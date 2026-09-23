import { useEffect } from "react";

export type EditorShortcutAction = "save" | "save-as" | "undo" | "redo" | "delete" | "split" | "play" | "frame-back" | "frame-forward" | "second-back" | "second-forward";

export function shortcutAction(input: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">, editable = false): EditorShortcutAction | undefined {
  const key = input.key.toLowerCase();
  const command = input.ctrlKey || input.metaKey;
  if (command && !input.altKey && key === "s") return input.shiftKey ? "save-as" : "save";
  if (editable) return undefined;
  if (command && !input.altKey && key === "z") return input.shiftKey ? "redo" : "undo";
  if (command && !input.altKey && key === "y") return "redo";
  if (editable || command || input.altKey) return undefined;
  if (key === "delete" || key === "backspace") return "delete";
  if (key === "b") return "split";
  if (key === " ") return "play";
  if (key === "arrowleft") return input.shiftKey ? "second-back" : "frame-back";
  if (key === "arrowright") return input.shiftKey ? "second-forward" : "frame-forward";
  return undefined;
}

function isTextEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable
    || Boolean(target.closest("input,textarea,select,[contenteditable]:not([contenteditable='false'])")));
}

function isFocusedButton(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("button"));
}

export function useEditorShortcuts(handlers: Partial<Record<EditorShortcutAction, () => void>>) {
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      // EditorShell owns modal state, including lazy dialogs not yet mounted.
      if (document.querySelector('[data-shortcuts-blocked="true"], [role="dialog"][aria-modal="true"]')) return;
      const action = shortcutAction(event, isTextEditable(event.target));
      const handler = action ? handlers[action] : undefined;
      if (!handler) return;
      // Timeline clips are buttons for keyboard accessibility. Keep their
      // native Space/arrow behavior, but do not suppress history or save after
      // a pointer drag leaves focus on the clip.
      if (action && isFocusedButton(event.target) && !["save", "save-as", "undo", "redo"].includes(action)) return;
      event.preventDefault();
      handler();
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [handlers]);
}
