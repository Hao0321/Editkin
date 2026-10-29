import type { AgentSetupResult } from "../desktop/mediaTypes";
import type { AgentTarget } from "./agentSetup";

/** Browser-safe copy of autopilotInvocationIdentity's VIDEO_AUTOPILOT_KIT_URL (that module is Node-only); a test pins them equal. */
export const AGENT_CONNECT_KIT_URL_V1 = "https://github.com/Hao0321/video-autopilot-kit";

const AGENT_NAME: Record<AgentTarget, string> = { codex: "Codex", claude: "Claude Code" };
const AGENT_COMMAND: Record<AgentTarget, string> = { codex: "codex", claude: "claude" };

/** Statuses after which the AI has Editkin's current MCP (a repeat Codex connect answers `already_installed`). */
export function agentSetupVerifiedV1(result: AgentSetupResult | undefined): boolean {
  return Boolean(result && (result.status === "installed" || result.status === "already_configured" || result.status === "already_installed")
    && result.runtimeVerified === true);
}

/** The text of a desktop rejection: the Tauri bridge rejects with the Rust error string, not an Error. */
export function agentConnectErrorTextV1(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error && typeof (error as { message: unknown }).message === "string") return (error as { message: string }).message;
  return "";
}

/**
 * A failed connect in plain words with the next step that fits the real cause, instead of one generic sentence and
 * steps that tell the person to paste a command nothing copied. The original text stays in `detail` (查看原因).
 */
export function agentConnectFailureV1(target: AgentTarget, error: unknown): AgentSetupResult {
  const detail = agentConnectErrorTextV1(error).trim(), name = AGENT_NAME[target];
  const base = { canceled: false, target, status: "failed" as const, health: "failed" as const, ...(detail ? { detail } : {}) };
  if (/video-autopilot|SKILL\.md|Autopilot Kit/i.test(detail)) return { ...base, cause: "kit_missing",
    message: "這台電腦還沒有安裝 Video Autopilot Kit，AI 需要它才能照規則剪片。",
    repairSteps: [`到 ${AGENT_CONNECT_KIT_URL_V1} 下載 Video Autopilot Kit，照 SETUP.md 安裝`, `裝好後回到 Editkin，再按一次「連接 ${name}」`] };
  if (/CLI.*(尚未安裝|PATH)|not recognized|ENOENT|command not found/i.test(detail)) return { ...base, cause: "cli_missing",
    message: `這台電腦找不到 ${name}，或它不在系統路徑（PATH）裡。`,
    repairSteps: [`先安裝並登入 ${name}，確認在終端機輸入 ${AGENT_COMMAND[target]} 能打開它`, `回到 Editkin，再按一次「連接 ${name}」`] };
  if (/工作資料夾|工作目錄|裝置路徑/.test(detail)) return { ...base, cause: "workspace", message: detail,
    repairSteps: ["重新按連接，選擇已存在且可存取的工作資料夾", "確認要剪輯的專案與素材都在所選資料夾範圍內"] };
  return { ...base, cause: "unknown", message: `Editkin 這次沒能設定 ${name}。`,
    repairSteps: ["按「返回重試」再試一次", "還是不行：重新開啟 Editkin 再試；仍然失敗時，把「查看原因」裡的文字提供給支援"] };
}

/** What to do next when the result has no steps of its own: only a copied command may be pasted. */
export function agentConnectDefaultStepsV1(result: AgentSetupResult): string[] {
  return result.status === "command_copied"
    ? ["開啟終端機", "貼上已複製的安全設定指令並按 Enter", "重新開啟 AI session，輸入 /mcp 確認 editkin"]
    : ["按「返回重試」再試一次", "還是不行：重新開啟 Editkin 再試；仍然失敗時，把「查看原因」裡的文字提供給支援"];
}
