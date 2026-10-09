// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gatewayModelCatalog, normalizeGatewayURL, readGatewayConfiguration, writeGatewayConfiguration, discoverGatewayModels } from "./openCodeGateway";
import { OpenCodeProviders } from "./openCodeProviders";
import { embeddedAgentEnvironment } from "./openCodeEnvironment";

const roots: string[] = [];
function configPath() { const root = mkdtempSync(join(tmpdir(), "editkin-gateway-test-")); roots.push(root); return join(root, "agent-providers", "omniroute.opencode.json"); }
const catalog = { data: ["cc/fixture-claude", "cx/fixture-codex", "gc/fixture-grok", "gemini/fixture-gemini"].map(id => ({ id, capabilities: { tool_calling: true }, apiKey: "fixture-secret" })) };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("OmniRoute gateway protocol", () => {
  it("normalizes one /v1 and preserves reverse proxy prefix", () => {
    expect(normalizeGatewayURL("http://localhost:20128/")).toBe("http://localhost:20128/v1");
    expect(normalizeGatewayURL("https://gateway.example/router/v1///")).toBe("https://gateway.example/router/v1");
  });
  it.each(["http://10.attacker.example/", "http://192.168.1.8:20128/", "http://public.example/", ["https://user", "secret@gateway.example"].join(":"), "https://gateway.example?key=secret", "https://gateway.example/v1/v1", "https://gateway.example/../private"])("rejects credential or malformed destination %s", url => {
    expect(() => normalizeGatewayURL(url)).toThrow();
  });
  it("keeps exact nested provider IDs, skips missing/false tools, and drops private metadata", () => {
    const result = gatewayModelCatalog({ data: [...catalog.data, { id: "chat-only", capabilities: { tool_calling: false } }, { id: "unknown" }, { id: "__proto__/bad", capabilities: { tool_calling: true } }] });
    expect(result.models.map(model => model.id)).toEqual(catalog.data.map(model => model.id));
    expect(result.excludedCount).toBe(3);
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
    expect(() => gatewayModelCatalog({ data: [{ id: "unknown" }] })).toThrow("工具");
  });
  it("persists only native provider metadata in an app-owned file, without a Windows-size environment blob", () => {
    const path = configPath(), configuration = { baseURL: "http://localhost:20128/v1", models: gatewayModelCatalog(catalog).models };
    writeGatewayConfiguration(path, configuration);
    expect(readGatewayConfiguration(path)).toEqual(configuration);
    const document = JSON.parse(readFileSync(path, "utf8"));
    expect(document.provider.omniroute.options).toEqual({ baseURL: configuration.baseURL });
    const env = embeddedAgentEnvironment("http://127.0.0.1:9999", path);
    expect(env.OPENCODE_CONFIG).toBe(path);
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!).provider.local).toBeTruthy();
    expect(env.OPENCODE_CONFIG_CONTENT).not.toContain("fixture-codex");
  });
  it("does not let a duplicate capability advertisement override an explicit unsupported tool model", () => {
    const result = gatewayModelCatalog({ data: [...catalog.data, { id: catalog.data[0].id, capabilities: { tool_calling: false } }] });
    expect(result.models.map(model => model.id)).not.toContain(catalog.data[0].id);
    expect(result.excludedCount).toBe(2);
  });
  it("rejects auth-bearing or unsafe config documents and paths", () => {
    const path = configPath(); mkdirSync(join(roots[0], "agent-providers"));
    writeFileSync(path, JSON.stringify({ $schema: "https://opencode.ai/config.json", provider: { omniroute: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://localhost:20128/v1", apiKey: "fixture-secret" }, models: {} } } }));
    expect(() => readGatewayConfiguration(path)).toThrow("設定無效");
    expect(() => readGatewayConfiguration(join(roots[0], "auth.json"))).toThrow("路徑");
  });
  it("bounds discovery, rejects redirect behavior and hides HTTP error bodies", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("fixture-secret", { status: 401 })); vi.stubGlobal("fetch", fetcher);
    await expect(discoverGatewayModels("http://192.168.1.8:20128/v1", "fixture-key")).rejects.toThrow("HTTPS");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(discoverGatewayModels("http://localhost:20128/v1", "fixture-key")).rejects.toThrow("HTTP 401");
    expect(fetcher).toHaveBeenCalledWith("http://localhost:20128/v1/models", expect.objectContaining({ redirect: "error", headers: { authorization: "Bearer fixture-key" } }));
    fetcher.mockResolvedValue(new Response("wrong", { headers: { "content-length": "9000000" } }));
    await expect(discoverGatewayModels("http://localhost:20128/v1")).rejects.toThrow("過大");
  });
  it("leaves the old gateway config and revision intact when the new catalog fails", async () => {
    const path = configPath(); writeGatewayConfiguration(path, { baseURL: "http://localhost:20128/v1", models: gatewayModelCatalog(catalog).models });
    const before = readFileSync(path, "utf8"); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("fixture-secret", { status: 429 })));
    const manager = new OpenCodeProviders();
    await expect(manager.action({ action: "connect-gateway", baseURL: "http://localhost:3333" }, { providerConfigPath: path } as any)).rejects.toThrow("429");
    expect(readFileSync(path, "utf8")).toBe(before); expect(manager.reconnectRequired()).toBe(false); manager.close();
  });
  it("stores a supplied gateway key only through native auth and requires an acknowledged refresh", async () => {
    const path = configPath(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(catalog)));
    const manager = new OpenCodeProviders(); vi.spyOn(manager, "start").mockResolvedValue();
    const native = vi.spyOn(manager as any, "request").mockResolvedValue(true);
    const reply = await manager.action({ action: "connect-gateway", baseURL: "http://localhost:20128", apiKey: "fixture-secret" }, { providerConfigPath: path } as any);
    expect(native).toHaveBeenCalledWith("/auth/omniroute", "PUT", { type: "api", key: "fixture-secret" });
    expect(JSON.stringify(reply)).not.toContain("fixture-secret"); expect(readFileSync(path, "utf8")).not.toContain("fixture-secret");
    expect(manager.reconnectRequired()).toBe(true); manager.acknowledgeReconnect(-1); expect(manager.reconnectRequired()).toBe(true);
    manager.acknowledgeReconnect(manager.version()); expect(manager.reconnectRequired()).toBe(false);
    await manager.action({ action: "disconnect-gateway" }, { providerConfigPath: path } as any);
    expect(readGatewayConfiguration(path)).toBeUndefined(); expect(native).toHaveBeenCalledTimes(1); expect(manager.reconnectRequired()).toBe(true); manager.close();
  });
  it("opens provider management from validated input before inference models exist and without starting an auth server", async () => {
    const manager = new OpenCodeProviders(); const start = vi.spyOn(manager, "start");
    const reply = await manager.action({ action: "open-gateway-dashboard", baseURL: "http://localhost:20128/router/v1" }, { providerConfigPath: configPath() } as any);
    expect(reply).toEqual({ dashboardUrl: "http://localhost:20128/router/dashboard/providers" }); expect(start).not.toHaveBeenCalled();
    manager.close();
  });
  it("can clear corrupt app metadata without starting native auth or touching shared credentials", async () => {
    const path = configPath(); mkdirSync(join(roots[0], "agent-providers")); writeFileSync(path, "corrupt isolated fixture");
    const manager = new OpenCodeProviders(); const native = vi.spyOn(manager, "start");
    await manager.action({ action: "disconnect-gateway" }, { providerConfigPath: path } as any);
    expect(readGatewayConfiguration(path)).toBeUndefined(); expect(native).not.toHaveBeenCalled(); expect(manager.reconnectRequired()).toBe(true); manager.close();
  });
});
