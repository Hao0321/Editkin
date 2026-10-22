import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";
import { DEFAULT_PROJECT_MEDIA_FILTER, PROJECT_MEDIA_SEARCH_LIMITS, type ProjectMediaSearchFilter, type ProjectMediaKind, type ProjectMediaSort } from "../domain/projectMediaSearch";
import { useEffect, useRef, useState } from "react";
import "./projectMediaSearch.css";

/** Up to this many project assets, the search waits behind one small 「搜尋素材」 button so the clips stay in view. */
export const PROJECT_MEDIA_SEARCH_FOLD_MAX = 6;

/** Whether the full search block shows: a project with more than six assets, a filter in use, or the creator asked. */
export function projectMediaSearchExpanded(total: number, filter: ProjectMediaSearchFilter, opened: boolean): boolean {
  return total > PROJECT_MEDIA_SEARCH_FOLD_MAX || projectMediaFilterActive(filter) || opened;
}

export function projectMediaFilterActive(filter: ProjectMediaSearchFilter): boolean {
  return Boolean(filter.query || filter.kind !== "all" || filter.sort !== "imported");
}

const SearchIcon = () => <svg className="project-media-search-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
  <circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" strokeWidth="2.2" /><path d="M15.2 15.2 20 20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
</svg>;

export function ProjectMediaSearchControls({ filter, found, total, error, onChange }: {
  filter: ProjectMediaSearchFilter; found: number; total: number; error?: string; onChange: (filter: ProjectMediaSearchFilter) => void;
}) {
  useI18n();
  const active = projectMediaFilterActive(filter);
  const [opened, setOpened] = useState(false);
  const queryInput = useRef<HTMLInputElement>(null);
  const openButton = useRef<HTMLButtonElement>(null);
  // Opening moves the cursor into the search box; folding it again returns focus to the button.
  const focusNext = useRef<"query" | "button" | undefined>(undefined);
  const expanded = projectMediaSearchExpanded(total, filter, opened);
  useEffect(() => {
    const target = focusNext.current;
    focusNext.current = undefined;
    if (target === "query") queryInput.current?.focus();
    else if (target === "button") openButton.current?.focus();
  }, [expanded]);
  if (!expanded) {
    // Nothing to search yet: no button at all.
    if (total === 0) return null;
    return <section className="project-media-search" data-collapsed="true" aria-label={uiText("搜尋專案素材")}>
      <button ref={openButton} type="button" className="project-media-search-open" data-testid="project-media-search-open" aria-expanded="false"
        onClick={() => { focusNext.current = "query"; setOpened(true); }}><SearchIcon />{uiText("搜尋素材")}</button>
    </section>;
  }
  // The creator opened it for a short list and no filter is in use: it can fold away again.
  const foldable = total <= PROJECT_MEDIA_SEARCH_FOLD_MAX && !active;
  return <section className="project-media-search" aria-label={uiText("搜尋專案素材")}>
    <label className="project-media-search-query">{uiText("搜尋素材")}<input ref={queryInput} type="search" aria-label={uiText("搜尋專案素材")} placeholder={uiText("名稱、資料夾、關鍵字")} value={filter.query} maxLength={PROJECT_MEDIA_SEARCH_LIMITS.queryCharacters}
      onChange={event => onChange({ ...filter, query: event.target.value })} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onChange({ ...filter, query: "" }); } }}/></label>
    <div className="project-media-search-selects"><label>{uiText("素材類型")}<select aria-label={uiText("專案素材類型")} value={filter.kind} onChange={event => onChange({ ...filter, kind: event.target.value as ProjectMediaKind })}><option value="all">{uiText("全部")}</option><option value="video">{uiText("影片")}</option><option value="audio">{uiText("音訊")}</option><option value="image">{uiText("圖片")}</option></select></label>
      <label>{uiText("排序")}<select aria-label={uiText("專案素材排序")} value={filter.sort} onChange={event => onChange({ ...filter, sort: event.target.value as ProjectMediaSort })}><option value="imported">{uiText("匯入順序")}</option><option value="name">{uiText("名稱")}</option><option value="duration">{uiText("長度由長到短")}</option></select></label></div>
    <div className="project-media-search-summary"><output aria-live="polite" data-testid="project-media-search-count">{found} / {total} {uiText("份素材")}</output>
      <span className="project-media-search-actions"><button type="button" disabled={!active} onClick={() => onChange({ ...DEFAULT_PROJECT_MEDIA_FILTER })}>{uiText("清除篩選")}</button>
        {foldable && <button type="button" data-testid="project-media-search-close" aria-expanded="true" onClick={() => { focusNext.current = "button"; setOpened(false); }}>{uiText("收起搜尋")}</button>}</span></div>
    {error && <p role="alert">{error}</p>}
  </section>;
}
