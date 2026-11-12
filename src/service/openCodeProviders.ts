// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, basename } from "node:path";
import { embeddedAgentEnvironment } from "./openCodeEnvironment";
import { agentProviders, isCloudAgentProvider, type AgentProviderInfo, type AgentProviderLogin, type AgentProviderReply, type AgentSettingsRequest } from "../application/agentProviders";
import { normalizeGatewayURL, readGatewayConfiguration, writeGatewayConfiguration, removeGatewayConfiguration, discoverGatewayModels } from "./openCodeGateway";

export function sanitizeAgentProviders(catalog: any, authentication: any): AgentProviderInfo[] {
  return agentProviders.map(provider => {
    const native = Array.isArray(catalog?.all) ? catalog.all.find((item: any) => item?.id === provider.id) : undefined;
    const methods = Array.isArray(authentication?.[provider.id]) ? authentication[provider.id] : [{ type: "api", label: "API Key" }];
    return { id: provider.id, name: provider.name, configured: Array.isArray(catalog?.connected) && catalog.connected.includes(provider.id),
      modelCount: native?.models && typeof native.models === "object" ? Object.keys(native.models).length : 0,
      authMethods: methods.flatMap((method: any, index: number) => {
        if ((method?.type !== "api" && method?.type !== "oauth") || typeof method.label !== "string" || method.prompts?.length) return [];
        // Native device login uses the system browser without binding a local OAuth callback listener.
        if (method.type === "oauth" && (provider.id !== "openai" || !/(headless|device)/iu.test(method.label))) return [];
        return [{ index, type: method.type, label: method.label.slice(0, 120) }];
      }) };
  });
}

type RuntimeOptions = { opencodeExecutable: string; workspace: string; modelOrigin?: string; providerConfigPath?: string };
export class OpenCodeProviders {
  private child?: ChildProcess;
  private startup?: Promise<void>;
  private origin = "";
  private authorization = "";
  private idle?: ReturnType<typeof setTimeout>;
  private login?: AgentProviderLogin & { nativeMethod: number };
  private callback?: AbortController;
  private generation = 0;
  private configurationVersion = 0;
  private reconnectedVersion = 0;
  version() { return this.configurationVersion; }
  acknowledgeReconnect(version: number) { if (version === this.configurationVersion) this.reconnectedVersion = version; }
  private needsReconnect() { return this.configurationVersion !== this.reconnectedVersion; }
  reconnectRequired() { return this.needsReconnect(); }

