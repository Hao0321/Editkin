import { sourcePreservingProbeFixtureV1 } from "./sourcePreservingV1.fixture";
/** Metadata double only; these tiny parameter bytes do not claim decodable H264. */
export function packetCopyProbeFixtureV1() {
  const probe = sourcePreservingProbeFixtureV1(); probe.streams = [probe.streams[0]];
  const data = Buffer.from([1,66,192,10,255,225,0,2,0x67,0x42,1,0,2,0x68,0xcd]);
  Object.assign(probe.streams[0], { profile:"Constrained Baseline",has_b_frames:0,is_avc:"true",nal_length_size:"4",pix_fmt:"yuv420p",field_order:"progressive",start_pts:0,start_time:"0.000000",
    extradata_size:data.length,extradata:"\n00000000: "+data.toString("hex").match(/.{1,4}/g)!.join(" ")+"  fixtureASCII\n" });
  return probe;
}
