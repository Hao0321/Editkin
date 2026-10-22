import { randomBytes } from "node:crypto";
import { longformSentenceAlignmentRequestV1Schema } from "../domain/longformSentenceAlignmentV1";
import { claimLongformRecognitionLeaseV1 } from "./longformRecognitionLeaseV1";
import { prepareLongformSentenceAlignmentV1, readLongformSentenceAlignmentArtifactV1,
  type LongformSentenceAlignmentRuntimeV1 } from "./longformSentenceAlignmentRuntimeV1";

type Progress=Parameters<NonNullable<LongformSentenceAlignmentRuntimeV1["onProgress"]>>[0];
export interface LongformSentenceAlignmentJobV1 {
  jobId:string;state:"RUNNING"|"CANCELLING"|"CANCELLED"|"FAILED"|"COMPLETED";startedAt:string;finishedAt?:string;
  progress:Omit<Progress,"phase"|"totalRecordings">&{phase:Progress["phase"]|"loading";totalRecordings:number|null};
  result?:{artifactId:string;state:"REVIEW_REQUIRED";sentenceCount:number;alignedSentenceCount:number;
    matchedRecordingSentenceCount:number;chapterCount:number;recordingEvidenceCount:number;cachedRecordingWindows:number;
    narrationSeconds:number;preservedNarrationSeconds:number;removedNarrationSeconds:0;
    contentVerified:false;syntheticTimingUsed:false;projectModified:false};
  error?:string;
}
export interface LongformSentenceAlignmentJobDepsV1 {
  prepare:typeof prepareLongformSentenceAlignmentV1;readArtifact:typeof readLongformSentenceAlignmentArtifactV1;
}
const production:LongformSentenceAlignmentJobDepsV1={prepare:prepareLongformSentenceAlignmentV1,readArtifact:readLongformSentenceAlignmentArtifactV1};
interface OwnedJob {value:LongformSentenceAlignmentJobV1;controller:AbortController;done:Promise<void>}
const active=(job:LongformSentenceAlignmentJobV1)=>job.state==="RUNNING"||job.state==="CANCELLING";

export class LongformSentenceAlignmentJobsV1 {
  private readonly jobs=new Map<string,OwnedJob>();private closed=false;
  constructor(private readonly runtime:Omit<LongformSentenceAlignmentRuntimeV1,"signal"|"onProgress">,
    private readonly deps:LongformSentenceAlignmentJobDepsV1=production){}
  start(raw:unknown):LongformSentenceAlignmentJobV1 {
    if(this.closed)throw new Error("LONGFORM_ALIGNMENT_JOBS_CLOSED");
    const request=longformSentenceAlignmentRequestV1Schema.parse(raw);
    if(Buffer.byteLength(JSON.stringify(request),"utf8")>2*1024*1024)throw new Error("LONGFORM_ALIGNMENT_REQUEST_BUDGET");
    if([...this.jobs.values()].some(row=>active(row.value)))throw new Error("LONGFORM_ALIGNMENT_JOB_ALREADY_RUNNING");
    while(this.jobs.size>=32){const oldest=[...this.jobs.entries()].find(([,row])=>!active(row.value));
      if(!oldest)throw new Error("LONGFORM_ALIGNMENT_JOB_HISTORY_FULL");this.jobs.delete(oldest[0]);}
    const release=claimLongformRecognitionLeaseV1(this.runtime.cacheRoot),jobId="la-"+randomBytes(12).toString("hex"),controller=new AbortController();
    const value:LongformSentenceAlignmentJobV1={jobId,state:"RUNNING",startedAt:new Date().toISOString(),
      progress:{phase:"loading",completedRecordings:0,totalRecordings:null}};
    const owned:OwnedJob={value,controller,done:Promise.resolve()};this.jobs.set(jobId,owned);
    owned.done=Promise.resolve().then(async()=>{
      try{
        controller.signal.throwIfAborted();const runtime={...this.runtime,signal:controller.signal,onProgress:async(progress:Progress)=>{value.progress={...progress};}};
        const prepared=await this.deps.prepare(request,runtime);controller.signal.throwIfAborted();
        const artifact=await this.deps.readArtifact(runtime,prepared.artifact.artifactId);controller.signal.throwIfAborted();
        const{stats,narration}=artifact.draft;
        value.result={artifactId:artifact.artifactId,state:"REVIEW_REQUIRED",sentenceCount:stats.sentenceCount,alignedSentenceCount:stats.alignedSentenceCount,
          matchedRecordingSentenceCount:stats.matchedRecordingSentenceCount,chapterCount:stats.chapterCount,
          recordingEvidenceCount:artifact.recordingReferences.filter(row=>row.kind!=="unavailable").length,cachedRecordingWindows:prepared.cachedRecordingWindows,
          narrationSeconds:narration.duration,preservedNarrationSeconds:narration.preservedDuration,removedNarrationSeconds:0,
          contentVerified:false,syntheticTimingUsed:false,projectModified:false};value.state="COMPLETED";
      }catch(error){
        value.state=controller.signal.aborted?"CANCELLED":"FAILED";delete value.result;
        value.error=controller.signal.aborted?"句子對齊已取消；已完成辨識分段仍保留":
          (error instanceof Error?error.message:String(error)).replace(/[A-Za-z]:[\\/][^\n\r]+/g,"[local-path]").slice(0,1000);
      }finally{value.finishedAt=new Date().toISOString();release();}
    });return structuredClone(value);
  }
  get(jobId:string){const row=this.jobs.get(jobId);if(!row)throw new Error("LONGFORM_ALIGNMENT_JOB_NOT_FOUND");return structuredClone(row.value);}
  cancel(jobId:string){const row=this.jobs.get(jobId);if(!row)throw new Error("LONGFORM_ALIGNMENT_JOB_NOT_FOUND");
    if(active(row.value)){row.value.state="CANCELLING";row.controller.abort();}return structuredClone(row.value);}
  async close(){this.closed=true;for(const[id,row]of this.jobs)if(active(row.value))this.cancel(id);
    await Promise.all([...this.jobs.values()].map(row=>row.done));}
}
const owners=new Set<LongformSentenceAlignmentJobsV1>();
export function ownLongformSentenceAlignmentJobsV1(runtime:Omit<LongformSentenceAlignmentRuntimeV1,"signal"|"onProgress">,
  deps?:LongformSentenceAlignmentJobDepsV1){const manager=new LongformSentenceAlignmentJobsV1(runtime,deps);owners.add(manager);return manager;}
export async function closeLongformSentenceAlignmentJobsV1(){await Promise.all([...owners].map(owner=>owner.close()));owners.clear();}
