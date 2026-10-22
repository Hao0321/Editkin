import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";
import type { BatchAutoEditSession } from "../desktop/types";
import "./batchAutoEdit.css";

interface BatchAutoEditPanelProps {
  session: BatchAutoEditSession;
  onClose: () => void;
  running?: boolean;
  canCancel?: boolean;
  onCancel?: () => void;
  onResume?: () => void;
  onRetry: (jobId: string) => void;
  onOpenProject: (jobId: string) => void;
}

const STATUS_LABEL = {
  queued: "等待中",
  running: "本機粗剪中",
  completed: "粗剪完成，可繼續編輯",
  failed: "需要重試",
} as const;

export function BatchAutoEditPanel({ session, onClose, onRetry, onOpenProject, running = false, canCancel = false, onCancel, onResume }: BatchAutoEditPanelProps) {
  useI18n();
  const completed = session.jobs.filter((job) => job.status === "completed").length;
  return (
    <div className="modal-backdrop batch-backdrop" role="presentation">
      <section className="batch-panel" role="dialog" aria-modal="true" aria-labelledby="batch-title" data-testid="batch-auto-edit-panel">
        <header className="batch-header">
          <div>
            <span className="eyebrow">{uiText("本機批次粗剪")}</span>
            <h2 id="batch-title">{uiText("先整理素材，再逐支精修")}</h2>
            <p>{completed}/{session.jobs.length} {uiText("支完成 · 每支都有 MP4、可編輯專案與處理收據")}</p>
          </div>
          <div className="batch-job-actions">
            {running && onCancel && <button type="button" className="secondary-action" disabled={!canCancel} onClick={onCancel} data-testid="batch-cancel">{uiText("停止批次")}</button>}
            {!running && onResume && session.jobs.some(job => job.status === "queued" || job.status === "failed") && <button type="button" className="secondary-action" onClick={onResume} data-testid="batch-resume">{uiText("續跑批次")}</button>}
            <button type="button" className="round-action" onClick={onClose} aria-label={uiText("關閉批量工作台")}>×</button>
          </div>
        </header>
        <div className="batch-explainer">
          <span>{uiText("1 選新影片")}</span><i>→</i><span>{uiText("2 本機粗剪")}</span><i>→</i><span>{uiText("3 打開時間軸微調")}</span>
        </div>
        <div className="batch-jobs" aria-live="polite">
          {session.jobs.map((job, index) => (
            <article className={`batch-job ${job.status}`} key={job.id}>
              <div className="batch-index">{String(index + 1).padStart(2, "0")}</div>
              <div className="batch-job-copy">
                <strong title={job.sourcePath}>{job.sourceName}</strong>
                <span><i className={`batch-status-dot ${job.status}`} /> {STATUS_LABEL[job.status]}</span>
                {job.warnings.length > 0 && <small>{job.warnings[0]}</small>}
                {job.error && <small className="batch-error">{job.error}</small>}
              </div>
              <div className="batch-job-actions">
                {job.projectPath && job.status !== "running" && <button type="button" className="primary-button" onClick={() => onOpenProject(job.id)}>{uiText("繼續編輯")}</button>}
                {job.status === "failed" && <button type="button" className="secondary-action" onClick={() => onRetry(job.id)}>{uiText("重試這支")}</button>}
                {job.status === "running" && <span className="batch-spinner" aria-label={uiText("處理中")} />}
              </div>
            </article>
          ))}
        </div>
        <footer className="batch-footer">
          <span>{uiText("輸出資料夾")}</span><strong title={session.outputRoot}>{session.outputRoot}</strong>
          <small>{uiText("完整 Video Autopilot 美感剪輯請從「連接 AI」交給 Codex／Claude，逐支判讀素材並套用你目前的 Skill。這裡提供本機粗剪，按「繼續編輯」可調整剪點、字幕與配樂。")}</small>
        </footer>
      </section>
    </div>
  );
}
