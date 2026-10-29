import { translateUi as uiText } from "../i18n/interfacePreferences";
import { EasyIcon } from "../easy/easyIcons";
import { useAgentRuntimeRepairV1 } from "./agentRuntimeRepairV1";
import "./agentHelpEntry.css";

/**
 * 「讓 AI 幫我剪片」: the one way into the AI connection, the same words and sparkle everywhere — a big card on the start
 * screens, a button in the simple editor's top bar. After an Editkin update whose start-up refresh failed, the same
 * entry says 「Editkin 更新後要重新連一次 AI」 with 「重新連一次」 and opens the same dialog (one normal connect fixes it).
 * The plain components take `repairNeeded`; the *Live ones read the shared state (desktop only).
 */
export function AgentHelpCard({ onClick, testId = "welcome-agent-connect", repairNeeded = false }: { onClick: () => void; testId?: string; repairNeeded?: boolean }) {
  return <button type="button" className="agent-help-card" data-repair={repairNeeded || undefined} onClick={onClick} data-testid={testId}>
    <span className="agent-help-card-icon" aria-hidden="true"><EasyIcon name={repairNeeded ? "refresh" : "sparkles"} /></span>
    {repairNeeded ? <span className="agent-help-card-text">
      <strong>{uiText("Editkin 更新後要重新連一次 AI")}</strong>
      <small>{uiText("按一下就好，你的作品都還在。")}</small>
    </span> : <span className="agent-help-card-text">
      <strong>{uiText("讓 AI 幫我剪片")}</strong>
      <small>{uiText("用 Claude Code 或 Codex，說一句話就幫你剪。")}</small>
    </span>}
    {repairNeeded ? <span className="agent-help-card-action">{uiText("重新連一次")}</span>
      : <span className="agent-help-card-go" aria-hidden="true"><EasyIcon name="arrow-right" /></span>}
  </button>;
}

export function AgentHelpButton({ onClick, testId = "simple-ai-help", repairNeeded = false }: { onClick: () => void; testId?: string; repairNeeded?: boolean }) {
  return <button type="button" className="agent-help-button" data-repair={repairNeeded || undefined} onClick={onClick} data-testid={testId}
    title={repairNeeded ? uiText("Editkin 更新後要重新連一次 AI") : undefined}>
    <EasyIcon name={repairNeeded ? "alert" : "sparkles"} /><span>{repairNeeded ? uiText("重新連一次 AI") : uiText("讓 AI 幫我剪片")}</span>
  </button>;
}

/** The start screens' card, with the shared 「重新連一次」 state. */
export function AgentHelpCardLive(props: { onClick: () => void; testId?: string }) {
  const repair = useAgentRuntimeRepairV1();
  return <AgentHelpCard {...props} repairNeeded={repair.state === "failed"} />;
}

/** The simple top bar's button, with the shared 「重新連一次」 state. */
export function AgentHelpButtonLive(props: { onClick: () => void; testId?: string }) {
  const repair = useAgentRuntimeRepairV1();
  return <AgentHelpButton {...props} repairNeeded={repair.state === "failed"} />;
}
