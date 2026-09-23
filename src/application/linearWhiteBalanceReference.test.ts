import {describe,expect,it} from "vitest";
import {measureLinearWhiteBalanceReference as measure,validateLinearWhiteBalanceReference as validate,linearWhiteBalanceReferenceUnusable as unusable,type LinearWhiteBalanceReferenceFrame} from "./linearWhiteBalanceReference";
function frame(rgb=[2,2,2],alpha=1):LinearWhiteBalanceReferenceFrame{return {sampleId:"kf-1",timeSeconds:0,width:8,height:8,pixels:Float32Array.from(Array.from({length:64},()=>[...rgb,alpha]).flat()),roi:{x:0,y:0,width:1,height:1},reference:"caller-declared-neutral",basis:"linear-rec709",inputConvention:"hlg-linear"};}
describe("explicit pre-tone float reference",()=>{
  it("accepts constant HDR without pretending display output or trusted white",()=>{
    const m=measure(frame());expect(m.meanLinearRgb).toEqual([2,2,2]);expect(m.neutralErrorStops).toBe(0);expect(unusable(m)).toBe(false);
    expect(()=>validate(JSON.parse(JSON.stringify(m)))).not.toThrow();
  });
  it("records nonopaque pixels and refuses even a small transparent contribution",()=>{
    const f=frame();f.pixels[3]=.5;const m=measure(f);expect(m.nonOpaqueCount).toBe(1);expect(unusable(m)).toBe(true);
  });
  it("permits negative scene components but refuses nonpositive reference and preserves null error",()=>{
    const m=measure(frame([-1,.2,.3]));expect(m.nonPositiveFraction).toBe(1);expect(m.neutralErrorStops).toBeNull();expect(unusable(m)).toBe(true);
    expect(()=>validate(JSON.parse(JSON.stringify(m)))).not.toThrow();expect(unusable(measure(frame([.001,.001,.001])))).toBe(true);
  });
  it("allows mild variance but rejects heterogeneous averaging to grey",()=>{
    const f=frame();for(let p=0;p<64;p++)f.pixels.set(p%2?[2.1,2.1,2.1,1]:[1.9,1.9,1.9,1],p*4);
    expect(unusable(measure(f))).toBe(false);
    for(let p=0;p<64;p++)f.pixels.set(p%2?[.5,1.5,1,1]:[1.5,.5,1,1],p*4);
    const m=measure(f);expect(m.neutralErrorStops).toBeCloseTo(0);expect(unusable(m)).toBe(true);
  });
  it("rejects geometry, nonfinite/giant data anywhere, mismatched transfer and tampered covariance",()=>{
    for(const mutate of [(f:LinearWhiteBalanceReferenceFrame)=>{f.roi.width=.1;},(f:LinearWhiteBalanceReferenceFrame)=>{f.roi.x=.9;},(f:LinearWhiteBalanceReferenceFrame)=>{f.pixels[0]=NaN;},(f:LinearWhiteBalanceReferenceFrame)=>{f.pixels[0]=10001;},(f:LinearWhiteBalanceReferenceFrame)=>{f.width=257;}]){const f=frame();mutate(f);expect(()=>measure(f)).toThrow();}
    const m=measure(frame());for(const change of [{varianceLinearY:1},{nonOpaqueFraction:.5},{meanLinearY:3},{neutralErrorStops:1},{pixelCount:1},{basis:"post-tone-rgb8"}])expect(()=>validate({...m,...change} as typeof m)).toThrow();
  });
});
