import { readFileSync } from "node:fs";
import { isValidElement, type ReactNode } from "react";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EDITOR_KEY_BINDINGS, shortcutAction, type EditorShortcutAction } from "../desktop/useEditorShortcuts";
import en from "./i18n/locales/en";
import es from "./i18n/locales/es";
import ja from "./i18n/locales/ja";
import ko from "./i18n/locales/ko";

// The guide's 快捷鍵 page (說明 opens the guide, "?" opens this page) with hook doubles, no mounted DOM: every line does
// what it says (checked against the editor's own key map), every key the editor answers is on it, the groups and words,
// and the guide's 剪掉不要的部分 step. `shortcutsOpen` forces the guide's second state (the page); undefined keeps the
// guide's own initial value.
const hooks = vi.hoisted(() => ({ shortcutsOpen: undefined as boolean | undefined, calls: 0 }));
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useEffect: () => {}, useRef: (value: unknown) => ({ current: value }),
    useState: (value: unknown) => [hooks.calls++ % 2 === 1 ? hooks.shortcutsOpen ?? value : value, () => {}] };
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
afterEach(async () => { await interfacePreferences.setLocale("zh-TW"); hooks.shortcutsOpen = undefined; hooks.calls = 0; });
const lines = () => EDITOR_SHORTCUT_GROUPS.flatMap(group => group.lines.map(line => ({ group: group.title, ...line })));

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
  it("every key line does what it says: its keys reach exactly its actions in the editor's key map", () => {
    for (const line of lines().filter(item => item.actions)) {
      const actions = line.keys.flatMap(combo => eventsOf(combo).map(event => shortcutAction(event)));
      expect(actions, `${line.group} · ${line.label}`).toEqual(line.actions as EditorShortcutAction[]);
    }
    // "?" belongs to the editor shell (it opens this page), not to the editing keys; mouse lines are gestures.
    const shell = lines().filter(item => item.shell);
    expect(shell.map(line => line.keys)).toEqual([[["?"]]]);
    expect(shortcutAction({ key: "?", ctrlKey: false, metaKey: false, shiftKey: true, altKey: false })).toBeUndefined();
    expect(lines().filter(item => !item.actions && !item.shell).every(item => item.gesture && item.group === "滑鼠")).toBe(true);
  });

  it("drift: every key the editor answers is on the page, with the action it does there (P8)", () => {
    const sheet = lines().flatMap(line => (line.actions ?? []).map((action, index) => `${line.keys[index].join("+")}→${action}`));
    for (const action of Object.keys(EDITOR_KEY_BINDINGS) as EditorShortcutAction[]) {
      for (const combo of EDITOR_KEY_BINDINGS[action]) expect(sheet, `${combo.join("+")} ${action}`).toContain(`${combo.join("+")}→${action}`);
    }
    // The page's keys are made from that table, so a new alias appears by itself: Backspace, Ctrl+Shift+Z and Ctrl+Shift+S were missing before.
    expect(sheet).toEqual(expect.arrayContaining(["Backspace→delete", "Shift+Backspace→lift", "Ctrl+Shift+Z→redo", "Ctrl+Shift+S→save-as"]));
  });

  it("each row describes one action, with aliases only for that same action", () => {
    for (const line of lines().filter(item => item.actions)) {
      expect(new Set(line.actions).size, `${line.group}: ${line.label}`).toBe(1);
    }
    const fit = lines().find(line => line.actions?.[0] === "fit-timeline")!;
    expect(fit.keys).toEqual([["\\"], ["Shift", "Z"]]);
    const sheet = BeginnerShortcutSheet();
    expect(all(sheet, (_props, type) => type === "i").map(props => text(props.children as ReactNode))).toContain("或");
  });

  it("names every word on the page in all five languages", () => {
    const words = [...new Set([...EDITOR_SHORTCUT_GROUPS.map(group => group.title), ...lines().flatMap(line => [line.label, ...(line.gesture ? [line.gesture] : [])])])];
    for (const [name, catalogue] of Object.entries({ en, es, ja, ko })) {
      for (const word of words) expect(catalogue[word], `${name}: ${word}`).toBeTruthy();
    }
  });

  it("groups the keys as 剪輯, 播放, 移動, 檔案 and 滑鼠, in big plain words", () => {
    const row = (line: { keys: string[][]; gesture?: string; label: string }) =>
      `${[line.keys.map(combo => combo.join("+")).join(" / "), line.gesture].filter(Boolean).join(" + ")} ${line.label}`;
    expect(EDITOR_SHORTCUT_GROUPS.map(group => [group.title, group.lines.map(row)])).toEqual([
  [
    "剪輯",
    [
      "B 剪刀",
      "A 選取",
      "Ctrl+B 在播放頭切開",
      "Delete / Backspace 刪除",
      "Shift+Delete / Shift+Backspace 刪除並保留空隙",
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
      "Delete / Backspace 刪除選取的轉場（先點轉場的菱形）",
      "Ctrl+Z 復原",
      "Ctrl+Y / Ctrl+Shift+Z 重做"
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
      "Ctrl+S 存檔",
      "Ctrl+Shift+S 另存新檔",
      "? 隨時打開這一頁"
    ]
  ],
  [
    "滑鼠",
    [
      "Shift + 用剪刀點片段 切開同一時間的所有軌道",
      "Ctrl / Shift + 點片段 多選片段",
      "在軌道空白處拖曳 框選片段",
      "Shift + 拖曳片段邊緣 向內修剪並補上空隙",
      "Ctrl + 拖曳兩段相接的剪接點 一起修剪兩段，總長不變",
      "Alt + 拖曳夾在兩段中間的片段 滑動片段，左右兩段跟著修剪",
      "Alt + 拖曳其他片段 換入點，位置和長度不變",
      "Alt + 拖曳途中按住 暫停吸附",
      "Ctrl + 把素材拖到主畫面軌 覆寫那一段（不按則插入）",
      "右鍵點軌道上的空隙 補上空隙",
      "Ctrl + 轉動滾輪 縮放時間軸",
      "Shift + 轉動滾輪 左右捲動時間軸",
      "雙擊時間尺 顯示整段時間軸"
    ]
  ]
]);
    const sheet = BeginnerShortcutSheet();
    expect(all(sheet, (_props, type) => type === "h3").map(props => text(props.children as ReactNode))).toEqual(["剪輯", "播放", "移動", "檔案", "滑鼠"]);
    expect(all(sheet, (_props, type) => type === "kbd").map(props => text(props.children as ReactNode)).slice(0, 4)).toEqual(["B", "A", "Ctrl", "B"]);
    expect(all(sheet, (_props, type) => type === "dd").map(props => text(props.children as ReactNode))).toContain("刪掉右邊");
  });

  it("speaks the interface language (the keys stay as printed on the keyboard)", async () => {
    await interfacePreferences.setLocale("en");
    const sheet = BeginnerShortcutSheet();
    const words = all(sheet, (_props, type) => type === "dd" || type === "h3").map(props => text(props.children as ReactNode));
    expect(words).toEqual(expect.arrayContaining(["Edit", "Play", "Move", "File", "Mouse", "Blade", "Select", "Split at the playhead", "Delete the left part", "Delete the right part"]));
    expect(words.join(" ")).not.toMatch(/[㐀-鿿]/);
    const gestures = all(sheet, props => props.className === "guide-shortcut-gesture").map(props => text(props.children as ReactNode));
    expect(gestures).toContain("+Click a clip with the blade");
    expect(gestures.join(" ")).not.toMatch(/[㐀-鿿]/);
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

  it("\"?\" opens the guide on the 快捷鍵 page; 說明 still opens it on the four steps (P8)", () => {
    hooks.calls = 0;
    const page = BeginnerGuide({ onClose: () => {}, onChooseMedia: () => {}, initialPage: "shortcuts" });
    expect(all(page, (_props, type) => type === BeginnerShortcutSheet)).toHaveLength(1);
    expect(all(page, props => props["data-testid"] === "guide-shortcuts-tab")[0]["aria-pressed"]).toBe(true);
    hooks.calls = 0;
    const steps = BeginnerGuide({ onClose: () => {}, onChooseMedia: () => {}, initialPage: "steps" });
    expect(all(steps, (_props, type) => type === BeginnerShortcutSheet)).toHaveLength(0);
    expect(all(steps, props => props.className === "guide-card")).toHaveLength(1);
    // The shell's wiring (AST): the "?" key asks for the 快捷鍵 page, both 說明 buttons for the steps, and the guide gets the page.
    const source = ts.createSourceFile("EditorShell.tsx", readFileSync(new URL("./EditorShell.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const opens: string[] = [], helps: string[] = [];
    let guidePage: string | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isIfStatement(node) && node.expression.getText(source).startsWith('event.key === "?"')) {
        const collect = (child: ts.Node) => { if (ts.isCallExpression(child)) opens.push(child.getText(source)); ts.forEachChild(child, collect); };
        collect(node.thenStatement);
      }
      if (ts.isJsxAttribute(node) && node.name.getText(source) === "onHelp" && node.initializer) helps.push(node.initializer.getText(source));
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === "BeginnerGuide") {
        guidePage = node.attributes.properties.filter(ts.isJsxAttribute).find(attribute => attribute.name.getText(source) === "initialPage")?.initializer?.getText(source);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(opens).toEqual(["event.preventDefault()", 'openBeginnerGuide("shortcuts")']);
    expect(helps).toEqual(['{() => openBeginnerGuide("steps")}', '{() => openBeginnerGuide("steps")}']);
    expect(guidePage).toBe("{beginnerGuidePage}");
  });

  it("the 剪掉不要的部分 step names 剪刀 (B) and Delete", () => {
    expect(STEPS[1]).toMatchObject({ title: "剪掉不要的部分" });
    expect(STEPS[1].body).toContain("B");
    expect(STEPS[1].body).toContain("剪刀");
    expect(STEPS[1].body).toContain("Delete");
  });
});
