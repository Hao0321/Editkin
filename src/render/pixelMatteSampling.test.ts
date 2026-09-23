import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { floorFrameRateSampleIndex, rationalRate, ffmpegRationalRate } from "../domain/clipAlphaPlan";
import { pixelMatteSamplingFilters } from "./pixelMatteSampling";
const ff=resolve(fileURLToPath(new URL("../../",import.meta.url)),"vendor/ffmpeg/win32-x64/ffmpeg.exe");
const rates=[24,25,30,60,24000/1001,30000/1001,29.97];
function decode(projectFps:number,sampleFps:number,count:number,first:number,frames:number,old=false) {
  const rate=rationalRate(projectFps),sampleRate=rationalRate(sampleFps);
  const filter=pixelMatteSamplingFilters(rate,count,frames,first);
  if(old) filter[3]=filter[3].replace("round=up","round=down");
  const pixels=Buffer.alloc(count*4);for(let i=0;i<count;i++)pixels.fill(i+1,i*4,(i+1)*4);
  const args=["-v","error","-f","rawvideo","-pixel_format","gray","-video_size","2x2","-framerate",ffmpegRationalRate(sampleRate),"-i","pipe:0","-vf",filter.join(","),"-fps_mode","passthrough","-pix_fmt","gray","-f","rawvideo","-"];
  const r=spawnSync(ff,args,{input:pixels,windowsHide:true,timeout:10000,maxBuffer:100000});
  expect(r.status,r.stderr.toString()).toBe(0);expect(r.stdout.length).toBe(frames*4);
  return Array.from({length:frames},(_,n)=>r.stdout[n*4]);
}
it.each(rates)("matches every domain floor sample and clamped tail at %s", fps=>{
  for(const sampleFps of [7,12,25,60,24000/1001]) for(const first of [0,7]) {
    const frames=47,count=11,actual=decode(fps,sampleFps,count,first,frames);
    const expected=actual.map((_,n)=>1+floorFrameRateSampleIndex(first+n,rationalRate(fps),rationalRate(sampleFps),count));
    expect(actual,{fps,sampleFps,first}.toString()).toEqual(expected);
  }
},30000);
it("rejects the old rounding defect with the same actual pixel oracle",()=>{
  for(const fps of [30,25,30000/1001]) {
    const old=decode(fps,12,11,0,31,true);
    const expected=old.map((_,n)=>1+floorFrameRateSampleIndex(n,rationalRate(fps),rationalRate(12),11));
    expect(old).not.toEqual(expected);
  }
});
it("holds the only sample for an arbitrary bounded output window",()=>{
  expect(decode(30000/1001,12,1,17,47)).toEqual(Array(47).fill(1));
});
it("rejects invalid rates/counts/offsets instead of an unbounded graph",()=>{
  for(const v of [0,-1,.5,NaN,Infinity]) {
    expect(()=>pixelMatteSamplingFilters({numerator:v,denominator:1},1,1)).toThrow();
    expect(()=>pixelMatteSamplingFilters(rationalRate(30),v,1)).toThrow();
    expect(()=>pixelMatteSamplingFilters(rationalRate(30),1,v)).toThrow();
  }
  expect(()=>pixelMatteSamplingFilters(rationalRate(30),1,1,-1)).toThrow();
  expect(()=>pixelMatteSamplingFilters(rationalRate(30),1,2,Number.MAX_SAFE_INTEGER)).toThrow();
});
