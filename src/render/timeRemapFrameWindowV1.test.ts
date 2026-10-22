import { describe, expect, it, vi } from "vitest";
import { compileTimeRemapClockV1, type TimeRemapClockV1 } from "../domain/timeRemapClockV1";
import type { DecodedPtsIndexV1 } from "./decodedPtsIndexV1";
import { resolveTimeRemapFrameWindowV1, describeTimeRemapWindowColorV1 } from "./timeRemapFrameWindowV1";
import { createTimeRemapFrameConsumerV2 } from "./timeRemapFrameConsumerV2";
import type { startRgbaPtsStreamV1 } from "./rgbaPtsStreamReaderV1";
import type { readRgbaPtsBatchV1 } from "./rgbaPtsBatchReaderV1";

function clock(direction:"forward"|"reverse"="forward",duration=4,fps={numerator:8,denominator:1}) {
  return compileTimeRemapClockV1({ timelineDurationSeconds:duration,sourceStartSeconds:0,sourceDurationSeconds:duration*2,outputRate:fps,direction,
    segments:[{from:{time:0,speed:1},control1:{time:1/3,speed:.25},control2:{time:2/3,speed:1.5},to:{time:1,speed:1}}] });
}
const pixel=(n:number)=>Buffer.from([n%256,(n*3)%256,5,255]);
function consumer(c:TimeRemapClockV1,window?:{firstFrame:number;frames:number}) {
  const rate=c.outputRate, index:DecodedPtsIndexV1={timing:"vfr",timeBase:{numerator:rate.denominator,denominator:rate.numerator},clockOrigin:{pts:0,sourceSeconds:0},
    decodedFrameCount:Math.ceil(c.sourceDurationSeconds*rate.numerator/rate.denominator),lastFrameEndPts:Math.ceil(c.sourceDurationSeconds*rate.numerator/rate.denominator),
    metadataBytes:24,metadataSha256:"a".repeat(64),ptsAt:n=>n,seekIndexAt:()=>0,assertIdentity:async()=>undefined,receipt:{pagesRead:1,cachedBytes:24,maximumCachedBytes:24,idrAnchors:0}};
  const requested:Array<{low:number;high:number}>=[];
  const readStream=vi.fn(async(input:Parameters<typeof startRgbaPtsStreamV1>[0])=>{requested.push({low:input.low,high:input.high});let n=input.low;
    return {readInto:async(destination:Uint8Array)=>{const i=n++;destination.set(pixel(i));return{index:i,pts:i};},finish:async()=>{expect(n).toBe(input.high+1);},close:async()=>undefined};});
  const readBatch=vi.fn(async(input:Parameters<typeof readRgbaPtsBatchV1>[0])=>{requested.push({low:input.low,high:input.high});
    const pixels=Buffer.concat(Array.from({length:input.high-input.low+1},(_,i)=>pixel(input.low+i)));
    input.onTerminal?.({closed:true,code:0,frames:input.high-input.low+1,bytes:pixels.length,maximumBufferedPixelBytes:pixels.length,simulatedProtocolOnly:true});return{pixels};});
  return {requested,consumer:createTimeRemapFrameConsumerV2({clock:c,index,width:1,height:1,ffmpegPath:"unused",sourcePath:"unused",timeoutMs:1000,maximumCacheBytes:8,outputFrameWindow:window,
    readStream:readStream as unknown as typeof startRgbaPtsStreamV1,readBatch:readBatch as unknown as typeof readRgbaPtsBatchV1})};
}
async function collect(c:ReturnType<typeof consumer>["consumer"],first:number,frames:number){
  const out:Buffer[]=[];try{for(let i=first;i<first+frames;i++)out.push(Buffer.from((await c.sample(i)).bytes));await c.finish();return Buffer.concat(out);}finally{await c.close();}
}

