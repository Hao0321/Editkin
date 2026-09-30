// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeAcp } from "./openCodeAcp";
import { KitSourceJobs } from "../mcp/kitSourceJobs";
import { mergeAgentEventUpdates } from "../ui/agentEventLog";

function update(agent: OpenCodeAcp, payload: Record<string, unknown>) {
  (agent as unknown as { onLine: (line: string) => void }).onLine(JSON.stringify({
    jsonrpc: "2.0", method: "session/update", params: { sessionId: "review-session", update: payload },
  }));
}

describe("OpenCode ACP event display", () => {
  it("polls the current source job and stops preparation even after the Agent turn is idle", async () => {
    const root = await mkdtemp(join(tmpdir(), "editkin-source-acp-"));
    try {
      const workspace = join(root, "workspace"), imports = join(root, "imports");
      await mkdir(workspace); await mkdir(imports);
      const project = join(workspace, "movie.editkin.json"), source = join(imports, "original.mp4");
      await writeFile(project, "{}"); await writeFile(source, "synthetic source");
      const facts = await stat(source);
      let controllerStarted = false;
      const jobs = new KitSourceJobs(workspace, project, async (_input, options) => {
        for (let index = 0; index < 100; index++) {
          options.onProgress?.({ phase: "hashing", sourceIndex: 1, sourceCount: 1, bytesDone: index, bytesTotal: 100 });
          await new Promise(resolve => setTimeout(resolve, 10));
          options.signal?.throwIfAborted();
        }
        options.onControllerStart(); controllerStarted = true;
        return { run_dir: join(workspace, "run") };
      });
      const started = jobs.start({ command: "create" }, [{ path: source, bytes: facts.size, mtimeMs: facts.mtimeMs }]);
      const agent = new OpenCodeAcp();
      Object.assign(agent, { workspace, projectPath: project });
      expect(agent.status(0).sourcePreparation).toMatchObject({ status: "PREPARING", preparationId: started.preparationId });
      expect(agent.cancel().sourcePreparation?.status).toBe("CANCELLING");
      let stopped = false;
      for (let index = 0; index < 100; index++) {
        if (jobs.status(started.preparationId).status === "CANCELLED") { stopped = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(stopped).toBe(true);
      expect(controllerStarted).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("keeps a long streamed answer as one revisable row without losing its beginning", () => {
    const agent = new OpenCodeAcp();
    (agent as unknown as { sessionId: string }).sessionId = "review-session";
    update(agent, { sessionUpdate: "agent_message_chunk", messageId: "answer", content: { type: "text", text: "start:" } });
    const initial = structuredClone(agent.status(0).events);
    for (let index = 0; index < 800; index++)
      update(agent, { sessionUpdate: "agent_message_chunk", messageId: "answer", content: { type: "text", text: String(index % 10) } });
    const latest = agent.status(1);
    expect(latest.historyTruncated).toBe(false);
    expect(latest.events).toHaveLength(1);
    expect(latest.events[0].text).toMatch(/^start:/);
    expect(latest.events[0].text).toHaveLength(806);
    expect(latest.events[0].entryId).toBe(initial[0].entryId);
    expect(mergeAgentEventUpdates(initial, structuredClone(latest.events))).toEqual(latest.events);
  });

  it("updates a tool card in place and reports only genuinely dropped entries", () => {
    const agent = new OpenCodeAcp();
    (agent as unknown as { sessionId: string }).sessionId = "review-session";
    update(agent, { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "讀取素材", status: "pending" });
    const initial = structuredClone(agent.status(0).events);
    update(agent, { sessionUpdate: "tool_call_update", toolCallId: "tool-1", title: "讀取完成", status: "completed" });
    const latest = agent.status(1);
    expect(latest.events).toHaveLength(1);
    expect(latest.events[0]).toMatchObject({ entryId: initial[0].entryId, status: "completed", text: "讀取完成" });
    expect(mergeAgentEventUpdates(initial, structuredClone(latest.events))).toEqual(latest.events);
    for (let index = 0; index < 501; index++)
      update(agent, { sessionUpdate: "tool_call", toolCallId: `tool-${index + 2}`, title: "下一個工具", status: "pending" });
    expect(agent.status(0).historyTruncated).toBe(true);
    expect(agent.status(3).historyTruncated).toBe(false);
  });

  it("revises the active plan instead of consuming the conversation window", () => {
    const agent = new OpenCodeAcp();
    (agent as unknown as { sessionId: string }).sessionId = "review-session";
    for (let index = 0; index < 700; index++)
      update(agent, { sessionUpdate: "plan", entries: [{ content: `步驟 ${index}`, status: "in_progress" }] });
    const status = agent.status(0);
    expect(status.historyTruncated).toBe(false);
    expect(status.events).toHaveLength(1);
    expect(status.events[0].entries?.[0].content).toBe("步驟 699");
  });

  it("retains the highest dropped sequence after an old tool is revised", () => {
    const agent = new OpenCodeAcp();
    (agent as unknown as { sessionId: string }).sessionId = "review-session";
    for (let index = 0; index < 499; index++)
      update(agent, { sessionUpdate: "tool_call", toolCallId: `tool-${index}`, title: "工具", status: "pending" });
    update(agent, { sessionUpdate: "tool_call_update", toolCallId: "tool-0", title: "完成", status: "completed" });
    update(agent, { sessionUpdate: "tool_call", toolCallId: "tool-499", title: "工具", status: "pending" });
    update(agent, { sessionUpdate: "tool_call", toolCallId: "tool-500", title: "工具", status: "pending" });
    expect(agent.status(499).historyTruncated).toBe(true);
  });
});
