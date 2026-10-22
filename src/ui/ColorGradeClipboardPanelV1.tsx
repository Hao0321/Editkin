import type { ColorGradeClipboardStateV1 } from "../application/colorGradeClipboardV1";
import { translateUi as uiText } from "./i18n/interfacePreferences";
export interface ColorGradeClipboardPanelPropsV1 { state: ColorGradeClipboardStateV1; canPaste: boolean; onCopy: () => void; onPaste: () => void }
export function ColorGradeClipboardPanelV1({ state, canPaste, onCopy, onPaste }: ColorGradeClipboardPanelPropsV1) {
  return <div className="grade-v2-panel" data-testid="grade-clipboard-panel">
    <strong>{uiText("複製與貼上調色")}</strong>
    <p>{uiText("複製目前影格的 Primary＋v2，僅在同一專案內使用。")}</p>
    <div className="grade-v2-actions"><button type="button" onClick={onCopy} data-testid="grade-copy-current">{uiText("複製目前影格調色")}</button>
      <button type="button" disabled={!canPaste} onClick={onPaste} data-testid="grade-paste-current">{uiText("貼上調色")}</button></div>
    {state.hasCopy && <small>{uiText("已複製：{value0} · 片段時間 {value1} 秒", { value0: state.sourceName ?? "", value1: (state.localTime ?? 0).toFixed(2) })}</small>}
    <small>{uiText("貼上會取代整段片段的調色與色彩關鍵幀；位置關鍵幀、變速、音量與素材保持不變，可一次復原。")}</small>
  </div>;
}
