// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { mergeAcpToolUpdate, type AgentToolDetail, type AgentToolLocation, type AgentToolState } from "./acpToolContent";
import { readCurrentKitSourcePreparation, requestCurrentKitSourceCancellation } from "../mcp/kitSourceJobs";
import { openCodePromptParts, type OpenCodeAttachment } from "./openCodePrompt";
import { embeddedAgentEnvironment } from "./openCodeEnvironment";
import { isEditingAgentModel, isSupportedAgentModel } from "../application/agentProviders";
import { randomUUID } from "node:crypto";
import { AgentLibraryStore } from "./agentLibraryStore";
import type { AgentLibraryRequest } from "../application/agentLibrary";
import agentProvenance from "../shared/agentProvenance.json";

type Rpc = { jsonrpc: "2.0"; id?: number; method?: string; params?: any; result?: any; error?: { code: number; message: string } };
export type AgentEvent = { seq: number; entryId?: number; kind: "user" | "message" | "thought" | "plan" | "tool" | "permission" | "turn" | "error" | "system"; text?: string; truncated?: boolean; messageId?: string; toolCallId?: string; toolName?: string; toolKind?: string; requestedAction?: string; outcome?: string; status?: string; projectChanged?: boolean; details?: AgentToolDetail[]; locations?: AgentToolLocation[]; requestId?: number; options?: { optionId: string; name: string; kind: string }[]; entries?: { content: string; status: string }[] };
export type AgentConfigOption = { id: string; name: string; category?: string; type: "select"; currentValue: string; options: Array<{ value: string; name: string; description?: string }> };
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

const editingModes = new Set(["editkin", "build", "plan"]);
function projectFingerprint(path?: string) {
  if (!path) return undefined;
  try { const value = statSync(path, { bigint: true }); return `${value.size}:${value.mtimeNs}`; }
  catch { return "missing"; }
}

export class OpenCodeAcp {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private permissions = new Map<number, { options: { optionId: string; name: string; kind: string }[] }>();
  private toolStates = new Map<string, AgentToolState>();
  private events: AgentEvent[] = [];
  private seq = 0;
  private entryId = 0;
  private discardedSeq = 0;
  private id = 0;
  private stdout = "";
  private sessionId?: string;
  private workspace?: string;
  private acpCwd?: string;
  private library?: AgentLibraryStore;
  private archiveEpoch = randomUUID();
  private archiveError?: string;
  private projectPath?: string;
  private mcpToolCount?: number;
  private skills: string[] = [];
  private busy = false;
  private starting = false;
  private switchingSession = false;
  private loadingSessionId?: string;
  private generation = 0;
  private capabilities: any;
  private configOptions: AgentConfigOption[] = [];
  private commands: { name: string; description: string; hint?: string }[] = [];
  private title?: string;
  private usage?: { used: number; size: number };
  private mcp?: { command: string; args: string[]; env: { name: string; value: string }[] };

  private resetConversation() {
    this.library?.finishTurn();
    this.archiveEpoch = randomUUID();
    this.events = []; this.seq = 0; this.entryId = 0; this.discardedSeq = 0; this.toolStates = new Map(); this.commands = []; this.title = undefined; this.usage = undefined;
  }

  private assertEditingMode() {
    const mode = this.configOptions.find(option => option.category === "mode" || option.id === "mode");
    if (!mode || mode.type !== "select" || !editingModes.has(mode.currentValue)) throw new Error("Agent 尚未確認剪輯模式，請重新連線");
  }
  private async confirmEditingMode() {
    const mode = this.configOptions.find(option => option.category === "mode" || option.id === "mode");
    if (mode?.type === "select" && !editingModes.has(mode.currentValue) && Array.isArray(mode.options) && mode.options.some(option => option.value === "editkin")) {
      const configured = await this.request("session/set_config_option", { sessionId: this.sessionId, configId: mode.id, value: "editkin" }, 20_000);
      this.configOptions = Array.isArray(configured?.configOptions) ? configured.configOptions : [];
    }
    this.assertEditingMode();
  }

