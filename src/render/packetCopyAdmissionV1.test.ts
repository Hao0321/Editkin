import { describe, expect, it } from "vitest";
import { admitPacketCopyProjectV1, admitPacketCopyMediaV1, EXACT_PACKET_COPY_POLICY_V1 } from "./packetCopyAdmissionV1";
import { sourcePreservingFixtureV1, sourcePreservingProbeFixtureV1 } from "./sourcePreservingV1.fixture";
import { packetCopyProbeFixtureV1 } from "./packetCopyV1.fixture";
describe("explicit exact-window packet cut admission",()=>{
 it("preserves a requested trim while requiring all original neutral-project checks",()=>{
  const p=sourcePreservingFixtureV1();p.tracks[0].clips[0].sourceStart=.5;p.tracks[0].clips[0].duration=1;const before=JSON.stringify(p);
  const admission=admitPacketCopyProjectV1(p,EXACT_PACKET_COPY_POLICY_V1),media=admitPacketCopyMediaV1(packetCopyProbeFixtureV1(),admission);
  expect(admission.requestedSourceStart).toBe(.5);expect(media.startTicks).toBe(7680);expect(media.endTicks).toBe(23040);
  expect(JSON.stringify(p)).toBe(before);expect(media.fullContainerMetadataPreserved).toBe(false);expect(media.fallbackRequiredForOtherCases).toBe("normal_renderer");
 });
 it("requires explicit policy and refuses effects, out-of-source windows and source derivatives",()=>{
  expect(()=>admitPacketCopyProjectV1(sourcePreservingFixtureV1(),"auto" as never)).toThrow("EXPLICIT_POLICY");
  for(const change of [(p:ReturnType<typeof sourcePreservingFixtureV1>)=>{p.tracks[0].clips[0].duration=3;},(p:ReturnType<typeof sourcePreservingFixtureV1>)=>{p.tracks[0].clips[0].color.exposure=.2;},(p:ReturnType<typeof sourcePreservingFixtureV1>)=>{p.assets[0].clipRetime={} as never;}]){const p=sourcePreservingFixtureV1();change(p);expect(()=>admitPacketCopyProjectV1(p,EXACT_PACKET_COPY_POLICY_V1)).toThrow();}
 });
 it("does not silently drop audio or accept B-frame/codec/config/clock/surface changes",()=>{
  const admission=admitPacketCopyProjectV1(sourcePreservingFixtureV1(),EXACT_PACKET_COPY_POLICY_V1);
  expect(()=>admitPacketCopyMediaV1(sourcePreservingProbeFixtureV1(),admission)).toThrow("AUDIO_OR_OTHER_STREAM");
  for(const change of [(p:ReturnType<typeof packetCopyProbeFixtureV1>)=>{Object.assign(p.streams[0],{has_b_frames:2});},(p:ReturnType<typeof packetCopyProbeFixtureV1>)=>{p.streams[0].codec_name="hevc";},(p:ReturnType<typeof packetCopyProbeFixtureV1>)=>{Object.assign(p.streams[0],{profile:"High"});},(p:ReturnType<typeof packetCopyProbeFixtureV1>)=>{Object.assign(p.streams[0],{start_pts:1024});},(p:ReturnType<typeof packetCopyProbeFixtureV1>)=>{p.streams[0].color_transfer="smpte2084";},(p:ReturnType<typeof packetCopyProbeFixtureV1>)=>{Object.assign(p.streams[0],{nal_length_size:"2"});},(p:ReturnType<typeof packetCopyProbeFixtureV1>)=>{p.streams[0].width=128;}]){const p=packetCopyProbeFixtureV1();change(p);expect(()=>admitPacketCopyMediaV1(p,admission)).toThrow();}
 });
 it("allows only representation-level tick error; an actual fractional requested tick is not rounded",()=>{
  const p=sourcePreservingFixtureV1();p.tracks[0].clips[0].sourceStart=1/30;p.tracks[0].clips[0].duration=1;
  expect(admitPacketCopyMediaV1(packetCopyProbeFixtureV1(),admitPacketCopyProjectV1(p,EXACT_PACKET_COPY_POLICY_V1)).startTicks).toBe(512);
  p.tracks[0].clips[0].sourceStart=.033;
  expect(()=>admitPacketCopyMediaV1(packetCopyProbeFixtureV1(),admitPacketCopyProjectV1(p,EXACT_PACKET_COPY_POLICY_V1))).toThrow("NOT_EXACT_TICK");
 });
});
