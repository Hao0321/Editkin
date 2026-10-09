// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
import { useEffect, useState } from "react";
import type { HaoDesktopApi } from "../desktop/apiTypes";
import { agentProviders, type AgentProviderInfo, type AgentProviderLogin, type AgentSettingsRequest, type AgentProviderId, type AgentGatewayInfo } from "../application/agentProviders";

export function AgentProviderSettings({ api, disabled, onReconnect, initialProvider = "openai", settingsRequest = 0 }: { api: HaoDesktopApi; disabled: boolean; onReconnect: () => Promise<void>; initialProvider?: AgentProviderId; settingsRequest?: number }) {
  const [providers, setProviders] = useState<AgentProviderInfo[]>([]);
  const [selected, setSelected] = useState<AgentProviderId>(initialProvider);
  const [gateway, setGateway] = useState<AgentGatewayInfo>();
  const [baseURL, setBaseURL] = useState("http://127.0.0.1:20128");
  const [key, setKey] = useState("");
  const [code, setCode] = useState("");
  const [login, setLogin] = useState<AgentProviderLogin>();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [reconnect, setReconnect] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => { if (login?.status !== "waiting") { setSelected(initialProvider); setKey(""); setCode(""); } }, [initialProvider, settingsRequest]);
  const refresh = async () => {
    const result = await api.openCodeAgentProvider({ action: "list" });
    setProviders(result.providers ?? []); setLogin(result.login); setGateway(result.gateway); if (result.gateway) setBaseURL(result.gateway.baseURL); if (result.requiresReconnect) setReconnect(true);
  };
  useEffect(() => { let active = true; setWorking(true);
    void api.openCodeAgentProvider({ action: "list" }).then(result => { if (active) { setProviders(result.providers ?? []); setLogin(result.login); setGateway(result.gateway); if (result.gateway) setBaseURL(result.gateway.baseURL); setReconnect(Boolean(result.requiresReconnect)); } })
      .catch(() => { if (active) setError("無法讀取供應商設定，請重新開啟。" ); }).finally(() => { if (active) setWorking(false); });
    return () => { active = false; };
  }, [api]);
  useEffect(() => {
    if (login?.status !== "waiting") return;
    let active = true;
    const timer = window.setInterval(() => { void api.openCodeAgentProvider({ action: "login-status", attemptId: login.id })
      .then(result => { if (!active) return; setLogin(result.login); if (result.requiresReconnect) { setReconnect(true); setNotice("登入設定完成；更新模型清單後選擇模型。實際可用額度以供應商回覆為準。" ); } })
      .catch(() => { if (active) setError("無法確認登入結果；請重新開啟設定核對，勿重複登入。" ); }); }, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [api, login?.id, login?.status]);
  const perform = async (request: AgentSettingsRequest) => {
    setWorking(true); setError(""); setNotice("");
    try {
      const result = await api.openCodeAgentProvider(request);
      if (result.login) setLogin(result.login);
      if (result.gateway) { setGateway(result.gateway); setBaseURL(result.gateway.baseURL); }
      if (request.action === "disconnect-gateway") setGateway(undefined);
      if (result.requiresReconnect) { setReconnect(true); setNotice(request.action === "disconnect" ? "已移除供應商憑證。請更新模型清單。" : "已儲存設定；請更新模型清單，再選擇要使用的模型。" ); }
      if (request.action === "connect-gateway" && result.gateway) setNotice(`已讀取 ${result.gateway.modelCount} 個工具模型，略過 ${result.gateway.excludedCount ?? 0} 個未確認支援工具的項目。更新模型清單後在同一個 Agent 對話使用；實際額度以回覆為準。`);
      if (request.action === "disconnect-gateway") setNotice("已移除剪輯台閘道連線，保留本機原有憑證。請更新模型清單。" );
      if (request.action === "save-api-key" || request.action === "disconnect") await refresh();
    } catch { setError(request.action === "connect-gateway" ? "OmniRoute 連線未完成。請先啟動閘道、確認位址／金鑰，並設定支援工具呼叫的模型；剪輯與對話保留。" : "供應商操作未完成，請檢查設定或重新登入。" ); }
    finally { setWorking(false); }
  };
  const provider = providers.find(provider => provider.id === selected);
  const pending = login?.status === "waiting";
  const locked = disabled || working;
  return <div className="opencode-provider-settings">
    <p>本機、API 與登入共用同一個 Agent 對話及剪輯工具。API 依各家計費，登入依帳號額度；雲端模型會收到送出的對話與剪輯上下文。</p>
    <label>供應商<select aria-label="Agent 供應商" value={selected} disabled={locked || pending} onChange={event => { setSelected(event.target.value as AgentProviderId); setKey(""); setCode(""); setError(""); setNotice(""); }}>
      {agentProviders.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>
    {selected !== "omniroute" && <small>{provider ? `${provider.configured ? "已有設定" : "尚未設定"} · 模型目錄 ${provider.modelCount}` : "正在讀取供應商…"}</small>}
    {selected === "openai" && provider?.authMethods.filter(method => method.type === "oauth").map(method =>
      <button key={method.index} type="button" className="opencode-provider-login" disabled={locked || pending} onClick={() => void perform({ action: "start-login", providerId: "openai", method: method.index })}>Continue with ChatGPT</button>)}
    {selected === "omniroute" && !pending && <div className="opencode-gateway-settings">
      <p>Claude、Codex、Grok、Gemini 與其他來源的 API／帳號在 OmniRoute 管理，剪輯仍在此對話完成。遠端閘道須使用 HTTPS；HTTP 僅限這台電腦的本機位址。</p>
      <form onSubmit={event => { event.preventDefault(); if (locked || !baseURL.trim()) return; const apiKey = key; setKey(""); void perform({ action: "connect-gateway", baseURL, apiKey: apiKey || undefined }); }}>
        <label>閘道位址<input aria-label="OmniRoute 位址" value={baseURL} disabled={locked} autoComplete="off" spellCheck={false} onChange={event => setBaseURL(event.target.value)} /></label>
        <label>閘道 API 金鑰<input aria-label="OmniRoute API 金鑰" type="password" value={key} disabled={locked} autoComplete="off" spellCheck={false} onChange={event => setKey(event.target.value)} placeholder="閘道啟用金鑰驗證時填入" /></label>
        <button type="submit" disabled={locked || !baseURL.trim()}>連線並讀取工具模型</button>
      </form>
      <small>{gateway ? `已儲存連線 · ${gateway.modelCount} 個工具模型，額度尚需實際回合核對` : "尚未連線；先啟動 OmniRoute，再設定供應商並讀取模型。"}</small>
      <button type="button" disabled={locked || !baseURL.trim()} onClick={() => void perform({ action: "open-gateway-dashboard", baseURL })}>管理 OmniRoute API／登入</button>
      <button type="button" disabled={locked} onClick={() => void perform({ action: "disconnect-gateway" })}>清除剪輯台閘道設定</button>
      <small>閘道金鑰由本機 Agent 共用管理；此處只保存位址與工具模型清單，不讀取各家的登入 token。連線不安全時會直接拒絕。</small>
    </div>}
    {selected !== "omniroute" && !pending && <form onSubmit={event => { event.preventDefault(); if (!key.trim() || locked) return; const apiKey = key; setKey(""); void perform({ action: "save-api-key", providerId: selected, apiKey }); }}>
      <label>API 金鑰<input type="password" aria-label="Agent API 金鑰" autoComplete="off" spellCheck={false} value={key} disabled={locked} onChange={event => setKey(event.target.value)} placeholder="貼上供應商 API 金鑰" /></label>
      <button type="submit" disabled={locked || !key.trim()}>儲存 API 金鑰</button><small>與本機 Agent 共用供應商憑證，替換或移除也會影響其他 Agent 使用。金鑰不放進對話、專案或還原包。</small></form>}
    {pending && <div role="status"><p>{login.instructions}</p>
      {login.method === "code" && <form onSubmit={event => { event.preventDefault(); const value = code; setCode(""); void perform({ action: "finish-login", attemptId: login.id, code: value }); }}>
        <input type="password" aria-label="登入驗證碼" autoComplete="off" value={code} onChange={event => setCode(event.target.value)} /><button disabled={locked || !code.trim()}>完成登入</button></form>}
      <button type="button" disabled={working} onClick={() => void perform({ action: "cancel-login", attemptId: login.id })}>取消登入</button></div>}
    {login?.status === "failed" && <p role="alert">{login.error || "登入未完成，請重新登入。"}</p>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <button type="button" title={reconnect ? "套用供應商變更" : "重新讀取已設定的來源"} disabled={locked || pending} onClick={() => { setWorking(true); setError(""); void onReconnect().then(() => { setReconnect(false); setNotice("模型清單已更新，請選擇模型。" ); }).catch(() => setError("無法更新模型清單；目前剪輯與對話仍保留。" )).finally(() => setWorking(false)); }}>更新模型清單</button>
    {selected !== "omniroute" && provider?.configured && !pending && <button type="button" disabled={locked} onClick={() => void perform({ action: "disconnect", providerId: selected })}>移除此供應商憑證</button>}
    {disabled && <small>請等 Agent 回合完成後再變更供應商。</small>}
  </div>;
}
