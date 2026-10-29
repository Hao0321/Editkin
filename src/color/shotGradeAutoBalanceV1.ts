import {assertColorGradeV2,COLOR_GRADE_V2_MAX_NODES} from "../domain/colorGradeV2Schema";
import type {ColorGradeV2} from "../domain/visualTypes";
import {resolveColorGradeV2} from "./gradeV2";
import {GradeSurfaceSampler,fitting,SHOT_GRADE_CANDIDATE_LIMITS_V1} from "./shotGradeCandidateV1";
import {analyzeShotGradeStatisticsV1,measureShotGradeSafetyV1,type ShotGradeFrameV1,type ShotGradeRegionV1,type ShotGradeStatisticsV1} from "./shotGradeStatisticsV1";
import {cieDeltaE2000V1,linearRec709ToCieLabD65V1} from "./cieDeltaE2000V1";
import {linearRec709ToWorking} from "./gradeV2Color";

export interface ShotGradeAutoBalanceInputV1 {frames:readonly ShotGradeFrameV1[];regions:readonly ShotGradeRegionV1[];gradeV2?:ColorGradeV2;maximumTimeMs?:number;signal?:AbortSignal}
export interface ShotGradeAutoBalanceResultV1 {
 schema:"editkin.shot-grade-auto-balance/v1";status:"candidate"|"unchanged"|"not_applicable"|"cancelled"|"budget_exceeded";
 reason:string;gradeV2:ColorGradeV2|null;before:ShotGradeStatisticsV1|null;after:ShotGradeStatisticsV1|null;
 safety:ReturnType<typeof measureShotGradeSafetyV1>|null;
 neutrality:{beforeCie00:number;afterCie00:number;maximumCie00:3;baselineLinearY:number;targetLab:[number,number,number];measuredBoundSatisfied:boolean}|null;
 search:{evaluations:number;fitPixels:number;maximumEvaluations:56;allSuppliedPixelsVerified:boolean;elapsedMs:number};
 scope:"provided-working-surfaces-and-caller-declared-regions-only";referenceAuthority:"declared-neutral-baseline-luminance-D65";
 whitePointClassified:false;sourceAndCommandEvidenceBound:false;appearanceCertified:false;actualSixShotPerformanceVerified:false;
}
class Stop extends Error {constructor(readonly status:"cancelled"|"budget_exceeded"){super("SHOT_GRADE_BALANCE_"+status.toUpperCase());}}
const initial=[0,0,0,0,0,0,0,1,1],bounds=[[-.06,.06],[-.06,.06],[-.06,.06],[-.24,.24],[-.24,.24],[-.24,.24],[-.24,.24],[.8,1.2],[.8,1.2]];
/** Caller-declared neutral chroma balancing, keeping its measured baseline
 * luminance. Skin/food/sky and endpoint gates use the fixed original cohort;
 * neither a white-point classifier nor a scene exposure preference is inferred. */
