import { useEffect, useRef, useSyncExternalStore } from "react";
import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";
import { currentPlaybackNotices, dismissPlaybackNotice, retryPlaybackNotice, subscribePlaybackNotices,
  type PlaybackNoticeKind, type PublishedPlaybackNotice } from "./playbackNoticeStore";

export interface PlaybackNoticeCopy {
  title: string;
  /** What to do next, in plain words. Never the raw technical cause. */
  line: string;
  action?: string;
  /** "error" paused or blocked playback; "warning" keeps a working picture or sound. */
  severity: "error" | "warning";
  /** A notice that does not block playback can be closed. */
  dismissible: boolean;
}

/** One fixed plain wording per kind and recovery step: what happened and what to do.
 * After a recovery that did not help, the line changes so it is announced again. */
export function playbackNoticeCopy(notice: PublishedPlaybackNotice): PlaybackNoticeCopy {
  const again = notice.attempts > 0 && !notice.busy;
  switch (notice.kind) {
    case "play":
      if (notice.step === "rebuild") return { severity: "error", dismissible: false, title: uiText("這段預覽無法播放，已暫停"), action: uiText("重建預覽"),
        line: again ? uiText("重建後還是無法播放。請確認原始檔案還在原位置，或換成 MP4 後重新匯入。") : uiText("重新載入後還是無法播放。請重建預覽；原片與剪輯都會保留。") };
      if (notice.step === "reload") return { severity: "error", dismissible: false, title: uiText("這段預覽無法播放，已暫停"), action: uiText("重新載入預覽"),
        line: again ? uiText("重新載入後還是無法播放。請確認原始檔案還在原位置，或換成 MP4 後重新匯入。") : uiText("素材可能無法在預覽中解碼。請重新載入預覽；原片與剪輯都會保留。") };
      return { severity: "error", dismissible: false, title: uiText("預覽無法開始播放，已暫停"), action: uiText("再播放一次"), line: uiText("再播放一次通常就能恢復。") };
    case "audio":
      return { severity: "error", dismissible: false, title: uiText("上一段聲音還沒停好，為避免重疊已先暫停"), action: uiText("再試一次"),
        line: again ? uiText("還是沒有停好。可以再試一次；如果一直出現，請儲存專案後重新開啟 Editkin。") : uiText("按「再試一次」確認聲音已停止，就能繼續播放。") };
    case "audio-source": {
      const names = notice.names ?? [];
      return { severity: "error", dismissible: true, action: uiText("重新載入聲音"),
        title: names.length === 1 ? uiText("「{value0}」的聲音無法播放", { value0: names[0] }) : uiText("{value0} 段聲音無法播放", { value0: names.length }),
        line: again ? uiText("還是無法播放。檔案可能已移動、損壞或格式不支援，請換一份檔案後重新匯入。") : uiText("請確認檔案還在原位置，再重新載入聲音。") };
    }
    case "gpu":
      return { severity: "warning", dismissible: true, action: uiText("重試 GPU 預覽"),
        title: notice.step === "playback" ? uiText("GPU 加速播放暫停") : uiText("GPU 加速暫停，已改用相容預覽"),
        line: again ? uiText("GPU 加速還是無法使用。可以先用相容預覽繼續剪輯，更新顯示卡驅動程式後再試。")
          : notice.step === "playback" ? uiText("畫面仍可預覽和剪輯，播放可能比較不順。") : uiText("畫面照常顯示，可以繼續剪輯。") };
    case "audio-fallback":
      return { severity: "warning", dismissible: false, title: uiText("音訊相容模式"), line: uiText("原生音訊無法使用，聲音改用相容方式播放，可能和畫面有些微落差。") };
  }
}

// Blocking problems first; a working fallback picture last.
const order: Record<PlaybackNoticeKind, number> = { play: 0, audio: 0, "audio-source": 1, gpu: 2, "audio-fallback": 3 };

/** Where the notices sit: "overlay" floats them over the bottom of the picture so it
 * never resizes; "inline" gives them their own space above the transport row. GPU 直出
 * needs "inline": its picture is a separate native window placed over the stage, and
 * web content under that window cannot be seen. */
export type PlaybackNoticePlacement = "overlay" | "inline";

/** What stopped playback, in plain words, right above the transport. Compatible
 * audio that keeps playing is not a notice; the transport readout states it. The
 * raw cause stays under 查看原因. */
export function PlaybackNotices({ placement = "overlay" }: { placement?: PlaybackNoticePlacement } = {}) {
  useI18n();
  const notices = useSyncExternalStore(subscribePlaybackNotices, currentPlaybackNotices, currentPlaybackNotices);
  const transportRef = useRef<Element | null>(null);
  const focusedRef = useRef(false);
  // A recovery that worked removes its notice together with the focused button;
  // keep keyboard and screen-reader focus on the transport instead of <body>.
  useEffect(() => {
    if (!focusedRef.current || typeof document === "undefined") return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    focusedRef.current = false;
    transportRef.current?.querySelector<HTMLButtonElement>('[data-testid="transport-play-pause"]')?.focus();
  }, [notices]);
  const visible = notices.filter(notice => notice.kind !== "audio-fallback").sort((a, b) => order[a.kind] - order[b.kind]);
  if (visible.length === 0) return null;
  return <div className={`playback-notices${placement === "inline" ? " playback-notices-inline" : ""}`} data-testid="playback-notices" data-placement={placement}
    ref={node => { if (node) transportRef.current = node.closest(".playback-controls") ?? node.parentElement; }}
    onFocus={() => { focusedRef.current = true; }}
    onBlur={event => { if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) focusedRef.current = false; }}>
    {visible.map(notice => {
      const copy = playbackNoticeCopy(notice), titleId = `playback-notice-title-${notice.key.replace(/[^\w-]/g, "-")}`;
      return <div key={notice.key} className={`preview-update-notice playback-notice${copy.severity === "error" ? " failed" : ""}`}
        role={copy.severity === "error" ? "alert" : "status"} data-testid={`playback-notice-${notice.kind}`} data-attempts={notice.attempts}>
        <div className="preview-update-copy">
          <strong id={titleId}>{copy.title}</strong>
          <span>{copy.line}</span>
          {notice.detail && <details className="playback-notice-reason"><summary>{uiText("查看原因")}</summary><span>{notice.detail}</span></details>}
        </div>
        {notice.retry && copy.action && <button type="button" aria-describedby={titleId} aria-disabled={notice.busy || undefined}
          onClick={() => retryPlaybackNotice(notice.key)}>{notice.busy ? uiText("重試中…") : copy.action}</button>}
        {copy.dismissible && <button type="button" className="playback-notice-dismiss" aria-label={uiText("關閉這則提醒")} aria-describedby={titleId}
          title={uiText("關閉這則提醒")} onClick={() => dismissPlaybackNotice(notice.key)}><span aria-hidden="true">×</span></button>}
      </div>;
    })}
  </div>;
}
