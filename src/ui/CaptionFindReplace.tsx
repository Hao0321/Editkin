import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { EditProject } from "../domain/types";
import type { EditorCommand } from "../domain/commandTypes";
import { captionTrackLocked } from "../domain/trackLock";
import { captionTextMatchRangesV1, currentCaptionTextReplacementCommandV1, findCaptionTextV1, prepareCaptionTextReplacementV1 } from "../application/captionTextReplacementV1";
import { translateUi as t, useI18n } from "./i18n/interfacePreferences";
import "./captionFindReplace.css";

export interface CaptionFindReplaceProps {
  project: EditProject;
  onCommand: (command: EditorCommand) => boolean | void;
  onSelect: (captionId: string) => void;
}

/** A bounded view into the original text; matching and replacement always use the complete original cue. */
export function CaptionMatchExcerpt({ text, query, firstOffset, caseSensitive }: {
  text: string; query: string; firstOffset: number; caseSensitive: boolean;
}) {
  let start = Math.max(0, firstOffset - 60), end = Math.min(text.length, start + 320);
  if (start && /[\udc00-\udfff]/u.test(text[start])) start--;
  if (end < text.length && /[\udc00-\udfff]/u.test(text[end])) end--;
  const nodes: ReactNode[] = []; let from = start;
  for (const range of captionTextMatchRangesV1(text, query, caseSensitive)) {
    if (range.start >= end) break;
    if (range.end <= start) continue;
    const left = Math.max(start, range.start), right = Math.min(end, range.end);
    nodes.push(text.slice(from, left), <mark key={left}>{text.slice(left, right)}</mark>); from = right;
  }
  nodes.push(text.slice(from, end));
  return <span className="caption-search-excerpt">{start > 0 && "…"}{nodes}{end < text.length && "…"}</span>;
}

function errorMessage(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  if (code.includes("鎖定")) return t("字幕軌道已鎖定，請先解鎖。");
  if (code.includes("EMPTY_CUE")) return t("取代後會留下空白字幕，請調整取代文字。");
  if (code.includes("BUDGET")) return t("取代後的字幕文字過多，請縮短取代內容。");
  if (code.includes("LITERAL_INPUT")) return t("搜尋或取代文字含有不支援的字元。");
  return t("字幕資料已變更，請重新檢查搜尋結果。");
}

export function CaptionFindReplace(props: CaptionFindReplaceProps) {
  useI18n();
  const id = useId(), { project, onCommand, onSelect } = props;
  const [query, setQuery] = useState(""), [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false), [offset, setOffset] = useState(0);
  const [selection, setSelection] = useState<{ project: EditProject; ids: ReadonlySet<string> }>({ project, ids: new Set() });
  const [notice, setNotice] = useState(""), [error, setError] = useState("");
  const context = { project, query, replacement, caseSensitive, selection, offset };
  const live = useRef(context); live.current = context;
  const result = useMemo(() => {
    if (!query) return {};
    try { return { page: findCaptionTextV1(project, query, offset, 200, undefined, { caseSensitive }) }; }
    catch (caught) { return { failure: errorMessage(caught) }; }
  }, [project, query, caseSensitive, offset]);
  const checked = selection.project === project ? selection.ids : new Set<string>();
  const locked = captionTrackLocked(project);
  function reset() { setOffset(0); setSelection({ project, ids: new Set() }); setError(""); setNotice(""); }
  function replace(all: boolean) {
    setError(""); setNotice("");
    if (live.current !== context) { setError(t("字幕資料已變更，請重新檢查搜尋結果。")); return; }
    if (!query || (!all && !checked.size)) return;
    try {
      const prepared = prepareCaptionTextReplacementV1(project, query, replacement, all ? undefined : [...checked], { caseSensitive });
      const command = currentCaptionTextReplacementCommandV1(project, prepared);
      if (!command) { setNotice(t("沒有需要取代的文字。")); return; }
      if (onCommand(command) === false) { setError(t("字幕尚未變更，請檢查狀態列。")); return; }
      setSelection({ project, ids: new Set() });
      setNotice(t("已取代 {count} 句字幕；復原一次即可還原。", { count: prepared.changedCues }));
    } catch (caught) { setError(errorMessage(caught)); }
  }
  return <section className="caption-search" aria-labelledby={`${id}-title`} data-testid="caption-find-replace">
    <h3 id={`${id}-title`}>{t("尋找／取代")}</h3>
    <label htmlFor={`${id}-query`}>{t("尋找文字")}</label>
    <input id={`${id}-query`} data-caption-search-input="true" value={query} maxLength={10000}
      onChange={event => { setQuery(event.target.value); reset(); }} />
    <label htmlFor={`${id}-replacement`}>{t("取代為")}</label>
    <input id={`${id}-replacement`} value={replacement} maxLength={10000} onChange={event => { setReplacement(event.target.value); setError(""); setNotice(""); }} />
    <label className="caption-search-check"><input type="checkbox" checked={caseSensitive}
      onChange={event => { setCaseSensitive(event.target.checked); reset(); }} />{t("區分大小寫")}</label>
    {locked && <p role="status">{t("字幕軌道已鎖定，請先解鎖。")}</p>}
    {!query && <p>{t("輸入文字以尋找字幕。")}</p>}
    {result.page && <>
      <output aria-live="polite">{t("找到 {count} 句字幕，共 {matches} 處。", { count: result.page.matchingCues, matches: result.page.totalOccurrences })}</output>
      <ul className="caption-delivery-issues caption-search-results">{result.page.matches.map(row => <li key={row.captionId}>
        <label className="caption-search-check"><input type="checkbox" aria-label={t("選取這句字幕")} checked={checked.has(row.captionId)}
          onChange={event => {
            if (live.current !== context) return;
            const ids = new Set(checked); if (event.target.checked) ids.add(row.captionId); else ids.delete(row.captionId);
            setSelection({ project, ids });
          }} /><button type="button" title={t("選取字幕並前往出現時間")}
            onClick={() => { if (live.current === context) onSelect(row.captionId); }}>{row.start.toFixed(2)} {t("秒")}</button></label>
        <CaptionMatchExcerpt text={row.text} query={query} firstOffset={row.firstOffset} caseSensitive={caseSensitive} />
      </li>)}</ul>
      {(offset > 0 || result.page.nextOffset !== null) && <nav className="caption-delivery-actions" aria-label={t("字幕搜尋分頁")}>
        <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 200))}>{t("上一頁")}</button>
        <button type="button" disabled={result.page.nextOffset === null} onClick={() => setOffset(result.page!.nextOffset ?? offset)}>{t("下一頁")}</button>
      </nav>}
      <div className="caption-delivery-actions">
        <button type="button" disabled={locked || !checked.size} onClick={() => replace(false)}>{t("取代選取")}</button>
        <button type="button" disabled={locked || !result.page.matchingCues} onClick={() => replace(true)}>{t("全部取代")}</button>
      </div>
    </>}
    {(error || result.failure) && <p role="alert">{error || result.failure}</p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
