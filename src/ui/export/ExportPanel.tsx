import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useI18n } from "../i18n/interfacePreferences";
import { cancelRenderJob, closeRenderJob, currentRenderJob, setRenderJobCollapsed, subscribeRenderJob, type RenderJobState } from "../../desktop/renderJobStore";
import { EXPORT_STEPS, elapsedWords, exportStepIndex, remainingWords, renderStageDetail, spentWords, type DurationWords } from "../../application/renderProgressModel";
import type { HaoDesktopApi } from "../../desktop/apiTypes";
import { PlainProblemText } from "../ProblemNotice";
import "./exportPanel.css";

export function useRenderJob(): RenderJobState | undefined {
  return useSyncExternalStore(subscribeRenderJob, currentRenderJob, currentRenderJob);
}

function fileParts(path: string | undefined): { name: string; folder: string } {
  if (!path) return { name: "", folder: "" };
  const parts = path.split(/[\\/]/);
  const name = parts.pop() ?? path;
  return { name, folder: parts.join("\\") };
}

/** A clock that ticks once a second while the panel shows a running export. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * The desktop export, one plain panel: where the video goes, which of four steps is running, a bar and remaining
 * time only when the renderer measured them, a cancel that stops the work, and 「打開資料夾」／「播放」 when done.
 */
