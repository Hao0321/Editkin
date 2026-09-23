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
  const currentLabel = layout.preset === "custom" ? "自訂" : PRESETS.find((item) => item.id === layout.preset)?.label;
  return <details className="workspace-controls" data-testid="workspace-controls">
    <summary><span>▦</span><b>{currentLabel}工作區</b></summary>
    <div className="workspace-controls-popover">
      <div className="workspace-controls-heading"><div><strong>工作區配置</strong><small>只顯示現在需要的工具</small></div><button type="button" onClick={onReset}>恢復簡易</button></div>
      <div className="workspace-preset-grid">{PRESETS.map((item) => <button type="button" key={item.id} className={layout.preset === item.id ? "active" : ""} onClick={() => onPreset(item.id)}><b>{item.label}</b><small>{item.detail}</small></button>)}</div>
      <fieldset><legend>顯示面板</legend>
        <label><input type="checkbox" checked={layout.mediaVisible} onChange={(event) => onPatch({ mediaVisible: event.target.checked })} />素材庫</label>
        <label><input type="checkbox" checked={layout.inspectorVisible} onChange={(event) => onPatch({ inspectorVisible: event.target.checked })} />屬性面板</label>
        <label><input type="checkbox" checked={layout.automationVisible} onChange={(event) => onPatch({ automationVisible: event.target.checked })} />自動剪輯</label>
        <label><input type="checkbox" checked={layout.timelineVisible} onChange={(event) => onPatch({ timelineVisible: event.target.checked })} />時間軸</label>
      </fieldset>
      <label className="workspace-text-size">介面字級<select value={layout.textSize} onChange={(event) => onPatch({ textSize: event.target.value as WorkspaceLayoutState["textSize"] })}><option value="large">大字（推薦）</option><option value="comfortable">標準</option></select></label>
      <p>拖曳面板邊界即可改寬度與時間軸高度，配置會自動保存。</p>
    </div>
  </details>;
}
