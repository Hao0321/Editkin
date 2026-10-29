import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";
import { useState } from "react";
import type { EditProject } from "../domain/types";
import type { EditorCommand } from "../domain/commandTypes";
import { inspectCaptionDelivery, prepareCaptionOverlapRepair, exportCaptionDelivery, type CaptionDeliveryMode, type CaptionDeliveryFormat } from "../domain/captionDelivery";
import "./captionDelivery.css";
import { CaptionFindReplace } from "./CaptionFindReplace";
import { CaptionFindReplaceSheet } from "./CaptionFindReplaceSheet";

type CaptionDeliveryReport = ReturnType<typeof inspectCaptionDelivery>;
export interface CaptionDeliveryReportState { report?: CaptionDeliveryReport; reportError: string }

/**
 * Per-panel memo of the caption check. The check reads only `fps` and `captions`; project snapshots are immutable
 * (every edit clones), so the same captions array and fps give the same report. Without this the whole O(captions)
 * check (grapheme segmentation + UTF-8 sizing) re-ran on every playhead tick while a caption was selected.
 */
export function createCaptionDeliveryReportMemo(inspect: (project: Pick<EditProject, "fps" | "captions">) => CaptionDeliveryReport = inspectCaptionDelivery) {
  let last: { captions: EditProject["captions"]; fps: number; state: CaptionDeliveryReportState } | undefined;
  return (project: Pick<EditProject, "fps" | "captions">): CaptionDeliveryReportState => {
    if (last && last.captions === project.captions && Object.is(last.fps, project.fps)) return last.state;
    let state: CaptionDeliveryReportState;
    try { state = { report: inspect(project), reportError: "" }; }
    catch (caught) { state = { reportError: caught instanceof Error ? caught.message : "字幕資料無法檢查" }; }
    last = { captions: project.captions, fps: project.fps, state };
    return state;
  };
}

export function CaptionDelivery({ project, onCommand, onSelect }: {
  project: EditProject; onCommand: (command: EditorCommand) => void; onSelect: (captionId: string) => void;
}) {
  const { mode: interfaceMode } = useI18n();
  const [searchOpen, setSearchOpen] = useState(false);
  const [mode, setMode] = useState<CaptionDeliveryMode>("original"), [error, setError] = useState("");
  const [reportMemo] = useState(createCaptionDeliveryReportMemo);
  const { report, reportError } = reportMemo(project);
  const [preview, setPreview] = useState<{ source: EditProject; repair: ReturnType<typeof prepareCaptionOverlapRepair> }>();
  const currentPreview = preview?.source === project ? preview : undefined;
  function prepare(id: string) {
    setError(""); setPreview(undefined);
    try { setPreview({ source: project, repair: prepareCaptionOverlapRepair(project, [id]) }); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "無法準備修正"); }
  }
  function download(format: CaptionDeliveryFormat) {
    setError("");
    try {
      const delivery = exportCaptionDelivery(project, format, mode), url = URL.createObjectURL(new Blob([delivery.text], { type: format === "vtt" ? "text/vtt;charset=utf-8" : "application/x-subrip;charset=utf-8" }));
      const link = document.createElement("a"); link.href = url;
      link.download = `${project.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 80) || "captions"}-${mode}.${format}`;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "字幕匯出失敗"); }
  }
  return <>{interfaceMode === "simple" && <button type="button" className="caption-search-open" onClick={() => setSearchOpen(true)}>{uiText("尋找取代")}</button>}
    {searchOpen && <CaptionFindReplaceSheet project={project} onCommand={onCommand} onSelect={onSelect} onClose={() => setSearchOpen(false)} />}
    <details className="caption-delivery" data-testid="caption-delivery">
    <summary>{uiText("字幕檢查與匯出")}<span>{report ? uiText("{value0} 句 · {value1} 個錯誤", { value0: report.cueCount, value1: report.errors }) : uiText("資料錯誤")}</span></summary>
    <div className="caption-delivery-body">
      {interfaceMode === "advanced" && <CaptionFindReplace project={project} onCommand={onCommand} onSelect={onSelect} />}
      <p>{uiText("核對時間重疊與閱讀停留。語音辨識缺字仍需要聽音確認。")}</p>
      {reportError && <p role="alert">{reportError}</p>}
      {report && <>
        <output aria-label={uiText("字幕檢查結果")}>{report.errors} {uiText("個錯誤 ·")}{report.warnings} {uiText("個提醒")}</output>
        <ul className="caption-delivery-issues">{report.issues.map((issue, index) => <li key={`${issue.captionId}-${index}`} data-severity={issue.severity}>
          <button type="button" onClick={() => onSelect(issue.captionId)} title={uiText("選取字幕並前往出現時間")}>{issue.captionId}</button><span>{issue.message}</span>
          {issue.code === "overlap" && issue.relatedId && <button type="button" onClick={() => prepare(issue.relatedId!)}>{uiText("預覽句尾修正")}</button>}
        </li>)}</ul>
        {report.omittedIssues > 0 && <p>{uiText("尚有")}{report.omittedIssues} {uiText("項；先修正前面的問題，再重新檢查。")}</p>}
        {currentPreview && <div className="caption-delivery-repair" aria-label={uiText("字幕時間修正預覽")}>
          {currentPreview.repair.changes.map(change => <p key={change.captionId}>{change.captionId}{uiText("：結束")}{change.oldEnd.toFixed(3)} → {change.newEnd.toFixed(3)} {uiText("秒，收短")}{change.removedFrames} {uiText("格。文字與起點保留。")}</p>)}
          <button type="button" onClick={() => { if (preview?.source !== project) return; onCommand(currentPreview.repair.command); setPreview(undefined); }}>{uiText("套用時間修正")}</button>
          <button type="button" onClick={() => setPreview(undefined)}>{uiText("取消")}</button>
        </div>}
        <label>{uiText("匯出內容")}<select aria-label={uiText("字幕匯出內容")} value={mode} onChange={event => { setMode(event.target.value as CaptionDeliveryMode); setError(""); }}>
          <option value="original">{uiText("原文")}</option><option value="translation">{uiText("翻譯")}</option><option value="bilingual">{uiText("原文＋翻譯")}</option>
        </select></label>
        <div className="caption-delivery-actions"><button type="button" disabled={!report.readyForSidecar} onClick={() => download("srt")}>{uiText("下載 SRT")}</button><button type="button" disabled={!report.readyForSidecar} onClick={() => download("vtt")}>{uiText("下載 VTT")}</button></div>
        <small>{uiText("UTF-8 字幕檔；保留 Timeline 時間。閱讀提醒不代表辨識與美術已驗收。")}</small>
      </>}
      {error && <p role="alert">{error}</p>}
    </div>
  </details></>;
}
