import { useEffect, useRef, useState } from "react";
import { useI18n } from "./i18n/interfacePreferences";
import type { RecoveryChoiceRequest } from "../desktop/useProjectRecovery";
import "./safetyDialogs.css";

/**
 * After Editkin did not close normally: three plain choices instead of one OK/Cancel that deleted the backup.
 * 「不要了」 asks once more before anything is thrown away.
 */
export function RecoveryChoiceDialog({ request }: { request: RecoveryChoiceRequest }) {
  const { t } = useI18n();
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [confirmingDiscard, request.failure]);
  return <main className="safety-screen" data-shortcuts-blocked="true" data-testid="recovery-choice">
    <section className="safety-card" role="dialog" aria-modal="true" aria-labelledby="recovery-choice-title">
      {confirmingDiscard ? <>
        <h1 id="recovery-choice-title" ref={heading} tabIndex={-1}>{t("確定不要找回的版本嗎？")}</h1>
        <p>{t("丟掉之後就找不回來了。")}</p>
        <div className="safety-actions">
          <button type="button" className="primary" onClick={() => setConfirmingDiscard(false)} data-testid="recovery-discard-back">{t("返回")}</button>
          <button type="button" className="danger" onClick={() => request.choose("discard")} data-testid="recovery-discard-confirm">{t("確定丟掉")}</button>
        </div>
      </> : <>
        <span className="safety-icon" aria-hidden="true">↺</span>
        <h1 id="recovery-choice-title" ref={heading} tabIndex={-1}>{t("上次的工作幫你找回來了")}</h1>
        <p>{t("Editkin 上次沒有正常關閉。這是 {time} 還沒存的「{name}」。", { time: request.savedAt, name: request.projectName })}</p>
        {request.failure && <div className="safety-failure" role="alert">
          <p>{t("打不開上次存的檔案。你可以打開找回的版本，或選「不要了」。")}</p>
          <details><summary>{t("查看原因")}</summary><p>{request.failure}</p></details>
        </div>}
        <div className="safety-choices">
          <button type="button" className="primary" onClick={() => request.choose("restore")} data-testid="recovery-restore">
            <strong>{t("打開找回的版本")}</strong><small>{t("從你停下來的地方繼續")}</small>
          </button>
          {request.savedFileAvailable && <button type="button" onClick={() => request.choose("open-saved")} data-testid="recovery-open-saved">
            <strong>{t("打開上次存的檔案")}</strong><small>{t("找回的版本會另外保留，不會刪掉")}</small>
          </button>}
          <button type="button" className="quiet" onClick={() => setConfirmingDiscard(true)} data-testid="recovery-discard">
            <strong>{t("不要了")}</strong><small>{t("丟掉找回的版本（會再問一次）")}</small>
          </button>
        </div>
      </>}
    </section>
  </main>;
}
