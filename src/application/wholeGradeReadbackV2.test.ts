import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { wholeGradeRgba16ReadbackV2 } from "./wholeGradeReadbackV2";

function fixture() {
  const bytes=new Uint8Array(24),view=new DataView(bytes.buffer);
  [1,256,4097,16384,32769,65534,7,255,65535].forEach((n,i)=>view.setUint16(i*2,n,true));
  bytes.fill(255,18);return bytes;
}
describe("opaque planar16 colour readback",()=>{
  it("preserves every GBR byte and merely excludes the alpha plane, including source byte offsets",()=>{
    const source=fixture(),backing=new Uint8Array(32);backing.set(source,4);const input=backing.subarray(4,28),before=Buffer.from(input);
    const out=wholeGradeRgba16ReadbackV2(input,3);
    expect(Buffer.from(out.bytes)).toEqual(Buffer.from(source.subarray(0,18)));expect(Buffer.from(input)).toEqual(before);
    expect(out.receipt).toMatchObject({pixels:3,transportBytes:24,colourBytes:18,alphaOpaque:true,pixelFormat:"gbrap16le"});
    expect(out.receipt.colourSha256).toBe(createHash("sha256").update(source.subarray(0,18)).digest("hex"));
  });
  it("rejects incomplete, oversized and unsafe pixel clocks before reading planes",()=>{
    for(const count of [0,-1,NaN,Infinity,Number.MAX_SAFE_INTEGER,3.5,4])expect(()=>wholeGradeRgba16ReadbackV2(fixture(),count)).toThrow("READBACK_BUDGET");
    expect(()=>wholeGradeRgba16ReadbackV2(fixture().subarray(0,23),3)).toThrow("READBACK_BUDGET");
  });
  it("refuses nonopaque or shared transport instead of compositing it into an RGB LUT",()=>{
    const b=fixture();b[18]=0;expect(()=>wholeGradeRgba16ReadbackV2(b,3)).toThrow("READBACK_NOT_OPAQUE");
    expect(()=>wholeGradeRgba16ReadbackV2(new Uint8Array(new SharedArrayBuffer(24)),3)).toThrow("READBACK_BUDGET");
  });
});
