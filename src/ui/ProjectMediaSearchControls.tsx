import { DEFAULT_PROJECT_MEDIA_FILTER, PROJECT_MEDIA_SEARCH_LIMITS, type ProjectMediaSearchFilter, type ProjectMediaKind, type ProjectMediaSort } from "../domain/projectMediaSearch";
import "./projectMediaSearch.css";

export function ProjectMediaSearchControls({ filter, found, total, error, onChange }: {
  filter: ProjectMediaSearchFilter; found: number; total: number; error?: string; onChange: (filter: ProjectMediaSearchFilter) => void;
}) {
  const active = Boolean(filter.query || filter.kind !== "all" || filter.sort !== "imported");
  return <section className="project-media-search" aria-label="搜尋專案素材">
    <label className="project-media-search-query">搜尋素材<input type="search" aria-label="搜尋專案素材" placeholder="名稱、資料夾、關鍵字" value={filter.query} maxLength={PROJECT_MEDIA_SEARCH_LIMITS.queryCharacters}
      onChange={event => onChange({ ...filter, query: event.target.value })} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onChange({ ...filter, query: "" }); } }}/></label>
    <div className="project-media-search-selects"><label>素材類型<select aria-label="專案素材類型" value={filter.kind} onChange={event => onChange({ ...filter, kind: event.target.value as ProjectMediaKind })}><option value="all">全部</option><option value="video">影片</option><option value="audio">音訊</option><option value="image">圖片</option></select></label>
      <label>排序<select aria-label="專案素材排序" value={filter.sort} onChange={event => onChange({ ...filter, sort: event.target.value as ProjectMediaSort })}><option value="imported">匯入順序</option><option value="name">名稱</option><option value="duration">長度由長到短</option></select></label></div>
    <div className="project-media-search-summary"><output aria-live="polite" data-testid="project-media-search-count">{found} / {total} 份素材</output><button type="button" disabled={!active} onClick={() => onChange({ ...DEFAULT_PROJECT_MEDIA_FILTER })}>清除篩選</button></div>
    {error && <p role="alert">{error}</p>}
  </section>;
}
