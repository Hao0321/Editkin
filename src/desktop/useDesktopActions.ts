import { useCallback } from "react";
import type { HaoDesktopApi } from "./types";
import type { AgentSetupResult } from "./types";
import type { AgentTarget } from "../application/agentSetup";

export function useDesktopActions(api: HaoDesktopApi | undefined, onStatus: (message: string) => void) {
  const connectAgent = useCallback(async (target: AgentTarget) => {
    if (!api) return undefined;
    try {
      const agentName = target === "codex" ? "Codex" : "Claude Code";
      onStatus(`請選擇要授權給 ${agentName} 的工作資料夾；取消不會變更設定。`);
      const result = await api.copyAgentSetup(target);
      if (result.canceled) {
        onStatus(result.message ?? "已取消選擇工作資料夾；沒有變更 AI 設定。");
        return result;
      }
      onStatus(result.message ?? (result.status === "installed" && result.runtimeVerified
        ? `${agentName} 已設定最新版 Editkin MCP；開啟新 session 後才能確認 Agent 連線。`
        : `已複製 ${agentName} 備援指令；只需貼到終端執行一次。`));
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "無法建立 Agent 串接設定";
      onStatus(message);
      return { canceled: false, target, status: "failed", health: "failed", message } satisfies AgentSetupResult;
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
