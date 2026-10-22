import {mkdir,writeFile,readFile,lstat} from "node:fs/promises";
import {isAbsolute,join} from "node:path";
import {findClip} from "../domain/editGraph";
import type {EditProject} from "../domain/types";
import type {EditorCommand} from "../domain/commands";
import {canonicalJson} from "../shared/canonicalJson";
import {readBoundedFile} from "../shared/boundedFile";
import {proposeShotGradeCandidateV1} from "../color/shotGradeCandidateV1";
import {proposeShotGradeAutoBalanceV1} from "../color/shotGradeAutoBalanceV1";
import {analyzeShotGradeStatisticsV1,measureShotGradeMatchV1,measureShotGradeSafetyV1} from "../color/shotGradeStatisticsV1";
import {cieDeltaE2000V1,linearRec709ToCieLabD65V1} from "../color/cieDeltaE2000V1";
import {readMaterialIntelligence} from "./materialIntelligence";
import {verifyCurrentAutopilotMaterialEvidence} from "./autopilotMaterialEvidence";
import {colorDigest,getMaterialColorRuntimeIdentity} from "./materialColorSamplingRuntime";
import {shotGradeCodeIdentityV1} from "./shotGradeCodeIdentityV1";
import {readShotGradeWorkingFrameV1} from "./shotGradeFramesV1";
import {readShotGradeRenderedFrameV1,type ShotGradeRenderedRuntimeV1} from "./shotGradeRenderedFramesV1";
import {shotGradeMatchRequestSchemaV1,shotGradeBalanceRequestSchemaV1,shotGradeCommandV1,assertShotGradeCommandV1,
 type ShotGradeMatchRequestV1,type ShotGradeBalanceRequestV1,type ParsedShotGradeRequestV1} from "./shotGradeDecisionV1";

export interface ShotGradeEvidenceRuntimeV1 extends ShotGradeRenderedRuntimeV1 {resolveSource:(assetId:string)=>Promise<string>}
type Mode="shot_match"|"auto_balance";
type GradeCommand=Extract<EditorCommand,{type:"set_clip_grade_v2"}>;
type MaterialBinding={materialId:string;semanticReceiptSha256:string};
const schema="editkin.shot-grade-decision/v1" as const;
const scope="actual-source-clock-local-post-v2-before-spatial" as const;
function refuse(message:string):never{throw Error("SHOT_GRADE_EVIDENCE_INVALID: "+message);}
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).sort().join("|")===keys.sort().join("|");
/** Stable receipt bytes omit performance observations. They never omit source
 * PTS, tool/code identities, ROI geometry or actual measured pixel hashes. */
function stable<T>(value:T):T {
 if(Array.isArray(value))return value.map(stable) as T;
 if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).filter(([key])=>key!=="elapsedMs").map(([key,item])=>[key,stable(item)])) as T;
 return value;
}
function frameIndices(length:number,maximum:number){if(!Number.isSafeInteger(length)||length<1||length>20)refuse("Measured sample inventory invalid");const n=Math.min(length,maximum);return Array.from({length:n},(_,i)=>n===1?0:Math.round(i*(length-1)/(n-1)));}
function pathFor(root:string,id:string){if(!isAbsolute(root)||!/^[a-f0-9]{64}$/.test(id))refuse("Invalid receipt root/ID");return join(root,"shot-grade-decisions-v1",id+".json");}

