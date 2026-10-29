import { EDITOR_KEY_BINDINGS, type EditorShortcutAction } from "../desktop/useEditorShortcuts";
import { useI18n } from "./i18n/interfacePreferences";

/**
 * One line of the guide's 快捷鍵 page: the keys as printed on the keyboard and what they do, in big plain words.
 * `keys` lists aliases, each a combination (Ctrl + B). Every row describes one action.
 * - A key line's keys come from the editor's own key table (useEditorShortcuts' EDITOR_KEY_BINDINGS) and `actions` are
 *   what shortcutAction does with each of them: the tests prove each line does what it says and that every key the editor
 *   answers is on the page, so the page cannot drift from the keys.
 * - A mouse line has a `gesture` (what the hand does, in plain words) and the keys held during it, if any.
 * - `shell` marks a key the editor shell owns rather than shortcutAction ("?" opens this page).
 */
export interface ShortcutLine {
  keys: string[][];
  label: string;
  actions?: EditorShortcutAction[];
  gesture?: string;
  shell?: true;
}

/** An editor key line: its keys printed from EDITOR_KEY_BINDINGS, so a new alias shows up here by itself. */
function keyLine(action: EditorShortcutAction, label: string): ShortcutLine {
  const keys = EDITOR_KEY_BINDINGS[action].map(combo => [...combo]);
  return { keys, label, actions: keys.map(() => action) };
}
/** A mouse line: hold `keys` (one combination each; several are alternatives) and do `gesture`. */
function mouseLine(keys: string[], gesture: string, label: string): ShortcutLine {
  return { keys: keys.map(key => [key]), gesture, label };
}

export const EDITOR_SHORTCUT_GROUPS: ReadonlyArray<{ title: string; lines: ReadonlyArray<ShortcutLine> }> = [
  { title: "剪輯", lines: [
    keyLine("blade-tool", "剪刀"),
    keyLine("select-tool", "選取"),
    keyLine("split", "在播放頭切開"),
    keyLine("delete", "刪除"),
    keyLine("lift", "刪除並保留空隙"),
    keyLine("escape-tool", "取消選取／回到選取"),
    keyLine("delete-left", "刪掉左邊"),
    keyLine("delete-right", "刪掉右邊"),
    keyLine("trim-start", "開頭修到播放頭"),
    keyLine("trim-end", "結尾修到播放頭"),
    keyLine("select-all", "全選片段與字幕"),
    keyLine("select-forward", "選取播放頭之後"),
    keyLine("copy", "複製選取"),
    keyLine("cut", "剪下選取"),
    keyLine("paste", "貼在播放頭"),
    keyLine("duplicate", "接著複製一份"),
    keyLine("find-captions", "尋找取代字幕（時間軸或字幕面板）"),
    keyLine("apply-transition", "在離播放頭最近的剪接點套用上次的轉場"),
    keyLine("delete", "刪除選取的轉場（先點轉場的菱形）"),
    keyLine("undo", "復原"),
    keyLine("redo", "重做"),
  ] },
  { title: "播放", lines: [
    keyLine("play", "播放／暫停"),
    keyLine("frame-back", "上一格"),
    keyLine("frame-forward", "下一格"),
    keyLine("second-back", "往前一秒"),
    keyLine("second-forward", "往後一秒"),
    keyLine("go-start", "回到開頭"),
    keyLine("go-end", "跳到結尾"),
    keyLine("shuttle-back", "倒放"),
    keyLine("pause", "暫停"),
    keyLine("shuttle-forward", "快轉"),
    keyLine("add-marker", "加入標記"),
    keyLine("next-marker", "跳到下一個標記"),
    keyLine("previous-marker", "跳到上一個標記"),
    keyLine("mark-in", "設定入點"),
    keyLine("mark-out", "設定出點"),
    keyLine("clear-marks", "清除入出點"),
    keyLine("go-in", "跳到入點"),
    keyLine("go-out", "跳到出點"),
    keyLine("play-range", "播放入出點範圍"),
    keyLine("previous-edit", "上一個編輯點"),
    keyLine("next-edit", "下一個編輯點"),
  ] },
  { title: "移動", lines: [
    keyLine("nudge-back", "向前移動一格"),
    keyLine("nudge-forward", "向後移動一格"),
    keyLine("nudge-back-ten", "向前移動十格"),
    keyLine("nudge-forward-ten", "向後移動十格"),
    keyLine("zoom-in", "放大時間軸"),
    keyLine("zoom-out", "縮小時間軸"),
    keyLine("fit-timeline", "顯示整段時間軸"),
    keyLine("toggle-snap", "切換吸附（進階模式）"),
  ] },
  { title: "檔案", lines: [
    keyLine("save", "存檔"),
    keyLine("save-as", "另存新檔"),
    { keys: [["?"]], label: "隨時打開這一頁", shell: true },
  ] },
  { title: "滑鼠", lines: [
    mouseLine(["Shift"], "用剪刀點片段", "切開同一時間的所有軌道"),
    mouseLine(["Ctrl", "Shift"], "點片段", "多選片段"),
    mouseLine([], "在軌道空白處拖曳", "框選片段"),
    mouseLine(["Shift"], "拖曳片段邊緣", "向內修剪並補上空隙"),
    mouseLine(["Ctrl"], "拖曳兩段相接的剪接點", "一起修剪兩段，總長不變"),
    mouseLine(["Alt"], "拖曳夾在兩段中間的片段", "滑動片段，左右兩段跟著修剪"),
    mouseLine(["Alt"], "拖曳其他片段", "換入點，位置和長度不變"),
    mouseLine(["Alt"], "拖曳途中按住", "暫停吸附"),
    mouseLine(["Ctrl"], "把素材拖到主畫面軌", "覆寫那一段（不按則插入）"),
    mouseLine([], "右鍵點軌道上的空隙", "補上空隙"),
    mouseLine(["Ctrl"], "轉動滾輪", "縮放時間軸"),
    mouseLine(["Shift"], "轉動滾輪", "左右捲動時間軸"),
    mouseLine([], "雙擊時間尺", "顯示整段時間軸"),
  ] },
];

/** The 快捷鍵 page of the guide (BeginnerGuide), open with 說明 or "?". */
export function BeginnerShortcutSheet() {
  const { t } = useI18n();
  return <div className="guide-shortcut-sheet" data-testid="guide-shortcut-sheet">
    {EDITOR_SHORTCUT_GROUPS.map(group => <section key={group.title} aria-labelledby={`guide-shortcuts-${group.title}`}>
      <h3 id={`guide-shortcuts-${group.title}`}>{t(group.title)}</h3>
      <dl>{group.lines.map(line => <div key={`${line.label}-${line.keys.flat().join("+")}-${line.gesture ?? ""}`} className={line.gesture ? "guide-shortcut-mouse" : undefined}>
        <dt>{line.keys.map((combo, choice) => <span key={combo.join("+")}>{choice > 0 && <i>{t("或")}</i>}
          {combo.map((key, index) => <span key={key}>{index > 0 && <i aria-hidden="true">+</i>}<kbd>{key}</kbd></span>)}</span>)}
          {line.gesture && <span className="guide-shortcut-gesture">{line.keys.length > 0 && <i aria-hidden="true">+</i>}{t(line.gesture)}</span>}</dt>
        <dd>{t(line.label)}</dd>
      </div>)}</dl>
    </section>)}
  </div>;
}
