import { describe, expect, it } from "vitest";
import { evidenceBoundKeepRanges, timedEvidenceFrameCount } from "./kitSingleClipCut";

const segments = [
  { start: 0, end: 1, summary: "Opening test pattern", evidenceFrameCount: 1 },
  { start: 1, end: 2, summary: "Middle test pattern", evidenceFrameCount: 1 },
  { start: 2, end: 3, summary: "Closing test pattern", evidenceFrameCount: 1 },
];

describe("evidence-bound Smart Cut intent", () => {
  it("accepts only viewed frame IDs whose timestamps fall in the claimed scene", () => {
    const times = new Map([["red", 0.5], ["green", 1.5], ["blue", 2.5]]);
    expect(timedEvidenceFrameCount({ start: 0, end: 1, evidenceFrameIds: ["red"] }, times)).toBe(1);
    expect(timedEvidenceFrameCount({ start: 0, end: 1, evidenceFrameIds: ["green"] }, times)).toBe(0);
    expect(timedEvidenceFrameCount({ start: 0, end: 1, evidenceFrameIds: ["missing"] }, times)).toBe(0);
  });
  it("keeps two reviewed segments and counts the removed interior second", () => {
    expect(evidenceBoundKeepRanges([{ start: 0, end: 1 }, { start: 2, end: 3 }], segments, 3, 30))
      .toEqual({ keepRanges: [{ start: 0, end: 1 }, { start: 2, end: 3 }],
        selectedSummaries: ["Opening test pattern", "Closing test pattern"], frames: 60 });
  });
  it.each([
    [{ start: 0, end: 1 }, { start: 1, end: 2 }],
    [{ start: 0, end: 1 }, { start: 1.5, end: 3 }],
    [{ start: 0, end: 1 }, { start: 2, end: 3.1 }],
    [{ start: 0, end: 1 }, { start: 2.01, end: 3 }],
  ])("rejects no-op or unevidenced range %j", ranges => {
    expect(() => evidenceBoundKeepRanges(ranges, segments, 3, 30)).toThrow();
  });
  it("rejects a semantic segment without a viewed frame", () => {
    const unviewed = segments.map((segment, index) => index === 2 ? { ...segment, evidenceFrameCount: 0 } : segment);
    expect(() => evidenceBoundKeepRanges([{ start: 0, end: 1 }, { start: 2, end: 3 }], unviewed, 3, 30))
      .toThrow(/evidenced/);
  });
});
