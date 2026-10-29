import { translateUi as uiText, translateUiStatus, useI18n, type UiLocale } from "./i18n/interfacePreferences";
import { localizeExportRefusalReasonV1, translateExportRefusalTextV1 } from "./i18n/exportRefusalTranslationV1";
import { useMemo, useRef, useSyncExternalStore } from "react";
import { simplifyStatus, STATUS_NEUTRAL, STATUS_PROBLEM_LINE, type PlainStatus } from "../application/plainStatus";
import type { PlainProblem } from "../application/plainProblems";
import { subscribeTemplateFollowProgress, templateFollowProgress } from "../application/templateFollowProgress";
import { currentRenderJob, subscribeRenderJob } from "../desktop/renderJobStore";
import "./operationStatus.css";

interface OperationStatusProps {
  status: string;
  runtimeInfo: string;
}

const CJK = /[㐀-鿿]/;

/** Source text in the current language; plain words never fall back to untranslated Chinese in another language. */
function sourceText(text: string, locale: UiLocale, fallbackKey: string): string {
  const translated = translateExportRefusalTextV1(text);
  return locale !== "zh-TW" && translated === text && CJK.test(text) ? uiText(fallbackKey) : translated;
}

/** The simple-mode words for a simplified status: one line, plus what to do when something did not work. */
function plainWords(plain: Exclude<PlainStatus, { kind: "as-is" }>, locale: UiLocale): { line: string; advice?: string } {
  switch (plain.kind) {
    case "message": return { line: uiText(plain.key, plain.values) };
    case "text": return { line: sourceText(plain.text, locale, STATUS_NEUTRAL) };
    case "problem": {
      const label = plain.label === plain.fallbackLabel ? uiText(plain.label) : sourceText(plain.label, locale, plain.fallbackLabel);
      return { line: uiText(STATUS_PROBLEM_LINE, { label, what: uiText(plain.what) }), advice: uiText(plain.todo) };
    }
  }
}

/**
 * A persistent, neutral message surface; status text never determines success. In simple mode it says only plain
 * words (「正在輸出 45%」「輸出失敗：存放的磁碟空間不夠了。」): encoder names, revision numbers and engine text move
 * behind 「查看原因」. Advanced mode shows the detailed text as it is.
 *
 * While a clip edit lays a title template out again and it takes a moment, it says 「標題跟著調整中…」 instead
 * (templateFollowProgress waits about 300 ms, so a fast edit never flashes it). The hint goes away when the edit is
 * applied or refused, and also as soon as any newer message arrives (an Undo, for example).
 */
export function OperationStatus({ status, runtimeInfo }: OperationStatusProps) {
  const { locale, mode } = useI18n();
  const details = useRef<HTMLDetailsElement>(null);
  const job = useSyncExternalStore(subscribeRenderJob, currentRenderJob, currentRenderJob);
  const follow = useSyncExternalStore(subscribeTemplateFollowProgress, templateFollowProgress, templateFollowProgress);
  // The message showing when the wait began: a different one means something newer happened.
  const followStart = useRef<{ episode: number; status: string } | undefined>(undefined);
  if (follow.pending && followStart.current?.episode !== follow.episode) followStart.current = { episode: follow.episode, status };
  const following = follow.visible && followStart.current?.episode === follow.episode && followStart.current.status === status;
  // The export's own plain cause stays matched to its raw text after the export panel closes.
  const exportProblem = useRef<PlainProblem | undefined>(undefined);
  if (job?.phase === "failed" && job.problem) exportProblem.current = job.problem;
  const source = status.trim() ? status : "目前沒有進行中的操作。";
  const plain = useMemo<PlainStatus>(() => mode === "simple" ? simplifyStatus(source, { job, exportProblem: exportProblem.current }) : { kind: "as-is" },
    [mode, source, job]);
  const words = useMemo(() => plain.kind === "as-is" ? { line: translateExportRefusalTextV1(source) } : plainWords(plain, locale), [plain, source, locale]);
  const reason = !following && plain.kind !== "as-is" && plain.detail && plain.detail.trim() !== words.line ? plain.detail : undefined;
  const message = following ? uiText("標題跟著調整中…") : words.line;
  const runtime = useMemo(() => translateUiStatus(runtimeInfo), [runtimeInfo, locale]);
  const close = () => {
    if (!details.current) return;
    details.current.open = false;
    details.current.querySelector("summary")?.focus();
  };
  return <details ref={details} className="operation-status" data-testid="operation-status" data-plain-status={plain.kind === "as-is" ? undefined : plain.kind}
    data-template-follow={following ? "pending" : undefined} onKeyDown={(event) => {
    if (event.key === "Escape" && details.current?.open) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }}>
    <summary title={message}>
      <b>{uiText("操作狀態")}</b>
      <span className="operation-status-message" data-testid="operation-status-message" role="status" aria-live="polite" aria-atomic="true">{message}</span>
      <span className="operation-status-chevron" aria-hidden="true">⌃</span>
    </summary>
    <div className="operation-status-panel" data-testid="operation-status-panel">
      <header><strong>{uiText("目前操作")}</strong><button type="button" onClick={close} aria-label={uiText("關閉操作狀態")}>×</button></header>
      <p className="operation-status-full-message">{message}</p>
      {!following && words.advice && <p className="operation-status-advice" data-testid="operation-status-advice">{words.advice}</p>}
      {reason && <details className="operation-status-reason" data-testid="operation-status-reason"><summary>{uiText("查看原因")}</summary><p>{localizeExportRefusalReasonV1(reason)}</p></details>}
      <p className="operation-status-runtime">{runtime}</p>
    </div>
  </details>;
}
