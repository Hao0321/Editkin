import type { MouseEvent } from "react";
import type { ProjectDownloadLease } from "../application/projectDownloadLease";

/** A genuine visible file link; its existence does not certify a browser disk write. */
export function ProjectDownloadNotice({ lease, onCancel }: {
  lease: ProjectDownloadLease;
  onCancel: (requestId: string) => void;
}) {
  const download = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!lease.isAvailable()) event.preventDefault();
  };
  return <section role="status" aria-live="polite" data-testid="project-download-notice" data-request-id={lease.requestId}
    style={{ position: "absolute", bottom: "calc(100% + 8px)", right: 12, width: "min(520px, calc(100% - 24px))", boxSizing: "border-box",
      zIndex: 90, padding: "12px 14px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--surface)", color: "var(--ink)",
      boxShadow: "0 6px 24px rgba(0,0,0,.25)", lineHeight: 1.5, fontSize: 13 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 12, justifyContent: "space-between" }}>
      <strong data-testid="project-download-snapshot">{lease.isCurrent() ? "送出時的專案版本" : "先前送出的版本；目前修改未包含"}</strong>
      <button type="button" aria-label="關閉專案下載連結" data-testid="project-download-cancel" onClick={() => onCancel(lease.requestId)}>關閉</button>
    </div>
    <a href={lease.url} download={lease.filename} onClick={download} data-testid="project-download-link" data-request-id={lease.requestId}
      style={{ display: "inline-block", padding: "4px 0", maxWidth: "100%", overflowWrap: "anywhere", color: "inherit", fontWeight: 700, textDecoration: "underline" }}>下載 {lease.filename}</a>
    <p style={{ margin: 0 }}>連結 15 秒內有效。請確認瀏覽器下載完成；不會標記已儲存，也沒有 Autosave。</p>
  </section>;
}
