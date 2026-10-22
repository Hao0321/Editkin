import { randomBytes } from "node:crypto";
import { claimLongformRecognitionLeaseV1 } from "./longformRecognitionLeaseV1";
import { longformWordTimingRequestV1Schema } from "../domain/longformWordTimingV1";
import { captionWindows } from "./segmentedCaptions";
import { prepareLongformWordRecognitionV1, readLongformWordArtifactV1,
  type LongformWordRecognitionRuntimeV1 } from "./longformWordRecognitionV1";

export interface LongformWordTimingJobV1 {
  jobId: string; state: "RUNNING" | "CANCELLING" | "CANCELLED" | "FAILED" | "COMPLETED";
  startedAt: string; finishedAt?: string; progress: {completedWindows:number;totalWindows:number;cachedWindows:number};
  result?: {artifactId:string;state:"WORDS_AVAILABLE"|"REVIEW_REQUIRED"|"EMPTY";wordCount:number;issueCount:number;
    segmentCount:number;windowCount:number;cachedWindows:number;contentVerified:false;syntheticTimingUsed:false};
  error?: string;
}
export interface LongformWordTimingJobDepsV1 {
  prepare: typeof prepareLongformWordRecognitionV1;
  readArtifact: typeof readLongformWordArtifactV1;
}
interface OwnedJob { value:LongformWordTimingJobV1; controller:AbortController; done:Promise<void> }
const active = (job:LongformWordTimingJobV1) => job.state === "RUNNING" || job.state === "CANCELLING";
const production:LongformWordTimingJobDepsV1 = {prepare:prepareLongformWordRecognitionV1,readArtifact:readLongformWordArtifactV1};

/** One recognizer per server owner; cancellation becomes terminal only after
 * preparation has settled and closed its direct native child. Results are
 * immutable artifacts; process-local job handles are not restart tokens. */
export class LongformWordTimingJobsV1 {
  private readonly jobs = new Map<string,OwnedJob>();
  private closed = false;
  constructor(private readonly runtime:Omit<LongformWordRecognitionRuntimeV1,"signal"|"onProgress">,
    private readonly deps:LongformWordTimingJobDepsV1 = production) {}

  start(raw:unknown):LongformWordTimingJobV1 {
    if (this.closed) throw new Error("LONGFORM_WORD_JOBS_CLOSED");
    const request=longformWordTimingRequestV1Schema.parse(raw);
    if (Buffer.byteLength(JSON.stringify(request),"utf8") > 2*1024*1024) throw new Error("LONGFORM_WORD_REQUEST_BUDGET");
    if ([...this.jobs.values()].some(row=>active(row.value))) throw new Error("LONGFORM_WORD_JOB_ALREADY_RUNNING");
    while(this.jobs.size>=32){
      const oldest=[...this.jobs.entries()].find(([,row])=>!active(row.value));
      if(!oldest)throw new Error("LONGFORM_WORD_JOB_HISTORY_FULL");this.jobs.delete(oldest[0]);
    }
    const jobId="lw-"+randomBytes(12).toString("hex"), controller=new AbortController();
    const release=claimLongformRecognitionLeaseV1(this.runtime.cacheRoot);
    const value:LongformWordTimingJobV1={jobId,state:"RUNNING",startedAt:new Date().toISOString(),
      progress:{completedWindows:0,totalWindows:captionWindows(request.narration.duration).length,cachedWindows:0}};
    const owned:OwnedJob={value,controller,done:Promise.resolve()};this.jobs.set(jobId,owned);
    owned.done=Promise.resolve().then(async()=>{
      try {
        controller.signal.throwIfAborted();
        const runtime={...this.runtime,signal:controller.signal,onProgress:async(progress:LongformWordTimingJobV1["progress"])=>{
          value.progress={...progress};
        }};
        const prepared=await this.deps.prepare(request,runtime);
        controller.signal.throwIfAborted();
        const artifact=await this.deps.readArtifact(runtime,prepared.artifact.artifactId);
        controller.signal.throwIfAborted();
        value.result={artifactId:artifact.artifactId,state:artifact.state,wordCount:artifact.wordCount,issueCount:artifact.issueCount,
          segmentCount:artifact.segmentCount,windowCount:artifact.windows.length,cachedWindows:prepared.cachedWindows,
          contentVerified:false,syntheticTimingUsed:false};
        value.state="COMPLETED";
      } catch(error) {
        value.state=controller.signal.aborted ? "CANCELLED" : "FAILED";
        value.error=controller.signal.aborted ? "辨識已取消；已完成分段仍保留" :
          (error instanceof Error?error.message:String(error)).replace(/[A-Za-z]:[\\/][^\n\r]+/g,"[local-path]").slice(0,1000);
        delete value.result;
      } finally {value.finishedAt=new Date().toISOString();release();}
    });
    return structuredClone(value);
  }
  get(jobId:string):LongformWordTimingJobV1 {
    const row=this.jobs.get(jobId);if(!row)throw new Error("LONGFORM_WORD_JOB_NOT_FOUND");return structuredClone(row.value);
  }
  cancel(jobId:string):LongformWordTimingJobV1 {
    const row=this.jobs.get(jobId);if(!row)throw new Error("LONGFORM_WORD_JOB_NOT_FOUND");
    if(active(row.value)){row.value.state="CANCELLING";row.controller.abort();}
    return structuredClone(row.value);
  }
  async close():Promise<void> {
    this.closed=true;
    for(const [id,row]of this.jobs)if(active(row.value))this.cancel(id);
    await Promise.all([...this.jobs.values()].map(row=>row.done));
  }
}

const owners=new Set<LongformWordTimingJobsV1>();
export function ownLongformWordTimingJobsV1(runtime:Omit<LongformWordRecognitionRuntimeV1,"signal"|"onProgress">,
  deps?:LongformWordTimingJobDepsV1) {
  const manager=new LongformWordTimingJobsV1(runtime,deps);owners.add(manager);return manager;
}
export async function closeLongformWordTimingJobsV1(){await Promise.all([...owners].map(owner=>owner.close()));owners.clear();}
