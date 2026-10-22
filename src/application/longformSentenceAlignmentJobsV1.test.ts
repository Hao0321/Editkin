import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { LongformSentenceAlignmentJobsV1, type LongformSentenceAlignmentJobDepsV1 } from "./longformSentenceAlignmentJobsV1";
import type { LongformSentenceAlignmentArtifactV1, LongformSentenceAlignmentRuntimeV1 } from "./longformSentenceAlignmentRuntimeV1";
import { LongformWordTimingJobsV1, type LongformWordTimingJobDepsV1 } from "./longformWordTimingJobsV1";
import type { LongformWordTimingArtifactV1 } from "./longformWordRecognitionV1";

const request={schema:"editkin.longform-sentence-alignment-request/v1",narrationArtifactId:"a".repeat(64)};
const runtime=()=>({sourceRoot:"D:/owned",cacheRoot:"D:/owned/cache-"+randomUUID(),workRoot:"D:/owned/work",ffmpegPath:"D:/owned/ffmpeg.exe",
  whisperCliPath:"D:/owned/whisper.exe",modelPath:"D:/owned/model.bin",modelRoot:"D:/owned"});
const artifact:LongformSentenceAlignmentArtifactV1={schema:"editkin.longform-sentence-alignment-artifact/v1",artifactId:"b".repeat(64),
  request:{schema:"editkin.longform-sentence-alignment-request/v1",narrationArtifactId:"a".repeat(64),recordingEvidence:[],chapterTitles:[]},algorithmSha256:"c".repeat(64),
  recordingReferences:[{kind:"word_timing",recordingId:"screen",artifactId:"d".repeat(64)}],
  draft:{schema:"editkin.longform-sentence-alignment-draft/v1",clock:"narration_local_seconds",state:"REVIEW_REQUIRED",sentences:[],chapters:[],
    narration:{sourceStart:1,duration:150,preservedDuration:150,removedDuration:0},
    stats:{sentenceCount:33,alignedSentenceCount:29,matchedRecordingSentenceCount:18,chapterCount:8,comparisonUnits:1},
    contentVerified:false,syntheticTimingUsed:false,projectModified:false}};
const deps=():LongformSentenceAlignmentJobDepsV1=>({prepare:vi.fn(async()=>({artifact,cachedRecordingWindows:5})),readArtifact:vi.fn(async()=>artifact)});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return{promise,resolve};};
const terminal=async(jobs:LongformSentenceAlignmentJobsV1,id:string)=>vi.waitFor(()=>expect(["COMPLETED","FAILED","CANCELLED"]).toContain(jobs.get(id).state));

