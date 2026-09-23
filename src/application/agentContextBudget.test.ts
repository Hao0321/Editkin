import { describe, expect, it } from "vitest";
import { estimateAgentContextTokens, paginateAgentRows, sliceTextToAgentBudget } from "./agentContextBudget";

describe("agent context budget", () => {
  it("charges non-ASCII conservatively and slices without exceeding the budget", () => {
    expect(estimateAgentContextTokens("abcdefgh")).toBe(2);
    expect(estimateAgentContextTokens("中文測試")).toBe(4);
    const page = sliceTextToAgentBudget("中文測試".repeat(500), 0, 6_000, 200);
    expect(page.estimatedTokens).toBeLessThanOrEqual(200);
    expect(page.nextOffset).toBeDefined();
  });

  it("returns a stable cursor for bounded row pages", () => {
    const first = paginateAgentRows(Array.from({ length: 100 }, (_, index) => index), 0, 16);
    expect(first.page).toEqual(Array.from({ length: 16 }, (_, index) => index));
    expect(first.nextOffset).toBe(16);
    const last = paginateAgentRows(Array.from({ length: 10 }, (_, index) => index), 8, 16);
    expect(last.page).toEqual([8, 9]);
    expect(last.nextOffset).toBeUndefined();
  });
});
