import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ProjectSession } from "../application/projectSession";
import type { HaoDesktopApi } from "../desktop/apiTypes";
import {
  createProjectOutsideMediaPrompt, shortFolder, usableProjectOutsideMediaApi, type ProjectOutsideMediaPromptState,
} from "../desktop/projectOutsideMediaConsent";
import { useI18n } from "./i18n/interfacePreferences";
import "./problemNotice.css";
import "./shellNotices.css";
import "./projectOutsideMediaPrompt.css";

/** At most this many file names are listed; the rest are counted. */
export const PROJECT_OUTSIDE_MEDIA_LISTED = 200;

type Asking = Extract<ProjectOutsideMediaPromptState, { kind: "asking" }>;

/** The question itself: plain words, the file names (folder shortened) on request, 允許 and 先不要. */
export function ProjectOutsideMediaPromptView({ state, onAllow, onDecline }: { state: Asking; onAllow: () => void; onDecline: () => void }) {
  const { t } = useI18n();
  const listed = state.files.slice(0, PROJECT_OUTSIDE_MEDIA_LISTED);
  return <section className="plain-problem-notice shell-notice-info project-outside-media-prompt" role="status" aria-labelledby="project-outside-media-question"
    data-testid="project-outside-media-prompt" data-count={state.count}>
    <span className="plain-problem-icon" aria-hidden="true">?</span>
    <div className="plain-problem-copy">
      <p className="project-outside-media-question" id="project-outside-media-question">
        {t("這個專案用到工作區外的 {count} 個素材。要允許 AI 助手讀取它們嗎？（只有你在這台電腦上按允許才會生效）", { count: state.count })}</p>
      <details className="project-outside-media-files">
        <summary>{t("看是哪些檔案")}</summary>
        <ul data-testid="project-outside-media-files">
          {listed.map(file => <li key={file.path}><b title={file.name}>{file.name}</b><small>{shortFolder(file.path)}</small></li>)}
        </ul>
        {state.count > listed.length && <p>{t("還有 {count} 個", { count: state.count - listed.length })}</p>}
      </details>
      {state.failed && <p className="plain-problem-todo" role="alert" data-testid="project-outside-media-failed">{t("沒有記錄到你的允許，請再按一次。")}</p>}
    </div>
    <div className="plain-problem-actions">
      <button type="button" className="plain-problem-primary" disabled={state.busy} onClick={onAllow} data-testid="project-outside-media-allow">
        {state.busy ? t("處理中…") : t("允許")}</button>
      <button type="button" disabled={state.busy} onClick={onDecline} data-testid="project-outside-media-decline">{t("先不要")}</button>
    </div>
  </section>;
}

const HIDDEN_SNAPSHOT: ProjectOutsideMediaPromptState = { kind: "hidden" };
const hiddenSnapshot = () => HIDDEN_SNAPSHOT;
const noSubscription = () => () => undefined;

/**
 * Desktop: asks once when an opened project uses media outside its folder that AI agents may not read yet (opening a
 * project grants nothing). Self-contained: give it the project session; it finds the desktop bridge itself and shows
 * nothing in the browser build, on the start screen (`enabled` false) or when nothing needs asking. Never blocks editing.
 */
export function ProjectOutsideMediaPrompt({ session, enabled = true, api }: {
  session: ProjectSession; enabled?: boolean; api?: Partial<HaoDesktopApi>;
}) {
  const bridge = usableProjectOutsideMediaApi(api ?? (typeof window === "undefined" ? undefined : window.haoDesktop));
  const prompt = useMemo(() => enabled && bridge ? createProjectOutsideMediaPrompt({ session, api: bridge }) : undefined, [enabled, bridge, session]);
  useEffect(() => prompt?.start(), [prompt]);
  const state = useSyncExternalStore(prompt?.subscribe ?? noSubscription, prompt?.getSnapshot ?? hiddenSnapshot, prompt?.getSnapshot ?? hiddenSnapshot);
  if (!prompt || state.kind !== "asking") return null;
  return <ProjectOutsideMediaPromptView state={state} onAllow={() => void prompt.allow()} onDecline={prompt.decline} />;
}