it("returns immediately and publishes compact source-current counts only after validation",async()=>{
  const done=deferred(),d=deps();let live!:LongformSentenceAlignmentRuntimeV1;
  d.prepare=async(_input,current)=>{live=current;await done.promise;return{artifact,cachedRecordingWindows:5};};
  const jobs=new LongformSentenceAlignmentJobsV1(runtime(),d),start=jobs.start(request);
  expect(start.state).toBe("RUNNING");expect(start.progress).toEqual({phase:"loading",completedRecordings:0,totalRecordings:null});
  await Promise.resolve();await live.onProgress!({phase:"recording_words",completedRecordings:0,totalRecordings:1,recordingId:"screen",completedWindows:2,totalWindows:5,cachedWindows:0});
  const copy=jobs.get(start.jobId);copy.progress.completedWindows=99;expect(jobs.get(start.jobId).progress.completedWindows).toBe(2);
  done.resolve();await terminal(jobs,start.jobId);
  expect(jobs.get(start.jobId)).toMatchObject({state:"COMPLETED",result:{artifactId:artifact.artifactId,sentenceCount:33,alignedSentenceCount:29,
    matchedRecordingSentenceCount:18,chapterCount:8,cachedRecordingWindows:5,preservedNarrationSeconds:150,removedNarrationSeconds:0,
    contentVerified:false,syntheticTimingUsed:false,projectModified:false}});
  expect(JSON.stringify(jobs.get(start.jobId))).not.toMatch(/"sentences"|"chapters"|sourceRoot|modelPath|"draft"/);
  expect(d.readArtifact).toHaveBeenCalledTimes(1);await jobs.close();
});
it("keeps CANCELLING until preparation settles and then releases the acoustic writer",async()=>{
  const current=runtime(),done=deferred(),d=deps();let signal!:AbortSignal;
  d.prepare=async(_input,r)=>{signal=r.signal!;await done.promise;signal.throwIfAborted();return{artifact,cachedRecordingWindows:0};};
  const jobs=new LongformSentenceAlignmentJobsV1(current,d),start=jobs.start(request);await Promise.resolve();
  expect(jobs.cancel(start.jobId).state).toBe("CANCELLING");expect(signal.aborted).toBe(true);expect(jobs.get(start.jobId).finishedAt).toBeUndefined();
  expect(()=>jobs.start(request)).toThrow("LONGFORM_ALIGNMENT_JOB_ALREADY_RUNNING");done.resolve();await terminal(jobs,start.jobId);
  expect(jobs.get(start.jobId).state).toBe("CANCELLED");expect(d.readArtifact).not.toHaveBeenCalled();await jobs.close();
  const next=new LongformSentenceAlignmentJobsV1(current,deps());const nextJob=next.start(request);await terminal(next,nextJob.jobId);await next.close();
});
it("source shutdown waits for active preparation and rejects subsequent starts",async()=>{
  const done=deferred(),d=deps();d.prepare=async(_input,r)=>{await done.promise;r.signal?.throwIfAborted();return{artifact,cachedRecordingWindows:0};};
  const jobs=new LongformSentenceAlignmentJobsV1(runtime(),d),start=jobs.start(request);await Promise.resolve();
  let closed=false;const close=jobs.close().then(()=>{closed=true;});await Promise.resolve();
  expect(closed).toBe(false);expect(jobs.get(start.jobId).state).toBe("CANCELLING");
  expect(()=>jobs.start(request)).toThrow("LONGFORM_ALIGNMENT_JOBS_CLOSED");done.resolve();await close;
  expect(closed).toBe(true);expect(jobs.get(start.jobId).state).toBe("CANCELLED");
});
it("refuses stale completion, bounds error text and releases its lease on failure",async()=>{
  const current=runtime(),d=deps();d.readArtifact=async()=>{throw new Error("changed D:/private/source.wav\n"+"x".repeat(4000));};
  const jobs=new LongformSentenceAlignmentJobsV1(current,d),start=jobs.start(request);await terminal(jobs,start.jobId);
  const failed=jobs.get(start.jobId);expect(failed.state).toBe("FAILED");expect(failed.result).toBeUndefined();
  expect(failed.error).not.toContain("private");expect(failed.error!.length).toBeLessThanOrEqual(1000);await jobs.close();
  const next=new LongformSentenceAlignmentJobsV1(current,deps()),second=next.start(request);await terminal(next,second.jobId);await next.close();
});
it("validates IDs and unknown model fields before claiming a recognizer",async()=>{
  const d=deps(),jobs=new LongformSentenceAlignmentJobsV1(runtime(),d);
  expect(()=>jobs.start({...request,model:"medium"})).toThrow();
  expect(()=>jobs.start({...request,narrationArtifactId:"../escape"})).toThrow();expect(d.prepare).not.toHaveBeenCalled();
  expect(()=>jobs.get("la-missing")).toThrow("LONGFORM_ALIGNMENT_JOB_NOT_FOUND");await jobs.close();
});
it("bounds process-local history and retains the latest completed artifact",async()=>{
  const jobs=new LongformSentenceAlignmentJobsV1(runtime(),deps());let first="",last="";
  for(let i=0;i<34;i++){last=jobs.start(request).jobId;first||=last;await terminal(jobs,last);}
  expect(()=>jobs.get(first)).toThrow("LONGFORM_ALIGNMENT_JOB_NOT_FOUND");expect(jobs.get(last).result?.artifactId).toBe(artifact.artifactId);await jobs.close();
});
it("serializes word and alignment jobs sharing a cache through cancellation settlement",async()=>{
  const current=runtime(),done=deferred(),wordArtifact={artifactId:"e".repeat(64),state:"WORDS_AVAILABLE",wordCount:1,issueCount:0,
    segmentCount:1,windows:[{}],contentVerified:false,syntheticTimingUsed:false}as LongformWordTimingArtifactV1;
  const wordDeps:LongformWordTimingJobDepsV1={prepare:async(_input,r)=>{await done.promise;r.signal?.throwIfAborted();return{artifact:wordArtifact,cachedWindows:0};},readArtifact:async()=>wordArtifact};
  const words=new LongformWordTimingJobsV1(current,wordDeps),alignments=new LongformSentenceAlignmentJobsV1(current,deps());
  const wordRequest={schema:"editkin.longform-word-timing-request/v1",narration:{id:"voice",path:"voice.wav",sourceStart:0,duration:10},
    script:{kind:"text",text:"hello"},recordings:[],screenshots:[],language:"en"};
  const word=words.start(wordRequest);await Promise.resolve();
  expect(()=>alignments.start(request)).toThrow("LONGFORM_RECOGNITION_ALREADY_RUNNING");expect(words.cancel(word.jobId).state).toBe("CANCELLING");
  expect(()=>alignments.start(request)).toThrow("LONGFORM_RECOGNITION_ALREADY_RUNNING");done.resolve();await words.close();
  const alignment=alignments.start(request);expect(()=>new LongformWordTimingJobsV1(current,wordDeps).start(wordRequest)).toThrow("LONGFORM_RECOGNITION_ALREADY_RUNNING");
  await terminal(alignments,alignment.jobId);await alignments.close();
});
