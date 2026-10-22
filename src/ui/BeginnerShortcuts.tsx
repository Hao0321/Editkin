import type { EditorShortcutAction } from "../desktop/useEditorShortcuts";
import { useI18n } from "./i18n/interfacePreferences";

/**
 * One line of the guide's 快捷鍵 page: the keys as printed on the keyboard and what they do, in big plain words.
 * `keys` lists aliases for one action, each a combination (Ctrl + B). Every row describes one action.
 * `actions` are what the editor's key owner does with them (useEditorShortcuts' shortcutAction): the test proves each
 * line does what it says, so the page cannot drift from the keys.
 */
export interface ShortcutLine {
  keys: string[][];
  label: string;
  actions?: EditorShortcutAction[];
}

export const EDITOR_SHORTCUT_GROUPS: ReadonlyArray<{ title: string; lines: ReadonlyArray<ShortcutLine> }> = [
  { title: "剪輯", lines: [
    { keys: [["B"]], label: "剪刀", actions: ["blade-tool"] },
    { keys: [["A"]], label: "選取", actions: ["select-tool"] },
    { keys: [["Ctrl", "B"]], label: "在播放頭切開", actions: ["split"] },
    { keys: [["Delete"]], label: "刪除", actions: ["delete"] },
    { keys: [["Shift", "Delete"]], label: "刪除並保留空隙", actions: ["lift"] },
    { keys: [["Esc"]], label: "取消選取／回到選取", actions: ["escape-tool"] },
    { keys: [["Q"]], label: "刪掉左邊", actions: ["delete-left"] },
    { keys: [["W"]], label: "刪掉右邊", actions: ["delete-right"] },
    { keys: [["["]], label: "開頭修到播放頭", actions: ["trim-start"] },
    { keys: [["]"]], label: "結尾修到播放頭", actions: ["trim-end"] },
    { keys: [["Ctrl", "A"]], label: "全選片段與字幕", actions: ["select-all"] },
    { keys: [["Ctrl", "Shift", "A"]], label: "選取播放頭之後", actions: ["select-forward"] },
    { keys: [["Ctrl", "C"]], label: "複製選取", actions: ["copy"] },
    { keys: [["Ctrl", "X"]], label: "剪下選取", actions: ["cut"] },
    { keys: [["Ctrl", "V"]], label: "貼在播放頭", actions: ["paste"] },
    { keys: [["Ctrl", "D"]], label: "接著複製一份", actions: ["duplicate"] },
    { keys: [["Ctrl", "H"]], label: "尋找取代字幕（時間軸或字幕面板）", actions: ["find-captions"] },
    { keys: [["Ctrl", "T"]], label: "在離播放頭最近的剪接點套用上次的轉場", actions: ["apply-transition"] },
    { keys: [["Delete"]], label: "刪除選取的轉場（先點轉場的菱形）", actions: ["delete"] },
    { keys: [["Ctrl", "Z"]], label: "復原", actions: ["undo"] },
    { keys: [["Ctrl", "Y"]], label: "重做", actions: ["redo"] },
  ] },
  { title: "播放", lines: [
    { keys: [["Space"]], label: "播放／暫停", actions: ["play"] },
    { keys: [["←"]], label: "上一格", actions: ["frame-back"] },
    { keys: [["→"]], label: "下一格", actions: ["frame-forward"] },
    { keys: [["Shift", "←"]], label: "往前一秒", actions: ["second-back"] },
    { keys: [["Shift", "→"]], label: "往後一秒", actions: ["second-forward"] },
    { keys: [["Home"]], label: "回到開頭", actions: ["go-start"] },
    { keys: [["End"]], label: "跳到結尾", actions: ["go-end"] },
    { keys: [["J"]], label: "倒放", actions: ["shuttle-back"] },
    { keys: [["K"]], label: "暫停", actions: ["pause"] },
    { keys: [["L"]], label: "快轉", actions: ["shuttle-forward"] },
    { keys: [["M"]], label: "加入標記", actions: ["add-marker"] },
    { keys: [["Shift", "M"]], label: "跳到下一個標記", actions: ["next-marker"] },
    { keys: [["Ctrl", "Shift", "M"]], label: "跳到上一個標記", actions: ["previous-marker"] },
    { keys: [["I"]], label: "設定入點", actions: ["mark-in"] },
    { keys: [["O"]], label: "設定出點", actions: ["mark-out"] },
    { keys: [["Alt", "X"]], label: "清除入出點", actions: ["clear-marks"] },
    { keys: [["Shift", "I"]], label: "跳到入點", actions: ["go-in"] },
    { keys: [["Shift", "O"]], label: "跳到出點", actions: ["go-out"] },
    { keys: [["/"]], label: "播放入出點範圍", actions: ["play-range"] },
    { keys: [["↑"]], label: "上一個編輯點", actions: ["previous-edit"] },
    { keys: [["↓"]], label: "下一個編輯點", actions: ["next-edit"] },
  ] },
  { title: "移動", lines: [
    { keys: [["Alt", "←"]], label: "向前移動一格", actions: ["nudge-back"] },
    { keys: [["Alt", "→"]], label: "向後移動一格", actions: ["nudge-forward"] },
    { keys: [["Alt", "Shift", "←"]], label: "向前移動十格", actions: ["nudge-back-ten"] },
    { keys: [["Alt", "Shift", "→"]], label: "向後移動十格", actions: ["nudge-forward-ten"] },
    { keys: [["="]], label: "放大時間軸", actions: ["zoom-in"] },
    { keys: [["-"]], label: "縮小時間軸", actions: ["zoom-out"] },
    { keys: [["\\"], ["Shift", "Z"]], label: "顯示整段時間軸", actions: ["fit-timeline", "fit-timeline"] },
    { keys: [["N"]], label: "切換吸附（進階模式）", actions: ["toggle-snap"] },
  ] },
  { title: "檔案", lines: [
    { keys: [["Ctrl", "S"]], label: "存檔", actions: ["save"] },
  ] },
];

/** The 快捷鍵 page of the guide (BeginnerGuide), open with 說明 or "?". */
export function BeginnerShortcutSheet() {
  const { t } = useI18n();
  return <div className="guide-shortcut-sheet" data-testid="guide-shortcut-sheet">
    {EDITOR_SHORTCUT_GROUPS.map(group => <section key={group.title} aria-labelledby={`guide-shortcuts-${group.title}`}>
      <h3 id={`guide-shortcuts-${group.title}`}>{t(group.title)}</h3>
      <dl>{group.lines.map(line => <div key={`${line.label}-${line.keys.flat().join("+")}`}>
        <dt>{line.keys.map((combo, choice) => <span key={combo.join("+")}>{choice > 0 && <i>{t("或")}</i>}
          {combo.map((key, index) => <span key={key}>{index > 0 && <i aria-hidden="true">+</i>}<kbd>{key}</kbd></span>)}</span>)}</dt>
        <dd>{t(line.label)}</dd>
      </div>)}</dl>
    </section>)}
  </div>;
}
