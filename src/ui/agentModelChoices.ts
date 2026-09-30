// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
import { isEditingAgentModel, isSupportedAgentModel, type AgentProviderId } from "../application/agentProviders";

export const agentModelSources = [
  { id: "local", name: "本機" },
  { id: "openai", name: "OpenAI／Codex" },
  { id: "anthropic", name: "Claude" },
  { id: "google", name: "Gemini" },
  { id: "xai", name: "Grok" },
  { id: "openrouter", name: "OpenRouter" },
  { id: "deepseek", name: "DeepSeek" },
  { id: "omniroute", name: "OmniRoute" },
] as const;
export type AgentModelSource = "local" | AgentProviderId;
export type AgentSourceChoice = AgentModelSource | "unlisted";
export type AgentModelChoice = { value: string; name: string };
export function modelSourceChoice(model: string): AgentSourceChoice {
  if (!isSupportedAgentModel(model)) return "unlisted";
  const provider = model.slice(0, model.indexOf("/"));
  return /^(pny|ollama|local|lmstudio|vllm)$/iu.test(provider) ? "local" : provider as AgentProviderId;
}
export function modelsForSource(models: AgentModelChoice[], source: AgentSourceChoice): AgentModelChoice[] {
  return models.filter(model => isEditingAgentModel(model.value) && modelSourceChoice(model.value) === source);
}
export function modelChoiceName(model: AgentModelChoice, source: AgentSourceChoice): string {
  // Preserve complete gateway route names; native value is never rewritten.
  return source === "omniroute" ? model.name : model.name.slice(model.name.indexOf("/") + 1);
}
