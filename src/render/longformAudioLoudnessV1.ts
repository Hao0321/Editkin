export const LONGFORM_AUDIO_TARGET_V1 = Object.freeze({ integratedLufs: -14, truePeakDbtp: -1.5, loudnessRangeLu: 11 });

export interface LongformLoudnessValuesV1 {
  integratedLufs: number; truePeakDbtp: number; loudnessRangeLu: number; thresholdLufs: number;
}
export interface LongformLoudnormStatisticsV1 {
  input: LongformLoudnessValuesV1; output: LongformLoudnessValuesV1;
  normalizationType: "linear" | "dynamic"; targetOffset: number; outputPeakPrecisionDb: number;
}
const finiteStatistic = (value: unknown): number => {
  if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value))) {
    throw new Error("LONGFORM_AUDIO_MEASUREMENT_MISSING_OR_SILENT");
  }
  return Number(value);
};

/** Parse only actual FFmpeg diagnostics. The runtime never accepts caller-provided statistics. */
export function parseLongformLoudnormV1(stderr: string): LongformLoudnormStatisticsV1 {
  const records = stderr.match(/\{\s*"input_i"\s*:[^{}]*\}/g);
  if (records?.length !== 1) throw new Error("LONGFORM_AUDIO_MEASUREMENT_NOT_UNIQUE");
  const data = JSON.parse(records[0]) as Record<string, unknown>;
  const values = (prefix: string): LongformLoudnessValuesV1 => ({
    integratedLufs: finiteStatistic(data[`${prefix}_i`]), truePeakDbtp: finiteStatistic(data[`${prefix}_tp`]),
    loudnessRangeLu: finiteStatistic(data[`${prefix}_lra`]), thresholdLufs: finiteStatistic(data[`${prefix}_thresh`]),
  });
  if (data.normalization_type !== "linear" && data.normalization_type !== "dynamic") throw new Error("LONGFORM_AUDIO_NORMALIZATION_TYPE_MISSING");
  const output = values("output"), peakDecimals = String(data.output_tp).split(".")[1]?.length ?? 0;
  return { input: values("input"), output, normalizationType: data.normalization_type, targetOffset: finiteStatistic(data.target_offset),
    outputPeakPrecisionDb: 10 ** -peakDecimals };
}

export const longformAudioMeasurementFilterV1 = "loudnorm=I=-14:LRA=11:TP=-1.5:print_format=json";
// Measure first-pass delivery after the same48kHz/stereo integer-sample conversion used by the PCM master.
export const longformAudioDeliveryMeasurementFilterV1 = longformAudioMeasurementFilterV1
  + ",aresample=48000,aformat=sample_fmts=s32:channel_layouts=stereo,ebur128=framelog=verbose:peak=true";
export function longformAudioSecondPassFilterV1(measured: LongformLoudnormStatisticsV1, internalTruePeakDbtp: number = LONGFORM_AUDIO_TARGET_V1.truePeakDbtp): string {
  const numbers = [...Object.values(measured.input), measured.targetOffset, internalTruePeakDbtp];
  if (!numbers.every(Number.isFinite)) throw new Error("LONGFORM_AUDIO_MEASURED_PARAMETERS_INVALID");
  if (internalTruePeakDbtp > LONGFORM_AUDIO_TARGET_V1.truePeakDbtp) throw new Error("LONGFORM_AUDIO_INTERNAL_PEAK_EXCEEDS_TARGET");
  return `loudnorm=I=-14:LRA=11:TP=${internalTruePeakDbtp}:measured_I=${measured.input.integratedLufs}:measured_TP=${measured.input.truePeakDbtp}`
    + `:measured_LRA=${measured.input.loudnessRangeLu}:measured_thresh=${measured.input.thresholdLufs}`
    + `:offset=${measured.targetOffset}:linear=true:print_format=json`;
}

export function parseLongformEbur128V1(stderr: string) {
  if (stderr.match(/Summary:/g)?.length !== 1) throw new Error("LONGFORM_AUDIO_EBUR128_NOT_UNIQUE");
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const number = (pattern: RegExp): number => finiteStatistic(summary.match(pattern)?.[1]);
  return {
    integratedLufs: number(/Integrated loudness:\s+I:\s+(-?\d+(?:\.\d+)?)\s+LUFS/),
    loudnessRangeLu: number(/Loudness range:\s+LRA:\s+(-?\d+(?:\.\d+)?)\s+LU/),
    truePeakDbtp: number(/True peak:\s+Peak:\s+(-?\d+(?:\.\d+)?)\s+dBFS/),
    reportedPrecisionDb: .1 as const,
  };
}

/** The measured delivery overshoot and diagnostic rounding intervals determine headroom, not a fixed margin. */
export function longformAudioPeakCompensationV1(first: LongformLoudnormStatisticsV1, delivered: ReturnType<typeof parseLongformEbur128V1>) {
  const overshootUpperDb = delivered.truePeakDbtp - first.output.truePeakDbtp
    + delivered.reportedPrecisionDb / 2 + first.outputPeakPrecisionDb / 2;
  if (!Number.isFinite(overshootUpperDb)) throw new Error("LONGFORM_AUDIO_DELIVERY_PEAK_MEASUREMENT_INVALID");
  const headroomDb = Math.max(0, overshootUpperDb);
  return { headroomDb, internalTruePeakDbtp: LONGFORM_AUDIO_TARGET_V1.truePeakDbtp - headroomDb,
    deliveryTargetDbtp: LONGFORM_AUDIO_TARGET_V1.truePeakDbtp };
}

/** This backend consumes a prepared48kHz stereo PCM WAV; exact sample counts preserve its timing. */
export function parseLongformPcmProbeV1(stdout: string) {
  const data = JSON.parse(stdout), streams = data.streams;
  if (!Array.isArray(streams) || streams.length !== 1) throw new Error("LONGFORM_AUDIO_REQUIRES_ONE_PCM_STREAM");
  const stream = streams[0], samples = Number(stream.duration_ts), duration = Number(data.format?.duration);
  if (stream.codec_type !== "audio" || !/^pcm_/.test(String(stream.codec_name)) || Number(stream.sample_rate) !== 48000
    || stream.channels !== 2 || stream.time_base !== "1/48000" || !Number.isSafeInteger(samples) || samples <= 0
    || !Number.isFinite(duration) || Math.abs(duration - samples / 48000) > 1 / 48000) {
    throw new Error("LONGFORM_AUDIO_REQUIRES_48K_STEREO_PCM_WAV");
  }
  return { codecName: String(stream.codec_name), samples, sampleRate: 48000 as const, channels: 2 as const, durationSeconds: samples / 48000 };
}
