import { describe, expect, it } from "vitest";
import { audioSidechainStagesV1, audioTimelineDelayFilterV1 } from "./audioFinalMixV1";
import { continuousAudioFilterV1 } from "./continuousEncoderV1";

describe("shared final audio clock and sidechain tail", () => {
  it.each([[0, "0"], [.031, "31"], [.025, "25"], [1.625, "1625"], [.03125, "1500S"], [1001 / 30000, "1602S"]])(
    "retains the exact48k sample position at%s seconds", (time, spelling) => {
      expect(audioTimelineDelayFilterV1(Number(time))).toBe(`adelay=${spelling}:all=1`);
    });
  it.each([-1, NaN, Infinity])("refuses an invalid audio timeline position%s", value => {
    expect(() => audioTimelineDelayFilterV1(value)).toThrow(/LONG_RENDER_CLOCK_RANGE/);
  });
  it("pads both sidechain inputs and trims the finite master input to its independent audio sample count", () => {
    expect(audioSidechainStagesV1(96480)).toEqual({ voiceSplit: "asplit=2[voiceout][voicekey-source]", musicPad: "apad[musicbus]",
      tail: ["[voicekey-source]apad[voicekey]", "[musicbus][voicekey]sidechaincompress=threshold=0.025:ratio=8:attack=25:release=360:makeup=1[duckedmusic]",
        "[voiceout][duckedmusic]amix=inputs=2:duration=longest:normalize=0,atrim=end_sample=96480[premaster]"] });
  });
  it.each([0, -1, 1.5, Infinity])("refuses an invalid final sample count%s", value => expect(() => audioSidechainStagesV1(value)).toThrow(/AUDIO_FINAL_SAMPLE_CLOCK_INVALID/));
  it("keeps the existing continuous voice/music FFmpeg graph exactly unchanged", () => {
    const legacy = ["[1:a]asplit=2[voiceraw][musicraw]", "[voiceraw]pan=stereo|c0=c0|c1=c1,asplit=2[voiceout][voicekey-source]",
      "[musicraw]pan=stereo|c0=c2|c1=c3,apad[musicbus]", "[voicekey-source]apad[voicekey]",
      "[musicbus][voicekey]sidechaincompress=threshold=0.025:ratio=8:attack=25:release=360:makeup=1[duckedmusic]",
      "[voiceout][duckedmusic]amix=inputs=2:duration=longest:normalize=0,atrim=end_sample=96480[premaster]",
      "[premaster]loudnorm=I=-18:LRA=11:TP=-3,atrim=duration=2.01[aout]"].join(";");
    expect(continuousAudioFilterV1({ hasVoice: true, hasMusic: true }, 2.01, 96480)).toBe(legacy);
  });
});