  private touch() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close(), this.login?.status === "waiting" ? 10 * 60_000 : 60_000);
    this.idle.unref();
  }
  async start(options: RuntimeOptions) {
    if (this.child && this.origin) { this.touch(); return; }
    if (this.startup) return this.startup;
    this.startup = this.startRuntime(options);
    try { await this.startup; } finally { this.startup = undefined; }
  }
  private async startRuntime(options: RuntimeOptions) {
    if (!isAbsolute(options.workspace) || !existsSync(options.workspace) || !isAbsolute(options.opencodeExecutable)
      || basename(options.opencodeExecutable).toLowerCase() !== (process.platform === "win32" ? "opencode.exe" : "opencode") || !existsSync(options.opencodeExecutable)) throw new Error("內建供應商 runtime 不完整");
    const password = randomBytes(32).toString("hex"), generation = ++this.generation;
    this.authorization = "Basic " + Buffer.from("opencode:" + password).toString("base64");
    const child = spawn(options.opencodeExecutable, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: options.workspace,
      env: { ...embeddedAgentEnvironment(options.modelOrigin, options.providerConfigPath), OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: password }, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    this.child = child;
    try {
      this.origin = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("供應商設定啟動逾時")), 20_000); let buffer = "";
        const finish = (error?: Error, origin?: string) => { clearTimeout(timer); if (error) reject(error); else resolve(origin!); };
        child.stdout!.on("data", chunk => { buffer = (buffer + chunk.toString()).slice(-8192); const match = /http:\/\/127\.0\.0\.1:\d+/u.exec(buffer); if (match) finish(undefined, match[0]); });
        child.once("error", () => finish(new Error("供應商設定無法啟動")));
        child.once("exit", () => { finish(new Error("供應商設定已結束")); if (generation === this.generation) { this.child = undefined; this.origin = ""; this.authorization = ""; this.callback?.abort(); if (this.login?.status === "waiting") { this.login.status = "failed"; this.login.error = "登入程序已結束，請重新登入"; } } });
      });
      if (generation !== this.generation) throw new Error("供應商啟動已取消");
      this.touch();
    } catch (error) { this.close(); throw error; }
  }
  private async request(path: string, method = "GET", body?: unknown, timeout = 15_000, signal?: AbortSignal): Promise<any> {
    if (!this.origin || !this.child) throw new Error("供應商設定尚未啟動");
    const response = await fetch(this.origin + path, { method, headers: { authorization: this.authorization, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
    // Do not expose native response bodies: authentication failures can include credentials.
    if (!response.ok) throw new Error(`供應商操作失敗（HTTP ${response.status}），請檢查設定或重新登入`);
    return response.json();
  }
  private visibleLogin(): AgentProviderLogin | undefined {
    if (!this.login) return undefined;
    const { nativeMethod: _method, ...visible } = this.login;
    return { ...visible };
  }
  async action(input: AgentSettingsRequest, options: RuntimeOptions): Promise<AgentProviderReply & { loginUrl?: string; dashboardUrl?: string }> {
    if (["connect-gateway", "disconnect-gateway", "open-gateway-dashboard"].includes(input.action)) {
      if (!options.providerConfigPath) throw Error("缺少剪輯台閘道設定路徑");
      if (this.login?.status === "waiting") throw Error("請先完成或取消目前登入");
      if (input.action === "open-gateway-dashboard") {
        const configuration = readGatewayConfiguration(options.providerConfigPath);
        const baseURL = input.baseURL ? normalizeGatewayURL(input.baseURL.trim()) : configuration?.baseURL;
        if (!baseURL) throw Error("請先輸入 OmniRoute 位址");
        return { dashboardUrl: baseURL.replace(/\/v1$/u, "") + "/dashboard/providers" };
      }
      if (input.action === "disconnect-gateway") {
        removeGatewayConfiguration(options.providerConfigPath); this.configurationVersion++; this.close(); return { requiresReconnect: true };
      }
      if (input.action === "connect-gateway") {
        const baseURL = normalizeGatewayURL(input.baseURL.trim()), apiKey = input.apiKey?.trim();
        if (input.apiKey && (input.apiKey.length > 4096 || /[\r\n\x00]/u.test(input.apiKey))) throw Error("API 金鑰格式不符");
        const catalog = await discoverGatewayModels(baseURL, apiKey);
        if (apiKey) {
          await this.start(options);
          if (await this.request("/auth/omniroute", "PUT", { type: "api", key: apiKey }) !== true) throw Error("供應商沒有確認儲存設定");
          this.configurationVersion++;
        }
        writeGatewayConfiguration(options.providerConfigPath, { baseURL, models: catalog.models });
        this.configurationVersion++; this.close();
        return { gateway: { baseURL, modelCount: catalog.models.length, excludedCount: catalog.excludedCount }, requiresReconnect: true };
      }
    }
    if (input.action === "login-status") {
      if (!this.login || input.attemptId !== this.login.id) throw new Error("登入要求已失效");
      return { login: this.visibleLogin(), requiresReconnect: this.needsReconnect() };
    }
    if (input.action === "cancel-login") {
      if (!this.login || input.attemptId !== this.login.id) throw new Error("登入要求已失效");
      this.close(); return { login: this.visibleLogin() };
    }
    await this.start(options); this.touch();
    if (input.action === "list") {
      const [catalog, methods] = await Promise.all([this.request("/provider"), this.request("/provider/auth")]);
      const configuration = readGatewayConfiguration(options.providerConfigPath);
      return { providers: sanitizeAgentProviders(catalog, methods), login: this.visibleLogin(), requiresReconnect: this.needsReconnect(),
        gateway: configuration && { baseURL: configuration.baseURL, modelCount: configuration.models.length } };
    }
    if (input.action === "save-api-key" || input.action === "disconnect") {
      if (!isCloudAgentProvider(input.providerId)) throw new Error("此供應商尚未支援");
      if (this.login?.status === "waiting") throw new Error("請先完成或取消目前登入");
      if (input.action === "save-api-key" && (!input.apiKey.trim() || input.apiKey.length > 4096 || /[\r\n\x00]/u.test(input.apiKey))) throw new Error("API 金鑰格式不符");
      const result = await this.request(`/auth/${input.providerId}`, input.action === "disconnect" ? "DELETE" : "PUT", input.action === "disconnect" ? undefined : { type: "api", key: input.apiKey.trim() });
      if (result !== true) throw new Error("供應商沒有確認儲存設定");
      this.configurationVersion++;
      return { requiresReconnect: true };
    }
    if (input.action === "start-login") {
      if (this.login?.status === "waiting") throw new Error("已有登入等待中，請先完成或取消");
      if (input.providerId !== "openai" || !Number.isInteger(input.method)) throw new Error("登入方式不符");
      const authentication = await this.request("/provider/auth");
      const method = sanitizeAgentProviders({}, authentication).find(provider => provider.id === "openai")?.authMethods.find(method => method.index === input.method && method.type === "oauth");
      if (!method) throw new Error("內建 runtime 沒有此 ChatGPT 裝置登入方式");
      const native = await this.request("/provider/openai/oauth/authorize", "POST", { method: input.method });
      const url = new URL(native.url);
      if (url.protocol !== "https:" || url.hostname !== "auth.openai.com" || url.username || url.password || !["auto", "code"].includes(native.method)) throw new Error("登入網址不符，未開啟瀏覽器");
      this.login = { id: randomUUID(), providerId: "openai", status: "waiting", method: native.method, nativeMethod: input.method,
        instructions: `${native.method === "auto" ? "請在系統瀏覽器登入並授權，完成後會回到剪輯台。" : "請完成瀏覽器登入，再貼上供應商提供的驗證碼。"}${typeof native.instructions === "string" ? "\n" + native.instructions.replace(/https:\/\/\S+/gu, "官方登入頁面").slice(0, 1000) : ""}` };
      this.touch();
      if (native.method === "auto") this.beginCallback();
      return { login: this.visibleLogin(), loginUrl: url.toString() };
    }
    if (input.action === "finish-login") {
      if (!this.login || input.attemptId !== this.login.id || this.login.status !== "waiting" || this.login.method !== "code" || !input.code || input.code.length > 4096) throw new Error("登入驗證碼或要求已失效");
      this.beginCallback(input.code.trim()); return { login: this.visibleLogin() };
    }
    throw new Error("不支援的供應商操作");
  }
  private beginCallback(code?: string) {
    if (this.callback || !this.login) throw new Error("登入回呼已在處理");
    const login = this.login, controller = new AbortController(); this.callback = controller;
    void this.request(`/provider/${login.providerId}/oauth/callback`, "POST", { method: login.nativeMethod, ...(code ? { code } : {}) }, 10 * 60_000, controller.signal)
      .then(result => { if (this.login === login && !controller.signal.aborted) { login.status = result === true ? "completed" : "failed"; if (result === true) this.configurationVersion++; else login.error = "供應商未確認登入，請重新登入"; } })
      .catch(() => { if (this.login === login && !controller.signal.aborted) { login.status = "failed"; login.error = "登入未完成或已逾時，請重新登入"; } })
      .finally(() => { if (this.callback === controller) { this.callback = undefined; this.touch(); } });
  }
  close() {
    ++this.generation; if (this.idle) clearTimeout(this.idle); this.idle = undefined;
    this.callback?.abort(); this.callback = undefined;
    if (this.login?.status === "waiting") this.login.status = "cancelled";
    this.child?.kill(); this.child = undefined; this.origin = ""; this.authorization = "";
  }
}
export const openCodeProviders = new OpenCodeProviders();
