import { isValidElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shortcutAction, type EditorShortcutAction } from "../desktop/useEditorShortcuts";

// The guide's 快捷鍵 page (open with 說明 or "?") with hook doubles, no mounted DOM: every line does what it says
// (checked against the editor's own key map), the groups and words, and the guide's 剪掉不要的部分 step.
const hooks = vi.hoisted(() => ({ shortcutsOpen: false, calls: 0 }));
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useEffect: () => {}, useRef: (value: unknown) => ({ current: value }),
    useState: (value: unknown) => [hooks.calls++ % 2 === 1 ? hooks.shortcutsOpen : value, () => {}] };
});
vi.mock("./i18n/interfacePreferences", async importOriginal => {
  const actual = await importOriginal<typeof import("./i18n/interfacePreferences")>();
  return { ...actual, useI18n: () => ({ ...actual.interfacePreferences.getSnapshot(), t: actual.translateUi }) };
});
import { BeginnerGuide, STEPS } from "./BeginnerGuide";
import { BeginnerShortcutSheet, EDITOR_SHORTCUT_GROUPS } from "./BeginnerShortcuts";
import { interfacePreferences } from "./i18n/interfacePreferences";

type Props = Record<string, unknown> & { children?: ReactNode };
function all(node: ReactNode, predicate: (props: Props, type: unknown) => boolean, out: Props[] = []): Props[] {
  if (Array.isArray(node)) node.forEach(child => all(child, predicate, out));
  else if (isValidElement<Props>(node)) { if (predicate(node.props, node.type)) out.push(node.props); if (node.props.children) all(node.props.children, predicate, out); }
  return out;
}
const text = (node: ReactNode): string => Array.isArray(node) ? node.map(text).join("") : typeof node === "string" || typeof node === "number" ? String(node)
  : isValidElement<Props>(node) ? text(node.props.children) : "";
afterEach(async () => { await interfacePreferences.setLocale("zh-TW"); hooks.shortcutsOpen = false; hooks.calls = 0; });

/** The key events a line's keys stand for ("← →" is both arrows). */
function eventsOf(combo: string[]) {
  const modifiers = { ctrlKey: combo.includes("Ctrl"), shiftKey: combo.includes("Shift"), altKey: combo.includes("Alt"), metaKey: false };
  const key = combo.find(token => !["Ctrl", "Shift", "Alt"].includes(token))!;
  const keyNames: Record<string, string> = { "←": "ArrowLeft", "→": "ArrowRight", "↑": "ArrowUp", "↓": "ArrowDown" };
  const keys = keyNames[key] ? [keyNames[key]] : key === "← →" ? ["ArrowLeft", "ArrowRight"] : key === "↑ ↓" ? ["ArrowUp", "ArrowDown"]
    : key === "Esc" ? ["Escape"] : key === "Space" ? [" "] : [key.length === 1 ? key.toLowerCase() : key];
  return keys.map(name => ({ key: name, ...modifiers }));
}

