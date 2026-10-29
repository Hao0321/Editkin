import { useEffect, useRef } from "react";
import { useI18n } from "./i18n/interfacePreferences";
import type { WindowCloseGuard } from "../desktop/useWindowCloseGuard";
import "./safetyDialogs.css";

/** 「要先存檔再關閉嗎？」 when the window closes with unsaved work or a running export. */
export function CloseConfirmDialog({ guard }: { guard: WindowCloseGuard }) {
  const { t } = useI18n();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const busy = Boolean(guard.busy);
  return <div className="safety-backdrop" data-testid="close-confirm" onKeyDown={event => { if (event.key === "Escape" && !busy) { event.preventDefault(); guard.cancel(); } }}>
    <section className="safety-card" role="alertdialog" aria-modal="true" aria-labelledby="close-confirm-title" aria-describedby="close-confirm-body">
      {guard.dirty ? <>
        <h2 id="close-confirm-title" ref={heading} tabIndex={-1}>{t("要先存檔再關閉嗎？")}</h2>
        <div id="close-confirm-body">
          <p>{t("你還有修改沒有存。")}</p>
          {guard.exporting && <p>{t("影片也還在輸出，關閉後會停止。")}</p>}
        </div>
        <div className="safety-actions">
          <button type="button" className="primary" disabled={busy} onClick={() => void guard.saveAndClose()} data-testid="close-save-and-close">
            {guard.busy === "saving" ? t("正在存檔…") : t("存檔後關閉")}</button>
          <button type="button" className="outline-danger" disabled={busy} onClick={() => void guard.closeWithoutSaving()} data-testid="close-without-saving">
            {guard.busy === "closing" ? t("正在關閉…") : t("不存檔，直接關閉")}</button>
          <button type="button" disabled={busy} onClick={guard.cancel} data-testid="close-cancel">{t("取消")}</button>
        </div>
      </> : <>
        <h2 id="close-confirm-title" ref={heading} tabIndex={-1}>{t("影片還在輸出，要停止並關閉嗎？")}</h2>
        <div id="close-confirm-body"><p>{t("關閉 Editkin 會停止這次輸出，已經做好的部分不會保留。")}</p></div>
        <div className="safety-actions">
          <button type="button" className="primary" disabled={busy} onClick={guard.cancel} data-testid="close-cancel">{t("繼續輸出")}</button>
          <button type="button" className="danger" disabled={busy} onClick={() => void guard.closeWithoutSaving()} data-testid="close-without-saving">
            {guard.busy === "closing" ? t("正在關閉…") : t("停止輸出並關閉")}</button>
        </div>
      </>}
    </section>
  </div>;
}
