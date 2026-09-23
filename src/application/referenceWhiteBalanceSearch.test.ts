import { describe, expect, it } from "vitest";
import { nextReferenceWhiteBalanceControl as next, type ReferenceWhiteBalanceControl } from "./referenceWhiteBalanceSearch";
import { measureReferenceWhiteBalanceFrame, selectReferenceWhiteBalanceCandidate, type ReferenceWhiteBalanceCandidate } from "./referenceWhiteBalance";
const baseline = { temperature: 0, tint: 0 };
// Independent RGB8 response instrument, NOT primaryGrade/gradeRgb or FFmpeg oracle.
const sample = (c: ReferenceWhiteBalanceControl, responsive = true): ReferenceWhiteBalanceCandidate => {
  const rgb = responsive ? [137 + c.temperature * 20, 128 + c.tint * 20, 119 - c.temperature * 20] : [137,128,119];
  return { ...c, frames: [0,1].map(i => measureReferenceWhiteBalanceFrame({ sampleId:`kf-${i+1}`,timeSeconds:i,width:8,height:8,
    roi:{x:0,y:0,width:1,height:1},transfer:"bt709-oetf",reference:"caller-declared-neutral",
    pixels:Uint8Array.from({length:192},(_,p)=>Math.round(rgb[p%3])) })) };
};
function run(max=1, responsive=true, base=baseline) {
  const evaluated:ReferenceWhiteBalanceCandidate[]=[];
  for(let i=0;i<10;i++) { const result=next(evaluated,base,max); if(result.status==="stop")return {evaluated,result}; evaluated.push(sample(result.control,responsive)); }
  throw Error("Budget was not bounded");
}
describe("bounded measured white balance Jacobian",()=>{
  it("corrects the unchanged 137/128/119 strong RGB control within nine measured candidates",()=>{
    const {evaluated,result}=run();
    expect(evaluated.length).toBeLessThanOrEqual(9);
    expect(evaluated[0].frames[0].neutralErrorStops).toBeGreaterThan(.3);
    expect(result).toEqual({status:"stop",reason:"target-reached"});
    expect(selectReferenceWhiteBalanceCandidate(evaluated,baseline).status).toBe("candidate");
    expect(evaluated.slice(0,5).map(({temperature,tint})=>({temperature,tint}))).toEqual([baseline,{temperature:-1,tint:0},{temperature:1,tint:0},{temperature:0,tint:-1},{temperature:0,tint:1}]);
  });
  it("stops explicitly on singular measured response without predicted results",()=>{
    const {evaluated,result}=run(1,false); expect(evaluated).toHaveLength(5); expect(result).toEqual({status:"stop",reason:"singular-jacobian"});
  });
  it("deduplicates clamped boundary seeds and keeps allowed adjustments",()=>{
    const {evaluated}=run(.5,false,{temperature:1,tint:1});
    expect(evaluated).toHaveLength(3); expect(new Set(evaluated.map(c=>`${c.temperature}:${c.tint}`)).size).toBe(3);
    expect(evaluated.every(c=>c.temperature>=.5&&c.tint>=.5&&c.temperature<=1&&c.tint<=1)).toBe(true);
  });
  it("keeps limited-search target unreachable without relaxing .08",()=>{
    const {evaluated}=run(.05); expect(selectReferenceWhiteBalanceCandidate(evaluated,baseline).status).toBe("target_unreachable");
  });
  it("rejects NaN, invalid bounds, wrong seed order and mismatched metadata",()=>{
    for(const value of [NaN,0,1.01]) expect(()=>next([],baseline,value)).toThrow();
    expect(()=>next([],{temperature:NaN,tint:0},1)).toThrow();
    expect(()=>next([sample(baseline),sample({temperature:1,tint:0})],baseline,1)).toThrow();
    const bad=sample({temperature:-1,tint:0}); bad.frames[0].roi.width=.5;
    expect(()=>next([sample(baseline),bad],baseline,1)).toThrow();
  });
});
