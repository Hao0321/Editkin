import { useState } from "react";
import type { EditProject } from "../domain/types";
import type { EditorCommand } from "../domain/commandTypes";
import { inspectCaptionDelivery, prepareCaptionOverlapRepair, exportCaptionDelivery, type CaptionDeliveryMode, type CaptionDeliveryFormat } from "../domain/captionDelivery";
import "./captionDelivery.css";

export function CaptionDelivery({ project, onCommand, onSelect }: {
  project: EditProject; onCommand: (command: EditorCommand) => void; onSelect: (captionId: string) => void;
}) {
  const [mode, setMode] = useState<CaptionDeliveryMode>("original"), [error, setError] = useState("");
  let report: ReturnType<typeof inspectCaptionDelivery> | undefined, reportError = "";
  try { report = inspectCaptionDelivery(project); } catch (caught) { reportError = caught instanceof Error ? caught.message : "字幕資料無法檢查"; }
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
  return <details className="caption-delivery" data-testid="caption-delivery">
    <summary>字幕檢查與匯出 <span>{report ? `${report.cueCount} 句 · ${report.errors} 個錯誤` : "資料錯誤"}</span></summary>
    <div className="caption-delivery-body">
      <p>核對時間重疊與閱讀停留。語音辨識缺字仍需要聽音確認。</p>
      {reportError && <p role="alert">{reportError}</p>}
      {report && <>
        <output aria-label="字幕檢查結果">{report.errors} 個錯誤 · {report.warnings} 個提醒</output>
        <ul className="caption-delivery-issues">{report.issues.map((issue, index) => <li key={`${issue.captionId}-${index}`} data-severity={issue.severity}>
          <button type="button" onClick={() => onSelect(issue.captionId)} title="選取字幕並前往出現時間">{issue.captionId}</button><span>{issue.message}</span>
          {issue.code === "overlap" && issue.relatedId && <button type="button" onClick={() => prepare(issue.relatedId!)}>預覽句尾修正</button>}
        </li>)}</ul>
        {report.omittedIssues > 0 && <p>尚有 {report.omittedIssues} 項；先修正前面的問題，再重新檢查。</p>}
        {currentPreview && <div className="caption-delivery-repair" aria-label="字幕時間修正預覽">
          {currentPreview.repair.changes.map(change => <p key={change.captionId}>{change.captionId}：結束 {change.oldEnd.toFixed(3)} → {change.newEnd.toFixed(3)} 秒，收短 {change.removedFrames} 格。文字與起點保留。</p>)}
          <button type="button" onClick={() => { if (preview?.source !== project) return; onCommand(currentPreview.repair.command); setPreview(undefined); }}>套用時間修正</button>
          <button type="button" onClick={() => setPreview(undefined)}>取消</button>
        </div>}
        <label>匯出內容<select aria-label="字幕匯出內容" value={mode} onChange={event => { setMode(event.target.value as CaptionDeliveryMode); setError(""); }}>
          <option value="original">原文</option><option value="translation">翻譯</option><option value="bilingual">原文＋翻譯</option>
        </select></label>
        <div className="caption-delivery-actions"><button type="button" disabled={!report.readyForSidecar} onClick={() => download("srt")}>下載 SRT</button><button type="button" disabled={!report.readyForSidecar} onClick={() => download("vtt")}>下載 VTT</button></div>
        <small>UTF-8 字幕檔；保留 Timeline 時間。閱讀提醒不代表辨識與美術已驗收。</small>
      </>}
      {error && <p role="alert">{error}</p>}
    </div>
  </details>;
}
