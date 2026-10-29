import type { MouseEvent } from "react";
import { PROJECT_FORMATS, type ProjectFormat } from "../application/projectFormats";
import { recentProjectFolder, type RecentProject } from "../desktop/recentProjects";
import { useI18n } from "./i18n/interfacePreferences";
import { EDITOR_THEMES, THEME_LABELS, type EditorTheme } from "./theme";
import type { WorkspaceTextSize } from "./workspaceLayout";
import "./simpleSettings.css";

export interface SimpleAppearanceSettingsProps {
  theme: EditorTheme;
  onThemeChange: (theme: EditorTheme) => void;
  textSize?: WorkspaceTextSize;
  onTextSizeChange?: (size: WorkspaceTextSize) => void;
}

/** 介面配色 and 介面字級, next to the language and size in the simple editor's ⚙ 設定. */
export function SimpleAppearanceSettings({ theme, onThemeChange, textSize, onTextSizeChange }: SimpleAppearanceSettingsProps) {
  const { t } = useI18n();
  return <>
    <label>{t("介面配色")}<select data-testid="theme-select" value={theme} onChange={event => onThemeChange(event.currentTarget.value as EditorTheme)}>
      {EDITOR_THEMES.map(item => <option key={item} value={item}>{t(THEME_LABELS[item])}</option>)}
    </select></label>
    {onTextSizeChange && <label>{t("介面字級")}<select data-testid="text-size-select" value={textSize ?? "large"}
      onChange={event => onTextSizeChange(event.currentTarget.value === "comfortable" ? "comfortable" : "large")}>
      <option value="large">{t("大字（推薦）")}</option><option value="comfortable">{t("標準")}</option>
    </select></label>}
  </>;
}

export interface SimpleProjectSettingsProps {
  isDesktop: boolean;
  projectFormat?: { width: number; height: number; onChange: (format: ProjectFormat) => void };
  onOpen: () => void;
  onNew: () => void;
  /** Desktop: a copy under a new name; the open file is never overwritten. */
  onSaveAs?: () => void;
  /** Browser only: the project file is downloaded (there is no autosave in a browser). */
  onDownload?: () => void;
  recentProjects?: readonly RecentProject[];
  onOpenRecent?: (path: string) => void;
}

/** Closes the ⚙ popover before an action that opens a dialog or replaces the project, so nothing is left over it. */
function closeSettings(event: MouseEvent<HTMLElement>) {
  const menu = event.currentTarget.closest<HTMLDetailsElement>("details.interface-settings");
  if (menu) menu.open = false;
}

/** 專案比例 and 檔案 in the simple editor's ⚙ 設定 (in advanced mode they stay in the footer and the 檔案 menu). */
export function SimpleProjectSettings({ isDesktop, projectFormat, onOpen, onNew, onSaveAs, onDownload, recentProjects = [], onOpenRecent }: SimpleProjectSettingsProps) {
  const { t } = useI18n();
  const recent = isDesktop && onOpenRecent ? recentProjects : [];
  return <>
    {projectFormat && <section className="simple-settings-section" aria-labelledby="simple-settings-format" data-testid="project-format-control"
      data-project-width={projectFormat.width} data-project-height={projectFormat.height}>
      <h3 id="simple-settings-format">{t("專案比例")}</h3>
      <p>{t("只改畫布，不破壞原素材；可再到檢查器調整裁切與位置。")}</p>
      <div className="simple-format-grid" role="group" aria-label={t("專案比例")}>
        {PROJECT_FORMATS.map(format => {
          const active = projectFormat.width === format.width && projectFormat.height === format.height;
          return <button type="button" key={format.id} aria-pressed={active} data-testid={`project-format-${format.id}`}
            title={`${format.ratio} ${t(format.label)} · ${format.width}×${format.height}`}
            onClick={() => { if (!active) projectFormat.onChange(format); }}>
            <b>{format.ratio}</b><span>{t(format.label)}</span>
          </button>;
        })}
      </div>
    </section>}
    <section className="simple-settings-section" aria-labelledby="simple-settings-files">
      <h3 id="simple-settings-files">{t("檔案")}</h3>
      <div className="simple-file-actions">
        <button type="button" data-testid="open-project-button" onClick={event => { closeSettings(event); onOpen(); }}>{t("開啟專案")}</button>
        {isDesktop && onSaveAs && <button type="button" data-testid="save-as-project-button" onClick={event => { closeSettings(event); onSaveAs(); }}>{t("另存新檔")}</button>}
        {!isDesktop && onDownload && <button type="button" data-testid="save-project-button" title={t("送出下載；不會標記已儲存，也沒有 Autosave。")}
          onClick={event => { closeSettings(event); onDownload(); }}>{t("下載專案")}</button>}
        <button type="button" data-testid="new-project-button" onClick={event => { closeSettings(event); onNew(); }}>{t("新增空白專案")}</button>
      </div>
      {isDesktop && onOpenRecent && <div className="simple-recent" role="group" aria-label={t("最近的作品")}>
        <strong>{t("最近的作品")}</strong>
        {recent.length ? recent.map((item, index) => <button type="button" key={item.path} data-testid={`recent-project-${index}`} title={item.path}
          onClick={event => { closeSettings(event); onOpenRecent(item.path); }}>
          <b>{item.name}</b><small>{recentProjectFolder(item.path)} · {new Date(item.openedAt).toLocaleDateString()}</small>
        </button>) : <p>{t("存過或打開過的專案會出現在這裡")}</p>}
      </div>}
    </section>
  </>;
}
