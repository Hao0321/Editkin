import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";
import type { WorkspaceLayoutState, WorkspacePreset } from "./workspaceLayout";
import "./workspaceLayout.css";

interface WorkspaceControlsProps {
  layout: WorkspaceLayoutState;
  onPreset: (preset: Exclude<WorkspacePreset, "custom">) => void;
  onPatch: (patch: Partial<WorkspaceLayoutState>) => void;
  onReset: () => void;
}

const PRESETS: Array<{ id: Exclude<WorkspacePreset, "custom">; label: string; detail: string }> = [
  { id: "simple", label: "簡易", detail: "素材＋時間軸" },
  { id: "edit", label: "剪輯", detail: "素材＋屬性" },
  { id: "color", label: "調色", detail: "大預覽＋Scopes" },
  { id: "focus", label: "專注", detail: "只留畫面" },
];

export function WorkspaceControls({ layout, onPreset, onPatch, onReset }: WorkspaceControlsProps) {
  useI18n();
  const currentLabel = layout.preset === "custom" ? "自訂" : PRESETS.find((item) => item.id === layout.preset)?.label;
  return <details className="workspace-controls" data-testid="workspace-controls">
    <summary><span>▦</span><b>{uiText("{name}工作區", { name: uiText(currentLabel ?? "簡易") })}</b></summary>
    <div className="workspace-controls-popover">
      <div className="workspace-controls-heading"><div><strong>{uiText("工作區配置")}</strong><small>{uiText("只顯示現在需要的工具")}</small></div><button type="button" onClick={onReset}>{uiText("恢復簡易")}</button></div>
      <div className="workspace-preset-grid">{PRESETS.map((item) => <button type="button" key={item.id} className={layout.preset === item.id ? "active" : ""} onClick={() => onPreset(item.id)}><b>{uiText(item.label)}</b><small>{uiText(item.detail)}</small></button>)}</div>
      <fieldset><legend>{uiText("顯示面板")}</legend>
        <label><input type="checkbox" checked={layout.mediaVisible} onChange={(event) => onPatch({ mediaVisible: event.target.checked })} />{uiText("素材庫")}</label>
        <label><input type="checkbox" checked={layout.inspectorVisible} onChange={(event) => onPatch({ inspectorVisible: event.target.checked })} />{uiText("屬性面板")}</label>
        <label><input type="checkbox" checked={layout.automationVisible} onChange={(event) => onPatch({ automationVisible: event.target.checked })} />{uiText("自動剪輯")}</label>
        <label><input type="checkbox" checked={layout.timelineVisible} onChange={(event) => onPatch({ timelineVisible: event.target.checked })} />{uiText("時間軸")}</label>
      </fieldset>
      <label className="workspace-text-size">{uiText("介面字級")}<select value={layout.textSize} onChange={(event) => onPatch({ textSize: event.target.value as WorkspaceLayoutState["textSize"] })}><option value="large">{uiText("大字（推薦）")}</option><option value="comfortable">{uiText("標準")}</option></select></label>
      <p>{uiText("拖曳面板之間的分隔線，可調整寬度與高度。")}</p>
    </div>
  </details>;
}
