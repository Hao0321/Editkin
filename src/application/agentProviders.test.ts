// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
import { describe, expect, it } from "vitest";
import { isSupportedAgentModel, agentModelSource } from "./agentProviders";

describe("Agent provider model contract", () => {
  it.each(["pny/fixture", "ollama/qwen", "openai/gpt-model", "anthropic/claude-model", "google/gemini-model", "openrouter/vendor/model", "xai/grok-model", "deepseek/chat-model", "omniroute/cc/fixture", "omniroute/cx/fixture", "omniroute/gc/fixture", "omniroute/gemini/fixture"])("supports configured native provider model %s", model => {
    expect(isSupportedAgentModel(model)).toBe(true);
  });
  it("labels local, direct API/login and gateway routes in the shared model selector", () => {
    expect(agentModelSource("pny/model")).toBe("本機");
    expect(agentModelSource("openai/model")).toBe("API／登入");
    expect(agentModelSource("omniroute/cc/model")).toBe("OmniRoute · API／登入");
  });
  it.each(["", "openai/", "/model", "unconfigured-provider/model", "openai/model\n", "openai/" + "x".repeat(301)])("rejects an unsupported or malformed model %s", model => {
    expect(isSupportedAgentModel(model)).toBe(false);
  });
});
