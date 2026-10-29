import { describe, expect, it } from "vitest";
import { createClipMask } from "../domain/masks";
import { compileColorWindowGeometryV1 } from "../domain/colorWindowGeometryV1";
import type { ColorWindowMaskV1 } from "../domain/colorWindowV1";
import { colorWindowRasterFramesV1, colorWindowRasterV1 } from "./colorWindowRasterV1";

function geometry(inverted=false) {
  const mask:ColorWindowMaskV1={...createClipMask("w","rectangle"),purpose:"color",inverted,feather:0,expansion:0,
    path:[{id:"a",x:.25,y:.25},{id:"b",x:.75,y:.25},{id:"c",x:.75,y:.75},{id:"d",x:.25,y:.75}],refine:{edgeShift:0,contrast:.5,chatterReduction:0}};
  return compileColorWindowGeometryV1({mask,clipId:"c",width:4,height:4});
}
describe("bounded colour-window plane transport",()=>{
  it("rasterizes independent center-pixel coverage as gray8 and little-endian gray16",()=>{
    const g=geometry().at(0),expected=[0,0,0,0,0,255,255,0,0,255,255,0,0,0,0,0];
    expect([...colorWindowRasterV1(g,{maximum:255})]).toEqual(expected);
    const high=colorWindowRasterV1(g);expect(high.length).toBe(32);
    expect(Array.from({length:16},(_,i)=>high.readUInt16LE(i*2))).toEqual(expected.map(n=>n*257));
  });
  it("quantizes opacity once and keeps lost inverted windows black",()=>{
    const g=geometry().at(0);g.opacity=.5;expect(colorWindowRasterV1(g,{maximum:255})[5]).toBe(128);
    expect(colorWindowRasterV1({...g,status:"lost",inverted:true},{maximum:255})).toEqual(Buffer.alloc(16));
  });
  it("enforces the allocation cap and checks cancellation before allocating",()=>{
    const g=geometry().at(0),abort=new AbortController();abort.abort(Error("test cancelled"));
    expect(()=>colorWindowRasterV1(g,{maximumBytes:31})).toThrow("COLOR_WINDOW_RASTER_BUDGET");
    expect(()=>colorWindowRasterV1(g,{maximumBytes:129*1024**2})).toThrow("COLOR_WINDOW_RASTER_BUDGET");
    expect(()=>colorWindowRasterV1({...g,width:32768,height:32768})).toThrow("COLOR_WINDOW_RASTER_BUDGET");
    expect(()=>colorWindowRasterV1(g,{signal:abort.signal})).toThrow("test cancelled");
  });
  it("pulls only requested frames at a ten-hour local clock and does not alias buffers",async()=>{
    const iterator=colorWindowRasterFramesV1(geometry(),{startFrame:1_080_000,frameCount:1_000_000_000,fps:30,maximum:255});
    const first=(await iterator.next()).value!;expect(first).toMatchObject({frame:1_080_000,localSeconds:36_000});
    first.bytes.fill(7);const second=(await iterator.next()).value!;expect(second.bytes[5]).toBe(255);
    expect(second.frame).toBe(1_080_001);await iterator.return();
  });
  it("stops a frame stream on cancellation and refuses unsafe frame arithmetic",async()=>{
    const abort=new AbortController(),it=colorWindowRasterFramesV1(geometry(),{startFrame:0,frameCount:3,fps:30,signal:abort.signal});
    await it.next();abort.abort(Error("stop"));await expect(it.next()).rejects.toThrow("stop");
    for(const values of [{startFrame:-1,frameCount:1,fps:30},{startFrame:Number.MAX_SAFE_INTEGER,frameCount:1,fps:30},{startFrame:0,frameCount:1,fps:NaN}])
      await expect(colorWindowRasterFramesV1(geometry(),values).next()).rejects.toThrow("COLOR_WINDOW_PARAMETERS");
  });
});