export function proposeShotGradeAutoBalanceV1(input:ShotGradeAutoBalanceInputV1):ShotGradeAutoBalanceResultV1 {
 const limit=input.maximumTimeMs??2000;if(!Number.isFinite(limit)||limit<=0||limit>2000)throw Error("SHOT_GRADE_BALANCE_INVALID: Time budget must be positive and at most 2000ms");
 const start=performance.now(),check=()=>{if(input.signal?.aborted)throw new Stop("cancelled");if(performance.now()-start>=limit)throw new Stop("budget_exceeded");};
 const result:ShotGradeAutoBalanceResultV1={schema:"editkin.shot-grade-auto-balance/v1",status:"not_applicable",reason:"bounded-neutrality-target-unreachable",gradeV2:null,before:null,after:null,safety:null,neutrality:null,
  search:{evaluations:0,fitPixels:0,maximumEvaluations:56,allSuppliedPixelsVerified:false,elapsedMs:0},scope:"provided-working-surfaces-and-caller-declared-regions-only",
  referenceAuthority:"declared-neutral-baseline-luminance-D65",whitePointClassified:false,sourceAndCommandEvidenceBound:false,appearanceCertified:false,actualSixShotPerformanceVerified:false};
 try{
  check();analyzeShotGradeStatisticsV1(input.frames,input.regions);
  if(input.frames.some(frame=>frame.stage!=="clip_working_pre_v2"))throw Error("SHOT_GRADE_BALANCE_INVALID: Pre-v2 surfaces required");
  const frames=input.frames.map(frame=>({...frame,pixels:frame.pixels.slice()})),regions=structuredClone(input.regions),grade=assertColorGradeV2(input.gradeV2??{schema:"editkin.color-grade/v2"});
  if(frames[0].workingSpace!=="rec709_display"){result.reason="actual-ACES-SDR-output-transform-required";return result;}
  if(frames.some(frame=>frame.format!==frames[0].format)){result.reason="uniform-bound-representation-required";return result;}
  if((grade.nodes?.length??0)>=COLOR_GRADE_V2_MAX_NODES){result.reason="four-node-capacity-preserve-existing-stack";return result;}
  const baseline=resolveColorGradeV2(grade,frames[0].workingSpace);if(baseline.finishing){result.reason="spatial-finishing-requires-actual-renderer-evidence";return result;}
  const sampler=new GradeSurfaceSampler(check),before=analyzeShotGradeStatisticsV1(sampler.render(frames,baseline),regions);check();result.before=before;
  if(!before.regions.neutral.pixelCount||!before.regions.skin.pixelCount){result.reason="measured-declared-neutral-and-skin-regions-required";return result;}
  const neutral=before.regions.neutral.meanLinearRec709!,y=.2126*neutral[0]+.7152*neutral[1]+.0722*neutral[2];
  if(!Number.isFinite(y)||y<=0||y>1){result.reason="neutral-baseline-luminance-unusable";return result;}
  const target=linearRec709ToCieLabD65V1([y,y,y]),distance=(stats:ShotGradeStatisticsV1)=>cieDeltaE2000V1(stats.regions.neutral.meanCieLabD65!,target);
  const original=distance(before);result.neutrality={beforeCie00:original,afterCie00:original,maximumCie00:3,baselineLinearY:y,targetLab:target,measuredBoundSatisfied:original<=3};
  if(original<=3){result.status="unchanged";result.reason="declared-neutral-already-within-bound";result.after=before;result.safety=measureShotGradeSafetyV1(before,before);result.search.allSuppliedPixelsVerified=true;return result;}
  const fit=fitting(frames,regions);result.search.fitPixels=fit.count;
  const fitBefore=analyzeShotGradeStatisticsV1(sampler.render(fit.frames,baseline),fit.regions),skin=fitBefore.regions.skin.meanCieLabD65!;
  let id="auto_balance_v1",suffix=1;while(grade.nodes?.some(node=>node.id===id))id="auto_balance_v1_"+(++suffix);
  const proposal=(values:readonly number[])=>assertColorGradeV2({...grade,nodes:[...(grade.nodes??[]),{id,offset:{r:values[0],g:values[1],b:values[2]},gain:{master:values[3],r:values[4],b:values[5]},gamma:{master:values[6]},saturation:values[7],contrast:values[8],skinProtection:.5,skyProtection:1}]});
  const loss=(stats:ShotGradeStatisticsV1)=>distance(stats)+.25*cieDeltaE2000V1(stats.regions.skin.meanCieLabD65!,skin);
  let best=[...initial],bestLoss=loss(fitBefore);result.search.evaluations=1;const visited=new Set<string>();
  const evaluate=(values:number[])=>{check();const key=values.join(":");if(visited.has(key))return Infinity;visited.add(key);
   if(result.search.evaluations>=SHOT_GRADE_CANDIDATE_LIMITS_V1.maximumEvaluations)throw Error("SHOT_GRADE_BALANCE_INVALID: Evaluation budget exceeded");result.search.evaluations++;
   const stats=analyzeShotGradeStatisticsV1(sampler.render(fit.frames,resolveColorGradeV2(proposal(values),frames[0].workingSpace)),fit.regions);
   const safety=measureShotGradeSafetyV1(fitBefore,stats);check();return safety.measuredBoundsSatisfied?loss(stats):Infinity;};
  const neutralWorking=linearRec709ToWorking(neutral,frames[0].workingSpace),targetWorking=linearRec709ToWorking([y,y,y],frames[0].workingSpace);
  const seed=[...initial];for(let channel=0;channel<3;channel++)seed[channel]=Number(Math.max(-.06,Math.min(.06,targetWorking[channel]-neutralWorking[channel])).toFixed(6));
  const centre=evaluate(seed);if(centre<bestLoss){best=seed;bestLoss=centre;}
  for(const fraction of [.25,.125,.0625])for(let axis=0;axis<initial.length;axis++){
   const saved=[...best],step=(bounds[axis][1]-bounds[axis][0])*fraction;
   for(const direction of [-1,1]){const values=[...saved];values[axis]=Number(Math.max(bounds[axis][0],Math.min(bounds[axis][1],saved[axis]+direction*step)).toFixed(6));const value=evaluate(values);if(value<bestLoss-1e-12){best=values;bestLoss=value;}}
  }
  const proposed=proposal(best),after=analyzeShotGradeStatisticsV1(sampler.render(frames,resolveColorGradeV2(proposed,frames[0].workingSpace)),regions);check();
  result.after=after;result.safety=measureShotGradeSafetyV1(before,after);result.neutrality.afterCie00=distance(after);result.neutrality.measuredBoundSatisfied=result.neutrality.afterCie00<=3;
  result.search.allSuppliedPixelsVerified=true;if(result.neutrality.measuredBoundSatisfied&&result.safety.measuredBoundsSatisfied){result.status="candidate";result.reason="full-supplied-surface-neutrality-and-safety-bounds-satisfied";result.gradeV2=proposed;}
  return result;
 }catch(error){if(!(error instanceof Stop))throw error;result.status=error.status;result.reason=error.message;result.gradeV2=null;result.search.allSuppliedPixelsVerified=false;return result;}
 finally{result.search.elapsedMs=performance.now()-start;}
}
