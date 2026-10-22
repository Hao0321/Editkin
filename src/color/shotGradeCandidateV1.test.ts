import { afterEach, describe, expect, it, vi } from "vitest";
import { assertColorGradeV2 } from "../domain/colorGradeV2Schema";
import type { ColorGradeV2 } from "../domain/visualTypes";
import { parseCubeFile, sampleCubeLut } from "./cubeLut";
import { bakeColorGradeLut, ffmpegRenderCubeText, sampleBakedGradeLut } from "./gradeLutBake";
import type { ColorLutResolver } from "./gradeV2";
import { oklabToWorking, type Vec3 } from "./gradeV2Color";
import { analyzeShotGradeStatisticsV1, measureShotGradeMatchV1, measureShotGradeSafetyV1,
  type ShotGradeFrameV1, type ShotGradeRegionV1 } from "./shotGradeStatisticsV1";
import { proposeShotGradeCandidateV1, renderShotGradeSurfacesV1, SHOT_GRADE_CANDIDATE_BOUNDS_V1,
  SHOT_GRADE_CANDIDATE_LIMITS_V1, type ShotGradeCandidateInputV1 } from "./shotGradeCandidateV1";

const empty:ColorGradeV2={schema:"editkin.color-grade/v2"};
const frame=(rgb:readonly Vec3[],patch:Partial<ShotGradeFrameV1>={}):ShotGradeFrameV1=>({sampleId:"source-0",timeSeconds:0,
  width:rgb.length,height:1,workingSpace:"rec709_display",stage:"clip_working_pre_v2",format:"rgb64f",pixels:new Float64Array(rgb.flat()),...patch});
const skin=(l=.6):Vec3=>oklabToWorking([l,.04*Math.cos(Math.PI/3),.04*Math.sin(Math.PI/3)],"rec709_display");
const regions=(sampleId="source-0"):ShotGradeRegionV1[]=>[
  {sampleId,role:"neutral",x:0,y:0,width:.5,height:1},
  {sampleId,role:"skin",x:.5,y:0,width:.5,height:1}];
const scene=()=>frame([[.2,.2,.2],[.4,.4,.4],[.6,.6,.6],skin(.4),skin(.55),skin(.7)]);
const targetGrade:ColorGradeV2={schema:"editkin.color-grade/v2",nodes:[{id:"reference",gain:{master:.12},skinProtection:1,skyProtection:1}]};
/** Reference generated independently with the actual full 65-cube bake. */
function reference(input:ShotGradeFrameV1,grade=targetGrade,resolve?:ColorLutResolver):ShotGradeFrameV1 {
  const baked=bakeColorGradeLut(grade,input.workingSpace,resolve);
  const scale=input.format==="rgb8"?255:input.format==="rgb16"?65535:1;
  const renderCopy=input.format==="rgb8"?parseCubeFile(ffmpegRenderCubeText(baked,"reference",false)):undefined;
  if(renderCopy&&renderCopy.kind!=="3d")throw new Error("Reference export must be a 3D cube");
  const output=input.pixels.slice();
  for(let i=0;i<input.width*input.height;i++) {
    const rgb:Vec3=[input.pixels[i*3]/scale,input.pixels[i*3+1]/scale,input.pixels[i*3+2]/scale];
    const value=renderCopy?sampleCubeLut(renderCopy,rgb):sampleBakedGradeLut(baked,rgb);
    for(let c=0;c<3;c++)output[i*3+c]=scale===1?value[c]:Math.min(scale,Math.max(0,Math.trunc(value[c]*scale)));
  }
  return {...input,sampleId:"reference-0",stage:"clip_working_post_v2",pixels:output};
}
const input=():ShotGradeCandidateInputV1=>{const source=scene();return{frames:[source],regions:regions(),
  referenceFrames:[reference(source)],referenceRegions:regions("reference-0")};};
afterEach(()=>vi.restoreAllMocks());

