import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { decodeColorLutBytesV1 } from "./colorLutApiV1";
describe("desktop LUT binary decoding",()=>{
  it("preserves UTF8 BOM and all bytes for the preview full-SHA check",()=>{
    const raw=new TextEncoder().encode('\ufeffTITLE "Own LUT 青空"\nLUT_1D_SIZE 2\n0 0 0\n1 1 1\n');
    const text=decodeColorLutBytesV1(raw.buffer);expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(createHash('sha256').update(new TextEncoder().encode(text)).digest('hex')).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(decodeColorLutBytesV1([...raw])).toBe(text);
  });
  it("refuses empty or malformed UTF8 responses",()=>{
    expect(()=>decodeColorLutBytesV1(new ArrayBuffer(0))).toThrow(/64 MiB/);
    expect(()=>decodeColorLutBytesV1([0xff])).toThrow();
  });
});
