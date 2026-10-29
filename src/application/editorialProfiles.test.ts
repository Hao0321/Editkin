import { describe, expect, it } from "vitest";
import { EDITORIAL_PROFILES, editorialProfile } from "./editorialProfiles";

describe("editorial profiles", () => {
  it("keeps each beginner choice unique and executable", () => {
    expect(new Set(EDITORIAL_PROFILES.map((profile) => profile.id)).size).toBe(EDITORIAL_PROFILES.length);
    for (const profile of EDITORIAL_PROFILES.filter((item) => item.id !== "auto" && item.id !== "music_mv")) {
      expect(profile.captionPresetId).toBeTruthy();
      expect(profile.lookPresetId).toBeTruthy();
      expect(profile.transitionPresetId).toBeTruthy();
    }
  });

  it("routes illustrated MV to original layered animation without stock footage caption/look defaults", () => {
    const mv = editorialProfile("music_mv");
    expect(mv.promptHint).toContain("prepare_illustrated_music_video_draft");
    expect(mv.promptHint).toContain("不得用實拍歌詞卡冒充");
    expect(mv.captionPresetId).toBeUndefined();
    expect(mv.lookPresetId).toBeUndefined();
  });

  it("separates on-camera speaker direction from the no-face evidence policy", () => {
    expect(editorialProfile("podcast_on_camera").visualPolicy).toBe("speaker_director");
    expect(editorialProfile("podcast_no_face").visualPolicy).toBe("no_face_documentary");
  });
});
