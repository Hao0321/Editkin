import { useState, useSyncExternalStore } from "react";
import { useI18n } from "./i18n/interfacePreferences";
import { localizeExportRefusalReasonV1 } from "./i18n/exportRefusalTranslationV1";
import { currentAppProblems, dismissAppProblem, subscribeAppProblems, type AppProblemNotice, type ProblemNoticeAction } from "../application/appProblemStore";
import type { PlainProblem } from "../application/plainProblems";
import "./problemNotice.css";

export function useAppProblems() {
  return useSyncExternalStore(subscribeAppProblems, currentAppProblems, currentAppProblems);
}

/** Title, what happened and what to do; the raw reason only under 「查看原因」 (an export refusal in it is translated). */
export function PlainProblemText({ problem, titleId }: { problem: PlainProblem; titleId?: string }) {
  const { t } = useI18n();
  return <>
    {problem.title && <strong className="plain-problem-title" id={titleId}>{t(problem.title)}</strong>}
    <p className="plain-problem-what">{t(problem.what)}</p>
    <p className="plain-problem-todo">{t(problem.todo)}</p>
    {problem.detail && <details className="plain-problem-reason"><summary>{t("查看原因")}</summary><p>{localizeExportRefusalReasonV1(problem.detail)}</p></details>}
  </>;
}

export function ProblemActionButton({ action, describedBy }: { action: ProblemNoticeAction; describedBy?: string }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  return <button type="button" className={action.primary ? "plain-problem-primary" : undefined} aria-describedby={describedBy} disabled={busy}
    onClick={() => {
      setBusy(true);
      let outcome: unknown;
      try { outcome = action.run(); } catch (error) { outcome = Promise.reject(error); }
      void Promise.resolve(outcome).catch(() => undefined).finally(() => setBusy(false));
    }}>{busy ? t("處理中…") : t(action.label)}</button>;
}

/** Save, open, reload and relink failures, under the toolbar: one notice per kind, newest wording. */
export function AppProblemNotices({ hide }: { hide?: (problem: AppProblemNotice) => boolean } = {}) {
  const { t } = useI18n();
  const problems = useAppProblems();
  return <>{problems.filter(problem => !hide?.(problem)).map(problem => {
    const titleId = `app-problem-title-${problem.key}-${problem.id}`;
    return <section key={`${problem.key}:${problem.id}`} className="plain-problem-notice" role="alert" aria-labelledby={titleId}
      data-testid={`problem-notice-${problem.key}`} data-cause={problem.cause}>
      <span className="plain-problem-icon" aria-hidden="true">!</span>
      <div className="plain-problem-copy"><PlainProblemText problem={problem} titleId={titleId} /></div>
      <div className="plain-problem-actions">
        {problem.actions.map(action => <ProblemActionButton key={action.label} action={action} describedBy={titleId} />)}
        <button type="button" className="plain-problem-dismiss" aria-label={t("關閉這則提醒")} title={t("關閉這則提醒")}
          onClick={() => dismissAppProblem(problem.key, problem.id)}><span aria-hidden="true">×</span></button>
      </div>
    </section>;
  })}</>;
}
