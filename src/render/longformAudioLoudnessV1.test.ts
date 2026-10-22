import { describe, expect, it } from "vitest";
import { LONGFORM_AUDIO_TARGET_V1, longformAudioMeasurementFilterV1, longformAudioSecondPassFilterV1, longformAudioPeakCompensationV1,
  parseLongformEbur128V1, parseLongformLoudnormV1, parseLongformPcmProbeV1 } from "./longformAudioLoudnessV1";

const statistics = { input_i: "-22.10", input_tp: "-10.20", input_lra: "4.30", input_thresh: "-32.10",
  output_i: "-14.00", output_tp: "-2.10", output_lra: "4.30", output_thresh: "-24.00", normalization_type: "linear", target_offset: "0.03" };
const probe = { streams: [{ codec_type: "audio", codec_name: "pcm_s24le", sample_rate: "48000", channels: 2,
  time_base: "1/48000", duration_ts: 144000 }], format: { duration: "3.000000" } };
const summary = "Summary:\n Integrated loudness:\n I: -14.0 LUFS\n Threshold: -24.0 LUFS\n\n Loudness range:\n LRA: 4.3 LU\n\n True peak:\n Peak: -2.1 dBFS";

describe("longform two-pass mastering parameters and actual-diagnostic parsers (synthetic text)", () => {
  it("uses all five first-pass derived parameters with the explicit longform target", () => {
    const measured = parseLongformLoudnormV1(JSON.stringify(statistics, null, 2));
    expect(measured.input).toEqual({ integratedLufs: -22.1, truePeakDbtp: -10.2, loudnessRangeLu: 4.3, thresholdLufs: -32.1 });
    expect(longformAudioSecondPassFilterV1(measured)).toBe("loudnorm=I=-14:LRA=11:TP=-1.5:measured_I=-22.1:measured_TP=-10.2:measured_LRA=4.3:measured_thresh=-32.1:offset=0.03:linear=true:print_format=json");
    expect(longformAudioMeasurementFilterV1).toContain("I=-14:LRA=11:TP=-1.5");
    expect(Object.isFrozen(LONGFORM_AUDIO_TARGET_V1)).toBe(true);
  });
  it("rejects missing, repeated, silent and nonfinite first-pass data without a single-pass fallback", () => {
    for (const input of ["", JSON.stringify(statistics) + JSON.stringify(statistics), JSON.stringify({ ...statistics, input_i: "-inf" }),
      JSON.stringify({ ...statistics, target_offset: "NaN" }), JSON.stringify({ ...statistics, output_tp: undefined })]) {
      expect(() => parseLongformLoudnormV1(input)).toThrow();
    }
    const measured = parseLongformLoudnormV1(JSON.stringify(statistics)); measured.input.truePeakDbtp = NaN;
    expect(() => longformAudioSecondPassFilterV1(measured)).toThrow(/PARAMETERS_INVALID/);
  });
  it("requires one complete ebur128 output summary and reports its measured precision", () => {
    expect(parseLongformEbur128V1(summary)).toEqual({ integratedLufs: -14, loudnessRangeLu: 4.3, truePeakDbtp: -2.1, reportedPrecisionDb: .1 });
    expect(() => parseLongformEbur128V1(summary + summary)).toThrow(/NOT_UNIQUE/);
    expect(() => parseLongformEbur128V1(summary.replace("Peak: -2.1", "Peak: -inf"))).toThrow();
  });
  it("derives delivery peak headroom from both actual diagnostic precisions and preserves the declared target", () => {
    const first = parseLongformLoudnormV1(JSON.stringify({ ...statistics, output_tp: "-1.50" }));
    const delivered = parseLongformEbur128V1(summary.replace("Peak: -2.1", "Peak: -1.4"));
    const compensation = longformAudioPeakCompensationV1(first, delivered);
    expect(first.outputPeakPrecisionDb).toBe(.01);
    expect(compensation.headroomDb).toBeCloseTo(.155, 12);
    expect(compensation.internalTruePeakDbtp).toBeCloseTo(-1.655, 12);
    expect(compensation.deliveryTargetDbtp).toBe(-1.5);
    expect(longformAudioSecondPassFilterV1(first, compensation.internalTruePeakDbtp)).toContain("TP=-1.655");
  });
  it("derives the exact sample clock only from one48kHz stereo PCM stream and rejects incompatible media", () => {
    expect(parseLongformPcmProbeV1(JSON.stringify(probe))).toMatchObject({ samples: 144000, durationSeconds: 3, channels: 2, sampleRate: 48000 });
    for (const stream of [{ ...probe.streams[0], codec_type: "video" }, { ...probe.streams[0], channels: 1 },
      { ...probe.streams[0], sample_rate: "44100" }, { ...probe.streams[0], duration_ts: 144000.5 }]) {
      expect(() => parseLongformPcmProbeV1(JSON.stringify({ ...probe, streams: [stream] }))).toThrow();
    }
    expect(() => parseLongformPcmProbeV1(JSON.stringify({ ...probe, streams: [probe.streams[0], probe.streams[0]] }))).toThrow();
  });
});
