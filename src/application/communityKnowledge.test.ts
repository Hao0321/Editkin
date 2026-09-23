import { describe, expect, it } from "vitest";
import { communityKnowledgeIdentity, listCommunityKnowledge, readCommunityKnowledge } from "./communityKnowledge";
import { communityKnowledgeSummary } from "./communityKnowledgeSummary";

describe("community editing knowledge", () => {
  it("keeps its checked summary bound to the public pack", () => {
    const summary = communityKnowledgeSummary();
    expect(summary.includedModuleCount).toBeGreaterThan(0);
    expect(summary.sourceFileCount).toBe(summary.includedModuleCount + summary.excludedSourceCount);
    expect(communityKnowledgeIdentity()).toMatchObject({
      packSha256: summary.packSha256,
      stableRulesSha256: summary.stableRulesSha256,
      stableRuleCount: summary.stableRuleCount,
      includedModuleCount: summary.includedModuleCount,
    });
  });

  it("reads content in bounded pages", () => {
    const result = listCommunityKnowledge({ tags: ["color"], limit: 2 });
    expect(result.modules.length).toBeGreaterThan(0);
    expect(result.modules.length).toBeLessThanOrEqual(2);
    const page = readCommunityKnowledge(result.modules[0].id, 0, 800, 700);
    expect(page.text.length).toBeLessThanOrEqual(800);
    expect(page.estimatedTokens).toBeLessThanOrEqual(700);
    expect(page.totalCharacters).toBeGreaterThan(0);
  });

  it("paginates without returning past the module boundary", () => {
    const summary = communityKnowledgeSummary();
    const first = listCommunityKnowledge({ offset: 0, limit: 16 });
    expect(first.modules.length).toBe(Math.min(16, summary.includedModuleCount));
    expect(first.totalModules).toBe(summary.includedModuleCount);
    if (first.nextOffset !== undefined) {
      const second = listCommunityKnowledge({ offset: first.nextOffset, limit: 16 });
      expect(second.modules.length).toBe(Math.max(0, Math.min(16, summary.includedModuleCount - first.nextOffset)));
      if (second.modules.length) expect(second.modules[0].id).not.toBe(first.modules[0].id);
    } else {
      expect(first.modules.length).toBe(summary.includedModuleCount);
    }
  });
});
