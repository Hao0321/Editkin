import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { avcConfigurationV1, exactPacketWindowV1, packetByteSourceV1, packetTimeKeyV1, parseSourcePacketV1, witnessAvcPacketV1, type SourcePacketV1 } from "./sourcePacketV1";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const nal = (type: number, size = 3) => { const b = Buffer.alloc(4 + size, 71); b.writeUInt32BE(size); b[4] = type; return b; };
const packet = (pts = 0, duration = 10, key = true): SourcePacketV1 => ({ pts, dts: pts, duration, key, pos: 0, size: 7 });
const witness = (idr = true, bytes = 7) => ({ idr, bytes, nalCount: 1, payloadSha256: "a".repeat(64) });
describe("bounded exact packet timeline and real AVC access-point witness core", () => {
  it("parses measured packet fields including offsets/timestamps beyond2^32 with no bitwise truncation", () => {
    expect(parseSourcePacketV1("pts=5000000000|dts=5000000000|duration=1024|size=321|pos=7000000000|flags=K__\r")).toEqual({ pts: 5000000000, dts: 5000000000, duration: 1024, size: 321, pos: 7000000000, key: true });
    expect(parseSourcePacketV1("pts=-1024|dts=-2048|duration=1024|size=10|pos=100|flags=___").key).toBe(false);
  });
  it("refuses malformed, duplicate, incomplete, corrupt/discard, N/A, overflowing and oversized lines", () => {
    const good = "pts=0|dts=0|duration=10|size=7|pos=100|flags=K__";
    for (const bad of [good+"|pts=0",good+"|side_data=changed",good.replace("pts=0","pts=N/A"),good.replace("duration=10","duration=0"),good.replace("size=7","size=-7"),good.replace("flags=K__","flags=KD_"),good.replace("pts=0","pts=9007199254740992"),good.replace("pos=100","pos=-1"),good.replace("dts=0|",""),"x".repeat(4097)]) expect(() => parseSourcePacketV1(bad)).toThrow();
  });
  it("checks actual AVC extradata dump layout/parameter bounds and length-prefix/profile support", () => {
    const bytes = Buffer.from([1,66,192,10,255,225,0,2,0x67,0x42,1,0,2,0x68,0xcd]);
    const dump = "\n00000000: "+bytes.toString("hex").match(/.{1,4}/g)!.join(" ")+"  fixtureASCII\n";
    expect(avcConfigurationV1(dump, bytes.length)).toEqual({ sha256:sha(bytes), bytes:bytes.length, profileIdc:66, nalLengthBytes:4 });
    for (const [bad,length] of [[dump,bytes.length-1],[dump.replace("0142","0164"),bytes.length],[dump.replace("00000000","00000001"),bytes.length],[dump.replace("ffe1","fee1"),bytes.length],["N/A",bytes.length]] as const) expect(() => avcConfigurationV1(bad,length)).toThrow();
  });
  it("hashes the exact packet while recognizing IDR even when all prefixes straddle tiny read chunks", async () => {
    const bytes = Buffer.concat([nal(6, 9),nal(5, 1031),nal(5, 7)]); let largest = 0;
    const result = await witnessAvcPacketV1({ ...packet(),size:bytes.length },{ bytes:bytes.length,chunk:async(pos,len)=>{const count=Math.min(3,len);largest=Math.max(largest,count);return bytes.subarray(pos,pos+count);} });
    expect(result).toEqual({ payloadSha256:sha(bytes),idr:true,nalCount:3,bytes:bytes.length }); expect(largest).toBe(3);
    const p = nal(1);expect((await witnessAvcPacketV1(packet(),{ bytes:p.length,chunk:async(pos,len)=>p.subarray(pos,pos+len) })).idr).toBe(false);
  });
  it("does not infer IDR from a key flag; malformed, mixed, non-picture or changed in-band config refuse", async () => {
    const zero = nal(5);zero.writeUInt32BE(0);const overflow = nal(5);overflow.writeUInt32BE(100);const forbidden = nal(133);
    for (const bytes of [zero,overflow,forbidden,nal(7),nal(8),nal(6),Buffer.concat([nal(5),nal(1)]),nal(5).subarray(0,6)]) await expect(witnessAvcPacketV1({ ...packet(),size:bytes.length },{ bytes:bytes.length,chunk:async(pos,len)=>bytes.subarray(pos,pos+len) })).rejects.toThrow();
    const bytes = nal(1), actual = await witnessAvcPacketV1(packet(),{ bytes:7,chunk:async(pos,len)=>bytes.subarray(pos,pos+len) });
    const window = exactPacketWindowV1(0,10,{numerator:1,denominator:30});expect(() => window.accept(packet(),actual)).toThrow("NOT_EXACT_IDR");
  });
  it("reuses one1MiB cache and reads positions beyond2^32 exactly, never allocating by source duration", async () => {
    const calls:number[]=[];const handle={ read:async(buffer:Buffer,offset:number,length:number,position:number)=>{calls.push(position);buffer.fill(67,offset,offset+length);return{bytesRead:length};} };
    const source=packetByteSourceV1(handle as never,8000000000),first=await source.chunk(5000000000,20),second=await source.chunk(5000000005,20);
    expect(first.length).toBe(20);expect(second.length).toBe(20);expect(calls).toEqual([Math.floor(5000000000/1024**2)*1024**2]);
    expect(first.buffer).toBe(second.buffer);expect(first.buffer.byteLength).toBe(1024**2);
    await expect(source.chunk(8000000000,1)).rejects.toThrow("RANGE_INVALID");
  });
  it("matches source cut and shifted output packet payload/clock identity across equivalent timebases", () => {
    const source=exactPacketWindowV1(10,20,{numerator:1,denominator:30});
    source.accept(packet(0,10),witness());source.accept(packet(10,10),witness());source.accept(packet(20,10,false),witness(false));const a=source.finish();
    const output=exactPacketWindowV1(0,20,{numerator:1,denominator:60});output.accept(packet(0,20),witness());const b=output.finish();
    expect(a.retainedPackets).toBe(1);expect(a.duration).toBe("1/3");expect(a.payloadAndTimelineSha256).toBe(b.payloadAndTimelineSha256);
  });
  it("rejects a shifted start, non-frame end, timestamp gaps/reordering, absent start and actual EOF", () => {
    const tb={numerator:1,denominator:30};
    const start=exactPacketWindowV1(5,20,tb);start.accept(packet(0,10),witness());expect(() => start.accept(packet(10,10),witness())).toThrow("NOT_EXACT_IDR");
    const end=exactPacketWindowV1(0,15,tb);end.accept(packet(0,10),witness());expect(() => end.accept(packet(10,10,false),witness(false))).toThrow("NOT_EXACT_FRAME");
    const gap=exactPacketWindowV1(0,30,tb);gap.accept(packet(0,10),witness());expect(() => gap.accept(packet(11,10),witness())).toThrow("GAP_OR_REORDER");
    const reorder=exactPacketWindowV1(0,30,tb);expect(() => reorder.accept({ ...packet(),dts:-1 },witness())).toThrow("GAP_OR_REORDER");
    const eof=exactPacketWindowV1(0,30,tb);eof.accept(packet(),witness());expect(() => eof.finish()).toThrow("SOURCE_EOF");
    expect(() => exactPacketWindowV1(10,20,tb).finish()).toThrow("SOURCE_EOF");
  });
  it("detects payload or duration substitution and preserves large clock tick boundaries", () => {
    const tb={numerator:1,denominator:15360};expect(packetTimeKeyV1(5000000000,tb)).toBe("1953125/6");
    const a=exactPacketWindowV1(5000000000,5000001024,tb);a.accept(packet(0,5000000000),witness());a.accept(packet(5000000000,1024),witness());const result=a.finish();
    expect(result.startTicks).toBe(5000000000);expect(result.endTicks).toBe(5000001024);expect(result.duration).toBe("1/15");
    const b=exactPacketWindowV1(0,1024,tb);b.accept(packet(0,1024),{...witness(),payloadSha256:"b".repeat(64)});expect(b.finish().payloadAndTimelineSha256).not.toBe(result.payloadAndTimelineSha256);
  });
});
