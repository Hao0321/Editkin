import type { AgentTarget } from "../../application/agentSetup";
import { AGENT_CONNECT_KIT_URL_V1, agentSetupVerifiedV1 } from "../../application/agentConnectOutcomeV1";
import type { AgentSetupFailureCodeV1, AgentSetupResultV1, AgentSetupStepV1 } from "./agentConnectTypesV1";

/**
 * Plain words for 「讓 AI 幫我剪片」. Every string here is a zh-TW interface key translated by interfaceMessages.241.ts;
 * screens pass them through uiText with `{app}` / `{command}` / `{folder}` values. No jargon on screen: no MCP, JSON,
 * scope, launcher or generation (those stay in the folded 查看原因 / 技術細節 and in the copied problem report).
 */

export const AGENT_APP_NAME_V1: Record<AgentTarget, string> = { claude: "Claude Code", codex: "Codex" };
export const AGENT_COMMAND_V1: Record<AgentTarget, string> = { claude: "claude", codex: "codex" };
/**
 * The official pages, exactly as the native open_external_url allow-list has them (src-tauri agent_connect.rs
 * EXTERNAL_URL_ALLOWLIST): anything else is refused natively.
 */
export const AGENT_DOWNLOAD_URL_V1: Record<AgentTarget, string> = {
  claude: "https://code.claude.com/docs/en/setup",
  codex: "https://github.com/openai/codex",
};
export const EDITKIN_RELEASES_URL_V1 = "https://github.com/Hao0321/Editkin/releases";
export const AGENT_KIT_URL_V1 = AGENT_CONNECT_KIT_URL_V1;
export const AGENT_EXTERNAL_URLS_V1: readonly string[] = [AGENT_DOWNLOAD_URL_V1.claude, AGENT_DOWNLOAD_URL_V1.codex, AGENT_KIT_URL_V1, EDITKIN_RELEASES_URL_V1];
/** Tile order: Claude Code first, then Codex. */
export const AGENT_TARGETS_V1: readonly AgentTarget[] = ["claude", "codex"];

/** The three steps people see while it connects. The native steps fold into them. */
export type AgentConnectStageV1 = "helper" | "config" | "hello";
export const AGENT_CONNECT_STAGES_V1: readonly { id: AgentConnectStageV1; label: string }[] = [
  { id: "helper", label: "準備小幫手" },
  { id: "config", label: "告訴 {app} 怎麼找到 Editkin" },
  { id: "hello", label: "試著打招呼" },
];
export function agentConnectStageOfV1(step: AgentSetupStepV1): AgentConnectStageV1 {
  if (step === "write_config") return "config";
  if (step === "health_check") return "hello";
  return "helper";
}

/** The problem codes the screen knows: the native failure codes plus two older-desktop results. */
export type AgentConnectProblemCodeV1 = AgentSetupFailureCodeV1 | "KIT_MISSING" | "MANUAL_STEP";
/** An extra button beside the main one: open a page. */
export type AgentConnectFixV1 = "download" | "update" | "kit";
/** The main button: run the setup again, show the command to paste, or choose the folder again. */
export type AgentConnectPrimaryV1 = "retry" | "manual" | "folder";

export interface AgentConnectProblemCopyV1 {
  title: string;
  body: string;
  fix?: AgentConnectFixV1;
  /** Default retry. `manual` falls back to retry when the result carries no command. */
  primary?: AgentConnectPrimaryV1;
}

