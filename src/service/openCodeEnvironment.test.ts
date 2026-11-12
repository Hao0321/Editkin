// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
import { describe, expect, it, vi, afterEach } from "vitest";
import { embeddedAgentEnvironment } from "./openCodeEnvironment";
import { AGENT_SESSION_BRIEFING } from "../application/agentTaskGuidance";

afterEach(() => vi.unstubAllEnvs());
describe("process-local integrated editing profile", () => {
  it.each([undefined, "http://127.0.0.1:9999"])("uses the same bounded MCP profile for origin %s without changing provider credentials", origin => {
    vi.stubEnv("OPENCODE_CONFIG", "fixture-native-provider-config.json");
    const env = embeddedAgentEnvironment(origin, undefined, true);
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
    expect(env.OPENCODE_CONFIG).toBe("fixture-native-provider-config.json");
    expect(config.default_agent).toBe("editkin");
    expect(config.agent.editkin.prompt).toBe(AGENT_SESSION_BRIEFING);
    expect(config.agent.editkin.permission).toMatchObject({ "*": "deny", "editkin_*": "allow" });
    for (const name of ["bash", "read", "edit", "write", "apply_patch", "task", "skill", "webfetch", "websearch"])
      expect(config.agent.editkin.permission[name]).toBe("deny");
    expect(config.agent.build).toEqual(config.agent.editkin);
    expect(config.agent.plan).toEqual(config.agent.editkin);
    expect(config.agent.editkin.model).toBeUndefined();
    expect(config.provider?.local?.options?.baseURL).toBe(origin ? origin + "/v1" : undefined);
    expect(config.provider?.openai).toBeUndefined();
    expect(process.env.OPENCODE_CONFIG_CONTENT).not.toBe(env.OPENCODE_CONFIG_CONTENT);
  });
  it("keeps provider discovery outside the editing tool profile", () => {
    const config = JSON.parse(embeddedAgentEnvironment("http://127.0.0.1:9999").OPENCODE_CONFIG_CONTENT!);
    expect(config.agent).toBeUndefined();
    expect(config.default_agent).toBeUndefined();
  });
});
