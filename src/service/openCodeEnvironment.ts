// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
import { readGatewayConfiguration } from "./openCodeGateway";
import { AGENT_SESSION_BRIEFING } from "../application/agentTaskGuidance";

export function embeddedAgentEnvironment(origin?: string, providerConfigPath?: string, editingSession = false): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_AUTO_SHARE: "0" };
  // App-owned metadata only. Native OpenCode still loads/authenticates credentials itself.
  if (readGatewayConfiguration(providerConfigPath)) env.OPENCODE_CONFIG = providerConfigPath;
  const config: Record<string, unknown> = { $schema: "https://opencode.ai/config.json", autoupdate: false };
  if (origin) {
    const url = new URL(origin);
    if (url.protocol !== "http:" || !/^\d+\.\d+\.\d+\.\d+$/u.test(url.hostname) || !url.port || url.pathname !== "/")
      throw new Error("內建 Agent 模型位址必須是本機或私有區網 HTTP IP 與連接埠");
    config.model = "pny/qwen3.8-27b-nvfp4";
    config.provider = { pny: { npm: "@ai-sdk/openai-compatible", name: "PNY 5090 Local", options: { baseURL: `${origin}/v1`, apiKey: "local" },
      models: { "qwen3.8-27b-nvfp4": { name: "Qwen 3.8 27B NVFP4" } } } };
  }
  if (editingSession) {
    // Process-local profile: shared native provider/auth configuration is untouched.
    const profile = { mode: "primary", description: "Editkin 剪輯助理", prompt: AGENT_SESSION_BRIEFING,
      // Native configuration is deep-merged. Explicit entries replace inherited tool-specific grants.
      permission: { "*": "deny", bash: "deny", read: "deny", edit: "deny", write: "deny", apply_patch: "deny",
        glob: "deny", grep: "deny", list: "deny", task: "deny", skill: "deny", webfetch: "deny", websearch: "deny",
        todowrite: "deny", todoread: "deny", question: "deny", lsp: "deny", plan_enter: "deny", plan_exit: "deny",
        execute: "deny", "editkin_*": "allow" } };
    config.default_agent = "editkin";
    // Old ACP conversations remember build/plan. Keep those IDs as safe aliases.
    config.agent = { editkin: profile, build: profile, plan: profile,
      general: { disable: true }, explore: { disable: true } };
  }
  if (origin || editingSession) env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  return env;
}