/** One plain title and one sentence per code. `{app}` is the AI app's name. */
export const AGENT_CONNECT_PROBLEM_COPY_V1: Record<AgentConnectProblemCodeV1, AgentConnectProblemCopyV1> = {
  AGENT_APP_NOT_FOUND: { title: "找不到 {app}", body: "這台電腦還沒有裝 {app}。裝好後，把 Editkin 關掉再打開，然後按「再試一次」。", fix: "download" },
  RUNTIME_FILES_MISSING: { title: "Editkin 的連線小幫手沒有啟動", body: "Editkin 少了一些檔案。請更新 Editkin，再按「再試一次」。", fix: "update" },
  RUNTIME_PROBE_FAILED: { title: "Editkin 的連線小幫手沒有啟動", body: "小幫手試著啟動，但沒有成功。請更新 Editkin，再按「再試一次」。", fix: "update" },
  WORKSPACE_NOT_WRITABLE: { title: "這個資料夾不能用", body: "Editkin 沒辦法在這個資料夾裡存東西。換一個資料夾（例如「文件」裡的），再試一次。", primary: "folder" },
  WORKSPACE_CHOICE_EXPIRED: { title: "請再選一次資料夾", body: "剛才選的資料夾等太久了。再選一次，然後按「用這個資料夾」就好。", primary: "folder" },
  WORKSPACE_UNSAFE: { title: "這個資料夾不能用", body: "請選一般的資料夾，例如「文件」裡的。", primary: "folder" },
  CONFIG_WRITE_REFUSED: { title: "{app} 沒有讓 Editkin 寫入設定", body: "先把 {app} 的視窗全部關掉，再按「再試一次」。還是不行，可以按「我自己貼指令」。" },
  CONFIG_ALREADY_EXISTS_DIFFERENT: { title: "{app} 裡有一份 Editkin 設定，Editkin 沒辦法自己換掉",
    body: "可能是你或別的程式另外加的。按「我自己貼指令」，照步驟貼上一次，就會換成這一版。", primary: "manual" },
  HEALTH_CHECK_FAILED: { title: "設定寫好了，但打招呼沒有回應", body: "先把 {app} 完全關掉再打開，然後回來按「再試一次」。" },
  UNKNOWN: { title: "這次沒連上", body: "原因不清楚。按「再試一次」；還是不行，請按「複製問題報告」，貼到 GitHub 的問題回報。" },
  KIT_MISSING: { title: "還差一個「影片自動剪輯技能」", body: "AI 要先有這個技能，才能照規則剪片。裝好後再按「再試一次」。", fix: "kit" },
  MANUAL_STEP: { title: "還差一步：自己貼一次指令", body: "{app} 沒有接受自動設定。指令已經複製好了，照下面的步驟貼上就好。" },
};

/** The page buttons' labels. */
export const AGENT_CONNECT_FIX_LABEL_V1: Record<AgentConnectFixV1, string> = {
  download: "下載 {app}",
  update: "打開 Editkin 下載頁",
  kit: "看怎麼裝",
};
export const AGENT_CONNECT_FIX_URL_V1 = (fix: AgentConnectFixV1, target: AgentTarget) =>
  fix === "download" ? AGENT_DOWNLOAD_URL_V1[target] : fix === "update" ? EDITKIN_RELEASES_URL_V1 : AGENT_KIT_URL_V1;

export interface AgentConnectProblemV1 {
  code: AgentConnectProblemCodeV1;
  /** The native step, when the result says where it stopped. */
  step?: AgentSetupStepV1;
  detail?: string;
  logPath?: string;
  /** The exact command for 「我自己貼指令」, only when the result carries it. */
  fallbackCommand?: string;
  /** The desktop already put the command on the clipboard (status command_copied; verified when `clipboardWritten`). */
  commandAlreadyCopied: boolean;
}

/**
 * What went wrong, from a result that is not a verified connection. The structured `failure` wins; an older desktop's
 * result (no `failure`) is read from its `cause` / `status` so it still gets plain words instead of a generic line.
 */
export function agentConnectProblemV1(result: AgentSetupResultV1): AgentConnectProblemV1 {
  const fallbackCommand = typeof result.fallbackCommand === "string" && result.fallbackCommand.trim() ? result.fallbackCommand : undefined;
  // command_copied: the native side wrote the command to the clipboard (and read it back when `clipboardWritten`).
  const base = { fallbackCommand, commandAlreadyCopied: result.status === "command_copied" && (result.clipboardWritten !== false || !fallbackCommand) };
  if (result.failure) {
    const failure = result.failure;
    return { ...base, code: AGENT_CONNECT_PROBLEM_COPY_V1[failure.code] ? failure.code : "UNKNOWN", step: failure.step,
      detail: failure.detail || result.detail || result.message, logPath: failure.logPath ?? result.logPath };
  }
  const detail = [result.message, result.detail].filter((text, index, all): text is string => Boolean(text) && all.indexOf(text) === index).join("\n") || undefined;
  if (result.status === "command_copied") return { ...base, code: "MANUAL_STEP", step: "write_config", detail };
  if (result.cause === "kit_missing") return { ...base, code: "KIT_MISSING", step: "detect", detail: result.detail ?? result.message };
  if (result.cause === "cli_missing") return { ...base, code: "AGENT_APP_NOT_FOUND", step: "detect", detail };
  if (result.cause === "workspace") return { ...base, code: "WORKSPACE_NOT_WRITABLE", detail };
  // An older desktop's 健康檢查未通過: the configuration was written and the runtime started.
  if (result.status === "failed" && result.runtimeVerified === true && !result.cause) return { ...base, code: "HEALTH_CHECK_FAILED", step: "health_check", detail };
  return { ...base, code: "UNKNOWN", detail };
}

