import { describe, expect, it } from "vitest";
import { shouldUseNativeFinalAudio } from "./ffmpeg";

describe("bounded native final audio routing", () => {
  const eligible = {
    alphaIntermediate: false,
    nativeCoreReady: true,
    durationSeconds: 30,
    decodableAudioSourceCount: 8,
  };

  it("accepts the documented upper boundary", () => {
    expect(shouldUseNativeFinalAudio(eligible)).toBe(true);
  });

  it.each([
    ["alpha intermediate", { alphaIntermediate: true }],
    ["missing native core", { nativeCoreReady: false }],
    ["long export", { durationSeconds: 30.001 }],
    ["zero duration", { durationSeconds: 0 }],
    ["no decodable audio", { decodableAudioSourceCount: 0 }],
    ["too many sources", { decodableAudioSourceCount: 9 }],
    ["fractional source count", { decodableAudioSourceCount: 1.5 }],
  ])("rejects %s", (_name, change) => {
    expect(shouldUseNativeFinalAudio({ ...eligible, ...change })).toBe(false);
  });
});
