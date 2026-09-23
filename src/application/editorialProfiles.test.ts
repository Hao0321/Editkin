import { describe, expect, it } from "vitest";
import { EDITORIAL_PROFILES, editorialProfile } from "./editorialProfiles";

describe("editorial profiles", () => {
  it("keeps each beginner choice unique and executable", () => {
    expect(new Set(EDITORIAL_PROFILES.map((profile) => profile.id)).size).toBe(EDITORIAL_PROFILES.length);
    for (const profile of EDITORIAL_PROFILES.filter((item) => item.id !== "auto")) {
      expect(profile.captionPresetId).toBeTruthy();
      expect(profile.lookPresetId).toBeTruthy();
      expect(profile.transitionPresetId).toBeTruthy();
    }
  });

  it("separates on-camera speaker direction from the no-face evidence policy", () => {
    expect(editorialProfile("podcast_on_camera").visualPolicy).toBe("speaker_director");
    expect(editorialProfile("podcast_no_face").visualPolicy).toBe("no_face_documentary");
  });
});
