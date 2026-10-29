import { useCallback } from "react";
import type { HaoDesktopApi } from "./types";
import type { AgentSetupRequest, AgentSetupResult } from "./types";
import type { AgentTarget } from "../application/agentSetup";
import { agentConnectFailureV1, agentSetupVerifiedV1 } from "../application/agentConnectOutcomeV1";

export function useDesktopActions(api: HaoDesktopApi | undefined, onStatus: (message: string) => void) {
  /** request.workspaceToken (a native folder choice) skips the picker; request.onProgress receives the live steps. */
  const connectAgent = useCallback(async (target: AgentTarget, request?: AgentSetupRequest) => {
    if (!api) return undefined;
    try {
      const agentName = target === "codex" ? "Codex" : "Claude Code";
      onStatus(request?.workspaceToken
        ? `正在把 ${agentName} 連到所選的工作資料夾…`
        : `請選擇要授權給 ${agentName} 的工作資料夾；取消不會變更設定。`);
      const result = request ? await api.copyAgentSetup(target, request) : await api.copyAgentSetup(target);
      if (result.canceled) {
        onStatus(result.message ?? "已取消選擇工作資料夾；沒有變更 AI 設定。");
        return result;
      }
      onStatus(result.message ?? (agentSetupVerifiedV1(result)
        ? `${agentName} 已設定最新版 Editkin MCP；開啟新 session 後才能確認 Agent 連線。`
        : result.status === "command_copied" ? `已複製 ${agentName} 備援指令；只需貼到終端執行一次。` : `${agentName} 這次沒有連成功。`));
      return result;
    } catch (error) {
      // The desktop bridge rejects with the Rust error string (not an Error): keep its real cause and the matching next
      // step instead of a generic sentence (2026-10-23, Area D B2/B3).
      const result: AgentSetupResult = agentConnectFailureV1(target, error);
      onStatus(result.message ?? "");
      return result;
    }
  }, [api, onStatus]);

  const checkForUpdates = useCallback(async () => {
    if (!api) return;
    try {
      onStatus("正在檢查並驗證更新…");
      const result = await api.checkForUpdates({ download: true });
      onStatus(result.message);
      if (result.status === "ready" && window.confirm(`${result.message}\n現在安裝嗎？`)) {
        const installed = await api.installUpdate();
        onStatus(installed.message);
      }
    } catch (error) {
      onStatus(error instanceof Error ? `更新檢查失敗：${error.message}` : "更新檢查失敗");
    }
  }, [api, onStatus]);

  return { connectAgent, checkForUpdates };
}
