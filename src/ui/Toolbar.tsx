import type { ReactNode, MouseEvent } from "react";
import type { RecoveryState } from "../desktop/useProjectRecovery";
import { formatTime } from "../lib/format";
import { EDITOR_THEMES, THEME_LABELS, type EditorTheme } from "./theme";
import { InterfaceSettings } from "./InterfaceSettings";
import { FileMenu } from "./FileMenu";
import type { RecentProject } from "../desktop/recentProjects";
import type { ProjectFormat } from "../application/projectFormats";
import { useI18n } from "./i18n/interfacePreferences";
import { SimpleEditorTopBar } from "./SimpleEditorTopBar";
import type { WorkspaceTextSize } from "./workspaceLayout";
import { EditingBrandMarkV1 } from "./EditingBrandMarkV1";

interface ToolbarProps {
  projectName: string; hasUserMedia: boolean; workspaceMode: "welcome" | "editor";
  theme: EditorTheme; onThemeChange: (theme: EditorTheme) => void;
  dirty: boolean; recoveryState: RecoveryState; playhead: number; canUndo: boolean; canRedo: boolean; isDesktop: boolean;
  /** False while the project has never been written to a file (a new or demo project). Defaults to true. */
  hasProjectFile?: boolean;
  onNew: () => void; onOpen: () => void; onSave: () => void; onUndo: () => void; onRedo: () => void; onExport: () => void;
  onExportOpenExrSequence?: () => void; onExportAlphaMaster?: () => void; onOpenAgentConnect: () => void;
  onAutoEdit?: () => void; autoEditLabel?: string; autoEditBusy?: boolean; autoEditUnavailableReason?: string;
  onMobileRemote?: () => void; mobileRemoteActive?: boolean; mobileRemoteCount?: number;
  onCheckUpdates: () => void; onDirectorConsole?: () => void; onHelp: () => void; workspaceControls?: ReactNode;
  onAddMedia?: () => void; onEdit?: () => void; onReview?: () => void; reviewing?: boolean;
  /** The 檔案 menu: Save As and the recent projects, where people can see them. */
  onSaveAs?: () => void; recentProjects?: readonly RecentProject[]; onOpenRecent?: (path: string) => void;
  /** Simple mode's ⚙ 設定 holds these (advanced mode keeps them in 更多工具 and the footer). */
  textSize?: WorkspaceTextSize; onTextSizeChange?: (size: WorkspaceTextSize) => void;
  projectFormat?: { width: number; height: number; onChange: (format: ProjectFormat) => void };
}

