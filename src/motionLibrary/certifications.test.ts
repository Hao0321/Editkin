import { describe, expect, it } from "vitest";
import { MOTION_LIBRARY_CATALOG, findMotionLibraryItem, listMotionLibraryItems } from "./catalog";
import { MOTION_ART_CERTIFICATIONS, motionArtStatus } from "./certifications";

describe("motion library art certifications", () => {
  it("pins only registered, implemented items at a revision they have reached", () => {
    for (const [id, revision] of Object.entries(MOTION_ART_CERTIFICATIONS)) {
      const item = findMotionLibraryItem(id);
      expect(item, id).toBeDefined();
      expect(item!.implemented, id).toBe(true);
      expect(Number.isInteger(revision) && revision >= 1, id).toBe(true);
      // A pin above the current revision is a typo; a pin below it is a stale certification (the item reads pending).
      expect(revision, id).toBeLessThanOrEqual(item!.revision ?? 0);
    }
  });

  it("certifies exactly the revision Claude reviewed", () => {
    expect(motionArtStatus("T01", MOTION_ART_CERTIFICATIONS.T01)).toBe("certified");
    expect(motionArtStatus("T01", MOTION_ART_CERTIFICATIONS.T01 + 1)).toBe("pending");
    expect(motionArtStatus("T80", 1)).toBe("pending");
    expect(motionArtStatus("constructor", 1)).toBe("pending");
  });

  it("lists as certified exactly the items whose pin matches their current revision", () => {
    const expected = MOTION_LIBRARY_CATALOG
      .filter(item => item.implemented && MOTION_ART_CERTIFICATIONS[item.id] === item.revision)
      .map(item => item.id);
    expect(listMotionLibraryItems({ artStatus: "certified" }).map(item => item.id)).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);
    for (const item of listMotionLibraryItems({ implemented: false })) expect(item.artStatus, item.id).toBe("pending");
  });
});
