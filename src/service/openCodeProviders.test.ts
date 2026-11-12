// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeProviders, sanitizeAgentProviders } from "./openCodeProviders";

afterEach(() => vi.restoreAllMocks());
describe("native provider protocol", () => {
  it("returns only provider metadata, preserves native method index, and never projects credentials", () => {
    const result = sanitizeAgentProviders({ connected: ["openai"], all: [{ id: "openai", options: { apiKey: "fixture-secret" }, models: { one: {} } }] },
      { openai: [{ type: "oauth", label: "ChatGPT Pro/Plus (browser)" }, { type: "oauth", label: "ChatGPT Pro/Plus (headless)" }, { type: "api", label: "API Key" }] });
    expect(result[0]).toMatchObject({ configured: true, modelCount: 1, authMethods: [{ index: 1, type: "oauth" }, { index: 2, type: "api" }] });
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
    expect(result).toHaveLength(7);
  });
  it("uses native Auth API envelope without returning the submitted secret", async () => {
    const manager = new OpenCodeProviders();
    vi.spyOn(manager, "start").mockResolvedValue();
    const request = vi.spyOn(manager as any, "request").mockResolvedValue(true);
    try {
      const result = await manager.action({ action: "save-api-key", providerId: "google", apiKey: "fixture-secret" }, {} as any);
      expect(request).toHaveBeenCalledWith("/auth/google", "PUT", { type: "api", key: "fixture-secret" });
      expect(result).toEqual({ requiresReconnect: true });
      expect(manager.reconnectRequired()).toBe(true);
      manager.acknowledgeReconnect(-1);
      expect(manager.reconnectRequired()).toBe(true);
      manager.acknowledgeReconnect(manager.version());
      expect(manager.reconnectRequired()).toBe(false);
      expect(JSON.stringify(result)).not.toContain("fixture-secret");
    } finally { manager.close(); }
  });
  it("rejects malformed keys before sending to native auth", async () => {
    const manager = new OpenCodeProviders(); vi.spyOn(manager, "start").mockResolvedValue();
    const request = vi.spyOn(manager as any, "request");
    try {
      await expect(manager.action({ action: "save-api-key", providerId: "openai", apiKey: "unsafe\nline" }, {} as any)).rejects.toThrow("格式");
      expect(request).not.toHaveBeenCalled();
    } finally { manager.close(); }
  });
  it("rejects stale login handles without starting any process", async () => {
    const manager = new OpenCodeProviders(); const start = vi.spyOn(manager, "start");
    await expect(manager.action({ action: "login-status", attemptId: "stale" }, {} as any)).rejects.toThrow("失效");
    expect(start).not.toHaveBeenCalled();
  });
  it("rejects an untrusted OAuth URL and leaves no pending login", async () => {
    const manager = new OpenCodeProviders(); vi.spyOn(manager, "start").mockResolvedValue();
    vi.spyOn(manager as any, "request").mockResolvedValueOnce({ openai: [{ type: "oauth", label: "ChatGPT (headless)" }] })
      .mockResolvedValueOnce({ url: "https://invalid.example/login", method: "auto" });
    try {
      await expect(manager.action({ action: "start-login", providerId: "openai", method: 0 }, {} as any)).rejects.toThrow("網址");
      await expect(manager.action({ action: "login-status", attemptId: "anything" }, {} as any)).rejects.toThrow("失效");
    } finally { manager.close(); }
  });
  it("does not start the local browser-callback method for device login", async () => {
    const manager = new OpenCodeProviders(); vi.spyOn(manager, "start").mockResolvedValue();
    const request = vi.spyOn(manager as any, "request").mockResolvedValue({ openai: [{ type: "oauth", label: "ChatGPT (browser)" }] });
    try {
      await expect(manager.action({ action: "start-login", providerId: "openai", method: 0 }, {} as any)).rejects.toThrow("裝置");
      expect(request).toHaveBeenCalledTimes(1);
    } finally { manager.close(); }
  });
  it("retains a cancelled login when an old native callback completes late", async () => {
    const manager = new OpenCodeProviders(); vi.spyOn(manager, "start").mockResolvedValue();
    let finish!: (value: unknown) => void;
    vi.spyOn(manager as any, "request").mockResolvedValueOnce({ openai: [{ type: "oauth", label: "ChatGPT (headless)" }] })
      .mockResolvedValueOnce({ url: "https://auth.openai.com/authorize", method: "auto" })
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = await manager.action({ action: "start-login", providerId: "openai", method: 0 }, {} as any);
    expect(pending.login?.status).toBe("waiting");
    const cancelled = await manager.action({ action: "cancel-login", attemptId: pending.login!.id }, {} as any);
    expect(cancelled.login?.status).toBe("cancelled");
    finish(true); await Promise.resolve(); await Promise.resolve();
    expect((await manager.action({ action: "login-status", attemptId: pending.login!.id }, {} as any)).login?.status).toBe("cancelled");
    expect(manager.reconnectRequired()).toBe(false); manager.close();
  });
});
