import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalJson } from "../shared/canonicalJson";
import { readBoundedFile } from "../shared/boundedFile";
import { longformSentenceAlignmentRequestV1Schema, type LongformSentenceAlignmentRequestV1,
  type LongformRecordingTextEvidenceV1, type LongformSentenceAlignmentDraftV1 } from "../domain/longformSentenceAlignmentV1";
import type { LongformTimedWordV1, LongformWordTimingIssueV1 } from "../domain/longformWordTimingV1";
import { alignLongformSentencesV1 } from "./longformSentenceAlignmentV1";
import { readLongformWordArtifactV1, readLongformWordPageV1, readLongformWordIssuePageV1,
  prepareLongformWordRecognitionV1, type LongformWordRecognitionRuntimeV1 } from "./longformWordRecognitionV1";
import { readMaterialIntelligence, readMaterialKeyframe, verifyMaterialSemanticsReceipt } from "./materialIntelligence";
import { verifyMaterialPacket } from "./materialEvidenceCache";
import type { LongformMaterialIdentityV1 } from "./longformMaterialIntakeV1";

export interface LongformSentenceAlignmentRuntimeV1 extends Omit<LongformWordRecognitionRuntimeV1,"onProgress"> {
  onProgress?:(value:{phase:"recording_words"|"aligning"|"finalizing";completedRecordings:number;totalRecordings:number;
    recordingId?:string;completedWindows?:number;totalWindows?:number;cachedWindows?:number})=>void|Promise<void>;
}
export interface LongformSentenceAlignmentDepsV1 {
  readWords:typeof readLongformWordArtifactV1;wordPage:typeof readLongformWordPageV1;issuePage:typeof readLongformWordIssuePageV1;
  prepareWords:typeof prepareLongformWordRecognitionV1;readMaterial:typeof readMaterialIntelligence;
  verifySemantics:typeof verifyMaterialSemanticsReceipt;readFrame:typeof readMaterialKeyframe;
}
const production:LongformSentenceAlignmentDepsV1={readWords:readLongformWordArtifactV1,wordPage:readLongformWordPageV1,
  issuePage:readLongformWordIssuePageV1,prepareWords:prepareLongformWordRecognitionV1,readMaterial:readMaterialIntelligence,
  verifySemantics:verifyMaterialSemanticsReceipt,readFrame:readMaterialKeyframe};
const hash=(value:unknown)=>createHash("sha256").update(canonicalJson(value)).digest("hex");
const jsonBytes=(value:unknown)=>Buffer.from(JSON.stringify(value)+"\n");
const safeId=(value:string)=>{if(!/^[a-f0-9]{64}$/.test(value))throw new Error("LONGFORM_ALIGNMENT_ARTIFACT_ID");return value;};
const wordRuntime=(runtime:LongformSentenceAlignmentRuntimeV1)=>({...runtime,onProgress:undefined});
type RecordingReference = {recordingId:string;kind:"word_timing";artifactId:string}
  |{recordingId:string;kind:"material";materialId:string;packetSha256:string;semanticReceiptSha256?:string}
  |{recordingId:string;kind:"unavailable";reason:"NO_AUDIO_OR_PREPARED_EVIDENCE"};
