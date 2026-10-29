import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { parseAacPacketV1, aacPacketPayloadSha256V1, aacOutputPacketWitnessV1, aacSourcePacketWindowV1, verifyCopiedAacPacketWindowV1, type AacPacketV1 } from "./aacPacketWitnessV1";
const sha=(v:string)=>createHash("sha256").update(v).digest("hex");
const p=(pts:number,skip?:number):AacPacketV1=>({pts,dts:pts,duration:1024,pos:2**32+pts+8192,size:4,discard:pts<0,...(skip===undefined?{}:{skip:{samples:skip,padding:0,skipReason:0,discardReason:0}})});
describe("raw AAC witness includes priming and exact presentation window",()=>{
 it("parses actual pinned Skip Samples fields, signed clocks and offsets larger than2^32",()=>{
  const text="pts=-48128|dts=-48128|duration=1024|size=513|pos=4294967297|flags=KD_|side_datum/skip_samples:side_data_type=Skip Samples|side_datum/skip_samples:skip_samples=48128|side_datum/skip_samples:discard_padding=0|side_datum/skip_samples:skip_reason=0|side_datum/skip_samples:discard_reason=0";
  expect(parseAacPacketV1(text)).toMatchObject({pts:-48128,pos:4294967297,discard:true,skip:{samples:48128,padding:0}});
  for(const bad of [text+"|pos=1",text.replace("Skip Samples","Other"),text.replace("size=513","size=8193"),text.replace("skip_samples=48128","skip_samples=9007199254740992"),text.replace("|side_datum/skip_samples:discard_reason=0","")])expect(()=>parseAacPacketV1(bad)).toThrow();
 });
 it("hashes streamed source range and every output preroll packet with identical normalized clocks",()=>{
  const source=aacSourcePacketWindowV1(2048,8192),out=aacOutputPacketWitnessV1(4096,96000);
  for(let pts=-1024;pts<10240;pts+=1024){const packet=p(pts,pts===-1024?1024:undefined);source.accept(packet,source.wantsPayload(packet)?sha(String(pts)):undefined);}
  for(let pts=-2048;pts<4096;pts+=1024)out.accept(p(pts,pts===-2048?2048:undefined),sha(String(pts+4096)));
  const result=verifyCopiedAacPacketWindowV1(source.finish(),out.finish(),4096);expect(result).toMatchObject({copiedPackets:6,prerollPackets:2,presentationSamples:4096,decodedSampleIdentityStillRequired:true});
 });
 it("rejects wrong skip, extra padding, gaps, missing tail, excessive preroll and shifted start",()=>{
  for(const packet of [p(-2048,2049),p(-97280,97280),p(1024),{...p(-2048,2048),skip:{samples:2048,padding:1,skipReason:0,discardReason:0}}])expect(()=>aacOutputPacketWitnessV1(4096,96000).accept(packet,sha("x"))).toThrow();
  const out=aacOutputPacketWitnessV1(4096,96000);out.accept(p(0),sha("x"));expect(()=>out.accept(p(2048),sha("x"))).toThrow("GAP");expect(()=>out.finish()).toThrow("EOF");
  const source=aacSourcePacketWindowV1(0,2048);source.accept(p(0),sha("x"));source.accept(p(1024),sha("y"));const positive=aacOutputPacketWitnessV1(2048,96000);positive.accept(p(0),sha("x"));positive.accept(p(1024),sha("y"));
  const s=source.finish(),o=positive.finish();expect(()=>verifyCopiedAacPacketWindowV1(s,{...o,payloadAndRelativeTimelineSha256:sha("altered")},0)).toThrow("CHANGED");expect(()=>verifyCopiedAacPacketWindowV1(s,o,1024)).toThrow("CHANGED");
 });
 it("streams bounded packet bytes and rejects truncated/out of range data",async()=>{
  const bytes=Buffer.from("ABCD"),packet={...p(0),pos:2**32,size:4};let calls=0;
  const source={bytes:2**32+4,chunk:async(position:number,length:number)=>{calls++;return bytes.subarray(position-2**32,position-2**32+Math.min(length,1));}};
  expect(await aacPacketPayloadSha256V1(packet,source)).toBe(sha("ABCD"));expect(calls).toBe(4);
  await expect(aacPacketPayloadSha256V1({...packet,size:5},source)).rejects.toThrow("RANGE");await expect(aacPacketPayloadSha256V1(packet,{...source,chunk:async()=>Buffer.alloc(0)})).rejects.toThrow("ENDED_EARLY");
 });
 it("allows a terminal short source duration after the selected window but never inside it or before another packet",()=>{
  const s=aacSourcePacketWindowV1(0,2048);s.accept(p(0),sha("a"));s.accept(p(1024),sha("b"));s.accept({...p(2048),duration:512});expect(s.finish()).toMatchObject({packets:2,terminalSourcePartialDuration:512});expect(()=>s.accept(p(3072))).toThrow("AFTER_TERMINAL");
  const selected=aacSourcePacketWindowV1(0,2048);selected.accept(p(0),sha("a"));expect(()=>selected.accept({...p(1024),duration:512},sha("b"))).toThrow("SHAPE_UNSUPPORTED");
  const output=aacOutputPacketWitnessV1(2048,96000);output.accept(p(0),sha("a"));expect(()=>output.accept({...p(1024),duration:512},sha("b"))).toThrow("SHAPE_UNSUPPORTED");
 });
});