  private archive(event: AgentEvent, text = event.text || "", append = false) {
    if (!this.library || !this.sessionId || this.switchingSession || this.starting) return;
    try { this.library.record(this.sessionId, `${this.archiveEpoch}:${event.entryId}`, event.kind, text, event.status, append); }
    catch { this.archiveError = "本機對話紀錄儲存失敗；請檢查磁碟空間與目錄權限，再重新連線。"; }
  }
  private registerSession() {
    if (this.sessionId) this.library?.session(this.sessionId, this.title, this.configOptions.find(option => option.id === "model")?.currentValue);
  }
  libraryAction(request: AgentLibraryRequest) {
    if (!this.library) throw Error("本機對話紀錄尚未準備好，請先連線目前專案");
    if (request.action === "save-extension" && (this.busy || this.starting || this.switchingSession)) throw Error("請等目前回合完成再修改個人指引");
    return this.library.action(request);
  }
  private emit(event: Omit<AgentEvent, "seq">, archiveText?: string) {
    if (event.kind === "turn") this.library?.finishTurn();
    this.events.push({ ...event, entryId: ++this.entryId, seq: ++this.seq });
    this.archive(this.events.at(-1)!, archiveText ?? (event.entries?.map(item => `${item.status}：${item.content}`).join("\n") || event.text || ""));
    if (this.events.length > 500) this.discardedSeq = Math.max(this.discardedSeq, this.events.shift()!.seq);
  }
  private emitChunk(kind: "message" | "thought" | "user", text: string, messageId?: string) {
    let last = this.events.at(-1);
    // Plans/reasoning can arrive between chunks of one ACP message. Keep its
    // stable archive entry so redaction still sees the complete token prefix.
    // Without a message ID, a tool or a new turn ends the contiguous message.
    if (kind !== "user") for (let at = this.events.length - 1; at >= 0; at--) {
      const candidate = this.events[at];
      if (candidate.kind === "user" || candidate.kind === "turn" || candidate.kind === "error") break;
      if (messageId === undefined && candidate.kind === "tool") break;
      if (candidate.kind === kind && candidate.messageId === messageId) { last = candidate; break; }
    }
    if (last?.kind === kind && last.messageId === messageId) {
      this.archive(last, text, true);
      const limit = 100_000;
      if (!last.truncated) {
        const combined = (last.text || "") + text;
        if (combined.length > limit) {
          last.text = combined.slice(0, limit) + "\n\n[側欄顯示已達 100,000 字元；完整對話保存在 Agent session]";
          last.truncated = true;
        } else last.text = combined;
      }
      last.seq = ++this.seq;
    } else this.emit({ kind, messageId, text: text.slice(0, 100_000), truncated: text.length > 100_000 }, text);
  }
  private emitPlan(entries: { content: string; status: string }[]) {
    let index = -1;
    for (let at = this.events.length - 1; at >= 0; at--) {
      if (this.events[at].kind === "user" || this.events[at].kind === "turn") break;
      if (this.events[at].kind === "plan") { index = at; break; }
    }
    if (index < 0) this.emit({ kind: "plan", entries });
    else { this.events[index] = { ...this.events[index], entries, seq: ++this.seq }; this.archive(this.events[index], entries.map(item => `${item.status}：${item.content}`).join("\n")); }
  }
  private emitTool(tool: AgentToolState) {
    let index = -1;
    if (tool.toolCallId) for (let at = this.events.length - 1; at >= 0; at--) {
      if (this.events[at].kind === "tool" && this.events[at].toolCallId === tool.toolCallId) { index = at; break; }
    }
    if (index < 0) this.emit({ kind: "tool", ...tool });
    else { this.events[index] = { ...this.events[index], kind: "tool", ...tool, seq: ++this.seq }; this.archive(this.events[index]); }
  }
  private write(value: Rpc) {
    if (!this.child || !this.child.stdin.writable) throw new Error("Agent ACP 已中斷");
    this.child.stdin.write(JSON.stringify(value) + "\n");
  }
  private request(method: string, params: any, timeoutMs: number): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 逾時`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  private onLine(line: string) {
    let frame: Rpc;
    try { frame = JSON.parse(line) as Rpc; } catch { this.emit({ kind: "error", text: "Agent ACP 回傳非 JSON-RPC 訊息" }); this.close(); return; }
    if (frame.jsonrpc !== "2.0") { this.emit({ kind: "error", text: "Agent ACP 協定格式不正確" }); this.close(); return; }
    if (typeof frame.id === "number" && !frame.method) {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(frame.id);
      if (frame.error) pending.reject(new Error(String(frame.error.message || "Agent ACP 呼叫失敗")));
      else pending.resolve(frame.result);
      return;
    }
    if (frame.method === "session/request_permission" && typeof frame.id === "number") {
      if (frame.params?.sessionId !== this.sessionId) return;
      const raw = Array.isArray(frame.params?.options) ? frame.params.options : [];
      const options = raw.filter((value: any) => typeof value?.optionId === "string")
        .map((value: any) => ({ optionId: value.optionId, name: String(value.name || value.optionId).slice(0, 120), kind: String(value.kind || "other") }));
      this.permissions.set(frame.id, { options });
      const tool = mergeAcpToolUpdate(frame.params?.toolCall, this.toolStates.get(String(frame.params?.toolCall?.toolCallId || "")));
      this.emit({ kind: "permission", requestId: frame.id, text: tool.text, toolCallId: tool.toolCallId,
        toolName: tool.toolName, toolKind: tool.toolKind, requestedAction: tool.requestedAction, details: tool.details, locations: tool.locations, options });
      return;
    }
    if (frame.method === "session/update") {
      if (this.switchingSession ? frame.params?.sessionId !== this.loadingSessionId : this.sessionId && frame.params?.sessionId !== this.sessionId) return;
      const update = frame.params?.update;
      if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text")
        this.emitChunk("message", String(update.content.text), update.messageId);
      else if (update?.sessionUpdate === "user_message_chunk" && update.content?.type === "text") {
        if (this.busy) return;
        const raw = String(update.content.text);
        this.emitChunk("user", (raw.includes("\n\n使用者：") ? raw.slice(raw.lastIndexOf("\n\n使用者：") + 6) : raw).slice(0, 12_000), update.messageId);
      }
      else if (update?.sessionUpdate === "agent_thought_chunk" && update.content?.type === "text")
        this.emitChunk("thought", String(update.content.text).slice(0, 16_000), update.messageId);
      else if (update?.sessionUpdate === "plan" && Array.isArray(update.entries))
        this.emitPlan(update.entries.slice(0, 40).map((entry: any) => ({ content: String(entry.content || "").slice(0, 500), status: String(entry.status || "pending") })));
      else if (update?.sessionUpdate === "tool_call" || update?.sessionUpdate === "tool_call_update") {
        const toolCallId = String(update.toolCallId || "");
        const tool = mergeAcpToolUpdate(update, this.toolStates.get(toolCallId));
        this.toolStates.set(toolCallId, tool);
        this.emitTool(tool);
        if (["completed", "failed", "cancelled"].includes(tool.status)) this.toolStates.delete(toolCallId);
      }
      else if (update?.sessionUpdate === "config_option_update" && Array.isArray(update.configOptions)) this.configOptions = update.configOptions;
      else if (update?.sessionUpdate === "available_commands_update" && Array.isArray(update.availableCommands))
        this.commands = update.availableCommands.slice(0, 100).filter((command: any) => typeof command?.name === "string")
          .map((command: any) => ({ name: String(command.name).slice(0, 80), description: String(command.description || "").slice(0, 300), hint: typeof command.input?.hint === "string" ? command.input.hint.slice(0, 120) : undefined }));
      else if (update?.sessionUpdate === "session_info_update" && typeof update.title === "string") { this.title = update.title.slice(0, 200); if (!this.switchingSession && !this.starting) { try { this.registerSession(); } catch { this.archiveError = "無法更新本機對話紀錄，請重新連線。"; } } }
      else if (update?.sessionUpdate === "current_mode_update" && typeof update.currentModeId === "string")
        this.configOptions = this.configOptions.map((option) => option.category === "mode" || option.id === "mode" ? { ...option, currentValue: update.currentModeId } : option);
      else if (update?.sessionUpdate === "usage_update" && Number.isFinite(update.used) && Number.isFinite(update.size) && update.size > 0) {
        this.usage = { used: update.used, size: update.size };
      }
      return;
    }
    if (frame.method && typeof frame.id === "number") {
      this.write({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: `Client does not implement ${frame.method}` } });
      this.emit({ kind: "error", text: `Agent 要求未支援的 client 方法：${frame.method}` });
    }
  }
  private fail(message: string, kind: AgentEvent["kind"] = "error") {
    this.library?.finishTurn();
    this.emit({ kind, text: message });
    for (const [id, pending] of this.pending) { clearTimeout(pending.timer); pending.reject(new Error(message)); this.pending.delete(id); }
    for (const requestId of this.permissions.keys()) {
      try { this.write({ jsonrpc: "2.0", id: requestId, result: { outcome: { outcome: "cancelled" } } }); } catch { /* process already closed */ }
    }
    this.permissions.clear(); this.busy = false; this.sessionId = undefined;
  }
  async start(options: { workspace: string; projectPath?: string; historyRoot?: string; opencodeExecutable: string; modelOrigin?: string; providerConfigPath?: string; mcpToolCount?: number; mcp?: { command: string; args: string[]; env: { name: string; value: string }[] }; resumeSessionId?: string; resumeModel?: string }) {
    if (this.child || this.starting) throw new Error("內建 Agent 已啟動或正在啟動；請先結束目前 session");
    this.starting = true;
    const generation = ++this.generation;
    try {
    this.resetConversation(); this.stdout = ""; this.configOptions = []; this.capabilities = undefined;
    if (!isAbsolute(options.workspace) || !existsSync(options.workspace)) throw new Error("Agent 工作資料夾不存在");
    if (options.projectPath && (!isAbsolute(options.projectPath) || !existsSync(options.projectPath))) throw new Error("Agent 專案檔不存在");
    this.library?.close(); this.library = undefined; this.archiveError = undefined;
    if (options.historyRoot) this.library = new AgentLibraryStore(options.historyRoot, options.workspace, options.projectPath);
    this.acpCwd = this.library?.cwd || options.workspace;
    if (options.projectPath && (!options.mcp || !isAbsolute(options.mcp.command) || !existsSync(options.mcp.command) || !isAbsolute(options.mcp.args[0] || "") || !existsSync(options.mcp.args[0]))) throw new Error("Editkin MCP launcher 不完整");
    const executable = options.opencodeExecutable;
    if (!isAbsolute(executable) || basename(executable).toLowerCase() !== (process.platform === "win32" ? "opencode.exe" : "opencode") || !existsSync(executable))
      throw new Error("剪輯台內建 Agent runtime 缺失或路徑不正確");
    const embeddedEnv = embeddedAgentEnvironment(options.modelOrigin, options.providerConfigPath, true);
    // Editing uses the bound MCP tools; native skill discovery is disabled in this profile.
    this.skills = [];
    if (generation !== this.generation) throw new Error("Agent 連線已取消");
    const child = spawn(executable, ["acp"], { cwd: this.acpCwd, env: embeddedEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child; this.workspace = options.workspace; this.projectPath = options.projectPath; this.mcpToolCount = options.mcpToolCount; this.mcp = options.mcp;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (generation !== this.generation) return;
      this.stdout += chunk;
      if (this.stdout.length > 2_000_000) { this.emit({ kind: "error", text: "Agent ACP 單行輸出超過限制" }); this.close(); return; }
      for (;;) { if (generation !== this.generation) break; const index = this.stdout.indexOf("\n"); if (index < 0) break; const line = this.stdout.slice(0, index).trim(); this.stdout = this.stdout.slice(index + 1); if (line) this.onLine(line); }
    });
    child.stderr.on("data", () => undefined); // Never expose potentially sensitive CLI diagnostics.
    child.stdin.on("error", (error) => { if (generation === this.generation) { this.emit({ kind: "error", text: `Agent ACP 輸入已中斷：${error.message}` }); this.close(); } });
    child.on("error", (error) => { if (generation === this.generation) this.fail(`Agent 無法啟動：${error.message}`); });
    child.on("exit", (code) => { if (generation === this.generation) { this.child = undefined; this.fail(`Agent 已結束（${code ?? "unknown"}）`); } });
    try {
      const initialized = await this.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "editkin", title: "Editkin Agent Dock", version: "0.1.0" } }, 20_000);
      if (initialized?.protocolVersion !== 1) throw new Error("Agent ACP 版本不相容");
      this.capabilities = initialized.agentCapabilities;
      const sessionParams = { cwd: this.acpCwd, mcpServers: options.mcp ? [{ name: "editkin", ...options.mcp }] : [] };
      let session: any;
      if (options.resumeSessionId && options.resumeModel && initialized.agentCapabilities?.loadSession) {
        if (this.library ? !this.library.owns(options.resumeSessionId) : initialized.agentCapabilities?.sessionCapabilities?.list && !(await this.listSessions()).some((item) => item.sessionId === options.resumeSessionId))
          throw new Error("舊對話不屬於目前 Agent 工作資料夾");
        await this.request("session/load", { ...sessionParams, sessionId: options.resumeSessionId }, 60_000);
        session = { sessionId: options.resumeSessionId };
        if (!isSupportedAgentModel(options.resumeModel)) throw new Error("舊 session 的模型來源不在支援清單");
        const restored = await this.request("session/set_config_option", { sessionId: options.resumeSessionId, configId: "model", value: options.resumeModel }, 20_000);
        if (!Array.isArray(restored?.configOptions)) throw new Error("Agent 無法恢復舊 session 模型設定");
        this.configOptions = restored.configOptions;
      } else session = await this.request("session/new", sessionParams, 60_000);
      if (typeof session?.sessionId !== "string" || !session.sessionId) throw new Error("Agent 未回傳 session ID");
      this.sessionId = session.sessionId;
      if (Array.isArray(session.configOptions)) this.configOptions = session.configOptions;
      await this.confirmEditingMode();
      this.registerSession();
      return this.status(0);
    } catch (error) { if (generation === this.generation) this.close(); throw error; }
    } finally { this.starting = false; }
  }
  prompt(text: string, projectPath?: string, displayText?: string, attachments: OpenCodeAttachment[] = []) {
    if (!this.sessionId || !this.child) throw new Error("內建 Agent 尚未啟動");
    if (this.starting || this.switchingSession) throw new Error("Agent 正在載入對話，請稍候");
    this.assertEditingMode();
    if (projectPath !== this.projectPath) throw new Error("目前專案已切換；請先結束舊 Agent session，再連線新專案");
    const model = this.configOptions.find((option) => option.category === "model" || option.id === "model")?.currentValue;
    if (!model || !isEditingAgentModel(model)) throw new Error("請選擇可處理文字與工具的剪輯模型，並完成對應供應商設定");
    if (this.busy) throw new Error("上一則訊息仍在執行");
    if (this.archiveError) throw Error(this.archiveError);
    if (!text.trim() || text.length > 12_000) throw new Error("訊息須為 1–12000 字");
    const prompt = openCodePromptParts(`${text}${this.library?.promptContext() || ""}`, attachments);
    const beforeProject = projectFingerprint(this.projectPath);
    this.busy = true; this.emit({ kind: "user", text: `${(displayText || text).slice(0, 12_000)}${attachments.length ? `\n📎 ${attachments.map((item) => item.name).join("、")}` : ""}` });
    const generation = this.generation;
    void this.request("session/prompt", { sessionId: this.sessionId, prompt }, 30 * 60_000)
      .then((result) => { if (generation === this.generation) { this.busy = false; this.emit({ kind: "turn", status: String(result?.stopReason || "end_turn"),
        projectChanged: Boolean(this.projectPath && beforeProject !== projectFingerprint(this.projectPath)) }); } })
      .catch((error) => {
        if (generation !== this.generation) return;
        this.emit({ kind: "turn", status: "error", projectChanged: Boolean(this.projectPath && beforeProject !== projectFingerprint(this.projectPath)) });
        if (error instanceof Error && error.message === "session/prompt 逾時") {
          this.emit({ kind: "error", text: "Agent 回合逾時，執行結果可能不明；已結束連線。若剛執行 apply，先核對 Kit run 狀態，勿直接重試。" });
          this.close();
          return;
        }
        this.busy = false;
        this.library?.finishTurn();
        this.emit({ kind: "error", text: error instanceof Error ? error.message : String(error) });
      });
    return this.status(this.seq - 1);
  }
  async listSessions() {
    if (!this.child || !this.workspace) throw new Error("內建 Agent 尚未啟動");
    if (this.library) return this.library.action({ schema: "editkin.agent-library/v1", binding: this.library.scope, action: "search" }).sessions || [];
    if (!this.capabilities?.sessionCapabilities?.list) return [];
    const sessions: { sessionId: string; title?: string; updatedAt?: string }[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 4; page++) {
      const result = await this.request("session/list", { cwd: this.workspace, ...(cursor ? { cursor } : {}) }, 20_000);
      for (const item of Array.isArray(result?.sessions) ? result.sessions : [])
        if (item.cwd === this.workspace && typeof item.sessionId === "string") sessions.push({ sessionId: item.sessionId, title: typeof item.title === "string" ? item.title.slice(0, 160) : undefined, updatedAt: item.updatedAt });
      if (!result?.nextCursor || sessions.length >= 80) break;
      cursor = result.nextCursor;
    }
    return sessions.slice(0, 80);
  }
  async newSession() {
    if (!this.child || !this.workspace || !this.sessionId || this.busy || this.starting || this.switchingSession) throw new Error("Agent 正在執行、載入對話或尚未啟動");
    const priorModel = this.configOptions.find((option) => option.id === "model")?.currentValue;
    const previous = { archiveEpoch: this.archiveEpoch, events: this.events, seq: this.seq, entryId: this.entryId, discardedSeq: this.discardedSeq, tools: this.toolStates, commands: this.commands, title: this.title, usage: this.usage, sessionId: this.sessionId, configOptions: this.configOptions };
    this.resetConversation();
    this.switchingSession = true;
    this.loadingSessionId = undefined;
    try {
      const result = await this.request("session/new", { cwd: this.acpCwd, mcpServers: this.mcp ? [{ name: "editkin", ...this.mcp }] : [] }, 60_000);
      if (typeof result?.sessionId !== "string") throw new Error("Agent 未回傳新 session ID");
      this.sessionId = result.sessionId;
      this.configOptions = Array.isArray(result.configOptions) ? result.configOptions : [];
      if (priorModel && isSupportedAgentModel(priorModel) && this.configOptions.find((option) => option.id === "model")?.options.some((option) => option.value === priorModel)) {
        const configured = await this.request("session/set_config_option", { sessionId: this.sessionId, configId: "model", value: priorModel }, 20_000);
        if (Array.isArray(configured?.configOptions)) this.configOptions = configured.configOptions;
      }
      await this.confirmEditingMode();
      this.registerSession();
      return this.status(0);
    } catch (error) {
      this.archiveEpoch = previous.archiveEpoch; this.events = previous.events; this.seq = previous.seq; this.entryId = previous.entryId; this.discardedSeq = previous.discardedSeq; this.toolStates = previous.tools; this.commands = previous.commands;
      this.title = previous.title; this.usage = previous.usage; this.sessionId = previous.sessionId; this.configOptions = previous.configOptions;
      throw error;
    } finally { this.switchingSession = false; this.loadingSessionId = undefined; }
  }
  async loadSession(sessionId: string, model: string) {
    if (!this.child || !this.workspace || !this.sessionId || this.busy || this.starting || this.switchingSession || !this.capabilities?.loadSession) throw new Error("Agent 無法載入對話");
    if (!sessionId || sessionId.length > 256 || /[\x00-\x1f]/.test(sessionId)) throw new Error("Agent session ID 不合法");
    if (!isSupportedAgentModel(model)) throw new Error("恢復模型必須是支援的供應商來源");
    const previous = { archiveEpoch: this.archiveEpoch, events: this.events, seq: this.seq, entryId: this.entryId, discardedSeq: this.discardedSeq, tools: this.toolStates, commands: this.commands, title: this.title, usage: this.usage, sessionId: this.sessionId, configOptions: this.configOptions };
    this.switchingSession = true;
    this.loadingSessionId = sessionId;
    try {
      if (this.library ? !this.library.owns(sessionId) : !this.capabilities?.sessionCapabilities?.list || !(await this.listSessions()).some((session) => session.sessionId === sessionId))
        throw new Error("這段對話不屬於目前 Agent 工作資料夾");
      this.resetConversation();
      const result = await this.request("session/load", { sessionId, cwd: this.acpCwd, mcpServers: this.mcp ? [{ name: "editkin", ...this.mcp }] : [] }, 60_000);
      this.sessionId = sessionId;
      if (Array.isArray(result?.configOptions)) this.configOptions = result.configOptions;
      const configured = await this.request("session/set_config_option", { sessionId, configId: "model", value: model }, 20_000);
      if (Array.isArray(configured?.configOptions)) this.configOptions = configured.configOptions;
      await this.confirmEditingMode();
      this.registerSession();
      return this.status(0);
    } catch (error) {
      this.archiveEpoch = previous.archiveEpoch; this.events = previous.events; this.seq = previous.seq; this.entryId = previous.entryId; this.discardedSeq = previous.discardedSeq; this.toolStates = previous.tools; this.commands = previous.commands;
      this.title = previous.title; this.usage = previous.usage; this.sessionId = previous.sessionId; this.configOptions = previous.configOptions;
      throw error;
    } finally { this.switchingSession = false; this.loadingSessionId = undefined; }
  }
  async setConfigOption(configId: string, value: string) {
    if (!this.sessionId) throw new Error("內建 Agent 尚未啟動");
    if (this.starting || this.switchingSession) throw new Error("Agent 正在載入對話，請稍候");
    if (this.busy) throw new Error("請等目前回合完成再切換模型或模式");
    const option = this.configOptions.find((item) => item.id === configId && item.type === "select");
    if (!option || !option.options.some((item) => item.value === value)) throw new Error("Agent 設定選項不合法");
    if ((option.category === "mode" || option.id === "mode") && !editingModes.has(value)) throw new Error("內部 Agent 只能使用剪輯模式");
    if ((option.category === "model" || option.id === "model") && !isEditingAgentModel(value)) throw new Error("此模型不能用於文字與工具剪輯，請選擇其他模型");
    const result = await this.request("session/set_config_option", { sessionId: this.sessionId, configId, value }, 20_000);
    if (!Array.isArray(result?.configOptions)) throw new Error("Agent 未回傳更新後的模型設定");
    this.configOptions = result.configOptions;
    this.assertEditingMode();
    this.registerSession();
    this.emit({ kind: "system", text: `${option.name} 已切換` });
    return this.status(this.seq - 1);
  }
  respondPermission(requestId: number, optionId?: string) {
    const pending = this.permissions.get(requestId);
    if (!pending) throw new Error("這項授權要求已失效");
    if (optionId && !pending.options.some((option) => option.optionId === optionId)) throw new Error("授權選項不合法");
    this.write({ jsonrpc: "2.0", id: requestId, result: { outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } } });
    this.permissions.delete(requestId);
    this.emit({ kind: "system", text: optionId ? "已回覆工具授權" : "已拒絕工具授權" });
    return this.status(this.seq - 1);
  }
  cancel() {
    const sourceCancellation = requestCurrentKitSourceCancellation(this.workspace, this.projectPath);
    if (!this.sessionId || !this.busy) {
      if (sourceCancellation) this.emit({ kind: "system", text: "已要求停止素材準備" });
      return this.status(sourceCancellation ? this.seq - 1 : this.seq);
    }
    for (const requestId of [...this.permissions.keys()]) this.respondPermission(requestId);
    this.write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.sessionId } });
    this.emit({ kind: "system", text: sourceCancellation ? "已要求停止對話與素材準備" : "已要求取消目前回合，等待 Agent 回覆" });
    return this.status(this.seq - 1);
  }
  close() {
    ++this.generation;
    this.switchingSession = false;
    if (this.child) { this.child.stdin.end(); this.child.kill(); this.child = undefined; }
    this.fail("內建 Agent 已結束", "system");
    this.library?.close(); this.library = undefined;
    return this.status(0);
  }
  status(afterSeq = 0) { return { connected: Boolean(this.sessionId && this.child), busy: this.busy, sessionId: this.sessionId, title: this.title, usage: this.usage, workspace: this.workspace, projectPath: this.projectPath, mcpToolCount: this.mcpToolCount, skills: this.skills,
    sourcePreparation: readCurrentKitSourcePreparation(this.workspace, this.projectPath),
    provenance: agentProvenance,
    historyAvailable: Boolean(this.library), libraryBinding: this.library?.scope, archiveError: this.archiveError,
    loadSession: Boolean(this.capabilities?.loadSession), listSession: Boolean(this.library || this.capabilities?.sessionCapabilities?.list), commands: this.commands, configOptions: this.configOptions, pendingPermissionIds: [...this.permissions.keys()], seq: this.seq,
    historyTruncated: afterSeq < this.discardedSeq,
    events: this.events.filter((event) => event.seq > afterSeq) }; }
}

export const openCodeAcp = new OpenCodeAcp();