export interface LongformSentenceAlignmentArtifactV1 {
  schema:"editkin.longform-sentence-alignment-artifact/v1";artifactId:string;request:LongformSentenceAlignmentRequestV1;
  algorithmSha256:string;recordingReferences:RecordingReference[];draft:LongformSentenceAlignmentDraftV1;
}
async function algorithmIdentity(){
  const paths=["longformSentenceAlignmentRuntimeV1.ts","longformSentenceAlignmentV1.ts","../domain/longformSentenceAlignmentV1.ts"];
  return hash(await Promise.all(paths.map(async path=>({path,sha256:createHash("sha256").update(await readFile(resolve(import.meta.dirname,path))).digest("hex")}))));
}
function assertRecordingBinding(recording:LongformMaterialIdentityV1,source:{sourceSha256:string;sourceStart:number;duration:number},exact=false){
  if(source.sourceSha256!==recording.sha256||!Number.isFinite(source.sourceStart)||!Number.isFinite(source.duration)
    ||source.duration<=0||source.sourceStart<recording.sourceStart-1e-6
    ||source.sourceStart+source.duration>recording.sourceStart+recording.duration+1e-6
    ||exact&&(Math.abs(source.sourceStart-recording.sourceStart)>1e-6||Math.abs(source.duration-recording.duration)>1e-6))
    throw new Error("LONGFORM_ALIGNMENT_RECORDING_BINDING");
}
async function words(runtime:LongformSentenceAlignmentRuntimeV1,id:string,deps:LongformSentenceAlignmentDepsV1){
  const artifact=await deps.readWords(runtime,id),rows:LongformTimedWordV1[]=[],issues:LongformWordTimingIssueV1[]=[];
  if(artifact.wordCount>200000||artifact.issueCount>200000)throw new Error("LONGFORM_ALIGNMENT_WORD_BUDGET");
  for(const[reader,target]of [[deps.wordPage,rows],[deps.issuePage,issues]]as const){
    let offset=0;while(true){runtime.signal?.throwIfAborted();
      const page=await reader(runtime,id,offset,200),items="words"in page?page.words:page.issues;
      (target as Array<LongformTimedWordV1|LongformWordTimingIssueV1>).push(...items);
      if(page.nextOffset===null)break;if(page.nextOffset<=offset)throw new Error("LONGFORM_ALIGNMENT_PAGE_CLOCK");offset=page.nextOffset;
    }
  }
  if(rows.length!==artifact.wordCount||issues.length!==artifact.issueCount)throw new Error("LONGFORM_ALIGNMENT_WORD_REFERENCE");
  return{artifact,rows,issues};
}
async function loadRecording(runtime:LongformSentenceAlignmentRuntimeV1,recording:LongformMaterialIdentityV1,
  reference:Exclude<RecordingReference,{kind:"unavailable"}>,deps:LongformSentenceAlignmentDepsV1):Promise<LongformRecordingTextEvidenceV1>{
  runtime.signal?.throwIfAborted();
  if(reference.kind==="word_timing"){
    const loaded=await words(runtime,reference.artifactId,deps),source=loaded.artifact.intake.materials.find(row=>row.kind==="narration")!;
    assertRecordingBinding(recording,{sourceSha256:source.sha256,sourceStart:source.sourceStart,duration:source.duration},true);
    if(source.path!==recording.path)throw new Error("LONGFORM_ALIGNMENT_RECORDING_PATH");
    return{recordingId:recording.id,sourceSha256:recording.sha256,sourceStart:recording.sourceStart,duration:recording.duration,
      wordArtifactId:reference.artifactId,words:loaded.rows};
  }
  const packet=await deps.readMaterial(runtime.cacheRoot,reference.materialId);verifyMaterialPacket(packet,reference.materialId);
  assertRecordingBinding(recording,packet.source);
  if(packet.source.kind!=="video"||packet.cache?.packetSha256!==reference.packetSha256)throw new Error("LONGFORM_ALIGNMENT_MATERIAL_REFERENCE");
  const evidence:LongformRecordingTextEvidenceV1={recordingId:recording.id,sourceSha256:recording.sha256,
    sourceStart:packet.source.sourceStart,duration:packet.source.duration,materialId:reference.materialId,packetSha256:reference.packetSha256,
    cues:packet.analysis.transcript.state==="ready"?packet.analysis.transcript.cues.map((row,index)=>({...row,index})):[]};
  if(reference.semanticReceiptSha256){
    const receipt=await deps.verifySemantics(runtime.cacheRoot,reference.materialId,reference.semanticReceiptSha256);
    if(receipt.materialId!==reference.materialId||receipt.sourceSha256!==recording.sha256)throw new Error("LONGFORM_ALIGNMENT_SEMANTIC_REFERENCE");
    for(const id of new Set(receipt.segments.flatMap(row=>row.evidenceFrameIds))){
      runtime.signal?.throwIfAborted();const declared=packet.keyframes.find(row=>row.id===id);
      if(!declared)throw new Error("LONGFORM_ALIGNMENT_FRAME_REFERENCE");
      const frame=await deps.readFrame(runtime.cacheRoot,reference.materialId,id);
      if(frame.frame.sha256!==declared.sha256||createHash("sha256").update(frame.data).digest("hex")!==declared.sha256)
        throw new Error("LONGFORM_ALIGNMENT_FRAME_REFERENCE");
    }
    evidence.semanticReceiptSha256=reference.semanticReceiptSha256;
    evidence.semantics=receipt.segments.map((row,index)=>({start:row.start,end:row.end,summary:row.summary,index,evidenceFrameIds:row.evidenceFrameIds}));
  }
  return evidence;
}
async function assertDependencies(runtime:LongformSentenceAlignmentRuntimeV1,artifact:LongformSentenceAlignmentArtifactV1,
  deps:LongformSentenceAlignmentDepsV1){
  const narration=(await words(runtime,artifact.request.narrationArtifactId,deps)).artifact;
  const recordings=narration.intake.materials.filter(row=>row.kind==="recording");
  if(artifact.recordingReferences.length!==recordings.length)throw new Error("LONGFORM_ALIGNMENT_RECORDING_REFERENCE");
  for(const[ordinal,recording]of recordings.entries()){
    const reference=artifact.recordingReferences[ordinal];
    if(reference.recordingId!==recording.id)throw new Error("LONGFORM_ALIGNMENT_RECORDING_REFERENCE");
    if(reference.kind!=="unavailable")await loadRecording(runtime,recording,reference,deps);
  }
  return narration;
}
export async function prepareLongformSentenceAlignmentV1(raw:unknown,runtime:LongformSentenceAlignmentRuntimeV1,
  deps:LongformSentenceAlignmentDepsV1=production){
  const request=longformSentenceAlignmentRequestV1Schema.parse(raw),algorithmSha256=await algorithmIdentity();
  const narration=await words(runtime,request.narrationArtifactId,deps),recordings=narration.artifact.intake.materials.filter(row=>row.kind==="recording");
  if(request.recordingEvidence.some(row=>!recordings.some(source=>source.id===row.recordingId)))throw new Error("LONGFORM_ALIGNMENT_RECORDING_ID");
  if(request.chapterTitles.some(row=>!narration.artifact.intake.script.paragraphs.some(paragraph=>paragraph.id===row.paragraphId)))
    throw new Error("LONGFORM_ALIGNMENT_CHAPTER_ID");
  const recordingReferences:RecordingReference[]=[],evidence:LongformRecordingTextEvidenceV1[]=[];let cachedRecordingWindows=0;
  for(const[ordinal,recording]of recordings.entries()){
    runtime.signal?.throwIfAborted();let reference:RecordingReference|undefined;
    const supplied=request.recordingEvidence.find(row=>row.recordingId===recording.id);
    if(supplied?.kind==="word_timing")reference=supplied;
    else if(supplied?.kind==="material"){
      const packet=await deps.readMaterial(runtime.cacheRoot,supplied.materialId);
      if(!packet.cache)throw new Error("LONGFORM_ALIGNMENT_MATERIAL_REFERENCE");
      reference={...supplied,packetSha256:packet.cache.packetSha256};
    }else if(recording.hasAudio){
      await runtime.onProgress?.({phase:"recording_words",completedRecordings:ordinal,totalRecordings:recordings.length,recordingId:recording.id});
      const generated=await deps.prepareWords({schema:"editkin.longform-word-timing-request/v1",narration:{id:recording.id,path:recording.path,
        sourceStart:recording.sourceStart,duration:recording.duration,expectedSha256:recording.sha256},
        script:narration.artifact.intake.request.script,recordings:[],screenshots:[],language:narration.artifact.intake.request.language},
      {...wordRuntime(runtime),onProgress:async progress=>runtime.onProgress?.({phase:"recording_words",completedRecordings:ordinal,
        totalRecordings:recordings.length,recordingId:recording.id,...progress})});
      reference={kind:"word_timing",recordingId:recording.id,artifactId:generated.artifact.artifactId};cachedRecordingWindows+=generated.cachedWindows;
    }else reference={kind:"unavailable",recordingId:recording.id,reason:"NO_AUDIO_OR_PREPARED_EVIDENCE"};
    recordingReferences.push(reference);if(reference.kind!=="unavailable")evidence.push(await loadRecording(runtime,recording,reference,deps));
  }
  await runtime.onProgress?.({phase:"aligning",completedRecordings:recordings.length,totalRecordings:recordings.length});
  const voice=narration.artifact.intake.materials.find(row=>row.kind==="narration")!;
  const draft=alignLongformSentencesV1({paragraphs:narration.artifact.intake.script.paragraphs,words:narration.rows,issues:narration.issues,
    narrationSourceStart:voice.sourceStart,narrationDuration:voice.duration,language:narration.artifact.intake.request.language,
    recordings:evidence,chapterTitles:request.chapterTitles,signal:runtime.signal});
  const body={schema:"editkin.longform-sentence-alignment-artifact/v1"as const,request,algorithmSha256,recordingReferences,draft};
  const artifact:LongformSentenceAlignmentArtifactV1={...body,artifactId:hash(body)};
  await runtime.onProgress?.({phase:"finalizing",completedRecordings:recordings.length,totalRecordings:recordings.length});
  await assertDependencies(runtime,artifact,deps);runtime.signal?.throwIfAborted();
  if(await algorithmIdentity()!==algorithmSha256)throw new Error("LONGFORM_ALIGNMENT_ALGORITHM_CHANGED");
  const bytes=jsonBytes(artifact);if(bytes.length>32*1024*1024)throw new Error("LONGFORM_ALIGNMENT_ARTIFACT_BUDGET");
  const root=join(resolve(runtime.cacheRoot),"longform-sentence-alignment-v1");await mkdir(root,{recursive:true});
  const path=join(root,artifact.artifactId+".json");
  try{await writeFile(path,bytes,{flag:"wx"});}catch(error){
    if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;
    if(!(await readBoundedFile(path,32*1024*1024)).equals(bytes))throw new Error("LONGFORM_ALIGNMENT_CACHE_CONFLICT");
  }
  return{artifact,cachedRecordingWindows};
}
export async function readLongformSentenceAlignmentArtifactV1(runtime:LongformSentenceAlignmentRuntimeV1,id:string,
  deps:LongformSentenceAlignmentDepsV1=production){
  const bytes=await readBoundedFile(join(resolve(runtime.cacheRoot),"longform-sentence-alignment-v1",safeId(id)+".json"),32*1024*1024);
  const artifact=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes))as LongformSentenceAlignmentArtifactV1;
  const{artifactId,...body}=artifact;
  if(artifact.schema!=="editkin.longform-sentence-alignment-artifact/v1"||artifactId!==id||hash(body)!==id)throw new Error("LONGFORM_ALIGNMENT_ARTIFACT_SHA");
  await assertDependencies(runtime,artifact,deps);return artifact;
}
export async function readLongformSentenceAlignmentPageV1(runtime:LongformSentenceAlignmentRuntimeV1,id:string,
  kind:"sentences"|"chapters",offset=0,limit=100,deps:LongformSentenceAlignmentDepsV1=production){
  if(!["sentences","chapters"].includes(kind)||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>200)
    throw new Error("LONGFORM_ALIGNMENT_PAGE");
  const artifact=await readLongformSentenceAlignmentArtifactV1(runtime,id,deps),rows=artifact.draft[kind],items=rows.slice(offset,offset+limit);
  return{artifactId:id,state:artifact.draft.state,kind,total:rows.length,offset,items,nextOffset:offset+items.length<rows.length?offset+items.length:null,
    narration:artifact.draft.narration,contentVerified:false,syntheticTimingUsed:false,projectModified:false};
}