describe("bounded shot grade candidate",()=>{
  it("returns existing-schema controls only after independent full-surface neutral/skin and safety verification",()=>{
    const request=input(),result=proposeShotGradeCandidateV1(request);
    expect(result.status).toBe("candidate");expect(result.gradeV2).not.toBeNull();assertColorGradeV2(result.gradeV2);
    const afterFrames=renderShotGradeSurfacesV1(request.frames,result.gradeV2!);
    const before=analyzeShotGradeStatisticsV1(request.frames,request.regions);
    const after=analyzeShotGradeStatisticsV1(afterFrames,request.regions),ref=analyzeShotGradeStatisticsV1(request.referenceFrames,request.referenceRegions);
    const match=measureShotGradeMatchV1(before,after,ref),safety=measureShotGradeSafetyV1(before,after);
    for(const role of ["neutral","skin"] as const) {
      expect(match.groups[role].afterDeltaE00).toBeLessThanOrEqual(4);
      expect(match.groups[role].reductionFraction).toBeGreaterThanOrEqual(.5);
    }
    expect(safety.measuredBoundsSatisfied).toBe(true);expect(result.search.allSuppliedPixelsVerified).toBe(true);
    expect(result.after?.pixelCount).toBe(6);expect(result.sourceAndCommandEvidenceBound).toBe(false);
    expect(result.appearanceCertified).toBe(false);expect(result.actualSixShotPerformanceVerified).toBe(false);
    expect(result.safety?.missingDeclaredHueRoles).toEqual(["food","sky"]);
    const node=result.gradeV2!.nodes!.at(-1)!;
    expect(node.skinProtection).toBe(1);expect(node.skyProtection).toBe(1);
    for(const v of Object.values(node.offset!))expect(Math.abs(v!)).toBeLessThanOrEqual(SHOT_GRADE_CANDIDATE_BOUNDS_V1.offset);
    for(const v of Object.values(node.gain!))expect(Math.abs(v!)).toBeLessThanOrEqual(SHOT_GRADE_CANDIDATE_BOUNDS_V1.gain);
    expect(result.search.evaluations).toBeLessThanOrEqual(SHOT_GRADE_CANDIDATE_LIMITS_V1.maximumEvaluations);
  });
  it("is deterministic and preserves caller arrays, regions and baseline nodes",()=>{
    const request=input();request.gradeV2={schema:"editkin.color-grade/v2",nodes:[{id:"shot_match_v1",enabled:false,gain:{master:.8}}]};
    const original=structuredClone(request),a=proposeShotGradeCandidateV1(request),b=proposeShotGradeCandidateV1(request);
    expect(a.status).toBe("candidate");expect(a.gradeV2).toEqual(b.gradeV2);expect(a.match).toEqual(b.match);
    expect(request).toEqual(original);expect(a.gradeV2!.nodes![0]).toEqual(original.gradeV2!.nodes![0]);
    expect(a.gradeV2!.nodes!.at(-1)!.id).toBe("shot_match_v1_2");
  });
  it("does not emit a no-op command for an exactly matched reference",()=>{
    const request=input();request.referenceFrames=[{...request.frames[0],sampleId:"reference-0",stage:"clip_working_post_v2",pixels:request.frames[0].pixels.slice()}];
    const result=proposeShotGradeCandidateV1(request);
    expect(result.status).toBe("unchanged");expect(result.gradeV2).toBeNull();expect(result.search.evaluations).toBe(0);
    expect(result.search.allSuppliedPixelsVerified).toBe(true);
  });
  it("refuses to overwrite a full four-node stack, including disabled nodes",()=>{
    const request=input();request.gradeV2={schema:"editkin.color-grade/v2",nodes:Array.from({length:4},(_,i)=>({id:"keep"+i,enabled:false}))};
    const original=structuredClone(request.gradeV2),result=proposeShotGradeCandidateV1(request);
    expect(result).toMatchObject({status:"not_applicable",gradeV2:null,reason:"four-node-capacity-preserve-existing-stack"});
    expect(request.gradeV2).toEqual(original);
  });
  it("leaves missing declared neutral or skin regions unmeasured",()=>{
    for(const side of ["source","reference"] as const) {
      const request=input();if(side==="source")request.regions=request.regions.filter(r=>r.role==="neutral");
      else request.referenceRegions=request.referenceRegions.filter(r=>r.role==="skin");
      const result=proposeShotGradeCandidateV1(request);expect(result.status).toBe("not_applicable");expect(result.gradeV2).toBeNull();
      expect(result.reason).toBe("measured-declared-neutral-and-skin-regions-required-in-both-shots");
    }
  });
  it("does not pretend ACES working-space measurements prove an SDR output transform",()=>{
    const request=input();request.frames=[{...request.frames[0],workingSpace:"acescct"}];
    request.referenceFrames=[{...request.referenceFrames[0],workingSpace:"acescct"}];
    const result=proposeShotGradeCandidateV1(request);
    expect(result.status).toBe("not_applicable");expect(result.reason).toContain("SDR-output-transform");expect(result.search.evaluations).toBe(0);
    expect(result.reference!.interpretation.sdrOutputTransformMeasured).toBe(false);
    const display=analyzeShotGradeStatisticsV1(input().frames);
    expect(display.interpretation).toMatchObject({sdrOutputTransformMeasured:false,declaredSdrDisplayBasis:true});
  });
  it("requires an explicit pre-grade source and post-grade reference in the same working space",()=>{
    const a=input();a.frames=[{...a.frames[0],stage:"clip_working_post_v2"}];expect(()=>proposeShotGradeCandidateV1(a)).toThrow("precede gradeV2");
    const b=input();b.referenceFrames=[{...b.referenceFrames[0],stage:"clip_working_pre_v2"}];expect(()=>proposeShotGradeCandidateV1(b)).toThrow("Reference must be post-grade");
    const c=input();c.referenceFrames=[{...c.referenceFrames[0],workingSpace:"acescct"}];expect(()=>proposeShotGradeCandidateV1(c)).toThrow("same working space");
  });
  it("refuses spatial finishing rather than evaluating only its colour part",()=>{
    const request=input();request.gradeV2={...empty,finishing:{vignette:{amount:.3}}};
    expect(proposeShotGradeCandidateV1(request)).toMatchObject({status:"not_applicable",gradeV2:null,reason:"spatial-finishing-requires-actual-renderer-evidence"});
    expect(()=>renderShotGradeSurfacesV1(request.frames,request.gradeV2!)).toThrow("Spatial finishing");
  });
  it("returns a refusal when a bounded search cannot meet the independent match gate",()=>{
    const request=input();request.referenceFrames=[frame([[.9,.9,.9],[.9,.9,.9],[.9,.9,.9],skin(.95),skin(.95),skin(.95)],
      {sampleId:"reference-0",stage:"clip_working_post_v2"})];
    const result=proposeShotGradeCandidateV1(request);
    expect(result.status).toBe("not_applicable");expect(result.gradeV2).toBeNull();expect(result.search.allSuppliedPixelsVerified).toBe(true);
    expect(result.match?.matchesSpecifiedNeutralAndSkinBounds).toBe(false);
  });
  it("keeps achromatic declared skin unmeasured rather than waiving its hue gate",()=>{
    const request=input(),source=frame(Array.from({length:6},(_,i)=>[.2+i*.08,.2+i*.08,.2+i*.08] as Vec3));
    request.frames=[source];request.referenceFrames=[reference(source)];
    const result=proposeShotGradeCandidateV1(request);expect(result.status).toBe("not_applicable");expect(result.gradeV2).toBeNull();
    expect(result.safety?.hueChanges.skin.undefinedHuePixels).toBe(3);expect(result.safety?.measuredBoundsSatisfied).toBe(false);
  });
  it("honours cancellation without returning the best incomplete candidate",()=>{
    const controller=new AbortController();controller.abort();const request={...input(),signal:controller.signal};
    const result=proposeShotGradeCandidateV1(request);expect(result).toMatchObject({status:"cancelled",gradeV2:null});
    expect(result.search.allSuppliedPixelsVerified).toBe(false);expect(result.search.evaluations).toBe(0);
  });
  it("checks a wall-time deadline and does not return partial-search parameters",()=>{
    const request=input();let calls=0;vi.spyOn(performance,"now").mockImplementation(()=>calls++<30?0:2001);
    const result=proposeShotGradeCandidateV1(request);
    expect(result).toMatchObject({status:"budget_exceeded",gradeV2:null});expect(result.search.allSuppliedPixelsVerified).toBe(false);
  });
  it("rejects malformed time budgets and contradictory declared ROI roles",()=>{
    for(const maximumTimeMs of [0,-1,NaN,Infinity,2001])expect(()=>proposeShotGradeCandidateV1({...input(),maximumTimeMs})).toThrow("Time budget");
    const request=input();request.regions=[{...request.regions[0],width:1},request.regions[1]];
    expect(()=>proposeShotGradeCandidateV1(request)).toThrow("Conflicting roles");
  });
  it("retains all supplied pixels for verification when the fitting population is bounded",()=>{
    const values=Array.from({length:1800},(_,i)=>i<900?[.3,.3,.3] as Vec3:skin(.55));
    const source=frame(values),request={frames:[source],regions:regions(),referenceFrames:[reference(source)],referenceRegions:regions("reference-0")};
    const result=proposeShotGradeCandidateV1(request);
    expect(result.status).toBe("candidate");expect(result.search.fitSourcePixels).toBeLessThanOrEqual(768);
    expect(result.search.fitSourcePixels).toBeLessThan(1800);expect(result.after?.pixelCount).toBe(1800);
    expect(result.safety?.hueChanges.skin.selectedPixels).toBe(900);expect(result.search.allSuppliedPixelsVerified).toBe(true);
  });
  it("verifies actual integer representations after fitting rather than returning an unquantized estimate",()=>{
    for(const format of ["rgb8","rgb16"] as const) {
      const source=scene(),scale=format==="rgb8"?255:65535;
      source.format=format;source.pixels=format==="rgb8"?Uint8Array.from(source.pixels,v=>Math.round(v*scale)):Uint16Array.from(source.pixels,v=>Math.round(v*scale));
      const request={frames:[source],regions:regions(),referenceFrames:[reference(source)],referenceRegions:regions("reference-0")};
      const result=proposeShotGradeCandidateV1(request);expect(result.status).toBe("candidate");
      const actual=analyzeShotGradeStatisticsV1(renderShotGradeSurfacesV1([source],result.gradeV2!),request.regions);
      expect(actual.regions).toEqual(result.after!.regions);expect(actual.displaySurfaceEndpoints).toEqual(result.after!.displaySurfaceEndpoints);
    }
  });
  it("refuses mixed representations instead of silently fitting one representation for both",()=>{
    const request=input(),extra=scene();extra.sampleId="source-1";extra.timeSeconds=1;extra.format="rgb32f";extra.pixels=new Float32Array(extra.pixels);
    request.frames=[request.frames[0],extra];
    const result=proposeShotGradeCandidateV1(request);expect(result).toMatchObject({status:"not_applicable",gradeV2:null});expect(result.reason).toContain("mixed-representations");
  });
  it("preserves an active baseline node and the existing look after the appended correction",()=>{
    const source=scene(),grade:ColorGradeV2={...empty,nodes:[{id:"baseline",gain:{master:.02}}],look:{id:"hfl2_travel_clear_air",strength:.2}};
    const target:ColorGradeV2={...grade,nodes:[...grade.nodes!,...targetGrade.nodes!]};
    const request={frames:[source],regions:regions(),referenceFrames:[{...renderShotGradeSurfacesV1([source],target)[0],sampleId:"reference-0"}],referenceRegions:regions("reference-0"),gradeV2:grade};
    const before=structuredClone(grade),result=proposeShotGradeCandidateV1(request);expect(result.status).toBe("candidate");
    expect(result.gradeV2!.nodes![0]).toEqual(before.nodes![0]);expect(result.gradeV2!.look).toEqual(before.look);expect(grade).toEqual(before);
    const actual=renderShotGradeSurfacesV1([source],result.gradeV2!)[0],independent=reference(source,result.gradeV2!);
    expect(Array.from(actual.pixels)).toEqual(Array.from(independent.pixels));
  });
});

