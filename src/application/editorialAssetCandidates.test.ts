import { describe, expect, it } from "vitest";
import { parseAutopilotPlan } from "./autopilotPlan";
import { createAutopilotV4Fixture } from "./autopilotPlanFixture";

function planWithCandidates(candidateIds: string[]) {
  const plan = createAutopilotV4Fixture();
  return { ...plan, budget: { ...plan.budget, assetCandidateCount: candidateIds.length },
    editorial: { ...plan.editorial, assets: { ...plan.editorial.assets, candidateIds } } };
}

describe("editorial asset candidate identities", () => {
  it("preserves namespaced IDs returned by the creative library without inventing aliases", () => {
    const ids = ["music:0123456789abcdefabcd", "broll:0123456789ab", "sfx:0123456789ab", "source-clip_1"];
    const plan = parseAutopilotPlan(planWithCandidates(ids));
    expect("editorial" in plan && plan.editorial.assets.candidateIds).toEqual(ids);
  });

  it.each(["", " music:abc", "music:abc ", "music:", ":abc", "music::abc", "music:a/b", "music:a\\b",
    "D:\\media\\a.mp3", "https://example.test/a.mp3", "creative://studio.hao.creator-library/music%3Aabc",
    "music:..", "music:%2e%2e", "music:a b", "music:a\nb", `music:${"a".repeat(128)}`])("rejects paths, URLs and malformed IDs: %s", id => {
    expect(() => parseAutopilotPlan(planWithCandidates([id]))).toThrow();
  });

  it("does not relax beat or graphic identifiers", () => {
    const plan = createAutopilotV4Fixture();
    const invalid = { ...plan, editorial: { ...plan.editorial, narrative: { ...plan.editorial.narrative,
      beats: plan.editorial.narrative.beats.map((beat, index) => index === 0 ? { ...beat, id: "music:0123456789ab" } : beat),
    } } };
    expect(() => parseAutopilotPlan(invalid)).toThrow();
  });
});
