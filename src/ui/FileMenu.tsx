import { useEffect, useRef, type MouseEvent } from "react";
import { useI18n } from "./i18n/interfacePreferences";
import { recentProjectFolder, type RecentProject } from "../desktop/recentProjects";
import "./fileMenu.css";

export interface FileMenuProps {
  isDesktop: boolean;
  editor: boolean;
  onNew: () => void;
  onOpen: () => void;
  /** 「另存新檔」: always a new file; never overwrites the open one. */
  onSaveAs?: () => void;
  recentProjects?: readonly RecentProject[];
  onOpenRecent?: (path: string) => void;
}

/** One visible place for files: open, save a copy, start new, and the recent projects. */
export function FileMenu({ isDesktop, editor, onNew, onOpen, onSaveAs, recentProjects = [], onOpenRecent }: FileMenuProps) {
  const { t } = useI18n();
  const details = useRef<HTMLDetailsElement>(null);
  // A click anywhere else closes the menu, so it never stays open over the editor.
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const menu = details.current;
      if (menu?.open && event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  const close = (event?: MouseEvent<HTMLElement>) => {
    const menu = event?.currentTarget.closest<HTMLDetailsElement>("details.file-menu") ?? details.current;
    if (menu) menu.open = false;
  };
  const recent = isDesktop && onOpenRecent ? recentProjects : [];
  return <details ref={details} className="project-menu file-menu" data-testid="file-menu" onKeyDown={event => {
    if (event.key === "Escape" && details.current?.open) {
      event.preventDefault(); event.stopPropagation(); close(); details.current.querySelector("summary")?.focus();
    }
  }}>
    <summary>{t("檔案")}</summary>
    <div className="project-menu-popover file-menu-popover">
      <button type="button" onClick={event => { close(event); onOpen(); }} data-testid="open-project-button"><span aria-hidden="true">⌂</span><div>{t("開啟專案")}<small>{t("繼續之前的工作")}</small></div></button>
      {isDesktop && editor && onSaveAs && <button type="button" onClick={event => { close(event); onSaveAs(); }} data-testid="save-as-project-button"><span aria-hidden="true">⧉</span><div>{t("另存新檔")}<small>{t("把這個專案另外存一份，原本的檔案不變")}</small></div></button>}
      <button type="button" onClick={event => { close(event); onNew(); }} data-testid="new-project-button"><span aria-hidden="true">＋</span><div>{t("新增空白專案")}<small>{t("從零開始剪一支影片")}</small></div></button>
      {isDesktop && onOpenRecent && <section className="file-menu-recent" aria-label={t("最近的作品")}>
        <strong>{t("最近的作品")}</strong>
        {recent.length ? recent.map((item, index) => <button type="button" key={item.path} data-testid={`recent-project-${index}`} title={item.path}
          onClick={event => { close(event); onOpenRecent(item.path); }}>
          <span aria-hidden="true">▤</span><div><b>{item.name}</b><small>{recentProjectFolder(item.path)} · {new Date(item.openedAt).toLocaleDateString()}</small></div>
        </button>) : <p className="file-menu-empty">{t("存過或打開過的專案會出現在這裡")}</p>}
      </section>}
    </div>
  </details>;
}
