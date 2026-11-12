// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
import { useEffect, useRef, useState } from "react";
import { agentModelSources, modelChoiceName, type AgentModelChoice, type AgentSourceChoice } from "./agentModelChoices";

export type AgentSourceStatus = "ready" | "loading" | "missing" | "empty" | "unavailable" | "unlisted" | "refresh";
export function AgentModelPicker({ source, models, currentModel, status, disabled, showMissingSource, onSource, onModel, onSettings, onMissingSource }: {
  source: AgentSourceChoice; models: AgentModelChoice[]; currentModel: string; status: AgentSourceStatus; disabled: boolean; showMissingSource: boolean;
  onSource: (source: AgentSourceChoice) => void; onModel: (model: string) => void; onSettings: () => void; onMissingSource: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => { if (menu.current) menu.current.open = false; };
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) close(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && menu.current?.open) { event.preventDefault(); close(); menu.current.querySelector("summary")?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, []);
  useEffect(() => { if (disabled) close(); }, [disabled]);
  const name = agentModelSources.find(item => item.id === source)?.name || "其他來源";
  const selectedModel = models.find(model => model.value === currentModel);
  const message = showMissingSource ? "找不到的供應商尚未列入支援大項；請到設定查看來源，或透過 OmniRoute 接入。"
    : status === "missing" ? `${name} 尚未設定；請到設定完成連線後更新模型清單。`
    : status === "empty" ? `${name} 沒有可選模型；請到設定確認來源並更新模型清單。`
    : status === "unavailable" ? "無法確認此來源設定；請到設定檢查，目前對話與模型保留。"
    : status === "unlisted" ? "目前模型的來源未列入支援大項；請到設定查看，或選擇已支援來源。"
    : status === "refresh" ? "供應商設定已變更；請到設定更新模型清單後再選擇。"
    : status === "loading" ? "正在確認來源設定…"
    : !selectedModel ? `請選擇 ${name} 的模型；目前對話保留。` : "";
  const usable = status === "ready";
  const shortNotice = showMissingSource ? "來源未列入支援大項" : status === "missing" ? `${name} 尚未設定`
    : status === "empty" ? `${name} 沒有模型` : status === "unavailable" ? "無法確認來源設定"
    : status === "unlisted" ? "來源未列入支援大項" : status === "refresh" ? "請更新模型清單" : "";
  const buttonLabel = `${name} · ${status === "loading" ? "確認中" : usable && selectedModel ? modelChoiceName(selectedModel, source) : usable ? "選擇模型" : "待設定"}`;
  const settings = () => { close(); onSettings(); };
  return <div ref={root} className="opencode-dock-model-picker">
    <details ref={menu} className="opencode-dock-model-menu" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary aria-label="選擇 Agent 來源與模型" aria-expanded={open} aria-haspopup="dialog" aria-disabled={disabled}
        title={buttonLabel} onClick={event => { if (disabled) event.preventDefault(); }}><span>{buttonLabel}</span><i aria-hidden="true">⌄</i></summary>
      <div className="opencode-dock-model-popover" role="dialog" aria-label="Agent 來源與模型選擇">
    <label className="opencode-dock-source-choice">來源
      <select aria-label="Agent 來源" title={name} value={source} disabled={disabled} onChange={event => onSource(event.target.value as AgentSourceChoice)}>
        {agentModelSources.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        {source === "unlisted" && <option value="unlisted">其他來源（未支援）</option>}
      </select></label>
    <label className="opencode-dock-compose-model">模型
      <select aria-label="Agent 模型" title={selectedModel ? modelChoiceName(selectedModel, source) : "先選來源，再選模型"}
        value={usable && selectedModel ? currentModel : ""} data-active-model={currentModel} disabled={disabled || !usable || !models.length}
        onChange={event => { if (models.some(model => model.value === event.target.value)) { close(); onModel(event.target.value); } }}>
        {(!usable || !selectedModel) && <option value="">{status === "loading" ? "讀取中…" : usable ? "選擇模型" : "請先設定來源"}</option>}
        {usable && models.map(model => <option key={model.value} value={model.value}>{modelChoiceName(model, source)}</option>)}
      </select></label>
    {message && <div className="opencode-dock-model-notice" role="status" aria-label="來源選擇說明">{message}
      {status !== "loading" && <button type="button" disabled={disabled} onClick={settings}>前往設定</button>}</div>}
    <div className="opencode-dock-model-help"><button type="button" disabled={disabled} onClick={onMissingSource}>找不到來源？</button>
      <button type="button" aria-label="Agent 供應商設定" disabled={disabled} onClick={settings}>設定</button></div>
      </div>
    </details>
    {shortNotice && <div className="opencode-dock-source-brief" role="status" aria-label="Agent 來源提示"><span title={message}>{shortNotice}</span>
      <button type="button" disabled={disabled} onClick={settings}>設定</button></div>}
  </div>;
}
