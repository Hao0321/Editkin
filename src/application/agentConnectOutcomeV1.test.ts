import { describe, expect, it, vi } from "vitest";
import { VIDEO_AUTOPILOT_KIT_URL } from "./autopilotInvocationIdentity";
import { AGENT_CONNECT_KIT_URL_V1, agentConnectDefaultStepsV1, agentConnectErrorTextV1, agentConnectFailureV1, agentSetupVerifiedV1 } from "./agentConnectOutcomeV1";

vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useCallback: (callback: unknown) => callback }));
import { useDesktopActions } from "../desktop/useDesktopActions";
import type { HaoDesktopApi } from "../desktop/types";

// 2026-10-23 (Area D action 2, B1–B3). Rust rejects copy_agent_setup with a plain string, which the UI used to replace
// with 「無法建立 Agent 串接設定」 and paste-a-command steps for a command nothing copied; a repeat Codex connect answered
// already_installed and showed 「這次沒有連成功」.
const KIT_MISSING = "找不到最新版 video-autopilot SKILL.md；Editkin 不會在缺少規則真相時假裝已連線";

describe("Agent Connect outcomes", () => {
  it("keeps the Kit URL equal to the Node-only source of truth", () => {
    expect(AGENT_CONNECT_KIT_URL_V1).toBe(VIDEO_AUTOPILOT_KIT_URL);
  });
  it("reads the real text of string, Error and object rejections", () => {
    expect(agentConnectErrorTextV1("raw")).toBe("raw");
    expect(agentConnectErrorTextV1(new Error("boom"))).toBe("boom");
    expect(agentConnectErrorTextV1({ message: "obj" })).toBe("obj");
    expect(agentConnectErrorTextV1(undefined)).toBe("");
  });
  it("names a missing Kit in plain words, with where to get it and what to do next", () => {
    const result = agentConnectFailureV1("claude", KIT_MISSING);
    expect(result).toMatchObject({ status: "failed", health: "failed", cause: "kit_missing", detail: KIT_MISSING, target: "claude",
      message: "這台電腦還沒有安裝 Video Autopilot Kit，AI 需要它才能照規則剪片。" });
    expect(result.repairSteps).toEqual([`到 ${VIDEO_AUTOPILOT_KIT_URL} 下載 Video Autopilot Kit，照 SETUP.md 安裝`, "裝好後回到 Editkin，再按一次「連接 Claude Code」"]);
    expect(result.repairSteps!.join(" ")).not.toContain("貼上已複製");
  });
  it("names a missing CLI, a bad folder, and keeps an unknown cause's text for 查看原因", () => {
    expect(agentConnectFailureV1("codex", "Codex CLI 尚未安裝或不在 PATH")).toMatchObject({ cause: "cli_missing",
      message: "這台電腦找不到 Codex，或它不在系統路徑（PATH）裡。", repairSteps: ["先安裝並登入 Codex，確認在終端機輸入 codex 能打開它", "回到 Editkin，再按一次「連接 Codex」"] });
    expect(agentConnectFailureV1("codex", "所選位置不是工作資料夾；未變更 AI 設定")).toMatchObject({ cause: "workspace", message: "所選位置不是工作資料夾；未變更 AI 設定" });
    const unknown = agentConnectFailureV1("codex", "最新版 Editkin MCP generation readiness 驗證失敗：timeout；generation rollback complete");
    expect(unknown).toMatchObject({ cause: "unknown", message: "Editkin 這次沒能設定 Codex。", detail: "最新版 Editkin MCP generation readiness 驗證失敗：timeout；generation rollback complete" });
    expect(unknown.message).not.toBe("無法建立 Agent 串接設定");
  });
  it("treats a repeat Codex connect (already_installed) as connected, and only a copied command gets paste steps", () => {
    expect(agentSetupVerifiedV1({ canceled: false, status: "already_installed", runtimeVerified: true })).toBe(true);
    expect(agentSetupVerifiedV1({ canceled: false, status: "installed", runtimeVerified: false })).toBe(false);
    expect(agentSetupVerifiedV1({ canceled: false, status: "failed", runtimeVerified: true })).toBe(false);
    expect(agentConnectDefaultStepsV1({ canceled: false, status: "command_copied" })[1]).toBe("貼上已複製的安全設定指令並按 Enter");
    expect(agentConnectDefaultStepsV1({ canceled: false, status: "failed" }).join(" ")).not.toContain("貼上已複製");
  });
  it("the desktop action keeps the real cause of a string rejection instead of 「無法建立 Agent 串接設定」", async () => {
    const statuses: string[] = [];
    const api = { copyAgentSetup: vi.fn(async () => { throw KIT_MISSING; }) } as unknown as HaoDesktopApi;
    const { connectAgent } = useDesktopActions(api, message => statuses.push(message));
    const result = await connectAgent("codex");
    expect(result).toMatchObject({ cause: "kit_missing", detail: KIT_MISSING });
    expect(statuses.at(-1)).toBe("這台電腦還沒有安裝 Video Autopilot Kit，AI 需要它才能照規則剪片。");
    expect(statuses).not.toContain("無法建立 Agent 串接設定");
    const repeat = { copyAgentSetup: vi.fn(async () => ({ canceled: false, target: "codex", status: "already_installed", runtimeVerified: true, health: "configured" })) } as unknown as HaoDesktopApi;
    const again = useDesktopActions(repeat, message => statuses.push(message));
    expect(await again.connectAgent("codex")).toMatchObject({ status: "already_installed" });
    expect(statuses.at(-1)).toBe("Codex 已設定最新版 Editkin MCP；開啟新 session 後才能確認 Agent 連線。");
  });
});
