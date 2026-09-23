import type { ReactNode } from "react";
import type { RecoveryState } from "../desktop/useProjectRecovery";
import { formatTime } from "../lib/format";
import { EDITOR_THEMES, THEME_LABELS, type EditorTheme } from "./theme";

interface ToolbarProps {
  projectName: string;
  hasUserMedia: boolean;
  workspaceMode: "welcome" | "editor";
  theme: EditorTheme;
  onThemeChange: (theme: EditorTheme) => void;
  dirty: boolean;
  recoveryState: RecoveryState;
  playhead: number;
  canUndo: boolean;
  canRedo: boolean;
  isDesktop: boolean;
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onExport: () => void;
  onExportOpenExrSequence?: () => void;
  onExportAlphaMaster?: () => void;
  onOpenAgentConnect: () => void;
  onAutoEdit?: () => void;
  autoEditBusy?: boolean;
  onMobileRemote?: () => void;
  mobileRemoteActive?: boolean;
  mobileRemoteCount?: number;
  onCheckUpdates: () => void;
  onDirectorConsole: () => void;
  onHelp: () => void;
  workspaceControls?: ReactNode;
}

export function Toolbar({
  projectName,
  hasUserMedia,
  workspaceMode,
  theme,
  onThemeChange,
  dirty,
  recoveryState,
  playhead,
  canUndo,
  canRedo,
  isDesktop,
  onNew,
  onOpen,
  onSave,
  onUndo,
  onRedo,
  onExport,
  onExportOpenExrSequence,
  onExportAlphaMaster,
  onOpenAgentConnect,
  onAutoEdit,
  autoEditBusy = false,
  onMobileRemote,
  mobileRemoteActive,
  mobileRemoteCount,
  onCheckUpdates,
  onDirectorConsole,
  onHelp,
  workspaceControls,
}: ToolbarProps) {
  const saveLabel = dirty
    ? recoveryState === "saving" ? "正在保護變更" : "儲存專案"
    : "已安全儲存";

  return (
    <header className="toolbar" data-testid="editor-toolbar">
      <div className="brand-lockup">
        <div className="brand-mark" aria-hidden="true"><span>✦</span></div>
        <div className="brand-copy">
          <strong>Editkin</strong>
          <span>你的自動剪輯工作台</span>
        </div>
      </div>

      <div className="project-flow">
        <div className="project-heading">
          <span className={`status-dot ${dirty ? "dirty" : ""}`} aria-hidden="true" />
          <strong>{projectName}</strong>
          <small>{dirty ? "尚未儲存" : "已儲存"} · {formatTime(playhead)}</small>
        </div>
        <ol className="quick-flow" aria-label="四步完成影片">
          <li className={hasUserMedia ? "done" : "current"} data-flow-step="1"><b>1</b><span>加入素材</span></li>
          <li className={hasUserMedia ? "current" : ""} data-flow-step="2"><b>2</b><span>自動剪輯</span></li>
          <li><b>3</b><span>拖曳微調</span></li>
          <li><b>4</b><span>輸出影片</span></li>
        </ol>
      </div>

      <nav className="toolbar-actions" aria-label="主要操作">
        {workspaceMode === "editor" && <div className="history-actions" aria-label="復原與重做">
          <button type="button" className="round-action" onClick={onUndo} disabled={!canUndo} data-testid="undo-button" title="復原（Ctrl/Cmd+Z）" aria-label="復原">↶</button>
          <button type="button" className="round-action" onClick={onRedo} disabled={!canRedo} data-testid="redo-button" title="重做（Ctrl/Cmd+Shift+Z）" aria-label="重做">↷</button>
        </div>}

        <button type="button" className="secondary-action help-action" onClick={onHelp} data-testid="beginner-guide-button"><span>?</span> 怎麼用</button>
        {workspaceMode === "editor" && onAutoEdit && <button
          type="button"
          className="secondary-action auto-edit-action"
          onClick={onAutoEdit}
          disabled={autoEditBusy || !hasUserMedia}
          title={hasUserMedia ? "分析畫面與語音，自動完成第一版剪輯" : "請先加入自己的影片"}
          data-testid="semantic-edit-button"
          data-beginner-action="一鍵自動完成"
        ><span>✦</span> {autoEditBusy ? "自動剪輯中…" : "自動剪輯"}</button>}
        {workspaceMode === "editor" && <details className="project-menu">
          <summary>更多</summary>
          <div className="project-menu-popover">
            {isDesktop && <button type="button" onClick={onOpenAgentConnect} data-testid="open-agent-connect-button"><span>✦</span><div>連接自動剪輯<small>讓 Video Autopilot 安全操作目前專案</small></div></button>}
            {onMobileRemote && <button type="button" onClick={onMobileRemote} data-testid="mobile-remote-button"><span>▣</span><div>{mobileRemoteCount ? `${mobileRemoteCount} 台已連線` : mobileRemoteActive ? "等待手機" : "手機連線"}<small>掃一次 QR，之後自動連線</small></div></button>}
            <details className="project-menu-group">
              <summary>專案、工作區與進階</summary>
              <div className="project-menu-group-body">
                {workspaceControls}
                <strong>外觀與工作區</strong>
                <div className="theme-control">
                  <span className={`theme-dot ${theme}`} aria-hidden="true" />
                  <label htmlFor="editor-theme">介面配色</label>
                  <select
                    id="editor-theme"
                    value={theme}
                    onChange={(event) => onThemeChange(event.target.value as EditorTheme)}
                    data-testid="theme-select"
                  >
                    {EDITOR_THEMES.map((item) => <option key={item} value={item}>{THEME_LABELS[item]}</option>)}
                  </select>
                </div>
                <button type="button" onClick={(event) => { const menu = event.currentTarget.closest<HTMLDetailsElement>("details.project-menu"); if (menu) menu.open = false; onDirectorConsole(); }} data-testid="director-console-button"><span>◉</span><div>導演台<small>標記重點並集中審片</small></div></button>
                {isDesktop && <>
                  <strong>專案與連線</strong>
                  <button type="button" onClick={onNew} data-testid="new-project-button"><span>＋</span><div>新增空白專案<small>從零開始剪一支影片</small></div></button>
                  <button type="button" onClick={onOpen} data-testid="open-project-button"><span>⌂</span><div>開啟專案<small>繼續之前的工作</small></div></button>
                  <button type="button" onClick={onSave} data-testid="save-project-button" title="儲存（Ctrl/Cmd+S；另存新檔 Ctrl/Cmd+Shift+S）"><span>✓</span><div>{saveLabel}<small>保留目前所有修改</small></div></button>
                  <button type="button" onClick={onCheckUpdates}><span>↥</span><div>檢查更新<small>下載後由你決定是否安裝</small></div></button>
                </>}
                {isDesktop && onExportOpenExrSequence && <>
                  <strong>專業輸出</strong>
                  <button type="button" onClick={onExportOpenExrSequence} disabled={!hasUserMedia} data-testid="render-openexr-sequence-button"><span>▧</span><div>OpenEXR 影格序列<small>場景線性 RGBA32F · 無音訊</small></div></button>
                  {onExportAlphaMaster && <button type="button" onClick={onExportAlphaMaster} disabled={!hasUserMedia} data-testid="render-alpha-master-button"><span>◈</span><div>透明背景 Alpha 主檔<small>ProRes 4444 · 高位元 Alpha · 24-bit PCM</small></div></button>}
                </>}
              </div>
            </details>
          </div>
        </details>}

        {workspaceMode === "editor" && <button type="button" className="primary-button export-action" onClick={onExport} disabled={!hasUserMedia} title={hasUserMedia ? "輸出完成影片" : "請先加入自己的影片"} data-testid="render-button" data-beginner-action="輸出影片">
          <span className="button-step">4</span>{isDesktop ? "輸出影片" : "匯出專案"}
        </button>}
      </nav>
    </header>
  );
}