/** The main button a problem gets: `manual` only when there is a command to show. */
export function agentConnectPrimaryV1(problem: AgentConnectProblemV1): AgentConnectPrimaryV1 {
  const primary = AGENT_CONNECT_PROBLEM_COPY_V1[problem.code].primary ?? "retry";
  return primary === "manual" && !problem.fallbackCommand && !problem.commandAlreadyCopied ? "retry" : primary;
}

/** A verified connection (installed, already configured, or a repeat connect that found it already there). */
export const agentConnectSucceededV1 = (result: AgentSetupResultV1 | undefined) => agentSetupVerifiedV1(result);

/** The last folder name of a Windows or POSIX path. */
export function agentFolderNameV1(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : undefined;
}

/** The friendly first line people paste into their AI (translated: it is the creator's own request). */
export const AGENT_STARTER_REQUEST_V1 = "用 Editkin 把『{folder}』資料夾裡的影片剪成一支 30 秒短片";
export const AGENT_STARTER_REQUEST_NO_FOLDER_V1 = "用 Editkin 把我的影片剪成一支 30 秒短片";
export const AGENT_STARTER_REQUEST_MV_V1 = "用 Editkin 把『{folder}』資料夾裡的素材做成一支原創插畫 Music MV";
export const AGENT_STARTER_REQUEST_MV_NO_FOLDER_V1 = "用 Editkin 把我的素材做成一支原創插畫 Music MV";

/** The Music MV route the old dialog appended to the workflow prompt (kept word for word). */
export const AGENT_MUSIC_MV_ROUTE_V1 = "本次請製作原創插畫動畫 Music MV：遵循 video-autopilot 的 music-video-motion 流程；先取得有使用權的歌曲，核對 beat/phrase，準備原創角色透明圖層及背景插畫，依 intro/verse/chorus 等樂段規劃分鏡、角色動勢與畫面內文字；用 Editkin 的 prepare_illustrated_music_video_draft 編出可編輯分層命令，再綁定 v4 計畫 audit、apply、render，逐鏡檢查美術與效能。缺插畫時先安排生成／匯入，不得拿實拍歌詞卡代替。歌詞必須有可核對來源；沒有時只用經 brief 核對的標題文字。";

/**
 * What 「複製這句話」 puts on the clipboard: the friendly request, then the full editing rules the AI follows (the
 * native result's starter prompt), so pasting one thing starts the complete, checked workflow.
 */
export function agentStarterClipboardV1(request: string, workflowPrompt: string, musicMvMode: boolean): string {
  return [request, workflowPrompt, musicMvMode ? AGENT_MUSIC_MV_ROUTE_V1 : ""].filter(Boolean).join("\n\n");
}

export interface AgentProblemReportInputV1 {
  problem: AgentConnectProblemV1;
  target?: AgentTarget;
  /** e.g. 「0.15.0 (official, build 1a2b3c4)」, or undefined when the build did not say. */
  editkinVersion?: string;
  status?: string;
  at: Date;
}

/** 「複製問題報告」: plain English lines for a GitHub issue, codes verbatim. No workspace path is included. */
export function agentProblemReportV1({ problem, target, editkinVersion, status, at }: AgentProblemReportInputV1): string {
  return [
    "Editkin AI connection problem report",
    `Editkin: ${editkinVersion ?? "unknown"}`,
    `AI app: ${target ? AGENT_APP_NAME_V1[target] : "unknown"}`,
    `Code: ${problem.code}`,
    `Step: ${problem.step ?? "unknown"}`,
    ...(status ? [`Status: ${status}`] : []),
    `Detail: ${problem.detail?.trim() || "(none)"}`,
    `Log: ${problem.logPath ?? "(none)"}`,
    `Time: ${at.toISOString()}`,
  ].join("\n");
}

/** 「0.15.0 (official, build 1a2b3c4)」 from appBuildInfo. */
export function agentEditkinVersionV1(info: { version?: string; productVersion?: string; buildId?: string; buildIdFull?: string; edition?: string } | undefined): string | undefined {
  if (!info?.version && !info?.productVersion) return undefined;
  const extra = [info.edition, info.buildIdFull ?? info.buildId ? `build ${info.buildIdFull ?? info.buildId}` : ""].filter(Boolean).join(", ");
  return `${info.productVersion ?? info.version}${extra ? ` (${extra})` : ""}`;
}
