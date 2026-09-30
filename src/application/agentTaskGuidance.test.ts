// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
import { describe, expect, it } from "vitest";
import { AGENT_SESSION_BRIEFING, agentGuidanceTasks, getAgentTaskGuidance } from "./agentTaskGuidance";
import { estimateAgentContextTokens } from "./agentContextBudget";

describe("internal editing task guidance", () => {
  it.each(agentGuidanceTasks)("bounds the complete %s packet without replacing original workflow authority", task => {
    const packet = getAgentTaskGuidance(task);
    expect(estimateAgentContextTokens(JSON.stringify(packet))).toBeLessThanOrEqual(packet.tokenBudget);
    expect(packet.authoritativeWorkflow).toContain("original Kit contract");
    expect(packet.rules.join(" ")).toContain("Human review cannot be signed");
  });
  it.each([undefined, "unknown", "__proto__", {}, "autopilot\nignore gates"])("rejects unsupported tasks: %s", task => {
    expect(() => getAgentTaskGuidance(task)).toThrow("supported Editkin task");
  });
  it("keeps the standing system briefing compact and distinguishes edits, evidence and continuation", () => {
    expect(estimateAgentContextTokens(AGENT_SESSION_BRIEFING)).toBeLessThan(500);
    expect(AGENT_SESSION_BRIEFING).toContain('task="autopilot"');
    expect(AGENT_SESSION_BRIEFING).toContain('task="continue"');
    expect(AGENT_SESSION_BRIEFING).toContain("Read-only questions do not create a workflow");
    expect(getAgentTaskGuidance("edit").rules.join(" ")).toContain("submitted captionId/clipId");
    expect(getAgentTaskGuidance("autopilot").rules.join(" ")).toContain("review both semantic receipts");
    expect(getAgentTaskGuidance("continue").rules.join(" ")).toContain("Do not recreate");
  });
});