describe("the guide's 快捷鍵 page", () => {
  it("every line does what it says: its keys reach exactly its actions in the editor's key map", () => {
    for (const group of EDITOR_SHORTCUT_GROUPS) for (const line of group.lines) {
      const actions = line.keys.flatMap(combo => eventsOf(combo).map(event => shortcutAction(event)));
      expect(actions, `${group.title} · ${line.label}`).toEqual(line.actions as EditorShortcutAction[]);
    }
  });

  it("each row describes one action, with aliases only for that same action", () => {
    for (const group of EDITOR_SHORTCUT_GROUPS) for (const line of group.lines) {
      expect(new Set(line.actions).size, `${group.title}: ${line.label}`).toBe(1);
    }
    const fit = EDITOR_SHORTCUT_GROUPS.flatMap(group => group.lines).find(line => line.actions?.[0] === "fit-timeline")!;
    expect(fit.keys).toEqual([["\\"], ["Shift", "Z"]]);
    const sheet = BeginnerShortcutSheet();
    expect(all(sheet, (_props, type) => type === "i").map(props => text(props.children as ReactNode))).toContain("或");
  });

  it("groups the keys as 剪輯, 播放, 移動 and 檔案, in big plain words", () => {
    expect(EDITOR_SHORTCUT_GROUPS.map(group => [group.title, group.lines.map(line => `${line.keys.map(combo => combo.join("+")).join(" / ")} ${line.label}`)])).toEqual([
  [
    "剪輯",
    [
      "B 剪刀",
      "A 選取",
      "Ctrl+B 在播放頭切開",
      "Delete 刪除",
      "Shift+Delete 刪除並保留空隙",
      "Esc 取消選取／回到選取",
      "Q 刪掉左邊",
      "W 刪掉右邊",
      "[ 開頭修到播放頭",
      "] 結尾修到播放頭",
      "Ctrl+A 全選片段與字幕",
      "Ctrl+Shift+A 選取播放頭之後",
      "Ctrl+C 複製選取",
      "Ctrl+X 剪下選取",
      "Ctrl+V 貼在播放頭",
      "Ctrl+D 接著複製一份",
      "Ctrl+H 尋找取代字幕（時間軸或字幕面板）",
      "Ctrl+T 在離播放頭最近的剪接點套用上次的轉場",
      "Delete 刪除選取的轉場（先點轉場的菱形）",
      "Ctrl+Z 復原",
      "Ctrl+Y 重做"
    ]
  ],
  [
    "播放",
    [
      "Space 播放／暫停",
      "← 上一格",
      "→ 下一格",
      "Shift+← 往前一秒",
      "Shift+→ 往後一秒",
      "Home 回到開頭",
      "End 跳到結尾",
      "J 倒放",
      "K 暫停",
      "L 快轉",
      "M 加入標記",
      "Shift+M 跳到下一個標記",
      "Ctrl+Shift+M 跳到上一個標記",
      "I 設定入點",
      "O 設定出點",
      "Alt+X 清除入出點",
      "Shift+I 跳到入點",
      "Shift+O 跳到出點",
      "/ 播放入出點範圍",
      "↑ 上一個編輯點",
      "↓ 下一個編輯點"
    ]
  ],
  [
    "移動",
    [
      "Alt+← 向前移動一格",
      "Alt+→ 向後移動一格",
      "Alt+Shift+← 向前移動十格",
      "Alt+Shift+→ 向後移動十格",
      "= 放大時間軸",
      "- 縮小時間軸",
      "\\ / Shift+Z 顯示整段時間軸",
      "N 切換吸附（進階模式）"
    ]
  ],
  [
    "檔案",
    [
      "Ctrl+S 存檔"
    ]
  ]
]);
    const sheet = BeginnerShortcutSheet();
    expect(all(sheet, (_props, type) => type === "h3").map(props => text(props.children as ReactNode))).toEqual(["剪輯", "播放", "移動", "檔案"]);
    expect(all(sheet, (_props, type) => type === "kbd").map(props => text(props.children as ReactNode)).slice(0, 4)).toEqual(["B", "A", "Ctrl", "B"]);
    expect(all(sheet, (_props, type) => type === "dd").map(props => text(props.children as ReactNode))).toContain("刪掉右邊");
  });

  it("speaks the interface language (the keys stay as printed on the keyboard)", async () => {
    await interfacePreferences.setLocale("en");
    const sheet = BeginnerShortcutSheet();
    const words = all(sheet, (_props, type) => type === "dd" || type === "h3").map(props => text(props.children as ReactNode));
    expect(words).toEqual(expect.arrayContaining(["Edit", "Play", "Move", "File", "Blade", "Select", "Split at the playhead", "Delete the left part", "Delete the right part"]));
    expect(words.join(" ")).not.toMatch(/[㐀-鿿]/);
  });

  it("is a page of the guide (說明 and \"?\" open the guide): a 快捷鍵 tab next to the four steps, then the sheet in place of the step", () => {
    const steps = BeginnerGuide({ onClose: () => {}, onChooseMedia: () => {} });
    const tab = all(steps, props => props["data-testid"] === "guide-shortcuts-tab")[0];
    expect([text(tab.children as ReactNode), tab["aria-pressed"]]).toEqual(["快捷鍵", false]);
    expect(all(steps, (_props, type) => type === BeginnerShortcutSheet)).toHaveLength(0);
    hooks.calls = 0;
    hooks.shortcutsOpen = true;
    const page = BeginnerGuide({ onClose: () => {}, onChooseMedia: () => {} });
    expect(all(page, (_props, type) => type === BeginnerShortcutSheet)).toHaveLength(1);
    expect(all(page, props => props.className === "guide-card")).toHaveLength(0);
    expect(all(page, props => props["data-testid"] === "guide-shortcuts-tab")[0]["aria-pressed"]).toBe(true);
  });

  it("the 剪掉不要的部分 step names 剪刀 (B) and Delete", () => {
    expect(STEPS[1]).toMatchObject({ title: "剪掉不要的部分" });
    expect(STEPS[1].body).toContain("B");
    expect(STEPS[1].body).toContain("剪刀");
    expect(STEPS[1].body).toContain("Delete");
  });
});
