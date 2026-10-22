import type { HaoDesktopApi, OpenProjectResult } from "../desktop/types";
import type { EditProject } from "../domain/types";
import { EXTERNAL_WRITE_UNDO_LABEL, isSingleRevisionExternalWrite, type ProjectSession } from "./projectSession";
import { clearAppProblem, reportAppProblem, type ProblemNoticeAction } from "./appProblemStore";
import { problemCause, rawProblemDetail, type ProblemAction, type ProblemCause } from "./plainProblems";

export interface ProjectPathOpenInput {
  api?: Pick<HaoDesktopApi, "openProjectPath">;
  session: ProjectSession;
  loadOpenedProject?: (opened: OpenProjectResult) => void;
  setStatus: (message: string) => void;
  pausePlayback?: () => void;
  /** Asked only when unsaved changes would be replaced; the message is a zh-TW key. */
  confirmDiscard?: (message: string) => boolean;
  /** More buttons for the failure notice (e.g. remove a recent project that is gone). */
  failureActions?: (cause: ProblemCause) => ProblemNoticeAction[];
  /**
   * Names the one Undo step a reload adopts (ROADMAP J4), usually from the committed receipt that wrote the new
   * revision (see externalWriteLabelFromReceipt). Missing, empty or failing falls back to 「外部修改」.
   */
  externalWriteLabel?: (opened: OpenProjectResult & { project: EditProject }) => Promise<string | undefined> | string | undefined;
}

/** A plain label from the committed execution receipt that wrote exactly this revision; undefined when it is not that receipt. */
export function externalWriteLabelFromReceipt(receipt: unknown, project: EditProject): string | undefined {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return undefined;
  const value = receipt as Record<string, unknown>;
  const identity = value.projectIdentityAfter as Record<string, unknown> | undefined;
  if (value.schema !== "hao.video-autopilot.execution-receipt/v1" || value.state !== "committed" || value.projectRevisionAfter !== project.revision
    || !identity || typeof identity !== "object" || identity.id !== project.id) return undefined;
  const chapters = (value.longformSet as { chapters?: unknown } | undefined)?.chapters;
  return Array.isArray(chapters) ? `AI 長片套用（${chapters.length} 章）` : "AI 自動剪輯套用";
}

async function readExternalWriteLabel(input: ProjectPathOpenInput, opened: OpenProjectResult & { project: EditProject }): Promise<string> {
  try {
    const label = await input.externalWriteLabel?.(opened);
    return typeof label === "string" && label.trim() ? label.trim().slice(0, 120) : EXTERNAL_WRITE_UNDO_LABEL;
  } catch { return EXTERNAL_WRITE_UNDO_LABEL; }
}

/**
 * Opens a project file the editor already knows (a recent project, or the open file after another program such
 * as an AI agent changed it) without a file dialog. Unsaved changes are replaced only after confirmation; a
 * failure becomes a plain problem notice ("open" or "reload") with the raw reason under 「查看原因」.
 */
export async function openProjectAtPath(input: ProjectPathOpenInput, path: string, action: Extract<ProblemAction, "open" | "reload"> = "open"): Promise<boolean> {
  if (!input.api?.openProjectPath || !input.loadOpenedProject) return false;
  const started = input.session.getSnapshot();
  const confirm = input.confirmDiscard ?? ((message: string) => window.confirm(message));
  if (started.dirty && !confirm(action === "reload"
    ? "載入新的版本會取代你還沒存的修改。要繼續嗎？"
    : "開啟其他專案會捨棄目前尚未儲存的修改。要繼續嗎？")) return false;
  try {
    input.pausePlayback?.();
    const opened = await input.api.openProjectPath(path);
    if (!input.session.isCurrentSession(started.sessionId) || opened.canceled || !opened.project) return false;
    const openedProject = opened.project;
    const label = action === "reload" && input.externalWriteLabel ? await readExternalWriteLabel(input, { ...opened, project: openedProject }) : EXTERNAL_WRITE_UNDO_LABEL;
    if (!input.session.isCurrentSession(started.sessionId)) return false;
    const current = input.session.getSnapshot();
    if (current.dirty && current.history.present !== started.history.present
      && !confirm("選擇檔案期間又有新的修改。確定捨棄這些修改並開啟其他專案嗎？")) return false;
    // ROADMAP J4: another program's clean single-revision write (Shorts, long-form or manual MCP apply) is one Undo step.
    const previous = current.history.present;
    if (action === "reload" && !current.dirty && !current.savePending && isSingleRevisionExternalWrite(previous, openedProject)) {
      input.session.adoptExternalWrite({ previous, next: openedProject, label }, () => input.loadOpenedProject?.(opened));
    } else input.loadOpenedProject(opened);
    clearAppProblem(action);
    input.setStatus(action === "reload" ? `已載入專案檔裡的新版本：${opened.path ?? path}` : `已開啟 ${opened.path ?? path}`);
    return true;
  } catch (error) {
    if (!input.session.isCurrentSession(started.sessionId)) return false;
    input.setStatus(error instanceof Error ? error.message : String(error));
    const extra = input.failureActions?.(problemCause(action, rawProblemDetail(error))) ?? [];
    reportAppProblem(action, error, [{ label: "再試一次", run: () => openProjectAtPath(input, path, action), primary: extra.length === 0 }, ...extra]);
    return false;
  }
}
