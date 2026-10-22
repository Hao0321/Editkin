import { expect, it, vi } from "vitest";
import { LongformWordTimingJobsV1, type LongformWordTimingJobDepsV1 } from "./longformWordTimingJobsV1";
import type { LongformWordTimingArtifactV1, LongformWordRecognitionRuntimeV1 } from "./longformWordRecognitionV1";

const request={schema:"editkin.longform-word-timing-request/v1",narration:{id:"voice",path:"voice.wav",sourceStart:2,duration:61},
  script:{kind:"text",text:"Actual speech"},recordings:[],screenshots:[],language:"en"};
const runtime={sourceRoot:"D:/owned",cacheRoot:"D:/owned/cache",workRoot:"D:/owned/work",ffmpegPath:"D:/owned/ffmpeg.exe",
  whisperCliPath:"D:/owned/whisper.exe",modelPath:"D:/owned/model.bin",modelRoot:"D:/owned"};
const artifact={artifactId:"a".repeat(64),state:"REVIEW_REQUIRED",wordCount:23,issueCount:2,segmentCount:7,
  windows:[{},{},{}],contentVerified:false,syntheticTimingUsed:false} as LongformWordTimingArtifactV1;
const deps=():LongformWordTimingJobDepsV1=>({prepare:vi.fn(async()=>({artifact,cachedWindows:1})),readArtifact:vi.fn(async()=>artifact)});
const completed=async(jobs:LongformWordTimingJobsV1,id:string)=>vi.waitFor(()=>expect(["COMPLETED","FAILED","CANCELLED"]).toContain(jobs.get(id).state));
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return{promise,resolve};};

it("returns immediately, updates progress and publishes only a readable compact artifact",async()=>{
  const done=deferred(), d=deps();let live!:LongformWordRecognitionRuntimeV1;
  d.prepare=vi.fn(async(_input,r)=>{live=r;await done.promise;return{artifact,cachedWindows:1};});
  const jobs=new LongformWordTimingJobsV1(runtime,d), start=jobs.start(request);
  expect(start.state).toBe("RUNNING");expect(start.progress.totalWindows).toBe(3);expect(start.result).toBeUndefined();
  await Promise.resolve();await live.onProgress!({completedWindows:1,totalWindows:3,cachedWindows:0});
  expect(jobs.get(start.jobId).progress.completedWindows).toBe(1);
  const copy=jobs.get(start.jobId);copy.progress.completedWindows=99;expect(jobs.get(start.jobId).progress.completedWindows).toBe(1);
  done.resolve();await completed(jobs,start.jobId);
  expect(jobs.get(start.jobId)).toMatchObject({state:"COMPLETED",result:{artifactId:artifact.artifactId,wordCount:23,
    issueCount:2,contentVerified:false,syntheticTimingUsed:false}});
  expect(JSON.stringify(jobs.get(start.jobId))).not.toMatch(/Actual speech|sourceRoot|voice\.wav|"windows"/);
  expect(d.readArtifact).toHaveBeenCalledTimes(1);await jobs.close();
});
it("keeps cancellation pending until the recognizer operation actually settles",async()=>{
  const done=deferred(), d=deps();let signal!:AbortSignal;
  d.prepare=async(_input,r)=>{signal=r.signal!;await done.promise;signal.throwIfAborted();return{artifact,cachedWindows:0};};
  const jobs=new LongformWordTimingJobsV1(runtime,d), start=jobs.start(request);await Promise.resolve();
  expect(jobs.cancel(start.jobId).state).toBe("CANCELLING");expect(signal.aborted).toBe(true);
  expect(jobs.get(start.jobId).finishedAt).toBeUndefined();
  expect(()=>jobs.start(request)).toThrow("LONGFORM_WORD_JOB_ALREADY_RUNNING");
  done.resolve();await completed(jobs,start.jobId);expect(jobs.get(start.jobId).state).toBe("CANCELLED");
  expect(d.readArtifact).not.toHaveBeenCalled();expect(jobs.cancel(start.jobId).state).toBe("CANCELLED");await jobs.close();
});
it("server shutdown awaits its active child settlement and refuses subsequent starts",async()=>{
  const done=deferred(), d=deps();d.prepare=async(_input,r)=>{await done.promise;r.signal?.throwIfAborted();return{artifact,cachedWindows:0};};
  const jobs=new LongformWordTimingJobsV1(runtime,d), start=jobs.start(request);await Promise.resolve();
  let closed=false;const closing=jobs.close().then(()=>{closed=true;});await Promise.resolve();
  expect(closed).toBe(false);expect(jobs.get(start.jobId).state).toBe("CANCELLING");
  expect(()=>jobs.start(request)).toThrow("LONGFORM_WORD_JOBS_CLOSED");done.resolve();await closing;
  expect(jobs.get(start.jobId).state).toBe("CANCELLED");expect(closed).toBe(true);
});
it("does not report completion when the saved artifact is stale or unreadable",async()=>{
  const d=deps();d.readArtifact=async()=>{throw new Error("LONGFORM_SOURCE_CHANGED");};
  const jobs=new LongformWordTimingJobsV1(runtime,d), start=jobs.start(request);await completed(jobs,start.jobId);
  expect(jobs.get(start.jobId)).toMatchObject({state:"FAILED",error:"LONGFORM_SOURCE_CHANGED"});
  expect(jobs.get(start.jobId).result).toBeUndefined();await jobs.close();
});
it("validates unknown model fields, duplicate identities and request bytes before starting native work",async()=>{
  const d=deps(), jobs=new LongformWordTimingJobsV1(runtime,d);
  expect(()=>jobs.start({...request,model:"medium"})).toThrow();
  expect(()=>jobs.start({...request,recordings:[request.narration]})).toThrow();
  const paragraphs=Array.from({length:200},(_,i)=>({id:String(i),text:"x".repeat(20000)}));
  expect(()=>jobs.start({...request,script:{kind:"paragraphs",paragraphs}})).toThrow("LONGFORM_WORD_REQUEST_BUDGET");
  expect(d.prepare).not.toHaveBeenCalled();expect(()=>jobs.get("lw-missing")).toThrow("LONGFORM_WORD_JOB_NOT_FOUND");await jobs.close();
});
it("bounds process-local history while retaining recent artifact identifiers",async()=>{
  const jobs=new LongformWordTimingJobsV1(runtime,deps());let first="",last="";
  for(let i=0;i<34;i++){last=jobs.start(request).jobId;first||=last;await completed(jobs,last);}
  expect(()=>jobs.get(first)).toThrow("LONGFORM_WORD_JOB_NOT_FOUND");expect(jobs.get(last).state).toBe("COMPLETED");await jobs.close();
});
