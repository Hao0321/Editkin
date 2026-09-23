import {getLinearWhiteBalanceStops,solveLinearWhiteBalanceStops,type LinearWhiteBalanceColor} from "../color/linearWhiteBalance";
import {validateLinearWhiteBalanceReference,linearWhiteBalanceReferenceUnusable,type LinearWhiteBalanceReferenceMeasurement} from "./linearWhiteBalanceReference";
import {validateReferenceWhiteBalanceMeasurement,type ReferenceWhiteBalanceMeasurement} from "./referenceWhiteBalance";
export interface LinearWhiteBalanceControl {whiteBalanceRed:number;whiteBalanceGreen:number;whiteBalanceBlue:number}
export interface LinearWhiteBalanceCandidate extends LinearWhiteBalanceControl {frames:LinearWhiteBalanceReferenceMeasurement[];outputReferences:ReferenceWhiteBalanceMeasurement[]}
const control=(s:number[]):LinearWhiteBalanceControl=>({whiteBalanceRed:s[0],whiteBalanceGreen:s[1],whiteBalanceBlue:s[2]});
const key=(c:LinearWhiteBalanceColor)=>getLinearWhiteBalanceStops(c).join(":");
function invalid():never{throw Error("Invalid linear white balance candidate binding");}
function validate(candidates:LinearWhiteBalanceCandidate[],baseline:LinearWhiteBalanceColor):number {
  const baseKey=key(baseline);
  if(!Array.isArray(candidates)||!candidates.length||candidates.length>9)invalid();
  const baseIndex=candidates.findIndex(c=>key(c)===baseKey);if(baseIndex<0)invalid();
  const base=candidates[baseIndex],keys=new Set<string>();
  for(const c of candidates){const k=key(c);if(keys.has(k)||!Array.isArray(c.frames)||c.frames.length<2||c.frames.length>3||!Array.isArray(c.outputReferences)||c.outputReferences.length!==c.frames.length||c.frames.length!==base.frames.length)invalid();keys.add(k);
    for(let i=0;i<c.frames.length;i++){
      const f=c.frames[i],b=base.frames[i],o=c.outputReferences[i];validateLinearWhiteBalanceReference(f);validateReferenceWhiteBalanceMeasurement(o);
      if(i>0&&(f.timeSeconds<=c.frames[i-1].timeSeconds||c.frames.slice(0,i).some(p=>p.sampleId===f.sampleId)))invalid();
      for(const field of ["sampleId","timeSeconds","width","height","pixelCount","basis","inputConvention","reference"] as const)if(f[field]!==b[field])invalid();
      for(const field of ["sampleId","timeSeconds","width","height","pixelCount","reference"] as const)if(f[field]!==o[field])invalid();
      if(o.transfer!=="bt709-oetf")invalid();
      for(const field of ["x","y","width","height"] as const)if(f.roi[field]!==b.roi[field]||f.roi[field]!==o.roi[field])invalid();
    }
  }return baseIndex;
}
export function selectLinearWhiteBalanceCandidate(candidates:LinearWhiteBalanceCandidate[],baseline:LinearWhiteBalanceColor,additionalReasons?:string[][]){
  const baselineIndex=validate(candidates,baseline),base=candidates[baselineIndex];
  if(additionalReasons&&(!Array.isArray(additionalReasons)||additionalReasons.length!==candidates.length||additionalReasons.some(r=>!Array.isArray(r)||r.some(s=>typeof s!=="string"||!s.trim()))))invalid();
  const invalidReference=base.frames.some(linearWhiteBalanceReferenceUnusable)||base.outputReferences.some(f=>f.endpointFraction>.02);
  const scores=candidates.map((c,ci)=>{
    const reasons=[...(additionalReasons?.[ci]??[])];
    c.frames.forEach((f,i)=>{if(linearWhiteBalanceReferenceUnusable(f))reasons.push(`reference-unusable:${f.sampleId}`);
      if(f.meanLinearY<=0||base.frames[i].meanLinearY<=0||Math.abs(Math.log2(f.meanLinearY/base.frames[i].meanLinearY))>.1+1e-12)reasons.push(`luminance-drift:${f.sampleId}`);
      if(c.outputReferences[i].endpointFraction-base.outputReferences[i].endpointFraction>.003+1e-12)reasons.push(`output-reference-endpoint-increase:${f.sampleId}`);
    });
    const errors=c.frames.map(f=>f.neutralErrorStops);
    return {...control(getLinearWhiteBalanceStops(c)),neutralErrorStops:errors.some(e=>e===null)?null:(errors as number[]).reduce((a,b)=>a+b,0)/errors.length,
      worstErrorStops:errors.some(e=>e===null)?null:Math.max(...errors as number[]),accepted:!invalidReference&&reasons.length===0,reasons};
  });
  const baseScore=scores[baselineIndex];
  const eligible=scores.map((s,i)=>({s,i})).filter(({s,i})=>i!==baselineIndex&&s.accepted&&s.neutralErrorStops!==null&&s.worstErrorStops!==null&&baseScore.neutralErrorStops!==null&&baseScore.worstErrorStops!==null
    &&baseScore.neutralErrorStops-s.neutralErrorStops>=.02-1e-12&&s.worstErrorStops<=baseScore.worstErrorStops+1e-12);
  eligible.sort((a,b)=>a.s.neutralErrorStops!-b.s.neutralErrorStops!||a.i-b.i);
  const selectedIndex=eligible[0]?.i??baselineIndex,selected=scores[selectedIndex];
  const status:"reference_unusable"|"target_unreachable"|"unchanged"|"candidate"=invalidReference?"reference_unusable":selected.worstErrorStops===null||selected.worstErrorStops>.08?"target_unreachable":selectedIndex===baselineIndex?"unchanged":"candidate";
  return {selectedIndex,baselineIndex,status,candidates:scores,referenceAuthority:"caller-declared-not-detected" as const,whitePointVerification:"unmeasured" as const,aestheticQuality:"unmeasured" as const};
}
export type LinearWhiteBalanceNext={status:"next";control:LinearWhiteBalanceControl}|{status:"stop";reason:"complete"|"reference-unusable"|"out-of-range"|"unchanged"};
/** One baseline-derived aggregate proposal; never compound successive candidate gains. */
export function nextLinearWhiteBalanceControl(evaluated:LinearWhiteBalanceCandidate[],baseline:LinearWhiteBalanceColor,maxGainStops:number):LinearWhiteBalanceNext{
  const baseStops=getLinearWhiteBalanceStops(baseline);
  if(!Number.isFinite(maxGainStops)||maxGainStops<.05||maxGainStops>1||!Array.isArray(evaluated)||evaluated.length>2)invalid();
  if(!evaluated.length)return {status:"next",control:control(baseStops)};
  const baseIndex=validate(evaluated,baseline);if(baseIndex!==0)invalid();
  const base=evaluated[0];
  const stop=(reason:"reference-unusable"|"out-of-range"|"unchanged"):LinearWhiteBalanceNext=>{if(evaluated.length!==1)invalid();return {status:"stop",reason};};
  if(base.frames.some(linearWhiteBalanceReferenceUnusable)||base.outputReferences.some(f=>f.endpointFraction>.02))return stop("reference-unusable");
  // A safe reference already inside the existing target needs no extra decode
  // for float noise or a below-threshold cast. This is not a relaxed solver.
  if(base.frames.every(f=>f.neutralErrorStops!==null&&f.neutralErrorStops<=.08))return stop("unchanged");
  const normalized=base.frames.reduce<number[]>((m,f)=>m.map((v,i)=>v+f.meanLinearRgb[i]/f.meanLinearY/base.frames.length),[0,0,0]) as [number,number,number];
  const solved=solveLinearWhiteBalanceStops(normalized,baseline,maxGainStops);
  if(solved.status==="out-of-range")return stop("out-of-range");
  if(solved.status==="unchanged")return stop("unchanged");
  const next=control(solved.stops);
  if(evaluated.length===2){if(key(evaluated[1])!==key(next))invalid();return {status:"stop",reason:"complete"};}
  return {status:"next",control:next};
}
