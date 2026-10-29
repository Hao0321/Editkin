import {expect,it} from "vitest";
import {proposeShotGradeAutoBalanceV1} from "./shotGradeAutoBalanceV1";
import type {ShotGradeFrameV1,ShotGradeRegionV1} from "./shotGradeStatisticsV1";
const regions:ShotGradeRegionV1[]=[{sampleId:"f",role:"neutral",x:0,y:0,width:.5,height:1},{sampleId:"f",role:"skin",x:.5,y:0,width:.5,height:1}];
function frame(warm=false,format:"rgb8"|"rgb16"="rgb8"):ShotGradeFrameV1{
 const rgb=warm?[.46,.4,.36,.61,.42,.3]:[.4,.4,.4,.61,.42,.3],scale=format==="rgb8"?255:65535;
 return {sampleId:"f",timeSeconds:0,width:2,height:1,workingSpace:"rec709_display",stage:"clip_working_pre_v2",format,pixels:format==="rgb8"?Uint8Array.from(rgb,x=>Math.round(x*scale)):Uint16Array.from(rgb,x=>Math.round(x*scale))};
}
it.each(["rgb8","rgb16"] as const)("balances declared neutral chroma with bounded protected controls (%s)",format=>{
 const source=frame(true,format),saved=source.pixels.slice(),result=proposeShotGradeAutoBalanceV1({frames:[source],regions});
 expect(result.status,result.reason).toBe("candidate");expect(result.neutrality!.beforeCie00).toBeGreaterThan(3);expect(result.neutrality!.afterCie00).toBeLessThanOrEqual(3);
 expect(result.safety!.measuredBoundsSatisfied).toBe(true);expect(result.search.evaluations).toBeLessThanOrEqual(56);expect(result.search.allSuppliedPixelsVerified).toBe(true);
 const node=result.gradeV2!.nodes!.at(-1)!;expect(node.skinProtection).toBe(.5);expect(node.skyProtection).toBe(1);
 for(const value of Object.values(node.offset!))expect(Math.abs(value!)).toBeLessThanOrEqual(.06);
 expect(Math.abs(node.gain!.master!)).toBeLessThanOrEqual(.24);expect(Math.abs(node.gamma!.master!)).toBeLessThanOrEqual(.24);
 expect(source.pixels).toEqual(saved);expect(result.whitePointClassified).toBe(false);expect(result.actualSixShotPerformanceVerified).toBe(false);
});
it("does not add a node when the declared neutral is already within bounds",()=>{
 const result=proposeShotGradeAutoBalanceV1({frames:[frame()],regions});expect(result.status).toBe("unchanged");expect(result.gradeV2).toBeNull();expect(result.search.allSuppliedPixelsVerified).toBe(true);
});
it("preserves the original grade and refuses the four-node limit",()=>{
 const grade={schema:"editkin.color-grade/v2" as const,nodes:Array.from({length:4},(_,i)=>({id:"old-"+i}))},saved=structuredClone(grade);
 expect(proposeShotGradeAutoBalanceV1({frames:[frame(true)],regions,gradeV2:grade}).reason).toMatch(/capacity/);expect(grade).toEqual(saved);
});
it("requires declared skin and neutral cohorts rather than inventing classification",()=>{
 expect(proposeShotGradeAutoBalanceV1({frames:[frame(true)],regions:regions.slice(0,1)}).reason).toMatch(/neutral-and-skin/);
});
it("refuses spatial finishing and unmeasured ACES output",()=>{
 expect(proposeShotGradeAutoBalanceV1({frames:[frame(true)],regions,gradeV2:{schema:"editkin.color-grade/v2",finishing:{grain:{amount:.1}}}}).reason).toMatch(/spatial/);
 expect(proposeShotGradeAutoBalanceV1({frames:[{...frame(true),workingSpace:"acescct"}],regions}).reason).toMatch(/ACES/);
});
it("returns cancellation and elapsed-budget outcomes without a grade",()=>{
 const controller=new AbortController();controller.abort();expect(proposeShotGradeAutoBalanceV1({frames:[frame(true)],regions,signal:controller.signal}).status).toBe("cancelled");
 const result=proposeShotGradeAutoBalanceV1({frames:[frame(true)],regions,maximumTimeMs:Number.MIN_VALUE});expect(result.status).toBe("budget_exceeded");expect(result.gradeV2).toBeNull();
});
it.each([0,-1,2001,NaN,Infinity])("refuses invalid budget %s",maximumTimeMs=>expect(()=>proposeShotGradeAutoBalanceV1({frames:[frame(true)],regions,maximumTimeMs})).toThrow(/budget/));
it("does not accept post-grade input as another pre-grade source",()=>{
 expect(()=>proposeShotGradeAutoBalanceV1({frames:[{...frame(true),stage:"clip_working_post_v2"}],regions})).toThrow(/Pre-v2/);
});
