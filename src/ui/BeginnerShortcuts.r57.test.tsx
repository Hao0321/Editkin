import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { shortcutAction, type EditorShortcutAction } from "../desktop/useEditorShortcuts";
import { INTERFACE_MESSAGES } from "./i18n/interfaceMessages.27";
import { INTERFACE_MESSAGES as SINGLE_ACTION_MESSAGES } from "./i18n/interfaceMessages.31";
import * as clipboardWords from "../application/timelineClipboard";
import * as selectionWords from "../application/timelineSelectionEdits";
import * as shortcutWords from "../application/timelineShortcutActions";

import { BeginnerShortcutSheet, EDITOR_SHORTCUT_GROUPS } from "./BeginnerShortcuts";
import { interfacePreferences } from "./i18n/interfacePreferences";

afterEach(async () => { await interfacePreferences.setLocale("zh-TW"); });

function events(combo: string[]) {
  const token = combo.find(key => !["Ctrl", "Shift", "Alt"].includes(key))!;
  const arrows: Record<string, string> = { "←": "ArrowLeft", "→": "ArrowRight", "↑": "ArrowUp", "↓": "ArrowDown" };
  const keys = arrows[token] ? [arrows[token]] : token === "← →" ? ["ArrowLeft", "ArrowRight"] : token === "↑ ↓" ? ["ArrowUp", "ArrowDown"]
    : token === "Space" ? [" "] : token === "Esc" ? ["Escape"] : [token];
  return keys.map(key => ({ key, ctrlKey: combo.includes("Ctrl"), shiftKey: combo.includes("Shift"), altKey: combo.includes("Alt"), metaKey: false }));
}

describe("B1 shortcut guide and five-language message source", () => {
  it("every printed combination reaches exactly the stated action through the real key map", () => {
    // Key lines only: P8 added mouse lines (gestures) and the shell's "?" line, which shortcutAction does not own.
    for (const group of EDITOR_SHORTCUT_GROUPS) for (const line of group.lines.filter(item => item.actions)) {
      expect(new Set(line.actions).size, `${group.title}: ${line.label}`).toBe(1);
      expect(line.keys.flatMap(combo => events(combo).map(input => shortcutAction(input))), `${group.title}: ${line.label}`).toEqual(line.actions);
    }
  });

  it("documents every B1 key while keeping the existing four groups (P8 adds 滑鼠 after them) and keycap classes", () => {
    expect(EDITOR_SHORTCUT_GROUPS.map(group => group.title)).toEqual(["剪輯", "播放", "移動", "檔案", "滑鼠"]);
    const documented = new Set(EDITOR_SHORTCUT_GROUPS.flatMap(group => group.lines.flatMap(line => line.actions ?? [])));
    const required: EditorShortcutAction[] = ["lift", "escape-tool", "select-all", "select-forward", "copy", "cut", "paste", "duplicate",
      "add-marker", "next-marker", "previous-marker", "mark-in", "mark-out", "clear-marks", "go-in", "go-out", "play-range",
      "previous-edit", "next-edit", "zoom-in", "zoom-out", "fit-timeline", "toggle-snap", "trim-start", "trim-end"];
    for (const key of required) expect(documented.has(key), key).toBe(true);
    expect(renderToStaticMarkup(<BeginnerShortcutSheet />)).toContain('class="guide-shortcut-sheet"');
  });

  it.each(["zh-TW", "en", "es", "ja", "ko"] as const)("renders every new legend in %s with the original component", async locale => {
    await interfacePreferences.setLocale(locale);
    const index = ["zh-TW", "en", "es", "ja", "ko"].indexOf(locale), html = renderToStaticMarkup(<BeginnerShortcutSheet />);
    for (const line of EDITOR_SHORTCUT_GROUPS.flatMap(group => group.lines)) {
      const row = [...INTERFACE_MESSAGES, ...SINGLE_ACTION_MESSAGES].find(item => item[0] === line.label);
      if (row) expect(html).toContain(row[index]);
    }
    expect(html).toContain("<kbd>Ctrl</kbd>");
    expect(html).toContain("<kbd>↑</kbd>");
    expect(html).toContain("<kbd>↓</kbd>");
    expect(html).not.toContain("<kbd>↑ ↓</kbd>");
  });

  it("covers all new exported status words and preserves interpolation fields across all five languages", () => {
    const source = new Map(INTERFACE_MESSAGES.map(row => [row[0], row]));
    expect(source.size).toBe(INTERFACE_MESSAGES.length);
    for (const message of Object.values({ ...clipboardWords, ...selectionWords, ...shortcutWords })) {
      if (typeof message === "string") expect(source.has(message), message).toBe(true);
    }
    const fields = (value: string) => [...new Set(value.match(/\{\w+\}/g) ?? [])].sort();
    for (const row of INTERFACE_MESSAGES) for (const value of row) {
      expect(value.trim().length).toBeGreaterThan(0);
      expect(fields(value), row[0]).toEqual(fields(row[0]));
    }
  });
});