describe("grade candidate forward model agrees with actual export bake",()=>{
  const grade:ColorGradeV2={schema:"editkin.color-grade/v2",nodes:[{id:"base",gamma:{master:.13},gain:{r:.06},
    curves:{y:[{x:0,y:0},{x:.35,y:.28},{x:1,y:1}]},saturation:.9,skinProtection:1,skyProtection:1}]};
  const values:Vec3[]=[[.201,.403,.605],[.601,.203,.405],[.401,.603,.205],[.201,.603,.405],[.401,.203,.605],[.601,.403,.205],[-.1,.3,1.1],[1,1,1],[0,0,0]];
  it("matches the full 65-cube on all six tetrahedron orderings and signed/outside domain inputs",()=>{
    const source=frame(values),baked=bakeColorGradeLut(grade,"rec709_display"),output=renderShotGradeSurfacesV1([source],grade)[0];
    const expected=values.flatMap(rgb=>sampleBakedGradeLut(baked,rgb));expect(Array.from(output.pixels)).toEqual(expected);
    expect(output.stage).toBe("clip_working_post_v2");expect(source.stage).toBe("clip_working_pre_v2");expect(Array.from(source.pixels)).toEqual(values.flat());
  });
  it("matches the biased 8-bit render copy's actual truncation representation",()=>{
    const source=frame(values,{format:"rgb8",pixels:Uint8Array.from(values.flat(),v=>Math.max(0,Math.min(255,Math.round(v*255))))});
    const output=renderShotGradeSurfacesV1([source],grade)[0],baked=bakeColorGradeLut(grade,"rec709_display");
    const parsed=parseCubeFile(ffmpegRenderCubeText(baked,"actual 8-bit render copy",false));expect(parsed.kind).toBe("3d");
    if(parsed.kind!=="3d")throw new Error("Expected the actual 3D export cube");
    const expected:number[]=[];
    for(let i=0;i<source.pixels.length;i+=3)expected.push(...sampleCubeLut(parsed,
      [source.pixels[i]/255,source.pixels[i+1]/255,source.pixels[i+2]/255]).map(v=>Math.min(255,Math.max(0,Math.trunc(v*255)))));
    expect(Array.from(output.pixels)).toEqual(expected);
  });
  it("matches the unbiased 16-bit representation instead of applying the 8-bit half-code bias",()=>{
    const source=frame(values,{format:"rgb16",pixels:Uint16Array.from(values.flat(),v=>Math.max(0,Math.min(65535,Math.round(v*65535))))});
    const output=renderShotGradeSurfacesV1([source],grade)[0],baked=bakeColorGradeLut(grade,"rec709_display");
    const expected:number[]=[];
    for(let i=0;i<source.pixels.length;i+=3)expected.push(...sampleBakedGradeLut(baked,
      [source.pixels[i]/65535,source.pixels[i+1]/65535,source.pixels[i+2]/65535]).map(v=>Math.min(65535,Math.max(0,Math.trunc(v*65535)))));
    expect(Array.from(output.pixels)).toEqual(expected);
  });
  it("preserves Float32 rounding and identity bypass byte-for-byte",()=>{
    const source=frame(values,{format:"rgb32f",pixels:new Float32Array(values.flat())});
    const identity=renderShotGradeSurfacesV1([source],empty)[0];expect(Array.from(identity.pixels)).toEqual(Array.from(source.pixels));
    const output=renderShotGradeSurfacesV1([source],grade)[0],baked=bakeColorGradeLut(grade,"rec709_display"),expected:number[]=[];
    for(let i=0;i<source.pixels.length;i+=3)expected.push(...sampleBakedGradeLut(baked,[source.pixels[i],source.pixels[i+1],source.pixels[i+2]]).map(Math.fround));
    expect(Array.from(output.pixels)).toEqual(expected);
  });
  it("resolves a baseline LUT once and preserves its reference and node ordering",()=>{
    const request=input(),sha="a".repeat(64),cube={kind:"1d" as const,size:2,domainMin:[0,0,0] as Vec3,domainMax:[1,1,1] as Vec3,
      values:new Float32Array([0,0,0,1,1,1])};
    request.gradeV2={...empty,nodes:[{id:"user-lut",lut:{id:"lut:"+sha.slice(0,16),sha256:sha,strength:.7}}]};
    const resolve=vi.fn(()=>cube),result=proposeShotGradeCandidateV1({...request,resolveLut:resolve});
    expect(result.status).toBe("candidate");expect(resolve).toHaveBeenCalledTimes(1);expect(result.gradeV2!.nodes![0]).toEqual(request.gradeV2.nodes![0]);
    const actual=renderShotGradeSurfacesV1(request.frames,result.gradeV2!,{resolveLut:()=>cube});
    const expected=reference(request.frames[0],result.gradeV2!,()=>cube);
    expect(Array.from(actual[0].pixels)).toEqual(Array.from(expected.pixels));
    expect(()=>renderShotGradeSurfacesV1(request.frames,result.gradeV2!)).toThrow(/LUT/);
  });
});
