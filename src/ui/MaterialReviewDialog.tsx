import { useEffect, useState } from "react";
import type { EditProject, MediaAsset, TimelineClip } from "../domain/types";
import type { DesktopMaterialReview } from "../desktop/apiTypes";
import "./materialReviewDialog.css";

type SavedJob = { jobId: string; includeTranscript: boolean; fingerprint: string };
const phaseName: Record<string, string> = {
  identity: "核對來源", scene: "分析場景", keyframes: "擷取影格", color: "檢查色彩",
  transcript: "辨識語音", finalizing: "封存證據",
};
const jobKey = (projectId: string, clipId: string) => `editkin.material-review.v1:${projectId}:${clipId}`;
const clipFingerprint = (asset: MediaAsset, clip: TimelineClip, fps: number) =>
  JSON.stringify([asset.id, asset.uri, clip.sourceStart, clip.duration, fps]);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function MaterialReviewDialog({ project, clip, asset, onClose, docked = false }: {
  project: EditProject; clip: TimelineClip; asset: MediaAsset; onClose: () => void; docked?: boolean;
}) {
  const desktop = window.haoDesktop;
  const storageKey = jobKey(project.id, clip.id);
  const fingerprint = clipFingerprint(asset, clip, project.fps);
  const [saved, setSaved] = useState<SavedJob | undefined>(() => {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey) ?? "null") as SavedJob | null;
      return value && typeof value.jobId === "string" && typeof value.includeTranscript === "boolean"
        && typeof value.fingerprint === "string" ? value : undefined;
    } catch { return undefined; }
  });
  const [includeTranscript, setIncludeTranscript] = useState(saved?.includeTranscript ?? false);
  const [review, setReview] = useState<DesktopMaterialReview>();
  const [frame, setFrame] = useState<{ id: string; dataUrl: string }>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(saved ? "正在讀取上次素材工作…" : "選取片段後開始建立素材證據。");
  const stale = Boolean(saved && saved.fingerprint !== fingerprint);
  const active = review?.job.state === "RUNNING" || review?.job.state === "CANCELLING";

  useEffect(() => {
    if (!saved?.jobId || !desktop) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const next = await desktop.getMaterialReview(saved.jobId);
        if (disposed) return;
        setReview(next);
        setStatus(next.job.state === "COMPLETED" ? "封存證據已驗證；請逐張看片核對。"
          : next.job.error ?? `${next.job.state} · ${phaseName[next.job.progress.phase] ?? next.job.progress.phase}`);
      } catch (error) { if (!disposed) { setReview(undefined); setFrame(undefined); setStatus(`無法查詢工作：${message(error)}`); } }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 10_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [desktop, saved?.jobId]);

  const start = async (resumeJobId?: string) => {
    if (!desktop || busy || stale) return;
    setBusy(true);
    setStatus(resumeJobId ? "正在明確續跑素材分析…" : "正在提交素材分析…");
    try {
      const result = await desktop.startMaterialReview(project, clip.id, includeTranscript, resumeJobId);
      const next: SavedJob = { jobId: result.job.jobId, includeTranscript, fingerprint };
      localStorage.setItem(storageKey, JSON.stringify(next));
      setSaved(next);
      setReview({ job: result.job });
      setStatus(result.coalesced ? "已接回相同的進行中工作。" : "已開始分析；關閉面板後工作仍會繼續。");
    } catch (error) { setStatus(`提交狀態未確認：${message(error)}。同一請求會在服務端合併，請勿改動素材後盲目重送。`); }
    finally { setBusy(false); }
  };
  const cancel = async () => {
    if (!desktop || !saved || busy) return;
    setBusy(true);
    try { const job = await desktop.cancelMaterialReview(saved.jobId); setReview({ job }); setStatus("已要求取消，請等分析程序結束。"); }
    catch (error) { setStatus(`取消未確認：${message(error)}`); }
    finally { setBusy(false); }
  };
  const viewFrame = async (frameId: string) => {
    if (!desktop || !saved || busy) return;
    setBusy(true);
    try {
      const result = await desktop.getMaterialReviewFrame(saved.jobId, frameId);
      setFrame({ id: result.frameId, dataUrl: result.dataUrl });
      setStatus("已驗證這張影格的 SHA-256；畫面內容仍需人工判讀。");
    } catch (error) { setFrame(undefined); setStatus(`無法顯示影格：${message(error)}`); }
    finally { setBusy(false); }
  };
  const forget = () => {
    if (active) return;
    localStorage.removeItem(storageKey);
    setSaved(undefined); setReview(undefined); setFrame(undefined);
    setStatus("已移除面板中的工作連結；原封存證據仍保留。");
  };

  const content = <section className={`material-review-dialog${docked ? " docked" : ""}`} role={docked ? "region" : "dialog"} aria-modal={docked ? undefined : true} aria-labelledby="material-review-title" data-testid="material-review-dialog">
      <button type="button" className="modal-close" onClick={onClose} aria-label="關閉">×</button>
      <small>素材證據 · 僅本機分析</small>
      <h2 id="material-review-title">檢視「{asset.name}」</h2>
      <p>片段來源 {clip.sourceStart.toFixed(2)}–{(clip.sourceStart + clip.duration).toFixed(2)} 秒。分析不改時間軸；關鍵影格是抽樣，不能證明未拍到的事件。</p>
      {stale && <p className="material-review-warning" role="alert">素材或片段範圍已變更；先移除舊工作連結，再重新分析。</p>}
      <div className="material-review-actions">
        {!saved && <label><input type="checkbox" checked={includeTranscript} onChange={(event) => setIncludeTranscript(event.target.checked)} /> 辨識語音（需本機模型）</label>}
        {!saved && <button type="button" onClick={() => void start()} disabled={busy || !desktop}>開始分析</button>}
        {saved && review && ["FAILED", "CANCELLED", "INTERRUPTED"].includes(review.job.state) && !stale &&
          <button type="button" onClick={() => void start(saved.jobId)} disabled={busy}>明確續跑</button>}
        {active && <button type="button" onClick={() => void cancel()} disabled={busy}>取消工作</button>}
        {saved && review && !active && <button type="button" onClick={forget} disabled={busy}>移除工作連結</button>}
      </div>
      <p className="material-review-status" role="status" aria-live="polite">{status}</p>
      {review && <div className="material-review-job"><strong>工作狀態：{review.job.state}</strong><span>{phaseName[review.job.progress.phase] ?? review.job.progress.phase}</span>
        {review.job.progress.phase === "transcript" && <span>{review.job.progress.completedSegments}/{review.job.progress.totalSegments} 段 · {review.job.progress.analyzedSeconds.toFixed(1)} 秒</span>}
        <small>工作 ID：{review.job.jobId}</small></div>}
      {review?.packet && <>
        {review.packet.source.kind !== "audio" && review.packet.keyframes.length === 0 && <p className="material-review-warning" role="alert">沒有可核對的畫面；這份分析不能當作選鏡證據。</p>}
        {review.packet.transcript.state === "blocked" && <p className="material-review-warning" role="alert">語音分析未完成：{review.packet.transcript.reason ?? "請檢查本機辨識工具"}</p>}
        <div className="material-review-facts">
          <span>來源 SHA-256 <code>{review.packet.source.sourceSha256}</code></span>
          <span>場景：{review.packet.scene.state} · {review.packet.scene.cuts.length} 個切點</span>
          <span>語音：{review.packet.transcript.state} · {review.packet.transcript.cueCount} 段</span>
          <span>影格：{review.packet.keyframes.length} 張</span>
        </div>
        {review.packet.transcript.cues && review.packet.transcript.cues.length > 0 && <details><summary>查看語音片段（前 80 段）</summary><ol>{review.packet.transcript.cues.map((cue, index) => <li key={index}>{cue.start.toFixed(2)}s · {cue.text}</li>)}</ol></details>}
        <div className="material-review-frames">{review.packet.keyframes.map((item) =>
          <button type="button" key={item.id} onClick={() => void viewFrame(item.id)} disabled={busy} aria-label={`查看 ${item.time.toFixed(2)} 秒影格`}>
            {item.time.toFixed(2)}s <small>{item.id}</small>
          </button>)}</div>
        {frame && <figure><img src={frame.dataUrl} alt={`素材 ${asset.name} 在 ${review.packet.keyframes.find((item) => item.id === frame.id)?.time.toFixed(2) ?? "?"} 秒的已驗證抽樣影格`} /><figcaption>SHA-256：{review.packet.keyframes.find((item) => item.id === frame.id)?.sha256} · 中性色彩顯示代理；尚未作語意判讀或人工通過。</figcaption></figure>}
      </>}
    </section>;
  return docked ? content : <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>{content}</div>;
}
