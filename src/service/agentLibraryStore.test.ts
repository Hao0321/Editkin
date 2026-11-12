// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { AgentLibraryStore } from "./agentLibraryStore";
import { AGENT_EXTENSION_SCHEMA, AGENT_LIBRARY_SCHEMA, type AgentExtension, type AgentLibraryRequest } from "../application/agentLibrary";

describe("local Agent library isolation and extension contract", () => {
  let root: string, a: AgentLibraryStore, b: AgentLibraryStore;
  const request = (store: AgentLibraryStore, input: Omit<AgentLibraryRequest, "schema" | "binding">) => store.action({ schema: AGENT_LIBRARY_SCHEMA, binding: store.scope, ...input } as AgentLibraryRequest);
  const extension = (overrides: Partial<AgentExtension> = {}): AgentExtension => ({ schema: AGENT_EXTENSION_SCHEMA, id: randomUUID(), kind: "skill", name: "剪輯規則", instructions: "先確認字幕與畫面。", hooks: ["prompt-context"], enabled: false, visibility: "project", ...overrides });
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "editkin-agent-library-test-"));
    for (const name of ["a.json", "b.json"]) await writeFile(join(root, name), "{}");
    a = new AgentLibraryStore(join(root, "data"), root, join(root, "a.json"));
    b = new AgentLibraryStore(join(root, "data"), root, join(root, "b.json"));
    a.session("a", "字幕修正", "local/model"); b.session("b", "其他專案", "api/model");
  });
  afterEach(async () => { a.close(); b.close(); await rm(root, { recursive: true, force: true }); });
  it("isolates projects in the same folder and rejects stale bindings and foreign session IDs", () => {
    expect(a.cwd).not.toBe(b.cwd); a.record("a", "1", "user", "私人字幕工作");
    expect(request(b, { action: "search", query: "私人" } as any).sessions).toEqual([]);
    for (const action of ["read", "draft"] as const) expect(() => request(b, { action, sessionId: "a" } as any)).toThrow(/不屬於/);
    expect(() => b.action({ schema: AGENT_LIBRARY_SCHEMA, binding: a.scope, action: "search" })).toThrow(/已切換/);
    expect(() => a.action({ schema: AGENT_LIBRARY_SCHEMA, binding: a.scope, action: "read", sessionId: "../history.sqlite" })).toThrow(/不屬於/);
  });
  it("keeps more than 80 conversations searchable and pages entries without replay", () => {
    for (let n = 0; n < 101; n++) { a.session(`s${n}`); a.record(`s${n}`, "1", "user", `片段 ${n} special-${n}`); }
    expect(request(a, { action: "search", query: "special-100" } as any).sessions?.[0].sessionId).toBe("s100");
    expect(request(a, { action: "search" }).nextOffset).toBe(20);
    for (let n = 0; n < 25; n++) a.record("a", String(n), "message", `答案${n}`);
    expect(request(a, { action: "read", sessionId: "a" } as any).entries).toHaveLength(20);
    expect(request(a, { action: "read", sessionId: "a", offset: 20 } as any).entries).toHaveLength(5);
    expect(() => a.owns("s100")).not.toThrow();
  }, 15_000);
  it("survives a service restart, preserves large stream text, and does not duplicate updates", () => {
    a.record("a", "stream", "message", "字幕".repeat(55_000));
    a.record("a", "stream", "message", "結尾", undefined, true);
    a.record("a", "tool", "tool", "完成", "completed");
    a.record("a", "tool", "tool", "已核對", "completed");
    a.close(); a = new AgentLibraryStore(join(root, "data"), root, join(root, "a.json"));
    const rows = request(a, { action: "read", sessionId: "a" } as any).entries!;
    expect(rows).toHaveLength(2); expect(rows[0].truncated).toBe(true);
    expect(request(a, { action: "search", query: "結尾" } as any).sessions).toHaveLength(1);
    expect(rows[1].text).toBe("已核對");
  });
  it("redacts credentials even across chunks and omits hidden thoughts and permissions", () => {
    a.record("a", "token", "message", "sk-"); a.record("a", "token", "message", "synthetic".repeat(8), undefined, true);
    a.record("a", "bearer", "user", "Bearer " + "fixture".repeat(8));
    a.record("a", "url", "user", "https://fixture.invalid/?access_token=" + "fixture".repeat(8));
    a.record("a", "reasoning", "thought", "PRIVATE_THOUGHT_FIXTURE"); a.record("a", "permission", "permission", "PRIVATE_PERMISSION_FIXTURE");
    const rows = request(a, { action: "read", sessionId: "a" } as any).entries!;
    expect(rows).toHaveLength(3); expect(JSON.stringify(rows)).not.toContain("syntheticsynthetic");
    expect(rows.every(row => row.text.includes("已遮蔽憑證"))).toBe(true);
  });
  it("does not write streaming credential tails or an unfinished private-key body", () => {
    for (const [n, part] of ["prefix ", "sk-", "synthetic", "tail", " ending"].entries()) a.record("a", "stream-secret", "message", part, undefined, n > 0);
    a.record("a", "key", "message", ["-----BEGIN", " PRIVATE KEY-----\n"].join(""));
    a.record("a", "key", "message", "SYNTHETIC_KEY_BODY_ONLY", undefined, true);
    const rows = request(a, { action: "read", sessionId: "a" } as any).entries!;
    expect(rows[0].text).not.toContain("synthetic"); expect(rows[0].text).not.toContain("tail");
    expect(rows[0].text).toContain(" ending"); expect(rows[1].text).toBe("[已遮蔽私鑰]");
    for (const suffix of ["", "-wal"]) {
      const path = join(root, "data", `history.sqlite${suffix}`);
      if (existsSync(path)) { const bytes = readFileSync(path).toString("latin1"); expect(bytes).not.toContain("SYNTHETIC_KEY_BODY_ONLY"); expect(bytes).not.toContain("synthetictail"); }
    }
  });
  it("creates a disabled local draft and requires rewritten rules before activation", () => {
    a.record("a", "user", "user", "把字幕改成白色");
    const draft = request(a, { action: "draft", sessionId: "a" } as any).draft!;
    expect(draft.enabled).toBe(false); expect(draft.visibility).toBe("project"); expect(a.promptContext()).toBe("");
    expect(() => request(a, { action: "save-extension", extension: { ...draft, enabled: true } } as any)).toThrow(/改寫/);
    request(a, { action: "save-extension", extension: { ...draft, instructions: "字幕預設白色，但以本次需求優先。", enabled: true } } as any);
    expect(a.promptContext()).toContain("字幕預設白色"); expect(a.promptContext()).not.toContain("sourceSessionId");
    expect(b.promptContext()).toBe("");
  });
  it("redacts interleaved message streams without archiving credential continuations", () => {
    a.record("a", "first", "message", "prefix sk-synthetic");
    a.record("a", "second", "message", "another reply");
    a.record("a", "first", "message", "secrettail ending", undefined, true);
    const entries = request(a, { action: "read", sessionId: "a" } as any).entries!;
    expect(entries[0].text).toBe("prefix [已遮蔽憑證] ending");
    expect(JSON.stringify(entries)).not.toContain("secrettail");
    a.finishTurn();
    expect(() => a.record("a", "first", "message", "late continuation", undefined, true)).toThrow(/串流/);
    expect(request(a, { action: "read", sessionId: "a" } as any).entries![0].text).toBe(entries[0].text);
  });
  it("bounds concurrent stream buffers and rejects evicted credential continuations", () => {
    a.record("a", "evicted", "message", "sk-synthetic");
    for (let n = 0; n < 32; n++) a.record("a", `message-${n}`, "message", "ordinary reply");
    expect(() => a.record("a", "evicted", "message", "PRIVATE_TAIL_FIXTURE", undefined, true)).toThrow(/記憶體預算/);
    expect(JSON.stringify(request(a, { action: "read", sessionId: "a" } as any).entries)).not.toContain("PRIVATE_TAIL_FIXTURE");
  });
  it("shares only explicitly published rules, never source conversations or foreign editing ownership", () => {
    a.record("a", "user", "user", "PRIVATE_SOURCE_FIXTURE");
    const shared = extension({ enabled: true, visibility: "personal", sourceSessionId: "a" });
    request(a, { action: "save-extension", extension: shared } as any);
    expect(b.promptContext()).toContain(shared.instructions); expect(b.promptContext()).not.toContain("PRIVATE_SOURCE_FIXTURE");
    expect(() => request(b, { action: "save-extension", extension: shared } as any)).toThrow(/原專案/);
  });
  it("supports only the declared plugin context hook and bounds prompt cost without granting tool access", () => {
    const plugin = extension({ kind: "plugin", enabled: true });
    request(a, { action: "save-extension", extension: plugin } as any);
    expect(a.promptContext()).toContain("plugin");
    for (const extra of [{ command: "arbitrary-shell" }, { hooks: ["execute"] }, { permissions: ["*"] }, { schema: "unknown/v2" }]) {
      expect(() => request(a, { action: "save-extension", extension: { ...extension(), ...extra } } as any)).toThrow(/格式/);
    }
    request(a, { action: "save-extension", extension: extension({ enabled: true, instructions: "規則".repeat(1000) }) } as any);
    expect(() => request(a, { action: "save-extension", extension: extension({ enabled: true, instructions: "規則".repeat(1000) }) } as any)).toThrow(/預算/);
  });
});
