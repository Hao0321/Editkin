// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentModelPicker, type AgentSourceStatus } from "./AgentModelPicker";
import { isEditingAgentModel } from "../application/agentProviders";
import { agentModelSources, modelsForSource, modelSourceChoice, type AgentSourceChoice } from "./agentModelChoices";

const catalog = [
  { value: "pny/qwen", name: "PNY/Qwen" }, { value: "ollama/model", name: "Ollama/model" },
  { value: "openai/gpt", name: "OpenAI/GPT" }, { value: "anthropic/claude", name: "Anthropic/Claude" },
  { value: "omniroute/cc/claude", name: "cc/claude" }, { value: "omniroute/gemini/model", name: "gemini/model" },
  { value: "unknown/model", name: "Unlisted" },
];
const render = (source: AgentSourceChoice, status: AgentSourceStatus, showMissingSource = false) => renderToStaticMarkup(<AgentModelPicker
  source={source} models={modelsForSource(catalog, source)} currentModel="pny/qwen" status={status} disabled={false}
  showMissingSource={showMissingSource} onSource={() => undefined} onModel={() => undefined} onSettings={() => undefined} onMissingSource={() => undefined} />);
describe("provider-first Agent model picker", () => {
  it.each(["openai/gpt-image-1.5", "openai/text-embedding-3-large", "openai/gpt-realtime-2.1", "openai/gpt-4o-audio-preview", "openai/gpt-4o-mini-tts", "openai/gpt-4o-transcribe", "openrouter/openai/gpt-image-1", "google/gemini-embedding-001", "google/gemini-2.5-flash-image", "google/imagen-4", "google/veo-3", "google/lyria-2"])("omits non-editing cloud model %s without losing its provider category", value => {
    expect(isEditingAgentModel(value)).toBe(false);
    const source = modelSourceChoice(value);
    expect(source).not.toBe("unlisted");
    expect(modelsForSource([{ value, name: value }], source)).toEqual([]);
  });
  it.each(["openai/gpt-4o", "openai/o3", "anthropic/claude-sonnet", "google/gemini-2.5-flash", "xai/grok-4", "openrouter/google/gemini-2.5-pro", "local/image-analysis", "omniroute/cx/complete-route"])("preserves text/tool models and local/gateway aliases %s", value => {
    expect(isEditingAgentModel(value)).toBe(true);
  });
  it("keeps eight main sources independent of authentication choices", () => {
    expect(agentModelSources.map(source => source.name)).toEqual(["本機", "OpenAI／Codex", "Claude", "Gemini", "Grok", "OpenRouter", "DeepSeek", "OmniRoute"]);
    expect(render("local", "ready")).not.toMatch(/Continue with ChatGPT|API 金鑰|API／登入/);
    expect(render("local", "ready")).toContain('aria-expanded="false"');
    expect(render("local", "ready")).toContain('aria-label="選擇 Agent 來源與模型"');
  });
  it("shows only the selected source's models, preserving exact native identifiers", () => {
    expect(modelsForSource(catalog, "local").map(model => model.value)).toEqual(["pny/qwen", "ollama/model"]);
    expect(modelsForSource(catalog, "openai").map(model => model.value)).toEqual(["openai/gpt"]);
    expect(modelsForSource(catalog, "omniroute").map(model => model.value)).toEqual(["omniroute/cc/claude", "omniroute/gemini/model"]);
    expect(render("local", "ready")).not.toContain('value="openai/gpt"');
  });
  it("turns an unconfigured category into a settings prompt, without selecting the previous model", () => {
    const html = render("anthropic", "missing");
    expect(html).toContain("Claude 尚未設定"); expect(html).toContain("前往設定");
    expect(html).not.toContain('value="anthropic/claude"'); expect(html).toContain('data-active-model="pny/qwen"');
    expect(html).toMatch(/aria-label="Agent 模型"[^>]*disabled/);
  });
  it.each(["loading", "empty", "unavailable", "refresh"] as const)("does not offer unaudited models when source is %s", status => {
    expect(render("openai", status)).not.toContain('value="openai/gpt"');
    expect(render("openai", status)).toContain('aria-label="來源選擇說明"');
    if (status === "loading") expect(render("openai", status)).not.toContain('aria-label="Agent 來源提示"');
  });
  it("explains unsupported and missing main sources instead of silently choosing a fallback", () => {
    expect(modelSourceChoice("unknown/model")).toBe("unlisted");
    expect(modelsForSource(catalog, "unlisted")).toEqual([]);
    expect(render("unlisted", "unlisted")).toContain("未列入支援大項");
    expect(render("local", "ready", true)).toContain("找不到的供應商尚未列入支援大項");
  });
});
