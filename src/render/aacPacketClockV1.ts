import { createHash } from "node:crypto";
import { packetTimeKeyV1, type PacketTimebaseV1 } from "./sourcePacketV1";

export interface AacConfigV1 { sampleRate: 44100 | 48000; channels: 1 | 2; frameSamples: 1024; configSha256: string; pnsAbsenceProven: false }
/** ASC advertises codec/rate/layout, but never proves the absence of packet-level PNS. */
export function readAacLcConfigurationV1(data: Uint8Array): AacConfigV1 {
  if (data.length < 2 || data.length > 64) throw Error("AAC_ASC_SIZE_UNSUPPORTED");
  let position = 0;
  const bits = (count: number) => {
    if (position + count > data.length * 8) throw Error("AAC_ASC_TRUNCATED");
    let value = 0; for (let i = 0; i < count; i++, position++) value = value * 2 + ((data[Math.floor(position / 8)] >> (7 - position % 8)) & 1);
    return value;
  };
  const objectType = bits(5), rateIndex = bits(4), channels = bits(4);
  if (objectType !== 2 || ![3, 4].includes(rateIndex) || ![1, 2].includes(channels)) throw Error("AAC_PROFILE_RATE_LAYOUT_UNSUPPORTED");
  if (bits(1) || bits(1) || bits(1)) throw Error("AAC_FRAME_CORE_EXTENSION_UNSUPPORTED");
  if (data.length * 8 - position >= 16) {
    const extensionType = bits(11), extensionObject = bits(5);
    if (extensionType !== 0x2b7 || extensionObject !== 5 || bits(1)) throw Error("AAC_SBR_EXTENSION_UNSUPPORTED");
  }
  while (position < data.length * 8) if (bits(1)) throw Error("AAC_ASC_TRAILING_EXTENSION_UNSUPPORTED");
  return { sampleRate: rateIndex === 3 ? 48000 : 44100, channels: channels as 1 | 2, frameSamples: 1024,
    configSha256: createHash("sha256").update(data).digest("hex"), pnsAbsenceProven: false };
}
function safe(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw Error(`AAC_${label}_UNSAFE`); return value;
}
function gcd(a: bigint, b: bigint) { while (b) { const r = a % b; a = b; b = r; } return a; }
/** Rational seconds to samples without a32-bit/float intermediate or implicit rounding. */
export function exactAudioSamplesV1(ticks: number, timebase: PacketTimebaseV1, sampleRate: number) {
  safe(ticks, "TICKS"); safe(sampleRate, "RATE"); if (!sampleRate || ![timebase.numerator, timebase.denominator].every(v => Number.isSafeInteger(v) && v > 0)) throw Error("AAC_TIMEBASE_UNSUPPORTED");
  const numerator = BigInt(ticks) * BigInt(timebase.numerator) * BigInt(sampleRate), denominator = BigInt(timebase.denominator);
  if (numerator % denominator) throw Error("AAC_CUT_NOT_EXACT_SAMPLE");
  const samples = numerator / denominator; if (samples > BigInt(Number.MAX_SAFE_INTEGER)) throw Error("AAC_SAMPLE_INDEX_UNSAFE"); return Number(samples);
}
export function aacExactWindowClockV1(startTicks: number, endTicks: number, videoTimebase: PacketTimebaseV1, config: AacConfigV1) {
  const start = exactAudioSamplesV1(startTicks, videoTimebase, config.sampleRate), end = exactAudioSamplesV1(endTicks, videoTimebase, config.sampleRate);
  if (end <= start) throw Error("AAC_WINDOW_INVALID");
  if (start % config.frameSamples || end % config.frameSamples) throw Error("AAC_CUT_NOT_PACKET_ALIGNED_REQUIRES_BOUNDARY_RENDER");
  const sampleCount = end - start; safe(sampleCount * config.channels * 4, "FLOAT_BYTES");
  // A movie timescale equal to the rate represents every audio sample exactly.
  return { startSample: start, endSample: end, sampleCount, expectedFloatBytes: sampleCount * config.channels * 4,
    durationRational: packetTimeKeyV1(sampleCount, { numerator: 1, denominator: config.sampleRate }), movieTimescale: config.sampleRate,
    decodedIdentityRequired: true, codecPnsAssumedAbsent: false };
}
export interface AudioDecodeWitnessV1 { bytes: number; samples: number; channels: number; sampleRate: number; sha256: string; complete: boolean }
export function verifyAacCutDecodedIdentityV1(clock: ReturnType<typeof aacExactWindowClockV1>, config: AacConfigV1,
  reference: AudioDecodeWitnessV1, output: AudioDecodeWitnessV1, outputDurationSamples: number) {
  for (const witness of [reference, output]) {
    if (!witness.complete || witness.sampleRate !== config.sampleRate || witness.channels !== config.channels || witness.bytes !== clock.expectedFloatBytes
      || witness.samples !== clock.sampleCount || !/^[a-f0-9]{64}$/.test(witness.sha256)) throw Error("AAC_DECODE_SAMPLE_SHAPE_MISMATCH");
  }
  if (outputDurationSamples !== clock.sampleCount) throw Error("AAC_CONTAINER_DURATION_SAMPLE_MISMATCH");
  if (reference.sha256 !== output.sha256) throw Error("AAC_DECODED_SAMPLE_IDENTITY_MISMATCH");
  return { audioDecodedFloatSamplesExact: true, samples: clock.sampleCount, channels: config.channels,
    sampleRate: config.sampleRate, decodedSha256: reference.sha256, originalAudioEncodingPasses: 0,
    pnsAbsenceProven: false, qualityCertified: false };
}
/** Rational intersection useful for future video/AAC packet-boundary planning; never moves a requested cut. */
export function audioVideoBoundaryPeriodV1(videoRateNumerator: number, videoRateDenominator: number, config: AacConfigV1) {
  if (![videoRateNumerator, videoRateDenominator].every(v => Number.isSafeInteger(v) && v > 0)) throw Error("AAC_VIDEO_RATE_UNSUPPORTED");
  const videoNumerator = BigInt(videoRateDenominator) * BigInt(config.sampleRate), videoDenominator = BigInt(videoRateNumerator);
  const common = gcd(videoNumerator, videoDenominator), numerator = videoNumerator / common, denominator = videoDenominator / common;
  const period = numerator * BigInt(config.frameSamples) / gcd(numerator, BigInt(config.frameSamples));
  return { audioSamples: period.toString(), videoFrames: (period * denominator / numerator).toString(),
    seconds: `${period}/${config.sampleRate}`, requestedCutMayBeShifted: false };
}
