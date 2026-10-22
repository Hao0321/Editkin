import type { RecoveryState } from "../desktop/useProjectRecovery";
import type { RecentProject } from "../desktop/recentProjects";
import type { ProjectFormat } from "../application/projectFormats";
import { useI18n } from "./i18n/interfacePreferences";
import { InterfaceSettings } from "./InterfaceSettings";
import { saveStateMessage } from "./saveStateLabel";
import { SimpleAppearanceSettings, SimpleProjectSettings } from "./SimpleSettingsSections";
import type { EditorTheme } from "./theme";
import type { WorkspaceTextSize } from "./workspaceLayout";
import "./simpleTopBar.css";
import { EditingBrandMarkV1 } from "./EditingBrandMarkV1";

export interface SimpleEditorTopBarProps {
  projectName: string;
  hasUserMedia: boolean;
  isDesktop: boolean;
  dirty: boolean;
  recoveryState: RecoveryState;
  /** False while the project has never been written to a file (a new or demo project). Defaults to true. */
  hasProjectFile?: boolean;
  canUndo: boolean;
  canRedo: boolean;
  theme: EditorTheme;
  onThemeChange: (theme: EditorTheme) => void;
  textSize?: WorkspaceTextSize;
  onTextSizeChange?: (size: WorkspaceTextSize) => void;
  projectFormat?: { width: number; height: number; onChange: (format: ProjectFormat) => void };
  onUndo: () => void;
  onRedo: () => void;
  /** Desktop: save to the project file. Browser: download the project file. */
  onSave: () => void;
  onSaveAs?: () => void;
  onNew: () => void;
  onOpen: () => void;
  recentProjects?: readonly RecentProject[];
  onOpenRecent?: (path: string) => void;
  onHelp: () => void;
  onExport: () => void;
}

/**
 * The simple editor's one-row top bar: the app mark, the project's name and whether it is saved, then 復原／重做,
 * ⚙ 設定 (language, size, colours, text size, project shape, files, 進階模式), ? 說明 and the one main 輸出影片.
 * Everything else lives in 進階模式, which shows the full toolbar again.
 */
export function SimpleEditorTopBar(props: SimpleEditorTopBarProps) {
  const { t } = useI18n();
  const { projectName, hasUserMedia, isDesktop, dirty, recoveryState, hasProjectFile = true, canUndo, canRedo, onUndo, onRedo, onSave, onHelp, onExport } = props;
  const message = t(saveStateMessage({ mode: "simple", isDesktop, dirty, recoveryState, hasProjectFile }));
  // On the desktop the save state is also the save button while there is something to save; in a browser saving
  // means downloading the project, which is in ⚙ 設定 → 檔案.
  const canSave = isDesktop && (dirty || !hasProjectFile);
  // A browser project never has a file of its own, so there only changes count as unsaved.
  const state = recoveryState === "error" ? "error" : dirty || (isDesktop && !hasProjectFile) ? "unsaved" : "saved";
  const dot = <i className={`status-dot${state === "saved" ? "" : " dirty"}`} data-state={state} aria-hidden="true" />;
  return <header className="toolbar simple-topbar" data-testid="editor-toolbar" data-toolbar-layout="simple">
    <div className="simple-topbar-project">
      <EditingBrandMarkV1 theme={props.theme} />
      <div className="simple-project-copy">
        <strong className="simple-project-name" title={projectName}>{projectName}</strong>
        {canSave
          ? <button type="button" className="simple-save-state" data-state={state} data-testid="save-project-button" onClick={onSave}
            title={t("儲存專案（Ctrl+S）")} aria-keyshortcuts="Control+S Meta+S">{dot}<span data-testid="save-state" title={message}>{message}</span><b>{t("儲存")}</b></button>
          : <span className="simple-save-state" data-state={state}>{dot}<span data-testid="save-state" title={message}>{message}</span></span>}
      </div>
    </div>
    <nav className="toolbar-actions simple-topbar-actions" aria-label={t("主要操作")}>
      <div className="history-actions" role="group" aria-label={t("復原與重做")}>
        <button type="button" className="simple-icon-action" onClick={onUndo} disabled={!canUndo} data-testid="undo-button"
          aria-label={t("復原")} title={t("復原（Ctrl/Cmd+Z）")} aria-keyshortcuts="Control+Z Meta+Z"><span aria-hidden="true">↶</span></button>
        <button type="button" className="simple-icon-action" onClick={onRedo} disabled={!canRedo} data-testid="redo-button"
          aria-label={t("重做")} title={t("重做（Ctrl/Cmd+Shift+Z）")} aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z"><span aria-hidden="true">↷</span></button>
      </div>
      <InterfaceSettings label={t("設定")}
        appearance={<SimpleAppearanceSettings theme={props.theme} onThemeChange={props.onThemeChange} textSize={props.textSize} onTextSizeChange={props.onTextSizeChange} />}>
        <SimpleProjectSettings isDesktop={isDesktop} projectFormat={props.projectFormat} onOpen={props.onOpen} onNew={props.onNew} onSaveAs={props.onSaveAs}
          onDownload={isDesktop ? undefined : onSave} recentProjects={props.recentProjects} onOpenRecent={props.onOpenRecent} />
      </InterfaceSettings>
      <button type="button" className="secondary-action help-action simple-help-action" onClick={onHelp} data-testid="beginner-guide-button" title={t("快速教學")}>
        <span aria-hidden="true">?</span>{t("說明")}</button>
      <button type="button" className="primary-button export-action" onClick={onExport} disabled={isDesktop && !hasUserMedia}
        title={t(!isDesktop ? "網頁版無法輸出影片；可下載專案繼續編輯。影片輸出需要桌面版。" : hasUserMedia ? "輸出完成影片" : "請先加入自己的影片")} data-testid="render-button">
        <span aria-hidden="true">↑</span>{t(isDesktop ? "輸出影片" : "匯出專案")}</button>
    </nav>
  </header>;
}
