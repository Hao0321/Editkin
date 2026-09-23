import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { useDesktopActions } from "./useDesktopActions";
import type { AgentSetupResult, HaoDesktopApi } from "./types";

// Real React hooks during SSR; only the desktop IPC API is a memory substitute.
function actionsFor(result: AgentSetupResult | Error) {
  const copyAgentSetup = result instanceof Error ? vi.fn().mockRejectedValue(result) : vi.fn().mockResolvedValue(result);
  const api = { copyAgentSetup } as unknown as HaoDesktopApi;
  const onStatus = vi.fn();
  let actions!: ReturnType<typeof useDesktopActions>;
  function Probe() { actions = useDesktopActions(api, onStatus); return null; }
  renderToStaticMarkup(<Probe />);
  return { actions, onStatus, copyAgentSetup };
}

describe("agent workspace selection status", () => {
  it.each(["codex", "claude"] as const)("keeps %s cancellation distinct from failure/connection success", async (target) => {
    const canceled = { canceled: true, target, message: "已取消選擇工作資料夾；沒有變更 Codex／Claude 設定" } satisfies AgentSetupResult;
    const { actions, onStatus, copyAgentSetup } = actionsFor(canceled);
    await expect(actions.connectAgent(target)).resolves.toEqual(canceled);
    expect(copyAgentSetup).toHaveBeenCalledExactlyOnceWith(target);
    expect(onStatus.mock.calls[0][0]).toContain("請選擇要授權給");
    expect(onStatus).toHaveBeenLastCalledWith(canceled.message);
    expect(onStatus.mock.calls.flat().join(" ")).not.toMatch(/已連上|已複製|已設定最新版/);
  });

  it("uses an explicit cancellation message even when the native result has no message", async () => {
    const { actions, onStatus } = actionsFor({ canceled: true, target: "codex" });
    await actions.connectAgent("codex");
    expect(onStatus).toHaveBeenLastCalledWith("已取消選擇工作資料夾；沒有變更 AI 設定。");
  });

  it("surfaces invalid/missing workspace as failure without claiming configuration success", async () => {
    const { actions, onStatus } = actionsFor(new Error("無法確認所選工作資料夾；未變更 AI 設定"));
    await expect(actions.connectAgent("claude")).resolves.toMatchObject({ status: "failed", health: "failed", canceled: false });
    expect(onStatus).toHaveBeenLastCalledWith("無法確認所選工作資料夾；未變更 AI 設定");
  });

  it("preserves the safe native workspace-validation result message without relying on Tauri error-string handling", async () => {
    const native = { canceled: false, target: "codex", status: "failed", health: "failed", message: "無法確認所選工作資料夾；未變更 AI 設定" } satisfies AgentSetupResult;
    const { actions, onStatus } = actionsFor(native);
    await expect(actions.connectAgent("codex")).resolves.toEqual(native);
    expect(onStatus).toHaveBeenLastCalledWith(native.message);
  });
});
