// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentAcpSnapshot } from "../desktop/apiTypes";
import type { AutomaticCaptionReadiness } from "../application/automaticCaptions";
import type { OpenCodeAttachment } from "../service/openCodePrompt";
import { mergeAgentEventUpdates } from "./agentEventLog";
import { agentSelectionContext, agentCaptionReplacementHint, agentClipVolumeHint, agentSelectionLabel, agentSelectionTitle, type AgentSelection } from "./agentSelectionContext";
import { parseAgentProjectResults, type AgentProjectResult } from "../application/agentProjectResult";
import { isEditingAgentModel, type AgentProviderId, type AgentProviderReply } from "../application/agentProviders";
import { AgentProviderSettings } from "./AgentProviderSettings";
import { AgentModelPicker, type AgentSourceStatus } from "./AgentModelPicker";
import { AgentLibraryPanel } from "./AgentLibraryPanel";
import { modelSourceChoice, modelsForSource, type AgentSourceChoice } from "./agentModelChoices";

interface Props {
  projectPath?: string;
  projectId: string;
  projectName: string;
  projectSessionId: number;
  projectSaved: boolean;
  projectSavePending: boolean;
  sourceBindingKey: string;
  selection?: AgentSelection;
  onSaveProject: () => Promise<void>;
  onEnsureAgentProject: () => Promise<string>;
  onReloadProject: (agentPath?: string, allowConflictReplace?: boolean) => Promise<void>;
  onOpenCompletedProject: (result: AgentProjectResult) => Promise<boolean>;
}

const stored = (key: string) => { try { return key ? window.localStorage.getItem(key) || "" : ""; } catch { return ""; } };
const remember = (key: string, value: string) => { try { if (key) window.localStorage.setItem(key, value); } catch { /* storage is optional */ } };
const forget = (key: string) => { try { if (key) window.localStorage.removeItem(key); } catch { /* storage is optional */ } };
const runtimeLabel = (text?: string) => text?.replace(/\bopen\s*code\b/giu, "Agent");
const toolStatus = (status?: string) => ({ pending: "等待中", in_progress: "執行中", completed: "完成", failed: "失敗", cancelled: "已取消" }[status || ""] || status || "等待中");
const toolKind = (kind?: string) => ({ read: "讀取", edit: "編輯", delete: "刪除", move: "移動", search: "搜尋", execute: "執行", fetch: "擷取", think: "思考" }[kind || ""] || "工具");
const turnLabel = (status?: string) => ({ cancelled: "已停止本回合", error: "本回合失敗", max_tokens: "回覆達到長度限制" }[status || ""] || "回合已結束");
const toolTitle = (event: AgentAcpSnapshot["events"][number]) => {
  const title = event.text?.trim();
  if (title?.includes("call_editkin_tool")) return "剪輯台工具";
  if (title && title !== "工具呼叫" && title !== event.toolName) return title.slice(0, 100);
  if (event.toolName?.endsWith("call_editkin_tool")) return "剪輯台工具";
  const kind = toolKind(event.toolKind);
  return event.toolName?.replaceAll("_", " ") || (kind === "工具" ? "工具操作" : `${kind}工具`);
};
const attachmentTypes: Record<string, string> = {
  txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
  srt: "text/plain", lrc: "text/plain", vtt: "text/vtt",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
};

async function readAttachment(file: File): Promise<OpenCodeAttachment> {
  const extension = file.name.split(".").at(-1)?.toLowerCase() || "";
  const mimeType = attachmentTypes[extension];
  if (!mimeType) throw new Error(`不支援附件格式：${file.name}`);
  if (!file.size || file.size > (mimeType.startsWith("image/") ? 4 * 1024 * 1024 : 512 * 1024))
    throw new Error(`附件超過大小限制：${file.name}`);
  if (mimeType.startsWith("image/")) {
    let bitmap: ImageBitmap;
    try { bitmap = await createImageBitmap(file); }
    catch { throw new Error(`圖片無法解碼：${file.name}`); }
    const { width, height } = bitmap;
    bitmap.close();
    if (width > 8192 || height > 8192) throw new Error(`圖片尺寸超過 8192 像素：${file.name}`);
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error(`無法讀取圖片：${file.name}`));
      reader.readAsDataURL(file);
    });
    return { name: file.name, mimeType, data: dataUrl.slice(dataUrl.indexOf(",") + 1) };
  }
  return { name: file.name, mimeType, text: new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()) };
}

function displayEvents(events: AgentAcpSnapshot["events"]) {
  const rows: AgentAcpSnapshot["events"] = [];
  for (const event of events) {
    const previous = rows.at(-1);
    if (event.kind === "tool" && event.toolCallId) {
      const index = [...rows].reverse().findIndex((row) => row.kind === "tool" && row.toolCallId === event.toolCallId);
      const actual = index < 0 ? -1 : rows.length - 1 - index;
      if (actual >= 0) { rows[actual] = { ...rows[actual], ...event }; continue; }
    }
    if (event.kind === "plan") {
      let actual = -1;
      for (let index = rows.length - 1; index >= 0; index--) {
        if (rows[index].kind === "user" || rows[index].kind === "turn") break;
        if (rows[index].kind === "plan") { actual = index; break; }
      }
      if (actual >= 0) { rows[actual] = event; continue; }
    }
    if ((event.kind === "message" || event.kind === "thought" || event.kind === "user") && previous?.kind === event.kind && previous.messageId === event.messageId && (previous.text?.length ?? 0) < 30_000) {
      rows[rows.length - 1] = { ...previous, text: (previous.text || "") + (event.text || "") };
    } else rows.push(event);
  }
  return rows;
}

function ToolDetails({ event, open = false }: { event: AgentAcpSnapshot["events"][number]; open?: boolean }) {
  if (!event.details?.length && !event.locations?.length && !event.toolName) return null;
  return <details className="opencode-dock-tool-details" open={open || undefined}><summary>查看操作紀錄</summary>
    {event.toolName && <small>Agent 工具：<code>{event.toolName}</code></small>}
    {event.locations?.length ? <div className="opencode-dock-locations">{event.locations.map((location, index) =>
      <code key={`${location.path}:${index}`}>{location.path}{location.line !== undefined ? `:${location.line}` : ""}</code>)}</div> : null}
    {event.details?.map((detail, index) => detail.type === "text"
      ? <pre key={index}>{detail.text}</pre>
      : detail.type === "diff"
        ? <div className="opencode-dock-diff" key={index}><code>{detail.path}</code>
          {detail.oldText !== undefined && <><small>變更前</small><pre>{detail.oldText}</pre></>}
          <small>變更後</small><pre>{detail.newText}</pre></div>
        : <small key={index}>終端工作階段：{detail.terminalId}</small>)}
  </details>;
}

