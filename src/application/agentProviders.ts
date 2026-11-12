// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
export const cloudAgentProviders = [
  { id: "openai", name: "OpenAI", keyUrl: "https://platform.openai.com/api-keys" },
  { id: "anthropic", name: "Anthropic", keyUrl: "https://console.anthropic.com/settings/keys" },
  { id: "google", name: "Google Gemini", keyUrl: "https://aistudio.google.com/api-keys" },
  { id: "openrouter", name: "OpenRouter", keyUrl: "https://openrouter.ai/settings/keys" },
  { id: "xai", name: "xAI", keyUrl: "https://console.x.ai/" },
  { id: "deepseek", name: "DeepSeek", keyUrl: "https://platform.deepseek.com/api_keys" },
] as const;
export type CloudAgentProviderId = typeof cloudAgentProviders[number]["id"];
export const isCloudAgentProvider = (id: string): id is CloudAgentProviderId => cloudAgentProviders.some(provider => provider.id === id);
export const agentProviders = [...cloudAgentProviders, { id: "omniroute", name: "OmniRoute · 共用閘道" }] as const;
export type AgentProviderId = CloudAgentProviderId | "omniroute";
export function isSupportedAgentModel(value: string): boolean {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1 || value.length > 300 || /[\x00-\x1f]/u.test(value)) return false;
  const provider = value.slice(0, separator);
  return /^(ollama|local|lmstudio|vllm)$/iu.test(provider) || provider === "omniroute" || isCloudAgentProvider(provider);
}
/** Exclude known non-chat cloud families from an ACP text/tool editing session. */
export function isEditingAgentModel(value: string): boolean {
  if (!isSupportedAgentModel(value)) return false;
  const separator = value.indexOf("/"), provider = value.slice(0, separator), model = value.slice(separator + 1);
  // Local aliases are user-defined. Gateway discovery separately requires an
  // explicit tool-calling capability and must preserve complete route names.
  if (provider === "omniroute" || /^(ollama|local|lmstudio|vllm)$/iu.test(provider)) return true;
  return !/(?:^|\/)(?:text-embedding|gemini-embedding|embedding|gpt-image|dall-e|whisper|tts|imagen|veo|lyria)(?:[-/]|$)/iu.test(model)
    && !/(?:^|[-/])(?:realtime|transcribe|transcription|tts|audio-preview)(?:[-/]|$)/iu.test(model)
    && !/(?:^|\/)gpt-audio(?:[-/]|$)/iu.test(model)
    && !/(?:^|\/)gemini-[^/]*-image(?:[-/]|$)/iu.test(model);
}
export function agentModelSource(model: string): string {
  const provider = model.slice(0, model.indexOf("/"));
  return provider === "omniroute" ? "OmniRoute · API／登入" : /^(ollama|local|lmstudio|vllm)$/iu.test(provider) ? "本機" : "API／登入";
}
export interface AgentGatewayInfo { baseURL: string; modelCount: number; excludedCount?: number }
export interface AgentProviderInfo { id: AgentProviderId; name: string; configured: boolean; modelCount: number;
  authMethods: Array<{ index: number; type: "api" | "oauth"; label: string }> }
export interface AgentProviderLogin { id: string; providerId: CloudAgentProviderId; status: "waiting" | "completed" | "failed" | "cancelled";
  method: "auto" | "code"; instructions: string; error?: string }
export type AgentProviderRequest = { action: "list" }
  | { action: "save-api-key"; providerId: CloudAgentProviderId; apiKey: string }
  | { action: "start-login"; providerId: "openai"; method: number }
  | { action: "finish-login"; attemptId: string; code?: string }
  | { action: "login-status" | "cancel-login"; attemptId: string }
  | { action: "disconnect"; providerId: CloudAgentProviderId };
export type AgentGatewayRequest = { action: "connect-gateway"; baseURL: string; apiKey?: string }
  | { action: "disconnect-gateway" } | { action: "open-gateway-dashboard"; baseURL?: string };
export type AgentSettingsRequest = AgentProviderRequest | AgentGatewayRequest;
export interface AgentProviderReply { providers?: AgentProviderInfo[]; login?: AgentProviderLogin; gateway?: AgentGatewayInfo; requiresReconnect?: boolean }
