import {describe,expect,it} from "vitest";
import {nextLinearWhiteBalanceControl as next,selectLinearWhiteBalanceCandidate as select,type LinearWhiteBalanceControl,type LinearWhiteBalanceCandidate} from "./linearWhiteBalanceSelection";
import {measureLinearWhiteBalanceReference} from "./linearWhiteBalanceReference";
import {measureReferenceWhiteBalanceFrame} from "./referenceWhiteBalance";
const zero={whiteBalanceRed:0,whiteBalanceGreen:0,whiteBalanceBlue:0};
const decode=(v:number)=>v<.081?v/4.5:((v+.099)/1.099)**(1/.45);
const cast=[137,128,119].map(v=>decode(v/255));
function candidate(control:LinearWhiteBalanceControl,rgb=cast,output=[128,128,128]):LinearWhiteBalanceCandidate{
  return {...control,frames:[0,1].map(i=>measureLinearWhiteBalanceReference({sampleId:`kf-${i+1}`,timeSeconds:i,width:8,height:8,roi:{x:0,y:0,width:1,height:1},reference:"caller-declared-neutral",basis:"linear-rec709",inputConvention:"rec709-oetf",pixels:Float32Array.from(Array.from({length:64},()=>[...rgb,1]).flat())})),
    outputReferences:[0,1].map(i=>measureReferenceWhiteBalanceFrame({sampleId:`kf-${i+1}`,timeSeconds:i,width:8,height:8,roi:{x:0,y:0,width:1,height:1},reference:"caller-declared-neutral",transfer:"bt709-oetf",pixels:Uint8Array.from(Array.from({length:64},()=>output).flat())}))};
}
function proposal(base=zero){const b=candidate(base),n=next([b],base,1);if(n.status!=="next")throw Error("Expected candidate");
  const values=[n.control.whiteBalanceRed-base.whiteBalanceRed,n.control.whiteBalanceGreen-base.whiteBalanceGreen,n.control.whiteBalanceBlue-base.whiteBalanceBlue];
  return [b,candidate(n.control,b.frames[0].meanLinearRgb.map((v,i)=>v*2**values[i]))];}
describe("baseline-bound linear neutral planner and selector",()=>{
  it("corrects strong 137128119 using one common absolute proposal",()=>{
    const c=proposal();expect(next([],{},1)).toEqual({status:"next",control:zero});expect(next(c,zero,1)).toEqual({status:"stop",reason:"complete"});
    expect(select(c,zero).status).toBe("candidate");expect(select(c,zero).selectedIndex).toBe(1);
    expect(select(c,zero).whitePointVerification).toBe("unmeasured");
  });
  it("preserves zero and existing nonzero baseline without cumulative application",()=>{
    expect(next([candidate(zero,[2,2,2])],zero,1)).toEqual({status:"stop",reason:"unchanged"});
    expect(select([candidate(zero,[2,2,2])],zero).status).toBe("unchanged");
    const base={whiteBalanceRed:.4,whiteBalanceGreen:-.2,whiteBalanceBlue:.1},c=proposal(base);
    expect(select(c,base).status).toBe("candidate");expect(next(c,base,1).status).toBe("stop");
  });
  it("does not use posttone neutral pixels as linear truth or ignore luma drift",()=>{
    const c=proposal();c[1]=candidate(c[1],cast,[128,128,128]);expect(select(c,zero).status).toBe("target_unreachable");
    c[1]=candidate(c[1],[.8,.8,.8]);expect(select(c,zero).candidates[1].reasons.join()).toContain("luminance-drift");
    expect(select(proposal(),zero,[[],["global-channel-high"]]).selectedIndex).toBe(0);
  });
  it("refuses clipped baseline reference and candidate endpoint growth",()=>{
    const c=proposal();c[0]=candidate(zero,cast,[255,128,128]);expect(select(c,zero).status).toBe("reference_unusable");expect(next([c[0]],zero,1)).toEqual({status:"stop",reason:"reference-unusable"});
    const d=proposal();d[1]=candidate(d[1],d[1].frames[0].meanLinearRgb,[255,255,255]);expect(select(d,zero).selectedIndex).toBe(0);
  });
  it("rejects ROI/time/sequence/control tamper and surplus candidates",()=>{
    for(const mutate of [(c:LinearWhiteBalanceCandidate[])=>{c[1].frames[0].timeSeconds=.1;},(c:LinearWhiteBalanceCandidate[])=>{c[1].frames[0].roi.width=.5;},(c:LinearWhiteBalanceCandidate[])=>{c[1].whiteBalanceRed+=.01;},(c:LinearWhiteBalanceCandidate[])=>{c.reverse();},(c:LinearWhiteBalanceCandidate[])=>{c.push(c[1]);}]){const c=proposal();mutate(c);expect(()=>next(c,zero,1)).toThrow();}
  });
  it("exposes out-of-range rather than clipped false success",()=>{
    expect(next([candidate(zero)],zero,.05)).toEqual({status:"stop",reason:"out-of-range"});
    for(const n of [0,1.01,NaN])expect(()=>next([],zero,n)).toThrow();
  });
  it("does not accept heterogeneous coloured patches averaging to neutral",()=>{
    const c=candidate(zero,[1,1,1]);
    c.frames=c.frames.map(f=>measureLinearWhiteBalanceReference({...f,pixels:Float32Array.from(Array.from({length:64},(_,i)=>i%2?[.5,1.5,1,1]:[1.5,.5,1,1]).flat())}));
    expect(c.frames[0].neutralErrorStops).toBeCloseTo(0);
    expect(select([c],zero).status).toBe("reference_unusable");
    expect(next([c],zero,1)).toEqual({status:"stop",reason:"reference-unusable"});
  });
  it("stops for safe small residuals within .08 but never hides unsafe reference or surplus candidate",()=>{
    const small=candidate(zero,[.26,.26000003,.265]);
    expect(small.frames.every(f=>f.neutralErrorStops!<.08)).toBe(true);
    expect(next([small],zero,1)).toEqual({status:"stop",reason:"unchanged"});
    expect(()=>next([small,candidate({...zero,whiteBalanceRed:.01},[.26,.26,.26])],zero,1)).toThrow();
    const clipped=candidate(zero,[.26,.26000003,.265],[255,255,255]);
    expect(next([clipped],zero,1)).toEqual({status:"stop",reason:"reference-unusable"});
    expect(candidate(zero).frames[0].neutralErrorStops).toBeGreaterThan(.3);
    expect(next([candidate(zero)],zero,1).status).toBe("next");
  });
});
