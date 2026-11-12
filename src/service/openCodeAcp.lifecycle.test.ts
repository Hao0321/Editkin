// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { OpenCodeAcp, type AgentConfigOption } from "./openCodeAcp";
import agentProvenance from "../shared/agentProvenance.json";

vi.mock("node:child_process", () => ({ spawn: vi.fn(), execFile: vi.fn() }));

const model = "local/qwen3.8-27b-nvfp4";
function config(mode = "editkin"): AgentConfigOption[] {
  return [{ id: "mode", name: "Mode", category: "mode", type: "select", currentValue: mode,
    options: ["editkin", "build", "plan", "external-fixture"].map(value => ({ value, name: value })) },
  { id: "model", name: "Model", category: "model", type: "select", currentValue: model, options: [{ value: model, name: model }] }];
}
type Internals = { request: (method: string, params: Record<string, unknown>, timeoutMs: number) => Promise<any>; onLine: (line: string) => void };

describe("Integrated Agent lifecycle", () => {
  let root: string, agent: OpenCodeAcp, kill: ReturnType<typeof vi.fn>;
  let nativeMode: string, rejectProfileRestore: boolean;
  let request: MockInstance<Internals["request"]>;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "editkin-acp-lifecycle-"));
    await writeFile(join(root, process.platform === "win32" ? "opencode.exe" : "opencode"), "isolated fixture; not executed");
    kill = vi.fn(); nativeMode = "editkin"; rejectProfileRestore = false;
    vi.mocked(spawn).mockImplementation(() => Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill,
    }) as unknown as ReturnType<typeof spawn>);
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: null, stdout: string, stderr: string) => void;
      callback(null, "[]", ""); return {} as ReturnType<typeof execFile>;
    });
    agent = new OpenCodeAcp();
    request = vi.spyOn(agent as unknown as Internals, "request").mockImplementation(async (method, params) => {
      if (method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: true } } };
      if (method === "session/list") return { sessions: [{ sessionId: "older", cwd: root }] };
      if (method === "session/new") return { sessionId: "new", configOptions: config(nativeMode) };
      if (method === "session/set_config_option" && params.configId === "mode" && !rejectProfileRestore) nativeMode = String(params.value);
      return { configOptions: config(nativeMode) };
    });
  });
  afterEach(async () => { agent.close(); vi.restoreAllMocks(); vi.clearAllMocks(); await rm(root, { recursive: true, force: true }); });
  const start = () => agent.start({ workspace: root, opencodeExecutable: join(root, process.platform === "win32" ? "opencode.exe" : "opencode") });

  it("starts ACP directly without a second skill-discovery subprocess", async () => {
    await start();
    expect(execFile).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawn).mock.calls[0][1]).toEqual(["acp"]);
  });
  it("reports contribution identity without adding it to conversation events or model requests", async () => {
    expect(agent.status().provenance).toEqual(agentProvenance);
    await start();
    await agent.prompt("provenance-context-fixture");
    expect(agent.status().provenance).toEqual(agentProvenance);
    expect(JSON.stringify(agent.status().events)).not.toContain(agentProvenance.originId);
    expect(JSON.stringify(request.mock.calls)).not.toContain(agentProvenance.originId);
  });
  it("persists provider-neutral history and reads it without native session load or tool replay", async () => {
    const executable = join(root, process.platform === "win32" ? "opencode.exe" : "opencode");
    await agent.start({ workspace: root, historyRoot: join(root, "history"), opencodeExecutable: executable });
    const binding = agent.status().libraryBinding!;
    request.mockClear();
    const notification = (sessionUpdate: string, text: string) => (agent as unknown as Internals).onLine(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "new", update: { sessionUpdate, content: { type: "text", text } } } }));
    notification("user_message_chunk", "回看測試"); notification("agent_message_chunk", "本機回答");
    expect(agent.libraryAction({ schema: "editkin.agent-library/v1", binding, action: "read", sessionId: "new" }).entries).toHaveLength(2);
    expect(request).not.toHaveBeenCalled();
    agent.close();
    await agent.start({ workspace: root, historyRoot: join(root, "history"), opencodeExecutable: executable, resumeSessionId: "new", resumeModel: model });
    expect(agent.libraryAction({ schema: "editkin.agent-library/v1", binding, action: "search", query: "本機回答" }).sessions).toHaveLength(1);
    expect(vi.mocked(spawn).mock.calls[0][2]?.cwd).not.toBe(root);
    expect(request).toHaveBeenCalledWith("session/load", expect.objectContaining({ cwd: vi.mocked(spawn).mock.calls[0][2]?.cwd }), 60_000);
  });
  it("does not adopt another project's vendor conversation even when the runtime lists it", async () => {
    await agent.start({ workspace: root, historyRoot: join(root, "history"), opencodeExecutable: join(root, process.platform === "win32" ? "opencode.exe" : "opencode") });
    request.mockClear();
    await expect(agent.loadSession("older", model)).rejects.toThrow(/不屬於/);
    expect(request).not.toHaveBeenCalled();
  });
  it.each([undefined, "stream-message"])("keeps interleaved plans in the same message and redacts split credentials (%s)", async messageId => {
    await agent.start({ workspace: root, historyRoot: join(root, "history"), opencodeExecutable: join(root, process.platform === "win32" ? "opencode.exe" : "opencode") });
    const binding = agent.status().libraryBinding!;
    const update = (value: Record<string, unknown>) => (agent as unknown as Internals).onLine(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "new", update: value } }));
    update({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: "prefix sk-" } });
    update({ sessionUpdate: "plan", entries: [{ content: "核對字幕", status: "in_progress" }] });
    update({ sessionUpdate: "agent_thought_chunk", messageId: "reasoning", content: { type: "text", text: "HIDDEN_FIXTURE" } });
    update({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: "synthetictail ending" } });
    const messages = agent.status().events.filter(event => event.kind === "message");
    expect(messages).toHaveLength(1); expect(messages[0].text).toBe("prefix sk-synthetictail ending");
    const entries = agent.libraryAction({ schema: "editkin.agent-library/v1", binding, action: "read", sessionId: "new" }).entries!;
    expect(entries.filter(entry => entry.kind === "message")).toHaveLength(1);
    expect(JSON.stringify(entries)).not.toContain("synthetictail");
    expect(JSON.stringify(entries)).not.toContain("HIDDEN_FIXTURE");
    expect(entries[0].text).toBe("prefix [已遮蔽憑證] ending");
  });
  it("adds only enabled personal rules to the shared prompt and keeps the archived user message clean", async () => {
    await agent.start({ workspace: root, historyRoot: join(root, "history"), opencodeExecutable: join(root, process.platform === "win32" ? "opencode.exe" : "opencode") });
    const binding = agent.status().libraryBinding!;
    agent.libraryAction({ schema: "editkin.agent-library/v1", binding, action: "save-extension", extension: {
      schema: "editkin.agent-extension/v1", id: "7bc4dfd4-73cb-4e7c-86c3-9b3c0f82c216", kind: "plugin", name: "本機指引", instructions: "先核對字幕", hooks: ["prompt-context"], enabled: true, visibility: "project" } });
    agent.prompt("只問目前狀態");
    expect(request).toHaveBeenCalledWith("session/prompt", expect.objectContaining({ prompt: [expect.objectContaining({ text: expect.stringContaining("先核對字幕") })] }), 30 * 60_000);
    const archived = agent.libraryAction({ schema: "editkin.agent-library/v1", binding, action: "read", sessionId: "new" }).entries!;
    expect(archived[0].text).toBe("只問目前狀態");
    expect(archived[0].text).not.toContain("先核對字幕");
  });
  it("rejects custom profiles before native configuration is changed", async () => {
    await start(); request.mockClear();
    await expect(agent.setConfigOption("mode", "external-fixture")).rejects.toThrow(/剪輯模式/);
    expect(request).not.toHaveBeenCalled();
    expect(agent.status().configOptions[0].currentValue).toBe("editkin");
    await agent.setConfigOption("mode", "build");
    await agent.setConfigOption("mode", "plan");
    expect(agent.status().configOptions[0].currentValue).toBe("plan");
  });
  it("rejects a non-editing cloud model before either configuration or a prompt reaches ACP", async () => {
    await start();
    const options = config();
    options[1] = { ...options[1], currentValue: "openai/gpt-image-1", options: [{ value: "openai/gpt-image-1", name: "Image only" }] };
    (agent as unknown as Internals).onLine(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "new", update: { sessionUpdate: "config_option_update", configOptions: options } } }));
    request.mockClear();
    expect(() => agent.prompt("Edit this caption")).toThrow(/剪輯模型/);
    await expect(agent.setConfigOption("model", "openai/gpt-image-1")).rejects.toThrow(/不能用於/);
    expect(request).not.toHaveBeenCalled(); expect(agent.status().busy).toBe(false);
  });
  it.each(["new", "load", "resume"])("restores the editing profile for %s conversations", async action => {
    if (action === "resume") {
      nativeMode = "external-fixture";
      await agent.start({ workspace: root, opencodeExecutable: join(root, process.platform === "win32" ? "opencode.exe" : "opencode"), resumeSessionId: "older", resumeModel: model });
    } else {
      await start(); nativeMode = "external-fixture";
      if (action === "load") await agent.loadSession("older", model); else await agent.newSession();
    }
    expect(agent.status().connected).toBe(true);
    expect(agent.status().configOptions[0].currentValue).toBe("editkin");
    expect(request).toHaveBeenCalledWith("session/set_config_option", expect.objectContaining({ configId: "mode", value: "editkin" }), 20_000);
  });
  it("blocks prompts after an unexpected native mode update", async () => {
    await start(); request.mockClear();
    (agent as unknown as Internals).onLine(JSON.stringify({ jsonrpc: "2.0", method: "session/update",
      params: { sessionId: "new", update: { sessionUpdate: "current_mode_update", currentModeId: "external-fixture" } } }));
    expect(() => agent.prompt("Only edit this project")).toThrow(/剪輯模式/);
    expect(request).not.toHaveBeenCalled(); expect(agent.status().busy).toBe(false);
  });
  it("closes startup when the runtime cannot confirm the restored editing profile", async () => {
    nativeMode = "external-fixture"; rejectProfileRestore = true;
    await expect(start()).rejects.toThrow(/剪輯模式/);
    expect(agent.status().connected).toBe(false); expect(kill).toHaveBeenCalledTimes(1);
  });
  it("retains the prior conversation when profile restoration fails during history load", async () => {
    await start(); nativeMode = "external-fixture"; rejectProfileRestore = true;
    await expect(agent.loadSession("older", model)).rejects.toThrow(/剪輯模式/);
    expect(agent.status().sessionId).toBe("new"); expect(agent.status().configOptions[0].currentValue).toBe("editkin");
  });
  it("blocks prompts and configuration while a conversation is being replaced", async () => {
    await start();
    let release!: (result: { sessionId: string; configOptions: AgentConfigOption[] }) => void;
    request.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = agent.newSession();
    expect(() => agent.prompt("Only edit this project")).toThrow(/對話/);
    await expect(agent.setConfigOption("mode", "build")).rejects.toThrow(/對話/);
    release({ sessionId: "replacement", configOptions: config() });
    await pending; expect(agent.status().sessionId).toBe("replacement");
  });
  it("blocks a new turn while history ownership is still being checked", async () => {
    await start();
    let release!: (result: { sessions: { sessionId: string; cwd: string }[] }) => void;
    request.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = agent.loadSession("older", model);
    expect(() => agent.prompt("Only edit this project")).toThrow(/對話/);
    await expect(agent.newSession()).rejects.toThrow(/對話/);
    release({ sessions: [{ sessionId: "older", cwd: root }] });
    await pending; expect(agent.status().sessionId).toBe("older");
  });
});
