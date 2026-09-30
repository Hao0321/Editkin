// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
import { useEffect, useRef, useState } from "react";
import { AGENT_EXTENSION_SCHEMA, AGENT_LIBRARY_SCHEMA, type AgentExtension, type AgentLibraryEntry, type AgentLibraryReply, type AgentLibraryRequest, type AgentLibrarySession } from "../application/agentLibrary";

export function AgentLibraryPanel({ call, binding, mode, disabled, onContinue }: {
  call: (request: AgentLibraryRequest) => Promise<AgentLibraryReply>; binding: string; mode: "history" | "extensions";
  disabled: boolean; onContinue: (session: string) => void;
}) {
  const [query, setQuery] = useState(""), [sessions, setSessions] = useState<AgentLibrarySession[]>([]);
  const [selected, setSelected] = useState<AgentLibrarySession>(), [entries, setEntries] = useState<AgentLibraryEntry[]>([]);
  const [extensions, setExtensions] = useState<AgentExtension[]>([]), [editor, setEditor] = useState<AgentExtension>();
  const [next, setNext] = useState<number>(), [readNext, setReadNext] = useState<number>();
  const [pageOffset, setPageOffset] = useState(0), [readOffset, setReadOffset] = useState(0);
  const [working, setWorking] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const generation = useRef(0);
  const run = async (request: AgentLibraryRequest, apply: (result: AgentLibraryReply) => void) => {
    const current = ++generation.current; setWorking(true); setError(""); setNotice("");
    try { const result = await call(request); if (current === generation.current) apply(result); }
    catch (reason) { if (current === generation.current) setError(reason instanceof Error ? reason.message : "無法讀取本機紀錄"); }
    finally { if (current === generation.current) setWorking(false); }
  };
  const search = (offset = 0) => run({ schema: AGENT_LIBRARY_SCHEMA, binding, action: "search", query, offset }, result => {
    setSessions(result.sessions || []); setNext(result.nextOffset); setPageOffset(offset);
  });
  const read = (session: AgentLibrarySession, offset = 0) => run({ schema: AGENT_LIBRARY_SCHEMA, binding, action: "read", sessionId: session.sessionId, offset }, result => {
    setSelected(session); setEntries(result.entries || []); setReadNext(result.nextOffset); setReadOffset(offset);
  });
  useEffect(() => {
    if (mode === "history") void search();
    else void run({ schema: AGENT_LIBRARY_SCHEMA, binding, action: "extensions" }, result => setExtensions(result.extensions || []));
    return () => { generation.current++; };
  }, [binding, mode]);
  const newExtension = () => setEditor({ schema: AGENT_EXTENSION_SCHEMA, id: crypto.randomUUID(), kind: "skill", name: "", instructions: "", hooks: ["prompt-context"], enabled: false, visibility: "project" });
  return <div className="agent-library-panel">
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {editor ? <form onSubmit={event => { event.preventDefault(); void run({ schema: AGENT_LIBRARY_SCHEMA, binding, action: "save-extension", extension: editor }, result => {
      setExtensions(result.extensions || []); setEditor(undefined); setNotice("已儲存在本機；啟用的指引於下一回合套用。");
    }); }}>
      <strong>個人指引 · 本機儲存</strong>
      <label>名稱<input aria-label="個人指引名稱" value={editor.name} maxLength={80} onChange={event => setEditor({ ...editor, name: event.target.value })} /></label>
      <label>類型<select aria-label="個人指引類型" value={editor.kind} onChange={event => setEditor({ ...editor, kind: event.target.value as AgentExtension["kind"] })}><option value="skill">Skill</option><option value="plugin">Plugin · 脈絡接口</option></select></label>
      <label>可重用的剪輯規則<textarea aria-label="個人剪輯規則" rows={7} maxLength={2400} value={editor.instructions} onChange={event => setEditor({ ...editor, instructions: event.target.value })} /></label>
      <small>先改寫並移除私人內容。啟用後，規則會隨下一回合送給所選模型；原始歷史不會自動傳送。插件目前支援脈絡指引，不能執行任意程式。</small>
      <label className="agent-library-check"><input type="checkbox" checked={editor.enabled} disabled={editor.instructions.startsWith("請先將以下對話摘要改寫")} onChange={event => setEditor({ ...editor, enabled: event.target.checked })} />啟用這份指引</label>
      <label className="agent-library-check"><input type="checkbox" checked={editor.visibility === "personal"} onChange={event => setEditor({ ...editor, visibility: event.target.checked ? "personal" : "project" })} />允許其他專案使用這份指引</label>
      <div className="agent-library-actions"><button type="submit" disabled={working || disabled || !editor.name.trim() || !editor.instructions.trim()}>儲存</button><button type="button" disabled={working} onClick={() => setEditor(undefined)}>返回</button></div>
    </form> : mode === "extensions" ? <>
      <p>只加入已啟用的指引，每回合最多 3,200 字元。對話保持隔離。</p>
      {extensions.map(extension => <button type="button" key={extension.id} disabled={working || disabled} onClick={() => setEditor(extension)}>{extension.name} · {extension.enabled ? "啟用" : "草稿"}<small>{extension.kind} · {extension.visibility === "personal" ? "跨專案指引" : "目前專案"}</small></button>)}
      <button type="button" disabled={working || disabled} onClick={newExtension}>新增個人指引</button>
    </> : selected ? <>
      <div className="agent-library-actions"><button type="button" disabled={working} onClick={() => { setSelected(undefined); setEntries([]); }}>返回清單</button><strong>{selected.title}</strong></div>
      <small>唯讀回看 · 不執行工具</small>
      <div className="agent-library-reader">{entries.map(entry => <article key={entry.id}><small>{({ user: "使用者", message: "助理", tool: "工具紀錄", turn: "回合", plan: "計畫" } as Record<string, string>)[entry.kind] || "系統"}{entry.status ? ` · ${entry.status}` : ""}</small><p>{entry.text}</p>{entry.truncated && <small>本段顯示已達上限。</small>}</article>)}</div>
      {readNext !== undefined && <button type="button" disabled={working} onClick={() => void read(selected, readNext)}>讀取後續紀錄</button>}
      {readOffset > 0 && <button type="button" disabled={working} onClick={() => void read(selected, Math.max(0, readOffset - 20))}>讀取前一頁</button>}
      <div className="agent-library-actions"><button type="button" disabled={working || disabled} onClick={() => onContinue(selected.sessionId)}>繼續這段對話</button><button type="button" disabled={working || disabled} onClick={() => void run({ schema: AGENT_LIBRARY_SCHEMA, binding, action: "draft", sessionId: selected.sessionId }, result => setEditor(result.draft))}>建立 Skill 草稿</button></div>
    </> : <>
      <strong>目前專案的本機對話</strong>
      <form className="agent-library-search" onSubmit={event => { event.preventDefault(); void search(); }}><input aria-label="搜尋本機對話" placeholder="搜尋標題或對話內容" value={query} maxLength={200} onChange={event => setQuery(event.target.value)} /><button type="submit" disabled={working}>搜尋</button></form>
      {sessions.map(session => <button type="button" key={session.sessionId} disabled={working} onClick={() => void read(session)}><span className="opencode-dock-history-title">{session.title}</span><small>{new Date(session.updatedAt).toLocaleString()}</small></button>)}
      {!sessions.length && !working && <p>沒有符合的對話。這個版本開始記錄，舊版紀錄保留但不跨專案自動匯入。</p>}
      {next !== undefined && <button type="button" disabled={working} onClick={() => void search(next)}>更多對話</button>}
      {pageOffset > 0 && <button type="button" disabled={working} onClick={() => void search(Math.max(0, pageOffset - 20))}>上一頁對話</button>}
    </>}
    {working && <small role="status">讀取本機資料中…</small>}
  </div>;
}
