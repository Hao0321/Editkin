import { describe, expect, it } from "vitest";
import { BEAT_MONTAGE_PRESETS_V2, getBeatMontagePresetV2 } from "./beatMontagePresetsV2";
import { beatMontageClockV2, type BeatMontageRequestV2 } from "./beatMontageCompilerV2";

const request = (): BeatMontageRequestV2 => ({ targetTrackId: "video-main", idPrefix: "candidate",
  beats: Array.from({ length: 13 }, (_, i) => ({ timeSeconds: i * .5, energy: [.2, .4, .8, 1][i % 4], downbeat: i % 4 === 0 })),
  pace: { lowThreshold: .5, highThreshold: .9 }, candidates: [{ shotId: "shot", assetId: "video", sourceStart: 0, sourceEnd: 8, salience: 1, storyOrder: 0 }],
  music: { assetId: "music", trackId: "audio-main", clipId: "music", sourceStart: 0, sourceSha256: "a".repeat(64), rightsEvidenceRefs: ["owner-source"] } });

describe("explicit unapproved montage pace candidates", () => {
  it("provides three immutable candidates without certification or default eligibility", () => {
    expect(BEAT_MONTAGE_PRESETS_V2.map(p => p.id)).toEqual(["travel", "food", "hype"]);
    expect(BEAT_MONTAGE_PRESETS_V2.every(p => Object.isFrozen(p) && !p.defaultEnabled && !p.vaDefaultEligible && p.qualityState === "ART_PENDING_CLAUDE")).toBe(true);
  });
  it("creates distinct declared cut density on a fixed measured-level pattern", () => {
    const counts = BEAT_MONTAGE_PRESETS_V2.map(p => beatMontageClockV2({ ...request(), pace: { lowThreshold: p.lowThreshold, highThreshold: p.highThreshold } }, 24).slots.length);
    expect(counts).toEqual([12, 15, 18]);
  });
  it.each(["auto", "gaming", "", null])("does not infer a style or silently fall back from %s", style => {
    expect(() => getBeatMontagePresetV2(style)).toThrow();
  });
  it("keeps food/travel authored flashes disabled in their candidate policy", () => {
    expect(getBeatMontagePresetV2("travel").authoredFlashAllowed).toBe(false);
    expect(getBeatMontagePresetV2("food").authoredFlashAllowed).toBe(false);
    expect(getBeatMontagePresetV2("hype").authoredFlashAllowed).toBe(true);
  });
});