async function evaluateDecision(inputProject:EditProject,inputRequest:ShotGradeMatchRequestV1|ShotGradeBalanceRequestV1,mode:Mode,runtime:ShotGradeEvidenceRuntimeV1){
 const started=performance.now(),originalProjectSha=colorDigest(inputProject),project=structuredClone(inputProject);
 const request=mode==="shot_match"?shotGradeMatchRequestSchemaV1.parse(structuredClone(inputRequest)):shotGradeBalanceRequestSchemaV1.parse(structuredClone(inputRequest));
 const budget=()=>{runtime.signal?.throwIfAborted();if(colorDigest(inputProject)!==originalProjectSha)refuse("Project changed during proposal");const left=request.maximumTimeMs-(performance.now()-started);if(left<=0)refuse("Proposal time budget exceeded");return left;};
 budget();if(!isAbsolute(runtime.cacheRoot))refuse("Absolute cache root required");
 const code=shotGradeCodeIdentityV1(),primary=await getMaterialColorRuntimeIdentity({...runtime,timeoutMs:Math.min(30000,budget())});budget();
 if(primary.status!=="verified")refuse("Primary runtime identity unverified");
 const verified=async(binding:MaterialBinding)=>{
  const packet=await readMaterialIntelligence(runtime.cacheRoot,binding.materialId);budget();
  if(!packet.cache||packet.analysis.color?.status!=="measured")refuse("Sealed measured material required");
  await verifyCurrentAutopilotMaterialEvidence({schema:"hao.editkin.material-intelligence/v1",receipts:[{...binding,
   sourceSha256:packet.source.sourceSha256,assetId:packet.source.assetId,clipId:packet.source.clipId}]},project,{...runtime,timeoutMs:budget()});budget();
  if(packet.analysis.color.identity.identitySha256!==primary.identitySha256)refuse("Material colour measurement runtime changed; reanalyse material");
  const source=await runtime.resolveSource(packet.source.assetId);budget();if(!isAbsolute(source))refuse("Authorized absolute source required");
  return {packet,source,binding:{...binding,assetId:packet.source.assetId,clipId:packet.source.clipId,sourceSha256:packet.source.sourceSha256,
   sourceStart:packet.source.sourceStart,duration:packet.source.duration,fps:packet.source.fps,measurementSha256:packet.analysis.color.receiptSha256,
   packetSha256:colorDigest(packet)}};
 };
 const target=await verified(request.target),clip=findClip(project,target.packet.source.clipId),indices=frameIndices(target.packet.analysis.color!.mapping.length,request.maximumFrames);
 const pre:Awaited<ReturnType<typeof readShotGradeWorkingFrameV1>>[]=[],before:Awaited<ReturnType<typeof readShotGradeRenderedFrameV1>>[]=[];
 for(const index of indices){pre.push(await readShotGradeWorkingFrameV1(target.packet,project,index,target.source,runtime,budget(),request.highBitDepth));budget();
  before.push(await readShotGradeRenderedFrameV1(target.packet,project,index,target.source,runtime,budget(),undefined,request.highBitDepth));budget();}
 const requireOpaque=(batch:Array<{allPixelsOpaque:boolean}>)=>{if(batch.some(frame=>!frame.allPixelsOpaque))refuse("Alpha cohort adapter required; invisible or partial-alpha RGB cannot authorize a grade decision");};
 requireOpaque(pre);requireOpaque(before);
 const baseline=analyzeShotGradeStatisticsV1(before.map(row=>row.frame),request.regions);budget();
 let reference:Awaited<ReturnType<typeof verified>>|undefined,referenceSurfaces:Awaited<ReturnType<typeof readShotGradeRenderedFrameV1>>[]=[];
 let evaluation:ReturnType<typeof proposeShotGradeCandidateV1>|ReturnType<typeof proposeShotGradeAutoBalanceV1>;
 if(mode==="shot_match"){
  const match=request as ReturnType<typeof shotGradeMatchRequestSchemaV1.parse>;
  reference=await verified(match.reference);if(reference.packet.source.clipId===clip.id)refuse("Distinct reference clip required");
  for(const index of frameIndices(reference.packet.analysis.color!.mapping.length,request.maximumFrames)){
   referenceSurfaces.push(await readShotGradeRenderedFrameV1(reference.packet,project,index,reference.source,runtime,budget(),undefined,request.highBitDepth));budget();}
  requireOpaque(referenceSurfaces);
  evaluation=proposeShotGradeCandidateV1({frames:pre.map(row=>row.frame),regions:request.regions,
   referenceFrames:referenceSurfaces.map(row=>row.frame),referenceRegions:match.referenceRegions,gradeV2:clip.gradeV2,signal:runtime.signal,maximumTimeMs:Math.min(2000,budget())});
 }else evaluation=proposeShotGradeAutoBalanceV1({frames:pre.map(row=>row.frame),regions:request.regions,gradeV2:clip.gradeV2,signal:runtime.signal,maximumTimeMs:Math.min(2000,budget())});
 budget();const numericalApplicable=evaluation.search.allSuppliedPixelsVerified&&(evaluation.status==="candidate"||evaluation.status==="unchanged");
 const selected=evaluation.status==="candidate"?evaluation.gradeV2:clip.gradeV2??null;
 const after:Awaited<ReturnType<typeof readShotGradeRenderedFrameV1>>[]=[];
 if(numericalApplicable&&evaluation.status==="candidate")for(const index of indices){after.push(await readShotGradeRenderedFrameV1(target.packet,project,index,target.source,runtime,budget(),selected,request.highBitDepth));budget();}
 else after.push(...before);requireOpaque(after);
 const actualAfter=analyzeShotGradeStatisticsV1(after.map(row=>row.frame),request.regions),safety=measureShotGradeSafetyV1(baseline,actualAfter);budget();
 let match:ReturnType<typeof measureShotGradeMatchV1>|null=null,neutrality:{beforeCie00:number;afterCie00:number;maximumCie00:3;baselineLinearY:number;targetLab:[number,number,number];measuredBoundSatisfied:boolean}|null=null;
 let actualBounds=false;
 if(mode==="shot_match"){
  const ref=analyzeShotGradeStatisticsV1(referenceSurfaces.map(row=>row.frame),(request as ReturnType<typeof shotGradeMatchRequestSchemaV1.parse>).referenceRegions);
  match=measureShotGradeMatchV1(baseline,actualAfter,ref);actualBounds=match.matchesSpecifiedNeutralAndSkinBounds;
 }else if(baseline.regions.neutral.meanLinearRec709&&baseline.regions.neutral.meanCieLabD65&&actualAfter.regions.neutral.meanCieLabD65){
  const v=baseline.regions.neutral.meanLinearRec709,y=.2126*v[0]+.7152*v[1]+.0722*v[2],targetLab=linearRec709ToCieLabD65V1([y,y,y]);
  const beforeCie00=cieDeltaE2000V1(baseline.regions.neutral.meanCieLabD65,targetLab),afterCie00=cieDeltaE2000V1(actualAfter.regions.neutral.meanCieLabD65,targetLab);
  neutrality={beforeCie00,afterCie00,maximumCie00:3,baselineLinearY:y,targetLab,measuredBoundSatisfied:afterCie00<=3&&afterCie00<=beforeCie00+1e-12};actualBounds=neutrality.measuredBoundSatisfied;
 }
 const applicable=numericalApplicable&&safety.measuredBoundsSatisfied&&actualBounds;
 const command=applicable?shotGradeCommandV1(clip.id,selected):null;
 // Recheck both sealed materials/actual source identities and every owned code
 // input after decoding/search. Reference evidence cannot be borrowed or stale.
 await verified(request.target);if(reference)await verified((request as ReturnType<typeof shotGradeMatchRequestSchemaV1.parse>).reference);budget();
 const endingCode=shotGradeCodeIdentityV1(),endingPrimary=await getMaterialColorRuntimeIdentity({...runtime,timeoutMs:Math.min(30000,budget())});budget();
 if(endingCode.identitySha256!==code.identitySha256||endingPrimary.identitySha256!==primary.identitySha256)refuse("Loaded code/tool drift during proposal");
 const body={mode,projectId:project.id,projectRevision:project.revision,projectSnapshotSha256:originalProjectSha,request,
  codeIdentity:code,primaryRuntimeIdentity:primary,target:target.binding,reference:reference?.binding??null,
  surfaces:{targetPre:pre.map(row=>row.surface),targetBefore:before.map(row=>row.surface),targetAfter:after.map(row=>row.surface),reference:referenceSurfaces.map(row=>row.surface)},
  numericalEvaluation:evaluation,actualMeasurements:{before:baseline,after:actualAfter,safety,match,neutrality},applicable,
  status:applicable?evaluation.status:numericalApplicable?"not_applicable":evaluation.status,
  reason:applicable?"actual-local-post-v2-bounds-satisfied":numericalApplicable?"actual-local-post-v2-bounds-not-satisfied":evaluation.reason,
  command,scope,regionAuthority:"caller-declared-not-classified",humanReview:"required",appearanceCertified:false,
  finalOutputMeasured:false,actualSixShotPerformanceVerified:false,vaContractAdmission:false};
 return {body:stable(body) as typeof body,elapsedMs:performance.now()-started};
}
type Body=Awaited<ReturnType<typeof evaluateDecision>>["body"];
async function propose(project:EditProject,request:ShotGradeMatchRequestV1|ShotGradeBalanceRequestV1,mode:Mode,runtime:ShotGradeEvidenceRuntimeV1){
 const {body,elapsedMs}=await evaluateDecision(project,request,mode,runtime),decisionSha256=colorDigest({schema,body});
 const receipt={schema,decisionSha256,body},bytes=canonicalJson(receipt)+"\n",path=pathFor(runtime.cacheRoot,decisionSha256);
 if(Buffer.byteLength(bytes)>1024*1024)refuse("Receipt byte budget exceeded");
 const directory=join(runtime.cacheRoot,"shot-grade-decisions-v1");await mkdir(directory,{recursive:true});const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())refuse("Aliased receipt directory");
 try{await writeFile(path,bytes,{flag:"wx",mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST"||await readFile(path,"utf8")!==bytes)throw error;}
 return {decisionSha256,mode,clipId:body.target.clipId,status:body.status,reason:body.reason,applicable:body.applicable,command:body.command,
  measurements:body.actualMeasurements,scope,humanReview:"required" as const,appearanceCertified:false,finalOutputMeasured:false,actualSixShotPerformanceVerified:false,
  vaContractAdmission:false,elapsedMs};
}
export const proposeShotColorMatchV1=(project:EditProject,request:ShotGradeMatchRequestV1,runtime:ShotGradeEvidenceRuntimeV1)=>propose(project,request,"shot_match",runtime);
export const proposeAutoBalanceV1=(project:EditProject,request:ShotGradeBalanceRequestV1,runtime:ShotGradeEvidenceRuntimeV1)=>propose(project,request,"auto_balance",runtime);

/** Recompute actual source-clock evidence before accepting an immutable
 * proposal command. A caller can recompute a content hash; it cannot substitute
 * that hash for the current measured surfaces or numerical gates. */
export async function verifyShotGradeDecisionV1(project:EditProject,decisionSha256:string,command:unknown,runtime:ShotGradeEvidenceRuntimeV1){
 const path=pathFor(runtime.cacheRoot,decisionSha256),bytes=await readBoundedFile(path,1024*1024),receipt:unknown=JSON.parse(bytes.toString("utf8"));
 if(!exact(receipt,["schema","decisionSha256","body"])||receipt.schema!==schema||receipt.decisionSha256!==decisionSha256
  ||colorDigest({schema,body:receipt.body})!==decisionSha256)refuse("Receipt integrity failed");
 const body=receipt.body as Body;if(!body||!body.applicable||!body.command||!(body.mode==="shot_match"||body.mode==="auto_balance"))refuse("Applicable receipt required");
 assertShotGradeCommandV1(command,body.command);if(body.projectSnapshotSha256!==colorDigest(project)||body.projectId!==project.id||body.projectRevision!==project.revision)refuse("Project/revision/baseline changed");
 const current=await evaluateDecision(project,body.request,body.mode,runtime);
 if(canonicalJson(current.body)!==canonicalJson(body))refuse("Current material/reference/ROI/grade/runtime/evaluation changed");
 return {schema:"editkin.shot-grade-command-verification/v1" as const,decisionSha256,clipId:body.target.clipId,command:structuredClone(body.command as GradeCommand),scope,
  currentActualLocalPostGradeVerified:true,finalOutputMeasured:false,vaContractAdmission:false};
}
