import { describe, expect, it } from "vitest";
import { compilePitchPreservingAudioPlanV1, assertPitchPreservingAudioPlanV1, checkPitchAudioClockFrameV1 } from "./pitchPreservingAudioPlanV1";
import { assertPitchSourceEligibilityV1, assertPitchOutputPeakV1 } from "./pitchSourcePcmStatsV1";
const stream = { sample_rate: "48000", channels: 2, channel_layout: "stereo", time_base: "1/48000", start_pts: 0, start_time: "0.000000" };
function input(speed = 2, atempo = [2]) { return { sourceStartSeconds: 2, consumedSourceSeconds: speed, timelineDurationSeconds: 1, direction: "forward" as const,
  mode: "pitch_preserving_constant", speed, atempo, volume: 1, stream }; }
describe("constant audio sample-clock policy", () => {
  it("binds exact source sample window, duration, samplerate/layout and atempo product", () => {
    const p = compilePitchPreservingAudioPlanV1(input()); expect(p.sourceStartSample).toBe(96000); expect(p.sourceEndSample).toBe(192000); expect(p.outputSamples).toBe(48000);
    expect(p.processingFilter).toContain("rubberband=tempo=2:pitch=1"); expect(p.processingFilter).toContain("channels=apart"); expect(p.muxFilter).toContain("apad=whole_len=48000,atrim=end_sample=48000"); expect(p.channels).toBe(2);
    expect(Object.isFrozen(p)).toBe(true); expect(Object.isFrozen(p.tempo)).toBe(true); expect(() => assertPitchPreservingAudioPlanV1({ ...p })).toThrow("AUTHENTIC_PLAN");
    const identity = compilePitchPreservingAudioPlanV1(input(1, [1])); expect(identity.processingEngine).toBe("identity_pcm_v1"); expect(identity.processingFilter).not.toContain("rubberband");
  });
  it("chains fast/slow supported rates, rounds physical boundaries by at most half a sample", () => {
    for (const [speed, tempo] of [[4, [2, 2]], [1 / 64, Array(6).fill(.5)]] as const) expect(compilePitchPreservingAudioPlanV1(input(speed, [...tempo])).speed).toBe(speed);
    const p = compilePitchPreservingAudioPlanV1({ ...input(1, [1]), sourceStartSeconds: .123456, consumedSourceSeconds: 1001 / 30000, timelineDurationSeconds: 1001 / 30000 });
    for (const v of Object.values(p.boundaryRoundingSamples)) expect(Math.abs(v)).toBeLessThanOrEqual(.5);
  });
  it("rejects curve/reverse, invalid or false tempo, volume and missing source span", () => {
    for (const v of [{ ...input(), direction: "reverse" as const }, { ...input(), mode: "follow_speed" }, { ...input(), atempo: [4] },
      { ...input(), atempo: [1] }, { ...input(), volume: 3 }, { ...input(), consumedSourceSeconds: 1 }, { ...input(), speed: NaN }]) expect(() => compilePitchPreservingAudioPlanV1(v)).toThrow();
  });
  it("rejects unknown origin/rate/layout and clock precision that cannot prove synchronization", () => {
    for (const changed of [{ start_pts: null }, { start_time: undefined }, { start_pts: 1 }, { time_base: "1/10" }, { sample_rate: 0 }, { channels: 6, channel_layout: "5.1" }, { channel_layout: "mono" }]) {
      expect(() => compilePitchPreservingAudioPlanV1({ ...input(), stream: { ...stream, ...changed } })).toThrow();
    }
  });
  it("accepts contiguous decoded clocks and rejects one missing sample/renamed channel shape", () => {
    const p = compilePitchPreservingAudioPlanV1(input()), state = { samples: 0, frames: 0 };
    checkPitchAudioClockFrameV1("pts=0|best_effort_timestamp=0|nb_samples=1024|channels=2|channel_layout=stereo", p, state);
    checkPitchAudioClockFrameV1("pts=1024|best_effort_timestamp=1024|nb_samples=1024|channels=2|channel_layout=stereo", p, state); expect(state.samples).toBe(2048);
    expect(() => checkPitchAudioClockFrameV1("pts=2049|best_effort_timestamp=2049|nb_samples=1024|channels=2|channel_layout=stereo", p, state)).toThrow("GAP");
    expect(() => checkPitchAudioClockFrameV1("pts=2048|best_effort_timestamp=2048|nb_samples=1024|channels=1|channel_layout=mono", p, state)).toThrow("SHAPE");
  });
  it("accepts only representable half-tick quantization for a millisecond audio timebase", () => {
    const p = compilePitchPreservingAudioPlanV1({ ...input(), stream: { ...stream, time_base: "1/1000" } }), state = { samples: 0, frames: 0 };
    checkPitchAudioClockFrameV1("pts=0|best_effort_timestamp=0|nb_samples=1024|channels=2|channel_layout=stereo", p, state);
    checkPitchAudioClockFrameV1("pts=21|best_effort_timestamp=21|nb_samples=1024|channels=2|channel_layout=stereo", p, state); expect(state.frames).toBe(2);
    expect(() => checkPitchAudioClockFrameV1("pts=44|best_effort_timestamp=44|nb_samples=1024|channels=2|channel_layout=stereo", p, state)).toThrow("GAP");
  });
  it("known opposed stereo and abnormal processing amplification cannot pass publication eligibility", () => {
    const p = compilePitchPreservingAudioPlanV1(input()), stats = { samples: 96000, channels: 2, sampleRate: 48000, channelPeaks: [.3, .3], centeredStereoCorrelation: -.999999 };
    expect(() => assertPitchSourceEligibilityV1(p, stats)).toThrow("OPPOSITE_PHASE_CONSUMER_REQUIRED");
    const separate = { ...stats, centeredStereoCorrelation: 0 }; expect(() => assertPitchOutputPeakV1(p, separate, [.31, .32])).not.toThrow();
    expect(() => assertPitchOutputPeakV1(p, separate, [.31, 128])).toThrow("PROCESSING_PEAK_CHANGED");
    const unity = compilePitchPreservingAudioPlanV1(input(1, [1])); expect(() => assertPitchSourceEligibilityV1(unity, { ...stats, samples: 48000 })).not.toThrow();
  });
});
