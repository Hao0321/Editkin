import { describe, expect, it } from "vitest";
import { aacExactWindowClockV1, audioVideoBoundaryPeriodV1, exactAudioSamplesV1, readAacLcConfigurationV1, verifyAacCutDecodedIdentityV1 } from "./aacPacketClockV1";
const config = () => readAacLcConfigurationV1(Buffer.from("119056e500", "hex"));
describe("AAC exact sample clock and measured decoded-identity admission", () => {
  it("reads realLC48k/stereo ASC but explicitly does not infer PNS absence", () => {
    const c=config();expect(c.sampleRate).toBe(48000);expect(c.channels).toBe(2);expect(c.frameSamples).toBe(1024);expect(c.pnsAbsenceProven).toBe(false);
    expect(readAacLcConfigurationV1(Buffer.from("1210", "hex")).sampleRate).toBe(44100);
  });
  it("rejects short/unsupported profiles/layouts/SBR and frame/core extensions", () => {
    for(const hex of ["11","2990","11a8","1191","119056e580","119156e500"])expect(()=>readAacLcConfigurationV1(Buffer.from(hex,"hex"))).toThrow();
  });
  it("maps exact rational ticks beyond2^32 without truncation and refuses fractional samples", () => {
    expect(exactAudioSamplesV1(5000000000,{numerator:1,denominator:48000},48000)).toBe(5000000000);
    expect(()=>exactAudioSamplesV1(1,{numerator:1,denominator:15360},48000)).toThrow("NOT_EXACT_SAMPLE");
    expect(()=>exactAudioSamplesV1(Number.MAX_SAFE_INTEGER,{numerator:2,denominator:1},48000)).toThrow("INDEX_UNSAFE");
  });
  it("records exact8s→12.2666667 window and selects a sample-exact movie timescale", () => {
    const c=config(),clock=aacExactWindowClockV1(122880,188416,{numerator:1,denominator:15360},c);
    expect(clock.startSample).toBe(384000);expect(clock.endSample).toBe(588800);expect(clock.sampleCount).toBe(204800);expect(clock.expectedFloatBytes).toBe(1638400);expect(clock.movieTimescale).toBe(48000);
  });
  it("does not align a non-packet cut silently even if it lies on a video frame", () => {
    expect(()=>aacExactWindowClockV1(30720,53760,{numerator:1,denominator:15360},config())).toThrow("NOT_PACKET_ALIGNED");
    expect(audioVideoBoundaryPeriodV1(30,1,config())).toEqual({audioSamples:"25600",videoFrames:"16",seconds:"25600/48000",requestedCutMayBeShifted:false});
  });
  it("admits only completed exact samples, channel/rate, PCM hash AND container sample duration", () => {
    const c=config(),clock=aacExactWindowClockV1(122880,188416,{numerator:1,denominator:15360},c),w={bytes:1638400,samples:204800,channels:2,sampleRate:48000,sha256:"a".repeat(64),complete:true};
    expect(verifyAacCutDecodedIdentityV1(clock,c,w,w,204800).audioDecodedFloatSamplesExact).toBe(true);
    expect(()=>verifyAacCutDecodedIdentityV1(clock,c,w,{...w,sha256:"b".repeat(64)},204800)).toThrow("IDENTITY_MISMATCH");
    expect(()=>verifyAacCutDecodedIdentityV1(clock,c,w,w,204768)).toThrow("DURATION_SAMPLE_MISMATCH");
    for(const bad of [{...w,samples:204799},{...w,bytes:w.bytes-8},{...w,channels:1},{...w,sampleRate:44100},{...w,complete:false}])expect(()=>verifyAacCutDecodedIdentityV1(clock,c,w,bad,204800)).toThrow("SAMPLE_SHAPE_MISMATCH");
  });
});
