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
  semanticAutoEditBusy?: boolean;
  semanticAutoEditStage?: SemanticAutoEditStage;
  onOpenAgentConnect?: () => void;
  onOpenLocalDraft?: () => void;
  unavailableReason?: string;
  hasMedia: boolean;
}

export function AgentPanel({ status, onSubmit, onSmartCut, smartCutBusy = false, onAutomaticCaptions, automaticCaptionsBusy = false, onSceneSplit, sceneSplitBusy = false, onSemanticAutoEdit, semanticAutoEditBusy = false, semanticAutoEditStage, onOpenAgentConnect, onOpenLocalDraft, unavailableReason, hasMedia }: AgentPanelProps) {
  const [instruction, setInstruction] = useState("");
  const [captionMode, setCaptionMode] = useState<"original" | "bilingual-en">("original");
  const submit = () => {
    if (!instruction.trim()) return;
    onSubmit(instruction);
    setInstruction("");
  };
  return (
    <section className="agent-panel" aria-label="用一句話修改影片">
      <div className="agent-lead">
        <div className="agent-orb" aria-hidden="true"><span>2</span>✦</div>
        <div className="agent-copy">
          <div><strong>剪輯工作台</strong><span>先確認故事與素材，再剪成片</span></div>
          <p data-testid="agent-status" aria-live="polite">{status}</p>
        </div>
      </div>
      <div className="agent-primary-workbench">
        {onOpenLocalDraft && <button type="button" className="local-story-primary" onClick={onOpenLocalDraft} data-testid="open-local-story-draft"><strong>從歌詞寫故事</strong><small>先編劇、審稿；看片核對後才能剪輯</small><span>開啟提案 →</span></button>}
        <details className="agent-panel-disclosure" data-testid="agent-panel-disclosure">
          <summary>素材粗剪與其他工具</summary>
          <div className="agent-panel-disclosure-body">
            {onSemanticAutoEdit && <button type="button" className="semantic-edit-button auto-complete-button" onClick={onSemanticAutoEdit} disabled={semanticAutoEditBusy || !hasMedia || Boolean(unavailableReason)} title={unavailableReason} data-testid="semantic-edit-panel-button" data-stage={semanticAutoEditStage?.step} data-beginner-action="規則式素材粗剪"><b>✦</b><span><strong>{semanticAutoEditStage?.title ?? (hasMedia ? "規則式素材粗剪" : "請先加入你的影片")}</strong><small>{unavailableReason ?? semanticAutoEditStage?.detail ?? "按畫面／語音規則處理素材；不會理解歌詞故事，結果需逐段審查"}</small></span><i>{semanticAutoEditStage ? `${semanticAutoEditStage.step} / 4` : hasMedia ? "開始粗剪 →" : "先加入影片"}</i></button>}
            <div className="auto-edit-how" data-testid="auto-edit-how"><strong>粗剪操作</strong><span className={hasMedia ? "done" : "current"}>1 加入影片</span><span>2 選片型</span><span>3 檢查粗剪</span><i>本機原生 · 0 AI 額度</i></div>
            <div className="agent-input-row">
              <span className="agent-input-icon" aria-hidden="true">✦</span>
              <input
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") submit(); }}
                placeholder="例如：字幕放大、節奏再快一點"
                data-testid="agent-input"
                aria-label="剪輯指令"
              />
              <button type="button" onClick={submit} data-testid="agent-submit">套用修改</button>
            </div>
            <div className="agent-secondary-row">
              <details className="agent-tools">
                <summary>更多一鍵功能</summary>
                {unavailableReason && <p className="agent-unavailable-note" data-testid="agent-unavailable-note">{unavailableReason}</p>}
                <div className="automation-actions" aria-label="一鍵自動剪輯">
                  {onOpenAgentConnect && <button type="button" className="agent-long-source" onClick={onOpenAgentConnect} title="直接在內部 Agent 交代素材範圍、影片目標與剪輯方式"><b>AI</b><span>交給 Agent 剪輯</span></button>}
                  {onSmartCut && <button type="button" className="smart-cut-button" onClick={onSmartCut} disabled={smartCutBusy || !hasMedia || Boolean(unavailableReason)} title={unavailableReason ?? (hasMedia ? "自動找出並刪除停頓" : "請先加入你的影片")} data-testid="smart-cut-button"><b aria-hidden="true">✂</b><span><strong>{smartCutBusy ? "分析中…" : "刪掉停頓"}</strong><small>自動找出空白</small></span></button>}
                  {onAutomaticCaptions && <div className="automatic-caption-choice">
                    <label htmlFor="automatic-caption-mode">字幕類型</label>
                    <select id="automatic-caption-mode" value={captionMode} onChange={(event) => setCaptionMode(event.target.value as "original" | "bilingual-en")} disabled={automaticCaptionsBusy} data-testid="automatic-caption-mode">
                      <option value="original">原文字幕</option>
                      <option value="bilingual-en">原文＋英文雙語</option>
                    </select>
                    <button type="button" className="automatic-caption-button" onClick={() => onAutomaticCaptions(captionMode)} disabled={automaticCaptionsBusy || !hasMedia || Boolean(unavailableReason)} title={unavailableReason ?? (hasMedia ? "把語音轉成逐句可編輯字幕" : "請先加入你的影片")} data-testid="automatic-caption-button"><b aria-hidden="true">字</b><span><strong>{automaticCaptionsBusy ? "辨識中…" : "加上字幕"}</strong><small>{captionMode === "bilingual-en" ? "本機辨識＋英文翻譯" : "本機把語音變文字"}</small></span></button>
                  </div>}
                  {onSceneSplit && <button type="button" className="scene-split-button" onClick={onSceneSplit} disabled={sceneSplitBusy || !hasMedia || Boolean(unavailableReason)} title={unavailableReason ?? (hasMedia ? "依畫面變化自動分段" : "請先加入你的影片")} data-testid="scene-split-button"><b aria-hidden="true">▤</b><span><strong>{sceneSplitBusy ? "找場景…" : "依畫面分段"}</strong><small>自動找鏡頭變化</small></span></button>}
                </div>
              </details>
              <span className="agent-safe-note">✓ 完成後仍能逐段修改、復原</span>
            </div>
          </div>
        </details>
      </div>
    </section>
  );
}