function inlineMarkdown(value: string): ReactNode[] {
  return value.split(/(\*\*[^*]+\*\*|`[^`]+`)/u).filter(Boolean).map((part, index) =>
    part.startsWith("**") && part.endsWith("**") ? <strong key={index}>{part.slice(2, -2)}</strong>
      : part.startsWith("`") && part.endsWith("`") ? <code key={index}>{part.slice(1, -1)}</code> : part);
}

function AgentMarkdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  const blocks: ReactNode[] = [];
  for (let at = 0; at < lines.length;) {
    const line = lines[at];
    if (!line.trim()) { at++; continue; }
    if (line.startsWith("```")) {
      const language = line.slice(3).trim().slice(0, 30);
      const code: string[] = [];
      at++;
      while (at < lines.length && !lines[at].startsWith("```")) code.push(lines[at++]);
      if (at < lines.length) at++;
      blocks.push(<pre key={blocks.length}><code>{language ? `${language}\n` : ""}{code.join("\n")}</code></pre>);
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/u.exec(line);
    if (heading) { blocks.push(<h4 key={blocks.length}>{inlineMarkdown(heading[2])}</h4>); at++; continue; }
    const bullet = /^\s*[-*]\s+(.+)$/u.exec(line);
    const numbered = /^\s*\d+\.\s+(.+)$/u.exec(line);
    if (bullet || numbered) {
      const items: ReactNode[] = [];
      const pattern = bullet ? /^\s*[-*]\s+(.+)$/u : /^\s*\d+\.\s+(.+)$/u;
      while (at < lines.length) {
        const matched = pattern.exec(lines[at]);
        if (!matched) break;
        items.push(<li key={items.length}>{inlineMarkdown(matched[1])}</li>);
        at++;
      }
      blocks.push(bullet ? <ul key={blocks.length}>{items}</ul> : <ol key={blocks.length}>{items}</ol>);
      continue;
    }
    const paragraph = [line];
    at++;
    while (at < lines.length && lines[at].trim() && !/^(?:```|#{1,4}\s|\s*[-*]\s|\s*\d+\.\s)/u.test(lines[at])) paragraph.push(lines[at++]);
    blocks.push(<p key={blocks.length}>{paragraph.map((part, index) => <span key={index}>{index > 0 && <br />}{inlineMarkdown(part)}</span>)}</p>);
  }
  return <div className="opencode-dock-markdown">{blocks}</div>;
}

export function OpenCodeAgentDock({ projectPath, projectId, projectName, projectSessionId, projectSaved, projectSavePending, sourceBindingKey,
  selection, onSaveProject, onEnsureAgentProject, onReloadProject, onOpenCompletedProject }: Props) {
  const api = window.haoDesktop;
  const [snapshot, setSnapshot] = useState<AgentAcpSnapshot>();
  const [boundProjectPath, setBoundProjectPath] = useState<string>();
  const [boundSessionId, setBoundSessionId] = useState<number>();
  const [events, setEvents] = useState<AgentAcpSnapshot["events"]>([]);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<OpenCodeAttachment[]>([]);
  const [origin, setOrigin] = useState("");
  const [activeOrigin, setActiveOrigin] = useState("");
  const [originLoaded, setOriginLoaded] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const [waitingBindingKey, setWaitingBindingKey] = useState<string>();
  const [completedProjects, setCompletedProjects] = useState(() => parseAgentProjectResults(stored("editkin.agent-completed-projects.v1")));
  const [completedPath, setCompletedPath] = useState("");
  const completedProject = completedProjects.find(result => result.path === completedPath) || completedProjects[0];
  useEffect(() => { remember("editkin.agent-completed-projects.v1", JSON.stringify(completedProjects)); }, [completedProjects]);
  const boundProjectInfo = useRef<AgentProjectResult | undefined>(undefined);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [reloadNeeded, setReloadNeeded] = useState(false);
  const [historyTruncated, setHistoryTruncated] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [commandMenuDismissed, setCommandMenuDismissed] = useState(false);
  const [activeCommandIndex, setActiveCommandIndex] = useState(0);
  const [includeSelection, setIncludeSelection] = useState(true);
  const [dismissedSourceId, setDismissedSourceId] = useState("");
  const [draftedSourceId, setDraftedSourceId] = useState("");
  const [sessions, setSessions] = useState<Array<{ sessionId: string; title?: string; updatedAt?: string }>>([]);
  const [providersOpen, setProvidersOpen] = useState(false);
  const [extensionsOpen, setExtensionsOpen] = useState(false);
  const [selectedSource, setSelectedSource] = useState<AgentSourceChoice>("local");
  const [settingsProvider, setSettingsProvider] = useState<AgentProviderId>("openai");
  const [settingsRequest, setSettingsRequest] = useState(0);
  const [providerCatalog, setProviderCatalog] = useState<AgentProviderReply>();
  const [providerCatalogError, setProviderCatalogError] = useState(false);
  const [missingSourceHint, setMissingSourceHint] = useState(false);
  const providersSectionRef = useRef<HTMLDetailsElement>(null);
  const originSectionRef = useRef<HTMLDetailsElement>(null);
  const lastNativeModel = useRef("");
  const [captionReadiness, setCaptionReadiness] = useState<AutomaticCaptionReadiness>();
  useEffect(() => {
    if (!api) return;
    let active = true;
    void api.automaticCaptionStatus().then((result) => {
      if (active) setCaptionReadiness(result);
    }).catch(() => {
      if (active) setCaptionReadiness({ status: "unavailable", message: "無法確認本機語音辨識能力。" });
    });
    return () => { active = false; };
  }, [api]);
  const seq = useRef(0);
  const currentSessionId = useRef<string | undefined>(undefined);
  const connectedSourceBinding = useRef("");
  const wasBusy = useRef(false);
  const projectSavedRef = useRef(projectSaved);
  const reloadProjectRef = useRef(onReloadProject);
  projectSavedRef.current = projectSaved;
  reloadProjectRef.current = onReloadProject;
  const pollGeneration = useRef(0);
  const pausedPolls = useRef(0);
  const autoStarted = useRef("");
  const startupQueue = useRef<Promise<void>>(Promise.resolve());
  const followTail = useRef(true);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDetailsElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const attachmentInput = useRef<HTMLInputElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const commandMenuRef = useRef<HTMLDivElement>(null);
  const sessionKey = `editkin.opencode-acp-session.v1:${projectId}`;
  const modelKey = `editkin.opencode-acp-model.v1:${projectId}`;
  const sourceNoticeKey = `editkin.kit-source-notice.v1:${projectId}`;
  useEffect(() => { setDismissedSourceId(stored(sourceNoticeKey)); setDraftedSourceId(""); }, [sourceNoticeKey]);
  useEffect(() => { if (!draft.trim() && draftedSourceId && !working) setDraftedSourceId(""); }, [draft, draftedSourceId, working]);
  const rememberSession = (id: string) => {
    remember(sessionKey, id);
  };
  useEffect(() => { setHistoryOpen(false); setSessions([]); setAttachments([]); }, [sessionKey]);
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (moreRef.current?.open && !moreRef.current.contains(event.target)) moreRef.current.open = false;
      if (historyOpen && !historyRef.current?.contains(event.target) && !historyButtonRef.current?.contains(event.target))
        setHistoryOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const moreOpen = Boolean(moreRef.current?.open);
      if (!moreOpen && !historyOpen) return;
      event.preventDefault();
      event.stopPropagation();
      if (moreOpen) { moreRef.current!.open = false; moreRef.current?.querySelector("summary")?.focus(); }
      if (historyOpen) { setHistoryOpen(false); historyButtonRef.current?.focus(); }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("pointerdown", onPointerDown); document.removeEventListener("keydown", onKeyDown); };
  }, [historyOpen]);
  useEffect(() => {
    if (!api) return;
    let active = true;
    void api.getLocalStoryOrigin().then((value) => { if (active) { setOrigin(value); setActiveOrigin(value); setOriginLoaded(true); } })
      .catch((reason) => { if (active) { setError(String(reason)); setOriginLoaded(true); } });
    return () => { active = false; };
  }, [api]);

  const ingest = (next: AgentAcpSnapshot) => {
    const sessionChanged = next.sessionId !== currentSessionId.current;
    if (sessionChanged) {
      if (next.sessionId) rememberSession(next.sessionId);
      currentSessionId.current = next.sessionId;
      seq.current = 0;
      setEvents([]);
      setHistoryTruncated(false);
      followTail.current = true;
      setShowJumpToLatest(false);
      wasBusy.current = false;
    }
    const justFinished = wasBusy.current && !next.busy;
    wasBusy.current = next.busy;
    const previousSeq = seq.current;
    setSnapshot(next);
    if (next.historyTruncated) setHistoryTruncated(true);
    if (next.seq <= previousSeq) return;
    const fresh = next.events.filter((event) => event.seq > previousSeq);
    if (fresh.length) {
      setEvents((current) => mergeAgentEventUpdates(current, fresh));
      if (justFinished && fresh.some((event) => event.kind === "turn" && event.projectChanged)) {
        const result = boundProjectInfo.current;
        if (result && boundSessionId !== projectSessionId && result.path === next.projectPath) {
          setCompletedProjects(current => [result, ...current.filter(item => item.path !== result.path)].slice(0, 5));
          setCompletedPath(result.path);
        } else {
          setReloadNeeded(true);
        }
        if (next.projectPath && next.projectPath === boundProjectPath && boundSessionId === projectSessionId
          && (projectSavedRef.current || next.projectPath !== projectPath)) {
          setWorking(true);
          void reloadProjectRef.current(next.projectPath).then(() => setReloadNeeded(false))
            .catch((reason) => setError(`Agent 已修改專案，但自動同步失敗：${String(reason)}`))
            .finally(() => setWorking(false));
        }
      }
    }
    seq.current = next.seq;
  };
  useEffect(() => {
    if (!api || !snapshot?.connected) return;
    let active = true;
    let inFlight = false;
    const poll = async () => {
      if (inFlight || pausedPolls.current > 0) return;
      inFlight = true;
      const generation = pollGeneration.current;
      try { const next = await api.statusOpenCodeAgent(seq.current); if (active && generation === pollGeneration.current && next.projectPath === boundProjectPath) ingest(next); }
      catch (reason) { if (active && generation === pollGeneration.current && pausedPolls.current === 0) setError(reason instanceof Error ? reason.message : String(reason)); }
      finally { inFlight = false; }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1000);
    return () => { active = false; window.clearInterval(timer); };
  }, [api, boundProjectPath, projectSessionId, snapshot?.connected]);
  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    if (!events.length) { transcript.scrollTop = 0; followTail.current = true; setShowJumpToLatest(false); return; }
    if (followTail.current) { transcript.scrollTop = transcript.scrollHeight; setShowJumpToLatest(false); }
  }, [snapshot?.seq, events.length]);
  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    const observer = new ResizeObserver(() => { if (followTail.current) transcript.scrollTop = transcript.scrollHeight; });
    observer.observe(transcript);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const input = composerInput.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(Math.max(input.scrollHeight, 48), 160)}px`;
    input.style.overflowY = input.scrollHeight > 160 ? "auto" : "hidden";
  }, [draft]);
  const onTranscriptScroll = () => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    const nearEnd = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <= 56;
    followTail.current = nearEnd;
    setShowJumpToLatest(!nearEnd && events.length > 0);
  };
  const rows = useMemo(() => displayEvents(events), [events]);
  const nativeTitle = snapshot?.title?.trim() || "";
  const firstRequest = rows.find((event) => event.kind === "user" && event.text?.trim())?.text?.replace(/\s+/gu, " ").trim();
  const currentTitle = nativeTitle && !/^(?:new session(?:\s*[-—:]|$)|新對話$)/iu.test(nativeTitle)
    ? nativeTitle : firstRequest?.slice(0, 100) || "新對話";
  const visibleRows = rows.filter((event) => event.kind !== "turn" || event.status !== "end_turn");
  const pendingPermissionIds = new Set(snapshot?.pendingPermissionIds ?? []);
  const pendingPermission = [...rows].reverse().find((event) => event.kind === "permission" && event.requestId !== undefined && pendingPermissionIds.has(event.requestId));
  const lastTurnBoundary = [...rows].reverse().find((event) => event.kind === "user" || event.kind === "turn")?.seq ?? -1;
  const activeTool = [...rows].reverse().find((event) => event.kind === "tool" && event.seq > lastTurnBoundary && (event.status === "pending" || event.status === "in_progress"));
  const latestTool = [...rows].reverse().find((event) => event.kind === "tool" && event.seq > lastTurnBoundary);
  const blockedWorkflow = latestTool?.outcome;
  const sourcePreparation = snapshot?.sourcePreparation;
  const sourceReadyToContinue = sourcePreparation?.status === "COMPLETED" && Boolean(sourcePreparation.preparationId)
    && sourcePreparation.preparationId !== dismissedSourceId && sourcePreparation.preparationId !== draftedSourceId && !snapshot?.busy;
  const sourceStatusVisible = sourcePreparation && (["PREPARING", "CANCELLING", "CREATING", "INTERRUPTED", "UNCERTAIN", "FAILED"].includes(sourcePreparation.status)
    || sourceReadyToContinue);
  const sourcePhases: Record<string, string> = { hashing: "讀取原片", checking: "檢查副本", copying: "複製素材", verifying: "驗證副本", ready: "副本已驗證" };
  const sourceProgress = sourcePreparation?.progress;
  const sourcePercent = sourceProgress && sourceProgress.bytesTotal > 0
    ? Math.min(99, Math.floor(sourceProgress.bytesDone / sourceProgress.bytesTotal * 100)) : undefined;
  const sourceLabel = sourcePreparation?.status === "PREPARING"
    ? `${sourcePhases[sourceProgress?.phase || ""] || "準備素材"}${sourcePercent === undefined ? "" : ` · ${sourcePercent}%`}`
    : ({ CANCELLING: "正在停止素材準備", CREATING: "素材已驗證，正在建立流程", COMPLETED: "素材已準備好，可接著剪輯",
      INTERRUPTED: "素材準備中斷，可請 Agent 恢復", UNCERTAIN: "流程建立結果待查證", FAILED: "素材準備失敗" } as Record<string, string>)[sourcePreparation?.status || ""];
  const continueSourcePreparation = () => {
    const id = sourcePreparation?.preparationId;
    if (!id || !sourceReadyToContinue) return;
    const suggestion = "素材準備好了，請接著分析內容並規劃剪輯。需要我決定故事方向或審片時先停下來。";
    setDraft((current) => current.trim() ? `${current.trim()}\n\n${suggestion}` : suggestion);
    setDraftedSourceId(id);
    composerInput.current?.focus();
  };
  const modelOption = snapshot?.configOptions?.find((option) => option.category === "model" || option.id === "model");
  const sourceModels = modelsForSource(modelOption?.options ?? [], selectedSource);
  useEffect(() => {
    if (!modelOption?.currentValue || !snapshot?.sessionId) return;
    const key = `${snapshot.sessionId}\0${modelOption.currentValue}`;
    if (lastNativeModel.current === key) return;
    lastNativeModel.current = key;
    setSelectedSource(modelSourceChoice(modelOption.currentValue)); setMissingSourceHint(false);
  }, [modelOption?.currentValue, snapshot?.sessionId]);
  useEffect(() => {
    if (!api || !snapshot?.connected || selectedSource === "local" || selectedSource === "unlisted" || snapshot.providerReconnectRequired) return;
    let active = true;
    setProviderCatalog(undefined); setProviderCatalogError(false);
    void api.openCodeAgentProvider({ action: "list" }).then(result => { if (active) setProviderCatalog(result); })
      .catch(() => { if (active) setProviderCatalogError(true); });
    return () => { active = false; };
  }, [api, snapshot?.connected, snapshot?.sessionId, snapshot?.providerReconnectRequired, selectedSource]);
  const configuredSource = selectedSource === "local" || (selectedSource === "omniroute"
    ? Boolean(providerCatalog?.gateway?.modelCount) : Boolean(providerCatalog?.providers?.find(provider => provider.id === selectedSource)?.configured));
  const sourceStatus: AgentSourceStatus = selectedSource === "unlisted" ? "unlisted"
    : !modelOption || !snapshot?.connected ? "loading"
    : snapshot.providerReconnectRequired || (selectedSource !== "local" && providerCatalog?.requiresReconnect) ? "refresh"
    : selectedSource !== "local" && providerCatalogError ? "unavailable"
    : selectedSource !== "local" && !providerCatalog ? "loading"
    : !configuredSource ? "missing" : !sourceModels.length ? "empty" : "ready";
  const modelSelectionReady = sourceStatus === "ready" && sourceModels.some(model => model.value === modelOption?.currentValue);
  const openSourceSettings = () => {
    const target = missingSourceHint ? "omniroute" : selectedSource;
    if (moreRef.current) moreRef.current.open = true;
    if (target === "local") {
      if (originSectionRef.current) originSectionRef.current.open = true;
      if (providersSectionRef.current) providersSectionRef.current.open = false;
    } else {
      setSettingsProvider(target === "unlisted" ? "omniroute" : target);
      setSettingsRequest(current => current + 1);
      if (providersSectionRef.current) providersSectionRef.current.open = true;
      setProvidersOpen(true);
    }
  };
  const otherOptions = snapshot?.configOptions?.filter((option) => option.id !== modelOption?.id && option.type === "select"
    && option.category !== "mode" && !/mode/iu.test(option.id) && option.options.length > 1) ?? [];
  const slashCommands = !commandMenuDismissed && draft.startsWith("/") && !draft.includes(" ")
    ? snapshot?.commands.filter((command) => command.name.toLowerCase().startsWith(draft.slice(1).toLowerCase())).slice(0, 8) ?? [] : [];
  useEffect(() => {
    commandMenuRef.current?.querySelectorAll("button")[activeCommandIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeCommandIndex, slashCommands.length]);
  const chooseSlashCommand = (name: string) => {
    setDraft(`/${name} `);
    setActiveCommandIndex(0);
    composerInput.current?.focus();
  };
  const starterPrompts = [
    { label: "盤點專案", text: "請先讀取目前專案，說明素材與時間軸狀態，暫時不要修改。" },
    selection
      ? { label: "分析片段", text: "請分析這個片段的節奏，提出具體剪輯建議，暫時不要修改時間軸。" }
      : { label: "規劃節奏", text: "請根據目前專案提出一版初剪順序與節奏，先不要修改時間軸。" },
  ];
  const bindingKey = `${projectSessionId}\0${activeOrigin}`;
  const waitingToBind = waitingBindingKey === bindingKey;
  const projectReady = Boolean(!waitingToBind && boundProjectPath && boundSessionId === projectSessionId
    && snapshot?.projectPath === boundProjectPath && (projectSaved || boundProjectPath !== projectPath));
  const workingCopy = Boolean(boundProjectPath && boundProjectPath !== projectPath);
  const needsProjectSave = Boolean(projectPath && !projectSaved && !workingCopy);
  const perform = async (action: () => Promise<AgentAcpSnapshot>, propagateError = false) => {
    pausedPolls.current++;
    setWorking(true); setError("");
    try { ingest(await action()); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); if (propagateError) throw reason; }
    finally { pausedPolls.current--; setWorking(false); }
  };
  const connect = async (targetPath?: string, resumeSessionId?: string, resumeModel?: string, propagateError = false) => {
    if (!api || !originLoaded) return;
    const prior = resumeSessionId || stored(sessionKey) || undefined;
    const priorModel = resumeModel || stored(modelKey) || undefined;
    await perform(async () => {
      ++pollGeneration.current; setEvents([]); seq.current = 0; setSnapshot(undefined); setReloadNeeded(false);
      const binding = targetPath || await onEnsureAgentProject();
      boundProjectInfo.current = { path: binding, projectId, projectName, workingCopy: binding !== projectPath };
      setBoundProjectPath(binding); setBoundSessionId(projectSessionId);
      let result: AgentAcpSnapshot;
      try { result = await api.startOpenCodeAgent(binding, priorModel ? prior : undefined, priorModel); }
      catch (reason) {
        if (!prior || !priorModel) throw reason;
        forget(sessionKey);
        result = await api.startOpenCodeAgent(binding);
        setError(`上次對話無法續接，已建立新對話：${reason instanceof Error ? reason.message : String(reason)}`);
      }
      const model = result.configOptions.find((option) => option.id === "model")?.currentValue;
      if (model && isEditingAgentModel(model)) remember(modelKey, model);
      if (propagateError && result.providerReconnectRequired) throw new Error("供應商設定在更新期间改變，請再更新模型清單");
      connectedSourceBinding.current = sourceBindingKey;
      return result;
    }, propagateError);
  };
  const openHistory = () => {
    if (!api) return;
    moreRef.current?.removeAttribute("open");
    if (historyOpen) { setHistoryOpen(false); return; }
    if (api.agentLibrary && snapshot?.historyAvailable) { setHistoryOpen(true); return; }
    void perform(async () => {
      setSessions(await api.listOpenCodeAgentSessions());
      setHistoryOpen(true);
      return api.statusOpenCodeAgent(seq.current);
    });
  };
  const refreshProviderModels = async () => {
    if (!api || !originLoaded || snapshot?.busy || working || waitingToBind) throw new Error("請等目前回合完成");
    setProviderCatalog(undefined); setProviderCatalogError(false);
    await api.closeOpenCodeAgent(); await connect(boundProjectPath, snapshot?.sessionId, modelOption?.currentValue, true);
  };
  const newConversation = () => {
    if (!api) return;
    void perform(async () => {
      const next = await api.newOpenCodeAgentSession();
      setHistoryOpen(false); setReloadNeeded(false);
      return next;
    });
  };
  const loadConversation = (sessionId: string) => {
    if (!api || !modelOption || !isEditingAgentModel(modelOption.currentValue)) return;
    void perform(async () => {
      const next = await api.loadOpenCodeAgentSession(sessionId, modelOption.currentValue);
      setHistoryOpen(false); setReloadNeeded(false);
      return next;
    });
  };
  useEffect(() => {
    if (!api || !originLoaded) return;
    const key = `${projectSessionId}\0${activeOrigin}`;
    if (autoStarted.current === key) return;
    autoStarted.current = key;
    setWaitingBindingKey(undefined);
    let active = true;
    const startForProject = async () => {
      if (!active) return;
      try {
        const binding = await onEnsureAgentProject();
        if (!active) return;
        const status = await api.statusOpenCodeAgent(0);
        if (!active) return;
        if (status.connected && status.busy) {
          // Keep polling the actual old binding until its existing turn ends.
          // Advertising the new path here would drop those status updates.
          connectedSourceBinding.current = "";
          setBoundProjectPath(status.projectPath);
          setWaitingBindingKey(key); setError(""); ingest(status);
          return;
        }
        if (status.connected && status.projectPath === binding) {
          const previousModel = status.configOptions.find(option => option.id === "model")?.currentValue;
          await api.closeOpenCodeAgent();
          if (active) await connect(binding, status.sessionId, previousModel);
          return;
        }
        if (status.connected) await api.closeOpenCodeAgent();
        if (active) await connect(binding);
      } catch (reason) { if (active) { autoStarted.current = ""; setError(reason instanceof Error ? reason.message : String(reason)); } }
    };
    // A project may open while the demo Agent is still starting. Finish that
    // startup before inspecting and replacing its session for the new project.
    startupQueue.current = startupQueue.current.then(startForProject, startForProject);
    return () => { active = false; };
    // Status updates are not scope changes: they must not cancel a queued
    // project startup while autoStarted still reserves the same key.
  }, [api, projectSessionId, activeOrigin, originLoaded, onEnsureAgentProject, retryNonce]);
  useEffect(() => {
    if (waitingBindingKey !== bindingKey || snapshot?.busy !== false) return;
    setWaitingBindingKey(undefined);
    autoStarted.current = "";
    setRetryNonce((current) => current + 1);
  }, [waitingBindingKey, bindingKey, snapshot?.busy]);
  const saveOrigin = () => {
    if (!api) return;
    void perform(async () => {
      const status = await api.statusOpenCodeAgent(0);
      if (status.connected && status.busy) throw new Error("請等目前回合完成後再更換本地模型位址");
      const value = await api.saveLocalStoryOrigin(origin);
      if (status.connected) await api.closeOpenCodeAgent();
      setOrigin(value); setActiveOrigin(value); autoStarted.current = "";
      return api.statusOpenCodeAgent(seq.current);
    });
  };
  const addAttachments = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(""); setWorking(true);
    try {
      if (attachments.length + files.length > 4) throw new Error("最多附加 4 個檔案");
      const next = await Promise.all(Array.from(files).map(readAttachment));
      setAttachments((current) => [...current, ...next]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (attachmentInput.current) attachmentInput.current.value = ""; setWorking(false); }
  };
  const send = async () => {
    const message = draft.trim();
    const sourceContinuationId = !message.startsWith("/") && sourcePreparation?.status === "COMPLETED" && sourcePreparation.preparationId === draftedSourceId
      ? draftedSourceId : "";
    if (!api || !message || !snapshot?.connected || snapshot.busy || working) return;
    if (!projectReady || reloadNeeded || snapshot?.providerReconnectRequired || !modelSelectionReady) return;
    followTail.current = true;
    setShowJumpToLatest(false);
    const selectedContext = agentSelectionContext(includeSelection ? selection : undefined, boundProjectPath);
    const directEditHint = agentClipVolumeHint(includeSelection ? selection : undefined, message, boundProjectPath)
      || agentCaptionReplacementHint(includeSelection ? selection : undefined, message, boundProjectPath);
    const continuationHint = sourceContinuationId
      ? `\n已完成 Kit 素材準備 ID：${sourceContinuationId}。先核對 source-status 取得原 run，不重建已完成工作；完整接續規則用 get_editkin_task_guidance(task=continue)。` : "";
    const context = message.startsWith("/") ? message
      : `目前 Editkin 專案檔：${boundProjectPath}。只使用此 session 的 Editkin MCP；唯讀要求不修改。${captionReadiness?.status === "unavailable" ? "語音辨識不可用；需要逐字稿時先回報阻斷，不虛構語音證據。" : ""}${selectedContext}${directEditHint}${continuationHint}\n\n使用者：${message}`;
    const sentAttachments = attachments;
    setDraft(""); setAttachments([]);
    setWorking(true); setError("");
    try {
      if (await onEnsureAgentProject() !== boundProjectPath) throw new Error("Agent 工作副本已切換；請重新開啟對話");
      if (connectedSourceBinding.current !== sourceBindingKey) {
        const resumeModel = snapshot.configOptions.find(option => option.id === "model")?.currentValue;
        ++pollGeneration.current;
        await api.closeOpenCodeAgent();
        const rebound = await api.startOpenCodeAgent(boundProjectPath,
          snapshot.sessionId && resumeModel && isEditingAgentModel(resumeModel) ? snapshot.sessionId : undefined,
          resumeModel && isEditingAgentModel(resumeModel) ? resumeModel : undefined);
        seq.current = 0;
        setEvents([]);
        ingest(rebound);
        connectedSourceBinding.current = sourceBindingKey;
      }
      ingest(await api.promptOpenCodeAgent(boundProjectPath, context, message, sentAttachments));
      if (sourceContinuationId) { remember(sourceNoticeKey, sourceContinuationId); setDismissedSourceId(sourceContinuationId); setDraftedSourceId(""); }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setDraft((current) => current.trim() ? `${message}\n\n${current}` : message);
      setAttachments((current) => [...sentAttachments, ...current]);
    }
    finally { setWorking(false); }
  };
  if (!api) return <div className="opencode-dock"><p>此 Agent 需要桌面版。</p></div>;
  return <section className="opencode-dock" aria-label="Agent 對話">
    <div className="opencode-dock-status">
      <strong title={currentTitle}>{currentTitle}</strong>
      {!snapshot?.connected && !error && <span className="opencode-dock-preparing" role="status" aria-label="正在準備 Agent 工作區"><i /><i /><i /></span>}
      {snapshot?.connected && <><button type="button" className="opencode-dock-icon-button" aria-label="建立新對話" title="建立新對話" onClick={newConversation} disabled={working || snapshot.busy || waitingToBind}>＋</button>
        {snapshot.listSession && <button ref={historyButtonRef} type="button" className="opencode-dock-icon-button" aria-label="對話紀錄" aria-expanded={historyOpen} aria-controls={historyOpen ? "opencode-dock-history" : undefined} title="對話紀錄" onClick={openHistory} disabled={working || snapshot.busy || waitingToBind}>◷</button>}</>}
      <details ref={moreRef} className="opencode-dock-skills opencode-dock-more" onToggle={(event) => { if (event.currentTarget.open) setHistoryOpen(false); }}><summary aria-label={`專案與 Agent 設定：${projectName}`} title={`專案：${projectName} · ${workingCopy ? "草稿" : "已儲存"} · ${snapshot?.busy ? "處理中" : snapshot?.mcpToolCount ? "可剪輯" : "準備中"}`}>⋯</summary>
        <div className="opencode-dock-more-panel">
          <div className="opencode-dock-project"><small>目前專案</small><strong title={projectName}>{projectName}</strong>
            <span>{workingCopy ? "草稿" : "已儲存"} · {snapshot?.busy ? "處理中" : snapshot?.mcpToolCount ? "可剪輯" : "準備中"}</span></div>
          {captionReadiness && <details className="opencode-dock-menu-section"><summary>語音辨識 · {captionReadiness.status === "ready" ? "可用" : captionReadiness.status === "model-download-needed" ? "需下載模型" : "不可用"}</summary>
            <p>{captionReadiness.message}</p></details>}
          {originLoaded && <details ref={originSectionRef} className="opencode-dock-menu-section"><summary>區網模型位址</summary><div className="opencode-dock-skill">
            <input aria-label="區網 Qwen 位址" value={origin} onChange={(event) => setOrigin(event.target.value)} placeholder="http://私有IP:連接埠" />
            <button type="button" disabled={working || snapshot?.busy || !origin.trim() || origin === activeOrigin} onClick={saveOrigin}>儲存模型位址</button></div></details>}
          <details ref={providersSectionRef} className="opencode-dock-menu-section" onToggle={event => setProvidersOpen(event.currentTarget.open)}><summary>模型供應商設定</summary>
            {providersOpen && api && <AgentProviderSettings api={api} initialProvider={settingsProvider} settingsRequest={settingsRequest} disabled={working || Boolean(snapshot?.busy) || waitingToBind} onReconnect={refreshProviderModels} />}</details>
          {snapshot?.historyAvailable && api?.agentLibrary && snapshot.libraryBinding && <details className="opencode-dock-menu-section" onToggle={event => setExtensionsOpen(event.currentTarget.open)}><summary>個人 Skill 與插件</summary>
            {extensionsOpen && <AgentLibraryPanel key={snapshot.libraryBinding} call={api.agentLibrary} binding={snapshot.libraryBinding} mode="extensions" disabled={working || snapshot.busy || waitingToBind} onContinue={loadConversation} />}</details>}
          {snapshot?.connected && <><p className="opencode-dock-session">可用剪輯工具：{snapshot.mcpToolCount ?? 0}</p>
            <details className="opencode-dock-menu-section"><summary>診斷資訊{snapshot.usage ? ` · 脈絡 ${Math.min(100, Math.round(snapshot.usage.used / snapshot.usage.size * 100))}%` : ""}</summary>
              <p className="opencode-dock-session">{snapshot.sessionId}<br />{snapshot.workspace}</p>
              {snapshot.provenance && <p className="opencode-dock-session" data-testid="agent-provenance">
                Agent 整合 · {snapshot.provenance.attribution} · {snapshot.provenance.license}<br />
                來源版本：<code title={snapshot.provenance.sourceDigest}>{snapshot.provenance.sourceDigest.slice(0, 12)}</code><br />
                <small>{snapshot.provenance.originId}</small></p>}</details></>}
        </div>
      </details>
    </div>
    {needsProjectSave && <div className="opencode-dock-warning opencode-dock-setup"><span>時間軸有未儲存修改</span>
      <button type="button" disabled={projectSavePending || working} onClick={() => void onSaveProject()}>{projectSavePending ? "儲存中…" : "儲存後交給 Agent"}</button>
    </div>}
    {snapshot?.archiveError && <p className="opencode-dock-warning" role="alert">{snapshot.archiveError}</p>}
    {snapshot?.connected && historyOpen && <div ref={historyRef} id="opencode-dock-history" className="opencode-dock-history">
      {api?.agentLibrary && snapshot.historyAvailable && snapshot.libraryBinding ? <AgentLibraryPanel key={snapshot.libraryBinding} call={api.agentLibrary} binding={snapshot.libraryBinding} mode="history" disabled={working || snapshot.busy || waitingToBind || !snapshot.loadSession} onContinue={loadConversation} /> : <><strong>對話紀錄</strong>
      {sessions.length ? sessions.map((session) => <button type="button" key={session.sessionId} title={session.title || "未命名對話"} disabled={working || session.sessionId === snapshot.sessionId} onClick={() => loadConversation(session.sessionId)}>
        <span className="opencode-dock-history-title">{session.title || "未命名對話"}</span><small>{session.updatedAt ? new Date(session.updatedAt).toLocaleString() : session.sessionId.slice(0, 12)}</small>
      </button>) : <p>目前工作資料夾沒有其他對話。</p>}</>}
    </div>}
    {snapshot?.connected && snapshot.projectPath !== boundProjectPath && <p className="opencode-dock-warning">正在切換專案工具；完成後即可操作目前專案。</p>}
    <div className="opencode-dock-transcript-wrap"><div ref={transcriptRef} className="opencode-dock-transcript" role="log" aria-live="polite" onScroll={onTranscriptScroll}>
      {historyTruncated && <small className="opencode-dock-history-limit">此側欄只載入最近 500 則紀錄；較早內容可從對話紀錄回看。</small>}
    {rows.length === 0 && <div className="opencode-dock-empty"><strong>想先做什麼？</strong>
        <div className="opencode-dock-starters">{starterPrompts.map((prompt) => <button type="button" key={prompt.label}
          title="填入草稿，不會直接傳送" onClick={() => { setDraft(prompt.text); composerInput.current?.focus(); }}>{prompt.label}<span aria-hidden="true">↗</span></button>)}</div>
      </div>}
      {visibleRows.map((event, index) => <div className={`opencode-dock-entry kind-${event.kind}`} key={`${event.entryId ?? event.seq}:${index}`}
        id={event.kind === "permission" && event.requestId !== undefined ? `opencode-dock-permission-${event.requestId}` : undefined}
        tabIndex={event.kind === "permission" ? -1 : undefined}>
        {event.kind === "tool" ? <><div className="opencode-dock-tool-heading"><strong>{toolTitle(event)}</strong><span className="opencode-dock-tool-state" data-status={event.status}>{toolStatus(event.status)}</span></div>
          {event.requestedAction && <small className="opencode-dock-tool-intent" title={`要求：${event.requestedAction}`}>要求：{event.requestedAction}</small>}
          {event.outcome && <p className="opencode-dock-tool-outcome" role="alert">{event.outcome}</p>}
          <ToolDetails event={event} open={event.status === "failed" && !event.outcome} /></>
          : event.kind === "plan" ? <><strong>執行計畫</strong><ol>{event.entries?.map((entry, item) => <li key={item} data-status={entry.status}>{entry.content}</li>)}</ol></>
          : event.kind === "thought" ? <details><summary>思考過程</summary><p>{event.text}</p></details>
          : event.kind === "user" ? <><strong>你</strong><p>{event.text}</p></>
          : event.kind === "message" ? <><strong>Agent</strong><AgentMarkdown text={event.text?.trim() || ""} /></>
          : event.kind === "permission" ? <><strong>Agent 要求授權 · {toolKind(event.toolKind)}</strong><p>{runtimeLabel(event.text)}</p>
            {event.requestedAction && <small className="opencode-dock-tool-intent">要求：{event.requestedAction}</small>}
            <ToolDetails event={event} open /><div className="opencode-dock-options">
            {event.options?.map((option) => <button type="button" key={option.optionId} disabled={working || !snapshot?.connected || !pendingPermissionIds.has(event.requestId!)}
              onClick={() => void perform(() => api.permissionOpenCodeAgent(event.requestId!, option.optionId))}>{option.name}</button>)}
            <button type="button" disabled={working || !snapshot?.connected || !pendingPermissionIds.has(event.requestId!)} onClick={() => void perform(() => api.permissionOpenCodeAgent(event.requestId!))}>拒絕</button>
            {!pendingPermissionIds.has(event.requestId!) && <small>這項要求已處理或失效</small>}
          </div></>
          : event.kind === "turn" ? <small>{turnLabel(event.status)}</small>
            : <p>{runtimeLabel(event.text)}</p>}
      </div>)}
      {snapshot?.busy && <div className="opencode-dock-activity" role="status"><span className="opencode-dock-preparing" aria-hidden="true"><i /><i /><i /></span>
        {pendingPermissionIds.size ? "等待你確認工具操作" : activeTool ? `${toolTitle(activeTool)} · ${toolStatus(activeTool.status)}`
          : blockedWorkflow ? "流程已停止，Agent 正在整理原因" : "Agent 正在回覆"}</div>}
    </div>
      {showJumpToLatest && <button type="button" className="opencode-dock-jump" onClick={() => { followTail.current = true; if (transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight; setShowJumpToLatest(false); }}>↓ 最新訊息</button>}
    </div>
    {waitingToBind && <p className="opencode-dock-binding-wait" role="status">正在等待先前回合結束，完成後會自動連接目前專案。</p>}
    {snapshot?.providerReconnectRequired && <div className="opencode-dock-warning" role="status"><span>供應商設定已更新，請先更新模型清單再繼續對話。</span>
      <button type="button" disabled={working || snapshot.busy || waitingToBind} onClick={() => void refreshProviderModels().catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))}>更新供應商模型清單</button></div>}
    {completedProject && <div className="opencode-dock-previous-result" role="status">
      <div><strong>先前專案的剪輯已保留</strong><span>{completedProject.projectName}</span></div>
      {completedProjects.length > 1 && <select aria-label="先前完成的剪輯" value={completedProject.path}
        onChange={event => setCompletedPath(event.target.value)}>{completedProjects.map(result =>
          <option key={result.path} value={result.path}>{result.projectName}</option>)}</select>}
      <div className="opencode-dock-previous-actions"><button type="button" disabled={working || snapshot?.busy || waitingToBind || projectSavePending}
        onClick={() => { setWorking(true); setError(""); void onOpenCompletedProject(completedProject)
          .then(opened => { if (opened) setCompletedProjects(current => current.filter(result => result.path !== completedProject.path)); })
          .catch(reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setWorking(false)); }}>開啟剪輯結果</button>
        <button type="button" aria-label="隱藏完成結果提示" title="隱藏提示；剪輯結果仍保留在磁碟" disabled={working}
          onClick={() => setCompletedProjects(current => current.filter(result => result.path !== completedProject.path))}>×</button></div>
    </div>}
    {error && <div role="alert" className="opencode-dock-error"><p>{runtimeLabel(error)}</p>{!snapshot?.connected && originLoaded &&
      <button type="button" disabled={working} onClick={() => { setError(""); autoStarted.current = ""; setRetryNonce((current) => current + 1); }}>再試一次</button>}</div>}
    {pendingPermissionIds.size > 0 && <div className="opencode-dock-attention" role="status"><span>需要確認工具操作{pendingPermissionIds.size > 1 ? ` · ${pendingPermissionIds.size} 項` : ""}</span>
      {pendingPermission && <button type="button" onClick={() => {
        const card = document.getElementById(`opencode-dock-permission-${pendingPermission.requestId}`);
        card?.scrollIntoView({ block: "center", behavior: "smooth" }); card?.focus({ preventScroll: true });
      }}>查看授權</button>}</div>}
    {snapshot?.connected && reloadNeeded && <button type="button" className="opencode-dock-reload" disabled={!projectReady || working || snapshot.busy}
      onClick={() => { setWorking(true); setError(""); void onReloadProject(boundProjectPath, true).then(() => setReloadNeeded(false)).catch((reason) => setError(String(reason))).finally(() => setWorking(false)); }}>
      載入 Agent 的剪輯變更（目前剪輯可復原）
    </button>}
    {snapshot?.connected && sourceStatusVisible && <div className="opencode-dock-source-status" role="status" aria-label="Kit 素材準備狀態"
      data-status={sourcePreparation.status}>
      <div className="opencode-dock-source-status-line"><span>{sourceLabel}</span>
        {sourcePreparation.status === "PREPARING" && !snapshot.busy && <button type="button" disabled={working}
          onClick={() => void perform(api.cancelOpenCodeAgent)}>停止</button>}
        {sourceReadyToContinue && <button type="button" disabled={working || reloadNeeded || !projectReady}
          onClick={continueSourcePreparation}>接著剪輯</button>}</div>
      {sourcePreparation.status === "PREPARING" && sourcePercent !== undefined && <div className="opencode-dock-source-track"
        role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={sourcePercent} aria-label="素材副本進度">
        <span style={{ width: `${sourcePercent}%` }} /></div>}
    </div>}
    <div className="opencode-dock-compose">
      <input ref={attachmentInput} className="opencode-dock-file-input" type="file" multiple
        accept=".txt,.md,.csv,.json,.srt,.lrc,.vtt,.png,.jpg,.jpeg,.gif,.webp"
        aria-label="選擇 Agent 附件" onChange={(event) => void addAttachments(event.currentTarget.files)} />
      {selection && projectReady && <label className="opencode-dock-selection" title={agentSelectionTitle(selection)}><input type="checkbox" checked={includeSelection} onChange={(event) => setIncludeSelection(event.target.checked)} />
        <span>{agentSelectionLabel(selection)}</span></label>}
      {attachments.length > 0 && <div className="opencode-dock-attachments" aria-label="待傳送附件">{attachments.map((item, index) =>
        <span key={`${item.name}:${index}`}>📎 {item.name}<button type="button" aria-label={`移除 ${item.name}`} disabled={working || snapshot?.busy}
          onClick={() => setAttachments((current) => current.filter((_, at) => at !== index))}>×</button></span>)}</div>}
      {slashCommands.length > 0 && <div ref={commandMenuRef} id="opencode-dock-commands" className="opencode-dock-commands" role="listbox" aria-label="Agent 指令建議">
        {slashCommands.map((command, index) => <button type="button" role="option" aria-selected={index === activeCommandIndex}
          id={`opencode-dock-command-${index}`} key={command.name} onMouseEnter={() => setActiveCommandIndex(index)} onClick={() => chooseSlashCommand(command.name)}>
          <strong>/{command.name}</strong><span>{runtimeLabel(command.description)}</span></button>)}</div>}
      <div className="opencode-dock-composer">
      <textarea ref={composerInput} aria-label="傳訊息給 Agent" title="Enter 傳送 · Shift+Enter 換行" value={draft}
        aria-controls={slashCommands.length ? "opencode-dock-commands" : undefined}
        aria-activedescendant={slashCommands.length ? `opencode-dock-command-${Math.min(activeCommandIndex, slashCommands.length - 1)}` : undefined}
        onChange={(event) => { setDraft(event.target.value); setCommandMenuDismissed(false); setActiveCommandIndex(0); }}
        onKeyDown={(event) => {
          if (!event.nativeEvent.isComposing && slashCommands.length) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setActiveCommandIndex((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + slashCommands.length) % slashCommands.length);
              return;
            }
            if (event.key === "Escape") { event.preventDefault(); setCommandMenuDismissed(true); return; }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault(); chooseSlashCommand(slashCommands[Math.min(activeCommandIndex, slashCommands.length - 1)].name); return;
            }
          }
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing
            && snapshot?.connected && projectReady && !working && !reloadNeeded && !snapshot?.providerReconnectRequired && modelSelectionReady) { event.preventDefault(); void send(); }
        }}
        placeholder={reloadNeeded ? "先載入 Agent 的剪輯變更，再繼續對話" : snapshot?.busy ? "可先寫下一則，完成後傳送…" : "交代剪輯任務，或輸入 / 使用命令…"} rows={2}
        disabled={reloadNeeded} />
      <div className="opencode-dock-compose-actions">
        <button type="button" className="opencode-dock-attach" aria-label="附加檔案" title="附加歌詞、字幕、文字或圖片" onClick={() => attachmentInput.current?.click()} disabled={working || snapshot?.busy || attachments.length >= 4}>＋</button>
        <div className="opencode-dock-compose-controls"><div className="opencode-dock-other-options">{otherOptions.map((option) => <label className="opencode-dock-compose-select" key={option.id}><span>{/mode/iu.test(option.id) || /mode/iu.test(option.name) ? "模式" : option.name}</span>
          <select aria-label={option.name} value={option.currentValue} disabled={working || snapshot?.busy} onChange={(event) => void perform(() => api.setOpenCodeAgentConfig(option.id, event.target.value))}>
            {option.options.map((choice) => <option key={choice.value} value={choice.value}>{choice.name}</option>)}
          </select></label>)}</div>
        <AgentModelPicker source={selectedSource} models={sourceModels} currentModel={modelOption?.currentValue || ""}
          status={sourceStatus} disabled={working || Boolean(snapshot?.busy) || waitingToBind} showMissingSource={missingSourceHint}
          onSource={source => { setSelectedSource(source); setMissingSourceHint(false); }}
          onModel={model => { if (modelOption) void perform(async () => { const next = await api.setOpenCodeAgentConfig(modelOption.id, model); remember(modelKey, model); return next; }); }}
          onSettings={openSourceSettings} onMissingSource={() => setMissingSourceHint(true)} /></div>
        {snapshot?.busy ? <button type="button" className="opencode-dock-stop" onClick={() => void perform(api.cancelOpenCodeAgent)} disabled={working}
          title={sourcePreparation?.status === "CREATING" ? "停止對話；Kit 已開始建立流程，結果需完成後查證" : "停止目前工作"}>
          {sourcePreparation?.status === "CREATING" ? "停止對話" : "停止"}</button>
          : <button type="button" className="opencode-dock-primary opencode-dock-send" aria-label="傳送訊息" title="傳送" onClick={() => void send()} disabled={!draft.trim() || working || !projectReady || reloadNeeded || snapshot?.providerReconnectRequired || !snapshot?.connected || !modelSelectionReady}>↑</button>}
      </div></div>
      {snapshot?.busy && draft.trim() && <small className="opencode-dock-draft-note">草稿已保留，回合完成後可傳送</small>}
      {attachments.some((item) => item.mimeType.startsWith("image/")) && <small className="opencode-dock-hint">圖片附件需要所選模型支援視覺輸入。</small>}
    </div>
  </section>;
}
