import { describe, expect, it } from "vitest";
import { rankStyleShotCandidates, SHOT_SELECTION_STYLES } from "./shotSelectionStyles";

describe("style-aware shot selection", () => {
  it("keeps nine distinct editorial styles with explicit exceptions", () => {
    expect(SHOT_SELECTION_STYLES).toHaveLength(9);
    expect(new Set(SHOT_SELECTION_STYLES.map((item) => item.id)).size).toBe(9);
    expect(SHOT_SELECTION_STYLES.every((item) => item.priorities.length >= 5 && item.exception)).toBe(true);
  });

  it("ranks only relevant, rights-approved, evidence-annotated shots and never auto-applies", () => {
    const result = rankStyleShotCandidates("vlog", [
      { id: "day-in-life", sourceRef: "source:clip1@00:10-00:14", rightsApproved: true, beatPurposeMatched: true,
        observations: [{ signal: "first_person_interaction", evidenceRef: "frame:301" }, { signal: "everyday_action", evidenceRef: "frame:348" }] },
      { id: "polished-logo", sourceRef: "source:clip2@00:01", rightsApproved: true, beatPurposeMatched: true,
        observations: [{ signal: "staged_everyday", evidenceRef: "frame:30" }] },
      { id: "unknown-rights", sourceRef: "source:clip3@00:02", rightsApproved: false, beatPurposeMatched: true,
        observations: [{ signal: "everyday_action", evidenceRef: "frame:60" }] },
      { id: "unsupported", sourceRef: "source:clip4@00:03", rightsApproved: true, beatPurposeMatched: true,
        observations: [{ signal: "everyday_action", evidenceRef: "" }] },
      { id: "wrong-beat", sourceRef: "source:clip5@00:04", rightsApproved: true, beatPurposeMatched: false,
        observations: [{ signal: "everyday_action", evidenceRef: "frame:120" }] },
    ]);
    expect(result).toMatchObject({ evidenceAuthority: "caller_asserted_unverified", directApplyAllowed: false });
    expect(result.rows[0]).toMatchObject({ id: "day-in-life", status: "DRAFT_RANKING_REVIEW_REQUIRED", points: 4 });
    expect(result.rows.slice(1).every((item) => item.points === null)).toBe(true);
  });

  it("recognizes that camera gaze means something different for realism and vlog", () => {
    expect(SHOT_SELECTION_STYLES.find((item) => item.id === "realist")?.exception).toContain("對鏡頭說話");
    expect(SHOT_SELECTION_STYLES.find((item) => item.id === "vlog")?.priorities.some((item) => item.signal === "first_person_interaction")).toBe(true);
  });
});
