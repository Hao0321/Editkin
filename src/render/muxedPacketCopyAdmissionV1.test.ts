import { describe, expect, it } from "vitest";
import { sourcePreservingFixtureV1 } from "./sourcePreservingV1.fixture";
import { packetCopyProbeFixtureV1 } from "./packetCopyV1.fixture";
import { admitMuxedPacketCopyProjectV1, admitMuxedPacketCopyMediaV1, MUXED_PACKET_COPY_POLICY_V1 } from "./muxedPacketCopyAdmissionV1";
function fixture() {
  const project=sourcePreservingFixtureV1();project.assets[0].duration=20.01;project.tracks[0].clips[0].sourceStart=8;project.tracks[0].clips[0].duration=204800/48000;
  const probe=packetCopyProbeFixtureV1();probe.format.duration="20.010000";probe.streams[0].duration="20.000000";
  probe.streams.push({codec_type:"audio",codec_name:"aac",profile:"LC",sample_fmt:"fltp",sample_rate:"48000",channels:2,channel_layout:"stereo",time_base:"1/48000",start_pts:0,start_time:"0.000000",duration_ts:960480,extradata_size:5,extradata:"\n00000000: 1190 56e5 00                             ..V..\n"}as never);
  return{project,probe};
}
describe("muxed exact packet-copy audio admission never assumes codec packet PNS state",()=>{
 it("retains requested window and actual container duration, requires decoded identity",()=>{
  const f=fixture(),before=JSON.stringify(f.project),a=admitMuxedPacketCopyProjectV1(f.project,MUXED_PACKET_COPY_POLICY_V1),m=admitMuxedPacketCopyMediaV1(f.probe,a);
  expect(m.audioClock.startSample).toBe(384000);expect(m.audioClock.sampleCount).toBe(204800);expect(m.audioDecodedIdentityRequired).toBe(true);expect(m.assumedPnsAbsence).toBe(false);expect(JSON.stringify(f.project)).toBe(before);
 });
 it("refuses extra streams, missing/unsupported codec shape, trim mismatch or source-origin recipe",()=>{
  const changes=[(f:ReturnType<typeof fixture>)=>{f.probe.streams.push({codec_type:"audio"}as never);},(f:ReturnType<typeof fixture>)=>{Object.assign(f.probe.streams[1],{profile:"HE-AAC"});},(f:ReturnType<typeof fixture>)=>{Object.assign(f.probe.streams[1],{channels:6,channel_layout:"5.1"});},(f:ReturnType<typeof fixture>)=>{Object.assign(f.probe.streams[1],{duration_ts:380000});},(f:ReturnType<typeof fixture>)=>{f.project.tracks[0].clips[0].sourceStart=0;},(f:ReturnType<typeof fixture>)=>{f.project.tracks[0].clips[0].sourceStart=2;f.project.tracks[0].clips[0].duration=1.5;}];
  for(const change of changes){const f=fixture();change(f);expect(()=>admitMuxedPacketCopyMediaV1(f.probe,admitMuxedPacketCopyProjectV1(f.project,MUXED_PACKET_COPY_POLICY_V1))).toThrow();}
  expect(()=>admitMuxedPacketCopyProjectV1(fixture().project,"auto"as never)).toThrow("EXPLICIT_POLICY");
 });
 it("rejects rounded output duration even when metadata profile and config are identical",()=>{
  const f=fixture();f.project.assets[0].duration=204800/48000;f.project.tracks[0].clips[0].sourceStart=0;f.probe.format.duration="4.266667";f.probe.streams[0].duration="4.266667";Object.assign(f.probe.streams[1],{duration_ts:204768});
  const admission=admitMuxedPacketCopyProjectV1(f.project,MUXED_PACKET_COPY_POLICY_V1);
  expect(()=>admitMuxedPacketCopyMediaV1(f.probe,admission,true)).toThrow("DURATION_SAMPLE_MISMATCH");
  Object.assign(f.probe.streams[1],{duration_ts:204800});expect(admitMuxedPacketCopyMediaV1(f.probe,admission,true).audioDurationSamples).toBe(204800);
 });
});
