import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";
import { useState } from "react";
import type { SemanticAutoEditStage } from "../desktop/useSemanticAutoEdit";
import "./agentPanelGuide.css";
import "./agentProgress.css";

interface AgentPanelProps {
  status: string;
  onSubmit: (instruction: string) => void;
  onSmartCut?: () => void;
  smartCutBusy?: boolean;
  onAutomaticCaptions?: (mode: "original" | "bilingual-en") => void;
  automaticCaptionsBusy?: boolean;
  onSceneSplit?: () => void;
  sceneSplitBusy?: boolean;
  onSemanticAutoEdit?: () => void;
  musicMvMode?: boolean;
  semanticAutoEditBusy?: boolean;
  semanticAutoEditStage?: SemanticAutoEditStage;
  onOpenAgentConnect?: () => void;
  /** Set when the runtime cannot run the local engines (browser build); the one-click actions are disabled with this reason. */
  unavailableReason?: string;
  hasMedia: boolean;
}

export function AgentPanel({ status, onSubmit, onSmartCut, smartCutBusy = false, onAutomaticCaptions, automaticCaptionsBusy = false, onSceneSplit, sceneSplitBusy = false, onSemanticAutoEdit, musicMvMode = false, semanticAutoEditBusy = false, semanticAutoEditStage, onOpenAgentConnect, unavailableReason, hasMedia }: AgentPanelProps) {
  useI18n();
  const [instruction, setInstruction] = useState("");
  const [captionMode, setCaptionMode] = useState<"original" | "bilingual-en">("original");
  const submit = () => {
    if (!instruction.trim()) return;
    onSubmit(instruction);
    setInstruction("");
  };
  return (
    <section className="agent-panel" aria-label={uiText("用一句話修改影片")}>
      <div className="agent-lead">
        <div className="agent-orb" aria-hidden="true"><span>2</span>✦</div>
        <div className="agent-copy">
          <div><strong>{musicMvMode ? uiText("製作 Music MV") : uiText("讓 Editkin 自動剪")}</strong><span>{uiText("完成後每一段都還能改")}</span></div>
          <p data-testid="agent-status" aria-live="polite">{status}</p>
        </div>
      </div>
      <div className="agent-primary-workbench">
        {onSemanticAutoEdit && <button type="button" className="semantic-edit-button auto-complete-button" onClick={onSemanticAutoEdit} disabled={semanticAutoEditBusy || (!hasMedia && !musicMvMode) || Boolean(unavailableReason)} title={unavailableReason} data-testid="semantic-edit-panel-button" data-stage={musicMvMode ? undefined : semanticAutoEditStage?.step} data-beginner-action={musicMvMode ? "製作 Music MV" : "一鍵自動完成"}><b>✦</b><span><strong>{musicMvMode ? uiText("製作插畫動畫 MV") : semanticAutoEditStage?.title ?? (hasMedia ? uiText("一鍵自動完成") : uiText("請先加入你的影片"))}</strong><small>{unavailableReason ?? (musicMvMode ? uiText("AI 規劃樂段與原創角色／場景，Editkin 製作可編輯分層動畫與動態文字") : semanticAutoEditStage?.detail ?? uiText("分析畫面與語音，自動剪掉停頓或挑出重點，加上字幕和配樂；不會自己調色或加轉場特效"))}</small></span><i>{musicMvMode ? uiText("連接 AI →") : semanticAutoEditStage ? `${semanticAutoEditStage.step} / 4` : hasMedia ? uiText("開始 →") : uiText("先做第 1 步")}</i></button>}
        <details className="agent-panel-disclosure" data-testid="agent-panel-disclosure">
          <summary>{uiText("自訂修改與更多功能")}</summary>
          <div className="agent-panel-disclosure-body">
            <div className="auto-edit-how" data-testid="auto-edit-how"><strong>{uiText("操作順序")}</strong><span className={hasMedia ? "done" : "current"}>{musicMvMode ? uiText("1 加入歌曲；插畫可由 AI 規劃製作") : uiText("1 加入影片")}</span><span>{uiText("2 選片型")}</span><span>{musicMvMode ? uiText("3 連接 AI 製作動畫 MV") : uiText("3 按下自動剪輯")}</span><i>{musicMvMode ? uiText("AI 規劃 · Editkin 本機執行") : uiText("本機原生 · 0 AI 額度")}</i></div>
            <div className="agent-input-row">
              <span className="agent-input-icon" aria-hidden="true">✦</span>
              <input
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") submit(); }}
                placeholder={uiText("例如：字幕放大、節奏再快一點")}
                data-testid="agent-input"
                aria-label={uiText("剪輯指令")}
              />
              <button type="button" onClick={submit} data-testid="agent-submit">{uiText("套用修改")}</button>
            </div>
            <div className="agent-secondary-row">
              <details className="agent-tools">
                <summary>{uiText("更多一鍵功能")}</summary>
                {unavailableReason && <p className="agent-unavailable-note" data-testid="agent-unavailable-note">{unavailableReason}</p>}
                <div className="automation-actions" aria-label={uiText("一鍵自動剪輯")}>
                  {onOpenAgentConnect && <button type="button" className="agent-long-source" onClick={onOpenAgentConnect} title={uiText("讓你的 Codex／Claude 看懂一支長片，再拆成多個獨立可編輯 Reels")}><b>AI</b><span>{uiText("長片拆多支 Reels")}</span></button>}
                  {onSmartCut && <button type="button" className="smart-cut-button" onClick={onSmartCut} disabled={smartCutBusy || !hasMedia || Boolean(unavailableReason)} title={unavailableReason ?? (hasMedia ? uiText("自動找出並刪除停頓") : uiText("請先加入你的影片"))} data-testid="smart-cut-button"><b aria-hidden="true">✂</b><span><strong>{smartCutBusy ? uiText("分析中…") : uiText("刪掉停頓")}</strong><small>{uiText("自動找出空白")}</small></span></button>}
                  {onAutomaticCaptions && <div className="automatic-caption-choice">
                    <label htmlFor="automatic-caption-mode">{uiText("字幕類型")}</label>
                    <select id="automatic-caption-mode" value={captionMode} onChange={(event) => setCaptionMode(event.target.value as "original" | "bilingual-en")} disabled={automaticCaptionsBusy} data-testid="automatic-caption-mode">
                      <option value="original">{uiText("原文字幕")}</option>
                      <option value="bilingual-en">{uiText("原文＋英文雙語")}</option>
                    </select>
                    <button type="button" className="automatic-caption-button" onClick={() => onAutomaticCaptions(captionMode)} disabled={automaticCaptionsBusy || !hasMedia || Boolean(unavailableReason)} title={unavailableReason ?? (hasMedia ? uiText("把語音轉成逐句可編輯字幕") : uiText("請先加入你的影片"))} data-testid="automatic-caption-button"><b aria-hidden="true">{uiText("字")}</b><span><strong>{automaticCaptionsBusy ? uiText("辨識中…") : uiText("加上字幕")}</strong><small>{captionMode === "bilingual-en" ? uiText("本機辨識＋英文翻譯") : uiText("本機把語音變文字")}</small></span></button>
                  </div>}
                  {onSceneSplit && <button type="button" className="scene-split-button" onClick={onSceneSplit} disabled={sceneSplitBusy || !hasMedia || Boolean(unavailableReason)} title={unavailableReason ?? (hasMedia ? uiText("依畫面變化自動分段") : uiText("請先加入你的影片"))} data-testid="scene-split-button"><b aria-hidden="true">▤</b><span><strong>{sceneSplitBusy ? uiText("找場景…") : uiText("依畫面分段")}</strong><small>{uiText("自動找鏡頭變化")}</small></span></button>}
                </div>
              </details>
              <span className="agent-safe-note">{uiText("✓ 完成後仍能逐段修改、復原")}</span>
            </div>
          </div>
        </details>
      </div>
    </section>
  );
}
