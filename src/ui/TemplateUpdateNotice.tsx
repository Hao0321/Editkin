import { useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { EditorCommand } from "../domain/commands";
import type { ProjectSession } from "../application/projectSession";
import { prepareReferenceMotionTemplatesUpdatePacket } from "../application/referenceMotionTemplateInstances";
import { createTemplateUpdateNotice, type TemplateUpdateNoticeState } from "../application/templateUpdateNotice";
import { registerTemplatesUpdateRunner } from "../application/templatesUpdateRuns";
import { makeId } from "../lib/format";
import { translateUi as uiText, translateUiStatus, useI18n } from "./i18n/interfacePreferences";
import { runReferenceMotionUiPreparation, type ReferenceMotionUiPreparationOptions } from "./SavedReferenceMotionInstances";
import "./problemNotice.css";
import "./shellNotices.css";
import "./templateUpdateNotice.css";

export const TEMPLATES_UPDATE_RUNNING = "正在把標題更新到新版，好了會一次套用…";

/** One calm line offering 「把標題更新到新版」, or, after an update, the titles it left behind and why. */
export function TemplateUpdateNotice({ state, onUpdate, onDismiss }: {
  state: TemplateUpdateNoticeState; onUpdate: () => void; onDismiss: () => void;
}) {
  useI18n();
  if (state.kind === "offer") {
    return <section className="plain-problem-notice shell-notice-info template-update-notice" role="status" aria-label={uiText("舊版標題更新提示")}
      data-testid="template-update-notice" data-state={state.running ? "running" : "offer"} data-count={state.count}>
      <span className="plain-problem-icon" aria-hidden="true">↻</span>
      <p className="template-update-line">{uiText("這個專案有 {count} 個標題是舊版模板做的；更新到新版後就能繼續改字，文字都會保留。", { count: state.count })}</p>
      <div className="plain-problem-actions">
        <button type="button" className="plain-problem-primary" data-testid="template-update-run" disabled={state.running} onClick={onUpdate}>
          {state.running ? uiText("正在更新…") : uiText("把標題更新到新版")}</button>
        <button type="button" data-testid="template-update-dismiss" disabled={state.running} onClick={onDismiss}>{uiText("先不要")}</button>
      </div>
    </section>;
  }
  if (state.kind === "result") {
    const { report } = state;
    return <section className="plain-problem-notice shell-notice-warning template-update-notice" role="status" aria-label={uiText("舊版標題更新提示")}
      data-testid="template-update-notice" data-state="result">
      <span className="plain-problem-icon" aria-hidden="true">!</span>
      <div className="template-update-result">
        <p>{report.updated.length ? uiText("已更新 {count} 個標題；下面的標題沒有更新：", { count: report.updated.length }) : uiText("下面的標題沒有更新：")}</p>
        <ul data-testid="template-update-left">{report.notUpdated.map(row => <li key={row.instanceId} data-instance-id={row.instanceId}>
          <b>{row.title}</b>{translateUiStatus(row.reason)}</li>)}</ul>
      </div>
      <div className="plain-problem-actions">
        <button type="button" data-testid="template-update-close" onClick={onDismiss}>{uiText("知道了")}</button>
      </div>
    </section>;
  }
  return null;
}

export interface TemplateUpdateNoticeOptions {
  session: ProjectSession;
  /** False while the start screen shows; the notice waits for the editor. */
  enabled: boolean;
  runCommand: (command: EditorCommand, message?: string) => boolean | void;
  setStatus: (message: string) => void;
  pausePlayback?: () => void;
}

function browserStorage(): Storage | undefined {
  try { return typeof window !== "undefined" ? window.localStorage : undefined; }
  catch { return undefined; }
}

/**
 * 「把標題更新到新版」 from the notice, through the template editor's own runner: one command (one Undo), refused when the
 * project changes meanwhile, and its report published for the notice.
 */
export function runTemplatesUpdate(options: Pick<TemplateUpdateNoticeOptions, "session" | "runCommand" | "setStatus" | "pausePlayback">
  & Pick<ReferenceMotionUiPreparationOptions, "createTextPreparer">, isMounted: () => boolean = () => true) {
  const { session } = options, project = session.getSnapshot().history.present;
  options.pausePlayback?.();
  options.setStatus(TEMPLATES_UPDATE_RUNNING);
  return runReferenceMotionUiPreparation({ project, session, controller: new AbortController(), isMounted, action: "更新標題模板",
    prepare: (prepareText, signal) => prepareReferenceMotionTemplatesUpdatePacket(project, { prepareText, signal, idFactory: makeId }),
    onCommand: options.runCommand, onStatus: options.setStatus, createTextPreparer: options.createTextPreparer });
}

/**
 * The editor's notice for a project whose titles an Editkin update left behind (see createTemplateUpdateNotice). Its
 * host also runs 「把標題更新到新版」 for the whole window, so the template editor's button runs the very same update.
 */
export function useTemplateUpdateNotice(options: TemplateUpdateNoticeOptions): { visible: boolean; notice: ReactNode } {
  const latest = useRef(options);
  latest.current = options;
  const mounted = useRef(true);
  const notice = useMemo(() => createTemplateUpdateNotice({ session: options.session, storage: browserStorage() }), [options.session]);
  useEffect(() => {
    mounted.current = true;
    const stopRunner = registerTemplatesUpdateRunner(() => runTemplatesUpdate(latest.current, () => mounted.current));
    const stop = notice.start();
    return () => { mounted.current = false; stop(); stopRunner(); };
  }, [notice]);
  const state = useSyncExternalStore(notice.subscribe, notice.getSnapshot, notice.getSnapshot);
  const visible = options.enabled && state.kind !== "hidden";
  return { visible, notice: visible ? <TemplateUpdateNotice state={state} onUpdate={() => void notice.update()} onDismiss={notice.dismiss} /> : null };
}
