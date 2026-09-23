import { useEffect, useState } from "react";
import { EDITKIN_AGENT_STARTER_PROMPT, type AgentTarget } from "../application/agentSetup";
import type { AgentSetupResult } from "../desktop/types";
import "./agentConnectModal.css";

interface AgentConnectModalProps {
  onClose: () => void;
  onConnect: (target: AgentTarget) => Promise<AgentSetupResult | undefined>;
}

const AGENT_NAME: Record<AgentTarget, string> = { codex: "Codex", claude: "Claude Code" };

export function AgentConnectModal({ onClose, onConnect }: AgentConnectModalProps) {
  const [busyTarget, setBusyTarget] = useState<AgentTarget>();
  const [result, setResult] = useState<AgentSetupResult>();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape" && !busyTarget) onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busyTarget, onClose]);

  const connect = async (target: AgentTarget) => {
    setBusyTarget(target);
    setResult(undefined);
    setCopied(false);
    setCopyFailed(false);
    const nextResult = await onConnect(target);
    setResult(nextResult?.canceled ? undefined : nextResult);
    setBusyTarget(undefined);
  };

  const copyStarterPrompt = async () => {
    const prompt = result?.starterPrompt ?? EDITKIN_AGENT_STARTER_PROMPT;
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = prompt;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.append(textarea);
      textarea.select();
      const copiedByFallback = document.execCommand("copy");
      textarea.remove();
      setCopied(copiedByFallback);
      setCopyFailed(!copiedByFallback);
    }
  };

  const setupVerified = (result?.status === "installed" || result?.status === "already_configured")
    && result.runtimeVerified === true;
  const connected = setupVerified && result.health === "connected";
  const manual = result?.status === "command_copied";

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busyTarget) onClose(); }}>
      <section className="agent-connect-modal" role="dialog" aria-modal="true" aria-labelledby="agent-connect-title" data-testid="agent-connect-modal">
        <button type="button" className="modal-close" onClick={onClose} disabled={Boolean(busyTarget)} aria-label="關閉">×</button>

        {!busyTarget && !result && <>
          <span className="agent-connect-kicker">EDITKIN × YOUR AI</span>
          <h2 id="agent-connect-title">連上你已經在用的 AI</h2>
          <p className="agent-connect-lead">不用申請 API key，也不會讀取或保存登入資料。Editkin 只把本機剪輯工具接進你自己的 Codex／Claude Code session。</p>
          <div className="agent-choice-grid">
            <button type="button" onClick={() => void connect("codex")} data-testid="connect-codex-button">
              <span className="agent-choice-icon codex">⌘</span><strong>連接 Codex</strong><small>沿用 Codex 登入與訂閱額度</small><em>一鍵設定 →</em>
            </button>
            <button type="button" onClick={() => void connect("claude")} data-testid="connect-claude-button">
              <span className="agent-choice-icon claude">◆</span><strong>連接 Claude Code</strong><small>沿用 Claude Code 登入與訂閱額度</small><em>一鍵設定 →</em>
            </button>
          </div>
          <p className="agent-workspace-note">按下後，請選擇要授權給 AI 的工作資料夾。專案與素材需在這個範圍內；每次都可重新選擇，取消不會變更設定。</p>
          <div className="agent-trust-row"><span>✓ 素材留在本機</span><span>✓ 不儲存密鑰</span><span>✓ 可隨時移除 editkin MCP</span></div>
          <p className="agent-connect-note">連上後，AI 負責看懂題材與規劃；Editkin 在本機執行剪輯、字幕、音樂、效果與可編輯 Timeline。</p>
        </>}

        {busyTarget && <div className="agent-connect-progress" aria-live="polite">
          <span className="agent-connect-spinner" aria-hidden="true" />
          <h2 id="agent-connect-title">正在連接 {AGENT_NAME[busyTarget]}</h2>
          <ol><li className="active">選擇要授權給 AI 的工作資料夾</li><li>驗證 Editkin 本機 MCP 並設定 {AGENT_NAME[busyTarget]}</li><li>讀回設定並確認可用</li></ol>
          <small>完成資料夾選擇後才會開始設定；可以取消，不會要求 API key。</small>
        </div>}

        {!busyTarget && result && <div className={`agent-connect-result ${setupVerified ? "success" : manual ? "manual" : "failed"}`} aria-live="polite">
          <span className="agent-result-icon" aria-hidden="true">{setupVerified ? "✓" : manual ? "!" : "×"}</span>
          <span className="agent-connect-kicker">{connected ? "CONNECTION VERIFIED" : setupVerified ? "CURRENT MCP VERIFIED" : manual ? "MANUAL SETUP" : "NEEDS ATTENTION"}</span>
          <h2 id="agent-connect-title">{connected ? `${AGENT_NAME[result.target ?? "codex"]} 已連上最新版` : setupVerified ? `${AGENT_NAME[result.target ?? "codex"]} 已設定最新版 MCP` : manual ? "需要手動完成連線" : "這次沒有連成功"}</h2>
          <p className="agent-connect-lead">{result.message}</p>
          {result.verification && <div className="agent-verification"><i />{result.verification}</div>}
          {setupVerified && <>
            <ol className="agent-next-steps">
              <li><b>1</b><span>重新開啟 {AGENT_NAME[result.target ?? "codex"]}，或建立新 session</span></li>
              <li><b>2</b><span>貼上下面這句，AI 就會自己啟動完整流程</span></li>
            </ol>
            <div className="agent-starter-prompt">{result.starterPrompt ?? EDITKIN_AGENT_STARTER_PROMPT}</div>
            <button type="button" className="agent-primary-action" onClick={() => void copyStarterPrompt()} data-testid="copy-agent-starter-prompt">{copied ? "✓ 開工指令已複製" : "複製開工指令"}</button>
            {copyFailed && <small className="agent-copy-failed">系統不允許自動複製，請在上方文字框手動選取。</small>}
          </>}
          {!setupVerified && <>
            <ol className="agent-repair-steps">{(result.repairSteps ?? ["開啟終端機", "貼上已複製的安全設定指令並按 Enter", "重新開啟 AI session，輸入 /mcp 確認 editkin"]).map((step) => <li key={step}>{step}</li>)}</ol>
            {manual && <button type="button" className="agent-primary-action" onClick={() => result.target && void connect(result.target)}>完成後重新檢查</button>}
          </>}
          <button type="button" className="agent-secondary-action" onClick={() => { setResult(undefined); setCopied(false); setCopyFailed(false); }}>{setupVerified ? "連接另一個 AI" : "返回重試"}</button>
        </div>}
      </section>
    </div>
  );
}