export function Toolbar(props: ToolbarProps) {
  const { t, mode } = useI18n();
  // Simple mode's editor gets the calm one-row bar; the start screen and advanced mode keep this full toolbar.
  if (mode === "simple" && props.workspaceMode === "editor") return <SimpleEditorTopBar {...props} />;
  const { projectName, hasUserMedia, workspaceMode, theme, onThemeChange, dirty, recoveryState, playhead,
    canUndo, canRedo, isDesktop, onNew, onOpen, onSave, onUndo, onRedo, onExport, onExportOpenExrSequence,
    onExportAlphaMaster, onOpenAgentConnect, onAutoEdit, autoEditLabel, autoEditBusy, autoEditUnavailableReason,
    onMobileRemote, mobileRemoteActive, mobileRemoteCount, onCheckUpdates, onHelp,
    workspaceControls, onAddMedia, onEdit, hasProjectFile = true, onSaveAs, recentProjects, onOpenRecent } = props;
  // Unchanged is not saved: a project without a file has nothing on disk yet.
  const neverSaved = isDesktop && !dirty && !hasProjectFile;
  const editor = workspaceMode === "editor";
  const saveLabel = !isDesktop ? "送出下載；不會標記已儲存，也沒有 Autosave。" : dirty ? recoveryState === "saving" ? "正在保護變更" : "儲存專案" : neverSaved ? "儲存專案" : "已安全儲存";
  const currentStep = !editor ? 1 : 2;
  const closeMenu = (event: MouseEvent<HTMLElement>) => {
    const menu = event.currentTarget.closest<HTMLDetailsElement>("details.project-menu");
    if (menu) menu.open = false;
  };
  return <header className="toolbar" data-testid="editor-toolbar">
    <div className="brand-lockup"><EditingBrandMarkV1 theme={theme} /><div className="brand-copy"><strong>Editkin</strong><span>{t("你的影片工作台")}</span></div></div>
    <div className="project-flow">
      {editor && <div className="project-heading"><span className={`status-dot ${dirty || neverSaved ? "dirty" : ""}`} aria-hidden="true" />
        <strong title={projectName}>{projectName}</strong><small>{t(dirty ? "尚未儲存" : neverSaved ? "還沒存成專案檔" : isDesktop ? "已儲存" : "網頁版請下載專案")} · {formatTime(playhead)}</small></div>}
      <ol className="quick-flow" aria-label={t("三步完成影片")}>
        {[
          { label: "加入影片", action: onAddMedia, enabled: true },
          { label: "剪輯", action: onEdit, enabled: editor },
          { label: "輸出", action: onExport, enabled: editor && (!isDesktop || hasUserMedia) },
        ].map((step, index) => <li key={step.label} data-flow-step={index + 1} className={currentStep === index + 1 ? "current" : ""}>
          <button type="button" onClick={step.action} disabled={!step.enabled} data-testid={`flow-step-${index + 1}`} aria-current={currentStep === index + 1 ? "step" : undefined}>
            <b aria-hidden="true">{index + 1}</b><span>{t(step.label)}</span>
          </button>
        </li>)}
      </ol>
    </div>
    <nav className="toolbar-actions" aria-label={t("主要操作")}>
      <InterfaceSettings />
      {editor && <div className="history-actions" aria-label={t("復原與重做")}>
        <button type="button" className="secondary-action" onClick={onUndo} disabled={!canUndo} data-testid="undo-button" title={t("復原（Ctrl/Cmd+Z）")}><span aria-hidden="true">↶</span>{t("復原")}</button>
        <button type="button" className="secondary-action" onClick={onRedo} disabled={!canRedo} data-testid="redo-button" title={t("重做（Ctrl/Cmd+Shift+Z）")}><span aria-hidden="true">↷</span>{t("重做")}</button>
      </div>}
      <FileMenu isDesktop={isDesktop} editor={editor} onNew={onNew} onOpen={onOpen} onSaveAs={onSaveAs} recentProjects={recentProjects} onOpenRecent={onOpenRecent} />
      {editor && <button type="button" className="secondary-action save-action" onClick={onSave} data-testid="save-project-button" title={t(saveLabel)}><span aria-hidden="true">✓</span>{t(isDesktop ? "儲存" : "下載專案")}</button>}
      <button type="button" className="secondary-action help-action" onClick={onHelp} data-testid="beginner-guide-button"><span aria-hidden="true">?</span>{t("快速教學")}</button>
      <details className="project-menu">
        <summary>{t("更多工具")}</summary>
        <div className="project-menu-popover">
          {editor && onAutoEdit && <button type="button" onClick={event => { closeMenu(event); onAutoEdit(); }}
            disabled={autoEditBusy || (!hasUserMedia && !autoEditLabel) || Boolean(autoEditUnavailableReason)}
            title={autoEditUnavailableReason ? t(autoEditUnavailableReason) : t("剪停頓、排節奏、加可編輯字幕；完成後可再調整。")}
            data-testid="semantic-edit-button"><span aria-hidden="true">✦</span><div>{autoEditBusy ? t("正在粗剪…") : autoEditLabel ? t(autoEditLabel) : t("先做一版粗剪")}<small>{t("剪停頓、排節奏、加可編輯字幕；完成後可再調整。")}</small></div></button>}
          {isDesktop && <button type="button" onClick={event => { closeMenu(event); onOpenAgentConnect(); }} data-testid="open-agent-connect-button"><span aria-hidden="true">✦</span><div>{t("連接 AI 助手")}<small>{t("使用自己的 Codex／Claude 訂閱")}</small></div></button>}
          {onMobileRemote && <button type="button" onClick={event => { closeMenu(event); onMobileRemote(); }} data-testid="mobile-remote-button"><span aria-hidden="true">▣</span><div>{mobileRemoteCount ? t("{count} 台已連線", { count: mobileRemoteCount }) : t(mobileRemoteActive ? "等待手機" : "手機連線")}<small>{t("掃描 QR 碼並確認連線")}</small></div></button>}
          <div className="project-menu-group-body">
            <strong>{t("外觀與工作區")}</strong>{workspaceControls}
            <div className="theme-control"><span className={`theme-dot ${theme}`} aria-hidden="true" /><label htmlFor="editor-theme">{t("介面配色")}</label>
              <select id="editor-theme" value={theme} onChange={event => onThemeChange(event.currentTarget.value as EditorTheme)} data-testid="theme-select">{EDITOR_THEMES.map(item => <option key={item} value={item}>{t(THEME_LABELS[item])}</option>)}</select>
            </div>
            {isDesktop && <button type="button" onClick={event => { closeMenu(event); onCheckUpdates(); }}><span aria-hidden="true">↥</span><div>{t("檢查更新")}<small>{t("下載後由你決定是否安裝")}</small></div></button>}
            {isDesktop && onExportOpenExrSequence && <><strong>{t("專業輸出")}</strong>
              <button type="button" onClick={event => { closeMenu(event); onExportOpenExrSequence(); }} disabled={!hasUserMedia} data-testid="render-openexr-sequence-button"><span aria-hidden="true">▧</span><div>{t("OpenEXR 影格序列")}<small>{t("場景線性 RGBA32F · 無音訊")}</small></div></button>
              {onExportAlphaMaster && <button type="button" onClick={event => { closeMenu(event); onExportAlphaMaster(); }} disabled={!hasUserMedia} data-testid="render-alpha-master-button"><span aria-hidden="true">◈</span><div>{t("透明背景 Alpha 主檔")}<small>ProRes 4444 · Alpha · 24-bit PCM</small></div></button>}
            </>}
          </div>
        </div>
      </details>
      {editor && <button type="button" className="primary-button export-action" onClick={onExport} disabled={isDesktop && !hasUserMedia}
        title={t(!isDesktop ? "網頁版無法輸出影片；可下載專案繼續編輯。影片輸出需要桌面版。" : hasUserMedia ? "輸出完成影片" : "請先加入自己的影片")} data-testid="render-button"><span aria-hidden="true">↑</span>{t(isDesktop ? "輸出影片" : "匯出專案")}</button>}
    </nav>
  </header>;
}
