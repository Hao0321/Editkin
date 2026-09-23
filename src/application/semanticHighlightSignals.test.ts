import { describe, expect, it } from "vitest";
import { analyzeSemanticHighlightSignals } from "./semanticHighlightSignals";

describe("semantic highlight signals", () => {
  it("separates useful proof from promotional keyword bait", () => {
    const proof = analyzeSemanticHighlightSignals("清空快取再測三輪，掉幀從四十七次變成六次。");
    const bait = analyzeSemanticHighlightSignals("最後提醒最重要的方法都在資訊欄，記得按讚訂閱。");
    expect(proof.roles).toEqual(expect.arrayContaining(["method", "evidence"]));
    expect(proof.bonus - proof.penalty).toBeGreaterThan(0.3);
    expect(bait.roles).toContain("housekeeping");
    expect(bait.penalty).toBeGreaterThan(bait.bonus);
  });

  it("marks explicitly invalid results without discarding the later correction", () => {
    const invalid = analyzeSemanticHighlightSignals("That was not the real result and must not be used as the conclusion.");
    const corrected = analyzeSemanticHighlightSignals("After clearing the cache, the median fell from eighteen seconds to eleven.");
    expect(invalid.roles).toContain("invalidated");
    expect(invalid.penalty).toBeGreaterThan(0.6);
    expect(corrected.roles).toContain("evidence");
    expect(corrected.roles).not.toContain("invalidated");
  });
});
