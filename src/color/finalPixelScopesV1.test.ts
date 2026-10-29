import { describe, expect, it } from "vitest";
import { measureFinalPixelScopesV1, readFinalPixelScopePageV1, type FinalScopePixelFrame, type FinalScopeName, type FinalScopePlane } from "./finalPixelScopesV1";

const rgb = (pixels: number[], width = pixels.length / 3): FinalScopePixelFrame => ({ width, height: pixels.length / 3 / width,
  format: "rgb8", pixels: new Uint8Array(pixels), primaries: "bt709", transfer: "bt709", range: "full" });
const options = { histogramBins: 16, waveformColumns: 4, waveformLevels: 16, vectorscopeBins: 16 };
function values(measurement: ReturnType<typeof measureFinalPixelScopesV1>, scope: FinalScopeName, plane: FinalScopePlane) {
  let offset = 0; const result: number[] = [];
  do { const page = readFinalPixelScopePageV1(measurement, { scope, plane, offset, limit: 256 }); result.push(...page.values); if (page.nextOffset === null) break; offset = page.nextOffset; } while (true);
  return result;
}
const sum = (array: number[]) => array.reduce((total, value) => total + value, 0);
describe("actual output RGB scope instrument", () => {
  it("conserves all pixels independently in nine count planes", () => {
    const measured = measureFinalPixelScopesV1(rgb([0,0,0, 255,255,255, 255,0,0, 0,255,0, 0,0,255, 97,69,51, 128,128,128, 255,255,0], 4), options);
    for (const plane of ["luma", "red", "green", "blue"] as const) expect(sum(values(measured, "histogram", plane))).toBe(8);
    for (const plane of ["red", "green", "blue"] as const) expect(sum(values(measured, "parade", plane))).toBe(8);
    expect(sum(values(measured, "waveform", "luma"))).toBe(8); expect(sum(values(measured, "vectorscope", "chroma"))).toBe(8);
  });
  it("places black/white at histogram endpoints without dropping white", () => {
    const m = measureFinalPixelScopesV1(rgb([0,0,0,255,255,255]), options);
    expect(values(m,"histogram","luma")).toEqual([1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1]);
  });
  it("measures encoded BT709 luma for RGB primaries", () => {
    const m = measureFinalPixelScopesV1(rgb([255,0,0,0,255,0,0,0,255]), options), h=values(m,"histogram","luma");
    expect(h[3]).toBe(1); expect(h[11]).toBe(1); expect(h[1]).toBe(1);
  });
  it("keeps spatial columns in waveform/parade while histograms ignore x", () => {
    const a=measureFinalPixelScopesV1(rgb([0,0,0,255,255,255]),options), b=measureFinalPixelScopesV1(rgb([255,255,255,0,0,0]),options);
    expect(values(a,"histogram","red")).toEqual(values(b,"histogram","red"));
    const wave=values(a,"waveform","luma");expect(wave[0]).toBe(1);expect(wave[15*4+2]).toBe(1);
    expect(values(a,"parade","red")).not.toEqual(values(b,"parade","red"));
  });
  it("maps neutral values to the zero-chroma bin and saturated red/blue to correct axes", () => {
    const m=measureFinalPixelScopesV1(rgb([0,0,0,255,255,255,128,128,128,255,0,0,0,0,255]),options), v=values(m,"vectorscope","chroma");
    expect(v[8*16+8]).toBe(3); expect(v[15*16+6]).toBe(1); expect(v[7*16+15]).toBe(1);
  });
  it("keeps distinct 16-bit code levels that an RGB8 sampler merges", () => {
    const data=new Uint8Array(12),view=new DataView(data.buffer);
    for(let p=0;p<2;p++)for(let c=0;c<3;c++)view.setUint16(p*6+c*2,p===0?32767:32768,true);
    const m=measureFinalPixelScopesV1({...rgb([0,0,0,0,0,0]),format:"rgb16le",pixels:data}, {...options,histogramBins:4096});
    const h=values(m,"histogram","red");expect(h[2047]).toBe(1);expect(h[2048]).toBe(1);
  });
  it("honours packed subarray byte offsets and copies page values", () => {
    const backing=new Uint8Array([99,255,0,0,99]);const m=measureFinalPixelScopesV1({...rgb([0,0,0]),pixels:backing.subarray(1,4)},options);
    const page=readFinalPixelScopePageV1(m,{scope:"histogram",plane:"red",offset:0,limit:16});page.values[15]=9;
    expect(values(m,"histogram","red")[15]).toBe(1);expect(backing).toEqual(new Uint8Array([99,255,0,0,99]));
  });
  it("provides a warm positive-I unit guide with no skin detector", () => {
    const ref=measureFinalPixelScopesV1(rgb([128,128,128]),options).vectorscope.skinReference;
    expect(ref.cb).toBeLessThan(0);expect(ref.cr).toBeGreaterThan(0);expect(Math.hypot(ref.cb,ref.cr)).toBeCloseTo(1,14);expect(ref.skinDetector).toBe(false);
  });
  it("requires real owned measurement handles for pages", () => {
    const m=measureFinalPixelScopesV1(rgb([0,0,0]),options);
    expect(()=>readFinalPixelScopePageV1({...m},{scope:"histogram",plane:"red",offset:0,limit:1})).toThrow("foreign");
  });
  it("bounds pages and supports an empty terminal page", () => {
    const m=measureFinalPixelScopesV1(rgb([0,0,0]),options);
    expect(readFinalPixelScopePageV1(m,{scope:"histogram",plane:"red",offset:16,limit:1})).toMatchObject({values:[],nextOffset:null});
    for(const patch of [{offset:-1},{offset:17},{limit:0},{limit:257},{limit:1.5}])expect(()=>readFinalPixelScopePageV1(m,{scope:"histogram",plane:"red",offset:0,limit:1,...patch})).toThrow();
    expect(()=>readFinalPixelScopePageV1(m,{scope:"parade",plane:"luma",offset:0,limit:1})).toThrow("plane");
  });
  it.each([{width:0},{width:1.5},{height:8193},{width:4096,height:4096},{format:"float"},{transfer:"arib-std-b67"},{primaries:"bt2020"},{range:"limited"},{pixels:new Uint8Array(2)}])("refuses unsupported/oversized input %j", patch=>{
    expect(()=>measureFinalPixelScopesV1({...rgb([0,0,0]),...patch} as FinalScopePixelFrame,options)).toThrow();
  });
  it("refuses shared memory and partially transparent output", () => {
    expect(()=>measureFinalPixelScopesV1({...rgb([0,0,0]),pixels:new Uint8Array(new SharedArrayBuffer(3))},options)).toThrow("shared");
    const bytes=new Uint8Array(8);expect(()=>measureFinalPixelScopesV1({...rgb([0,0,0]),format:"rgba16le",pixels:bytes},options)).toThrow("transparent");
    new DataView(bytes.buffer).setUint16(6,65535,true);expect(measureFinalPixelScopesV1({...rgb([0,0,0]),format:"rgba16le",pixels:bytes},options).pixelCount).toBe(1);
  });
  it("refuses combined density allocation and unknown options", () => {
    expect(()=>measureFinalPixelScopesV1(rgb([0,0,0]),{waveformColumns:1024,waveformLevels:1024})).toThrow("budget");
    expect(()=>measureFinalPixelScopesV1(rgb([0,0,0]),{skinCorrection:true} as never)).toThrow("options");
  });
});