export function ExportPanel({ api }: { api?: Pick<HaoDesktopApi, "cancelRenderJob" | "revealInFolder"> }) {
  const { t } = useI18n();
  const job = useRenderJob();
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const [revealFailed, setRevealFailed] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const running = job?.phase === "running";
  const now = useNow(Boolean(running));
  const words = (value: DurationWords) => t(value.key, value.values);
  useEffect(() => { setConfirmingCancel(false); setPlaying(false); setPlaybackFailed(false); setRevealFailed(false); }, [job?.id, job?.phase]);
  useEffect(() => { if (job && job.phase !== "choosing" && !job.collapsed) heading.current?.focus(); }, [job?.id, job?.phase, job?.collapsed]);
  if (!job || job.phase === "choosing") return null;
  const { name, folder } = fileParts(job.outputPath);
  const alpha = job.kind === "alpha";
  const fraction = running ? job.progress?.fraction : undefined;
  const percent = fraction === undefined ? undefined : Math.floor(fraction * 100);

  if (job.collapsed && running) {
    return <aside className="export-chip" data-testid="export-panel-chip" aria-live="polite">
      <span className="export-chip-spinner" aria-hidden="true" />
      <span>{percent === undefined ? t("輸出中") : t("輸出中 {percent}%", { percent })}</span>
      <button type="button" onClick={() => setRenderJobCollapsed(false)} data-testid="export-panel-expand">{t("展開")}</button>
    </aside>;
  }

  const stepIndex = job.progress ? exportStepIndex(job.progress.stage) : 0;
  const title = job.phase === "running" ? t(alpha ? "正在輸出透明背景主檔" : "正在輸出影片")
    : job.phase === "done" ? t(alpha ? "透明背景主檔做好了！" : "影片做好了！")
    : job.phase === "canceled" ? t("已停止輸出") : t(job.problem?.title ?? "影片沒有輸出完成");
  const elapsedMs = job.runningSinceMs === undefined ? undefined : (job.finishedAtMs ?? now) - job.runningSinceMs;

  return <div className="export-panel-backdrop" data-testid="export-panel-backdrop">
    <section className="export-panel" role="dialog" aria-modal="true" aria-labelledby="export-panel-title" data-testid="export-panel" data-phase={job.phase}>
      <header>
        <span className={`export-panel-badge ${job.phase}`} aria-hidden="true">{job.phase === "done" ? "✓" : job.phase === "failed" ? "!" : job.phase === "canceled" ? "■" : "↑"}</span>
        <h2 id="export-panel-title" ref={heading} tabIndex={-1}>{title}</h2>
        {running && <button type="button" className="export-panel-collapse" onClick={() => setRenderJobCollapsed(true)} data-testid="export-panel-collapse">{t("縮小，繼續剪輯")}</button>}
      </header>
      {name && <div className="export-panel-file">
        <strong title={job.outputPath}>{name}</strong>
        {folder && <span>{t("存放位置：{folder}", { folder })}</span>}
      </div>}

      {running && <>
        <ol className="export-panel-steps" aria-label={t("輸出步驟")}>
          {EXPORT_STEPS.map((step, index) => {
            const state = index < stepIndex ? "done" : index === stepIndex ? "current" : "waiting";
            return <li key={step.id} className={state} aria-current={state === "current" ? "step" : undefined}>
              <b aria-hidden="true">{state === "done" ? "✓" : index + 1}</b>
              <span>{t(step.label)}</span>
              <small className="visually-hidden">{t(state === "done" ? "已完成" : state === "current" ? "進行中" : "還沒開始")}</small>
            </li>;
          })}
        </ol>
        <p className="export-panel-stage" data-testid="export-panel-stage">
          {job.progress ? t(renderStageDetail(job.progress.stage)) : t("正在準備輸出")}
          {job.progress?.parts ? ` ${t("（第 {part}／{parts} 段）", { part: job.progress.part ?? 1, parts: job.progress.parts })}` : ""}
        </p>
        <div className={`export-panel-bar${percent === undefined ? " indeterminate" : ""}`} role="progressbar" aria-label={t("輸出進度")}
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={percent === undefined ? t("這一步算不出百分比，請稍候。") : `${percent}%`}
          data-testid="export-panel-bar">
          <span style={percent === undefined ? undefined : { width: `${Math.max(2, percent)}%` }} />
        </div>
        <p className="export-panel-time" data-testid="export-panel-time">
          {percent === undefined
            ? <span>{t("這一步算不出百分比，請稍候。")}</span>
            : <><b>{`${percent}%`}</b><span>{job.remainingMs === undefined ? t("正在估計剩餘時間…") : words(remainingWords(job.remainingMs))}</span></>}
          {elapsedMs !== undefined && <span className="export-panel-elapsed">{words(elapsedWords(elapsedMs))}</span>}
        </p>
        {confirmingCancel && !job.cancelRequested
          ? <div className="export-panel-confirm" role="alertdialog" aria-labelledby="export-cancel-question">
            <p id="export-cancel-question">{t("要停止輸出嗎？已經做好的部分不會保留。")}</p>
            <div className="export-panel-actions">
              <button type="button" className="danger" onClick={() => void cancelRenderJob(api)} data-testid="export-panel-cancel-confirm">{t("停止輸出")}</button>
              <button type="button" className="primary" onClick={() => setConfirmingCancel(false)}>{t("繼續輸出")}</button>
            </div>
          </div>
          : <div className="export-panel-actions">
            <button type="button" onClick={() => setConfirmingCancel(true)} disabled={job.cancelRequested || !api?.cancelRenderJob} data-testid="export-panel-cancel">
              {job.cancelRequested ? t("正在停止…") : t("停止輸出")}
            </button>
          </div>}
      </>}

      {job.phase === "done" && <>
        {elapsedMs !== undefined && <p className="export-panel-note">{words(spentWords(elapsedMs))}</p>}
        {playing && job.outputUrl && !playbackFailed && <video className="export-panel-player" src={job.outputUrl} controls autoPlay playsInline
          data-testid="export-panel-player" onError={() => setPlaybackFailed(true)} />}
        {playbackFailed && <p className="export-panel-note" role="status">{t("這台電腦的預覽放不出這支影片。請按「打開資料夾」，再用電腦的播放程式打開。")}</p>}
        {revealFailed && <p className="export-panel-note" role="status">{t("沒辦法打開資料夾。影片在：{path}", { path: job.outputPath ?? "" })}</p>}
        <div className="export-panel-actions">
          {api?.revealInFolder && job.outputPath && <button type="button" className="primary" data-testid="export-panel-reveal"
            onClick={() => { void api.revealInFolder!(job.outputPath!).catch(() => setRevealFailed(true)); }}>{t("打開資料夾")}</button>}
          {!alpha && job.outputUrl && !playing && <button type="button" data-testid="export-panel-play" onClick={() => setPlaying(true)}>{t("播放")}</button>}
          <button type="button" onClick={closeRenderJob} data-testid="export-panel-close">{t("關閉")}</button>
        </div>
      </>}

      {job.phase === "canceled" && <>
        <p className="export-panel-note">{t("你的專案沒有改變，可以隨時再輸出一次。")}</p>
        <div className="export-panel-actions"><button type="button" className="primary" onClick={closeRenderJob} data-testid="export-panel-close">{t("關閉")}</button></div>
      </>}

      {job.phase === "failed" && job.problem && <>
        <div className="export-panel-problem"><PlainProblemText problem={{ ...job.problem, title: "" }} /></div>
        <div className="export-panel-actions">
          {job.retry && <button type="button" className="primary" onClick={() => { closeRenderJob(); job.retry!(); }} data-testid="export-panel-retry">{t("再試一次")}</button>}
          <button type="button" onClick={closeRenderJob} data-testid="export-panel-close">{t("關閉")}</button>
        </div>
      </>}
    </section>
  </div>;
}
