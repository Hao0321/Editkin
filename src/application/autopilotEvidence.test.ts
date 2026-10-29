import { describe, expect, it } from "vitest";
import { autopilotOutcomeSchema, learningHandoff } from "./autopilotEvidence";

function event() {
  return {
    schema: "hao.video-autopilot.learning-event/v1",
    planSha256: "a".repeat(64),
    checkpoint: "D2",
    platform: "youtube",
    artifactId: "youtube-main-v1",
    selectedMemoryRuleIds: ["M117"],
    metrics: { views: 100, first30SecondRetentionPercent: 72 },
    review: { accepted: true, severeError: false, note: "開場清楚" },
  } as const;
}

describe("autopilot learning event", () => {
  it("accepts bounded outcome evidence without auto-promotion", () => {
    const parsed = autopilotOutcomeSchema.parse(event());
    expect(learningHandoff(parsed).instruction).toMatch(/Do not auto-promote/);
  });

  it("requires metrics for D2/D7/D28 and rejects duplicate rule ids", () => {
    expect(() => autopilotOutcomeSchema.parse({ ...event(), metrics: {} })).toThrow();
    expect(() => autopilotOutcomeSchema.parse({ ...event(), selectedMemoryRuleIds: ["M117", "M117"] })).toThrow();
  });

  it("records authorized agent review honestly and requires an evidence receipt", () => {
    const agent = { ...event(), checkpoint: "agent_review", metrics: {}, review: { ...event().review, reviewer: "agent", evidenceSha256: "b".repeat(64) } };
    expect(autopilotOutcomeSchema.parse(agent).checkpoint).toBe("agent_review");
    expect(() => autopilotOutcomeSchema.parse({ ...agent, review: { ...agent.review, evidenceSha256: undefined } })).toThrow(/evidence/);
    expect(() => autopilotOutcomeSchema.parse({ ...agent, checkpoint: "human_review" })).toThrow(/human approval/);
    expect(() => autopilotOutcomeSchema.parse({ ...agent, review: { ...agent.review, reviewer: "human" } })).toThrow(/agent reviewer/);
  });
});