describe("global source-clock output windows",()=>{
  it.each(["forward","reverse"] as const)("irregular windows concatenate to the unchanged full consumer: %s",async direction=>{
    const c=clock(direction),full=await collect(consumer(c).consumer,0,c.totalOutputFrames),parts:Buffer[]=[];
    let first=0;for(const frames of [1,3,7,5,16]){parts.push(await collect(consumer(c,{firstFrame:first,frames}).consumer,first,frames));first+=frames;}
    expect(Buffer.concat(parts)).toEqual(full);expect(first).toBe(c.totalOutputFrames);
  });
  it.each(["forward","reverse"] as const)("handles a tiny near-tail window on a12hour nonlinear clock without a frame table: %s",async direction=>{
    const c=clock(direction,43200,{numerator:30,denominator:1}),first=c.totalOutputFrames-9,window={firstFrame:first,frames:8},x=consumer(c,window);
    const out=await collect(x.consumer,first,8);expect(out.length).toBe(32);
    expect(x.consumer.receipt.framesSampled).toBe(8);expect(x.consumer.receipt.maximumCacheBytes).toBeLessThanOrEqual(8);
    expect(x.requested.length).toBeLessThanOrEqual(8);expect(JSON.stringify(c).length).toBeLessThan(1600);
    expect(resolveTimeRemapFrameWindowV1(c,window).timelineStart).toBeCloseTo(first/30,10);
  });
  it("keeps rational frame positions at a nonzero window without a rounded second offset",()=>{
    const c=clock("forward",1001,{numerator:30000,denominator:1001}),w=resolveTimeRemapFrameWindowV1(c,{firstFrame:29993,frames:7});
    expect(w.timelineStart).toBe(29993*1001/30000);expect(w.encodedDuration).toBe(7*1001/30000);expect(w.endFrame).toBe(c.totalOutputFrames);
  });
  it.each([undefined,{firstFrame:-1,frames:1},{firstFrame:0,frames:0},{firstFrame:0,frames:33},{firstFrame:31,frames:2},
    {firstFrame:NaN,frames:1},{firstFrame:1,frames:Infinity},{firstFrame:Number.MAX_SAFE_INTEGER,frames:2},{firstFrame:0,frames:1,unknown:true},null])("refuses invalid explicit windows without starting a decoder: %s",value=>{
    if(value===undefined)expect(resolveTimeRemapFrameWindowV1(clock()).frames).toBe(32);
    else expect(()=>resolveTimeRemapFrameWindowV1(clock(),value as never)).toThrow("FRAME_WINDOW_INVALID");
  });
  it.each(["forward","reverse"] as const)("rejects local-frame resets, incomplete finish and reading beyond the exact window: %s",async direction=>{
    const x=consumer(clock(direction),{firstFrame:7,frames:2});
    await expect(x.consumer.sample(0)).rejects.toThrow("STATE_INVALID");await expect(x.consumer.finish()).rejects.toThrow();
    await x.consumer.sample(7);await x.consumer.sample(8);await expect(x.consumer.sample(9)).rejects.toThrow("STATE_INVALID");
    await x.consumer.finish();await expect(x.consumer.sample(8)).rejects.toThrow("STATE_INVALID");await x.consumer.close();
  });
  it("does not restart a forward decoder at frame0 for a window that begins later",async()=>{
    const x=consumer(clock(),{firstFrame:20,frames:3});await collect(x.consumer,20,3);
    expect(x.requested).toHaveLength(1);expect(x.requested[0].low).toBeGreaterThan(0);
    expect(x.consumer.receipt.decoderLoads).toBe(1);expect("sourceFramesRead" in x.consumer.receipt ? x.consumer.receipt.sourceFramesRead : undefined).toBe(x.requested[0].high-x.requested[0].low+1);
  });
  it("labels missing VUI interpretation unresolved, and never certifies the encoded RGB candidate",()=>{
    expect(describeTimeRemapWindowColorV1({color_space:"gbr",color_range:"pc"})).toMatchObject({interpretationUnresolved:true,primaries:"unspecified",transfer:"unspecified",wholePixelQualityCertified:false});
    expect(describeTimeRemapWindowColorV1({color_space:"gbr",color_range:"pc",color_transfer:"bt709",color_primaries:"bt709"})).toMatchObject({interpretationUnresolved:false,wholePixelQualityCertified:false});
  });
  it.each([{color_transfer:"smpte2084"},{color_transfer:"arib-std-b67"},{color_primaries:"bt2020"},{color_space:"bt2020nc"}])("refuses explicitly declared HDR/other primaries: %s",metadata=>{
    expect(()=>describeTimeRemapWindowColorV1(metadata)).toThrow("REQUIRES_SDR_SOURCE");
  });
});
