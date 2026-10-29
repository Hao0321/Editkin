import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { PINNED_WHISPER_MODEL } from "./automaticCaptions";
import { prepareLongformWordRecognitionV1, readLongformWordPageV1, readLongformWordIssuePageV1,
  type LongformWordRecognitionDepsV1, type LongformWordRecognitionRuntimeV1 } from "./longformWordRecognitionV1";

const owned: string[] = [];
afterEach(async () => {
  for (const root of owned.splice(0)) {
    const inside = relative(tmpdir(),root);
    assert(inside && !inside.startsWith("..") && !isAbsolute(inside));
    await rm(root,{recursive:true,force:true});
  }
});
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const json = (index: number) => JSON.stringify({transcription:[{text:` ${["first","second","third"][index]}`,
  offsets:{from:0,to:3000},tokens:[{text:` ${["first","second","third"][index]}`,id:42,p:.9,
    offsets:{from:index === 0 ? 100 : 2100,to:index === 0 ? 800 : 2400}}]}]});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(),"longword-runtime-")); owned.push(root);
  for (const name of ["voice.wav","screen.mp4","proof.png"]) await writeFile(join(root,name),name);
  const request = {schema:"editkin.longform-word-timing-request/v1",
    narration:{id:"voice",path:"voice.wav",sourceStart:3,duration:61},script:{kind:"text",text:"first second third"},
    recordings:[{id:"screen",path:"screen.mp4",sourceStart:5,duration:61}],screenshots:[{id:"proof",path:"proof.png"}],language:"en"};
  const runtime: LongformWordRecognitionRuntimeV1 = {sourceRoot:root,cacheRoot:join(root,"cache"),workRoot:join(root,"work"),
    ffmpegPath:join(root,"ffmpeg.exe"),whisperCliPath:join(root,"whisper.exe"),modelPath:join(root,"model.bin"),modelRoot:root,
    probe:async()=>({duration:100,width:1920,height:1080,hasAudio:true,hasVideo:true})};
  const calls: string[][] = [];
  const deps: LongformWordRecognitionDepsV1 = {
    inspectModel:async()=>({valid:true,bytes:PINNED_WHISPER_MODEL.bytes,sha256:PINNED_WHISPER_MODEL.sha256}),
    runtimeIdentity:async()=>"a".repeat(64),
    run:async(exe,args,options)=>{
      options.signal?.throwIfAborted(); calls.push([exe,...args]);
      if(args[0] === "--help") return {stdout:Buffer.from("--output-json-full"),stderr:""};
      if(exe === runtime.ffmpegPath) await writeFile(args.at(-1)!,"owned PCM");
      else {
        const prefix=args[args.indexOf("-of")+1], index=Number(/recognition-(\d+)$/.exec(prefix)![1]);
        await writeFile(prefix+".json",json(index));
      }
      return {stdout:Buffer.alloc(0),stderr:""};
    },
  };
  const recognized=()=>calls.filter(row=>row.includes("-ojf"));
  return {root,request,runtime,deps,calls,recognized};
}
it("extracts each caller range, stores real word clocks and pages across context windows",async()=>{
  const f=await fixture(), progress: number[]=[];
  f.runtime.onProgress=value=>{progress.push(value.completedWindows);};
  const result=await prepareLongformWordRecognitionV1(f.request,f.runtime,f.deps);
  expect(result.artifact.wordCount).toBe(3); expect(result.artifact.syntheticTimingUsed).toBe(false);
  expect(progress).toEqual([1,2,3]);
  expect(f.calls.filter(row=>row[0] === f.runtime.ffmpegPath).map(row=>row[row.indexOf("-ss")+1])).toEqual(["3","31","61"]);
  const first=await readLongformWordPageV1(f.runtime,result.artifact.artifactId,0,2);
  expect(first.words.map(row=>[row.text,row.start,row.end])).toEqual([["first",.1,.8],["second",30.1,30.4]]);
  expect(first.nextOffset).toBe(2); expect(first.contentVerified).toBe(false);
  const last=await readLongformWordPageV1(f.runtime,result.artifact.artifactId,first.nextOffset!,2);
  expect(last.words.map(row=>[row.text,row.start,row.end])).toEqual([["third",60.1,60.4]]);
  expect(last.nextOffset).toBeNull(); expect(await readdir(f.runtime.workRoot)).toEqual([]);
  expect(await readFile(join(f.root,"voice.wav"),"utf8")).toBe("voice.wav");
});
it("reuses unchanged recognition but refuses damaged or missing raw cache evidence",async()=>{
  const f=await fixture(), first=await prepareLongformWordRecognitionV1(f.request,f.runtime,f.deps);
  const second=await prepareLongformWordRecognitionV1(f.request,f.runtime,f.deps);
  expect(second.artifact).toEqual(first.artifact); expect(second.cachedWindows).toBe(3); expect(f.recognized()).toHaveLength(3);
  const row=first.artifact.windows[0], path=join(f.runtime.cacheRoot,"longform-word-timing-v1/windows",row.rawFile);
  await writeFile(path,"substituted raw transcript");
  await expect(readLongformWordPageV1(f.runtime,first.artifact.artifactId)).rejects.toThrow("WORD_TIMING_WINDOW_CACHE_SHA");
  await rm(path); // this file is owned by this fixture
  await expect(prepareLongformWordRecognitionV1(f.request,f.runtime,f.deps)).rejects.toMatchObject({code:"ENOENT"});
  expect(f.recognized()).toHaveLength(3);
});
it("rejects a cached window clock even when its modified bytes have a fresh checksum",async()=>{
  const f=await fixture(), result=await prepareLongformWordRecognitionV1(f.request,f.runtime,f.deps);
  const row=result.artifact.windows[0], root=join(f.runtime.cacheRoot,"longform-word-timing-v1/windows");
  const saved=JSON.parse(await readFile(join(root,row.parsedFile),"utf8")); saved.window.coreEnd=29;
  const bytes=Buffer.from(JSON.stringify(saved)); await writeFile(join(root,row.parsedFile),bytes);
  await writeFile(join(root,row.key+".index.json"),JSON.stringify({...row,parsedSha256:sha(bytes)}));
  await expect(prepareLongformWordRecognitionV1(f.request,f.runtime,f.deps)).rejects.toThrow("WORD_TIMING_WINDOW_CACHE_CLOCK");
  expect(f.recognized()).toHaveLength(3);
});
it("does not publish an artifact after author material changes during recognition",async()=>{
  const f=await fixture(), run=f.deps.run;
  f.deps.run=async(...args)=>{
    const result=await run(...args); if(args[1].includes("-ojf")) await writeFile(join(f.root,"voice.wav"),"author revision"); return result;
  };
  await expect(prepareLongformWordRecognitionV1(f.request,f.runtime,f.deps)).rejects.toThrow("LONGFORM_SOURCE_CHANGED");
  expect(await readdir(join(f.runtime.cacheRoot,"longform-word-timing-v1/artifacts"))).toEqual([]);
  expect(await readdir(f.runtime.workRoot)).toEqual([]);
});
it("refuses another model and a runtime change during an otherwise successful job",async()=>{
  const f=await fixture(), inspect=f.deps.inspectModel;
  f.deps.inspectModel=async()=>({valid:false,bytes:0,sha256:""});
  await expect(prepareLongformWordRecognitionV1(f.request,f.runtime,f.deps)).rejects.toThrow("WORD_TIMING_PINNED_MODEL_UNAVAILABLE");
  expect(f.calls).toEqual([]); f.deps.inspectModel=inspect;
  let fingerprints=0; f.deps.runtimeIdentity=async()=>String(++fingerprints).repeat(64);
  await expect(prepareLongformWordRecognitionV1(f.request,f.runtime,f.deps)).rejects.toThrow("WORD_TIMING_RECOGNIZER_CHANGED");
  expect(await readdir(join(f.runtime.cacheRoot,"longform-word-timing-v1/artifacts"))).toEqual([]);
});
it("propagates cancellation and clears only the job's temporary directory",async()=>{
  const f=await fixture(), stop=new AbortController(), run=f.deps.run; f.runtime.signal=stop.signal;
  f.deps.run=async(...args)=>{
    if(args[1].includes("-ojf")){stop.abort();stop.signal.throwIfAborted();}
    return run(...args);
  };
  await expect(prepareLongformWordRecognitionV1(f.request,f.runtime,f.deps)).rejects.toMatchObject({name:"AbortError"});
  expect(await readdir(f.runtime.workRoot)).toEqual([]);
  expect(await readFile(join(f.root,"voice.wav"),"utf8")).toBe("voice.wav");
});
it("does not consume a previous window's JSON when a later recognizer exits without writing output",async()=>{
  const f=await fixture(), run=f.deps.run;
  f.deps.run=async(exe,args,options)=>args.includes("-ojf") && /recognition-1$/.test(args[args.indexOf("-of")+1])
    ? {stdout:Buffer.alloc(0),stderr:""} : run(exe,args,options);
  await expect(prepareLongformWordRecognitionV1(f.request,f.runtime,f.deps)).rejects.toMatchObject({code:"ENOENT"});
  expect(await readdir(join(f.runtime.cacheRoot,"longform-word-timing-v1/artifacts"))).toEqual([]);
  expect(await readdir(f.runtime.workRoot)).toEqual([]);
});
it("bounds page size and detects later material changes before returning saved words",async()=>{
  const f=await fixture(), result=await prepareLongformWordRecognitionV1(f.request,f.runtime,f.deps);
  await expect(readLongformWordPageV1(f.runtime,result.artifact.artifactId,0,201)).rejects.toThrow("WORD_TIMING_PAGE");
  await writeFile(join(f.root,"screen.mp4"),"changed recording");
  await expect(readLongformWordPageV1(f.runtime,result.artifact.artifactId)).rejects.toThrow("LONGFORM_SOURCE_CHANGED");
});
it("pages omitted words' review issues across windows and validates their raw evidence",async()=>{
  const f=await fixture(),run=f.deps.run;
  f.deps.run=async(exe,args,options)=>{
    const value=await run(exe,args,options);
    if(args.includes("-ojf")){
      const prefix=args[args.indexOf("-of")+1],index=Number(/recognition-(\d+)$/.exec(prefix)![1]);
      await writeFile(prefix+".json",JSON.stringify({transcription:[{text:" missing timed",offsets:{from:0,to:3000},tokens:[
        {id:1,p:.9,text:" missing"},{id:2,p:.9,text:" timed",offsets:{from:index===0?100:2100,to:index===0?800:2400}}]}]}));
    }return value;
  };
  const result=await prepareLongformWordRecognitionV1(f.request,f.runtime,f.deps);
  expect(result.artifact.issueCount).toBe(3);expect(result.artifact.state).toBe("REVIEW_REQUIRED");
  const first=await readLongformWordIssuePageV1(f.runtime,result.artifact.artifactId,0,1);
  expect(first.issues).toEqual([expect.objectContaining({code:"UNTIMED_WORD",text:"missing",windowIndex:0})]);
  expect(first.nextOffset).toBe(1);
  const next=await readLongformWordIssuePageV1(f.runtime,result.artifact.artifactId,first.nextOffset!,2);
  expect(next.issues.map(row=>row.windowIndex)).toEqual([1,2]);expect(next.nextOffset).toBeNull();
  expect(next.syntheticTimingUsed).toBe(false);
  await expect(readLongformWordIssuePageV1(f.runtime,result.artifact.artifactId,0,201)).rejects.toThrow("WORD_TIMING_PAGE");
  const rawPath=join(f.runtime.cacheRoot,"longform-word-timing-v1/windows",result.artifact.windows[1].rawFile);
  await writeFile(rawPath,"substituted transcript");
  await expect(readLongformWordIssuePageV1(f.runtime,result.artifact.artifactId,1,1)).rejects.toThrow("WORD_TIMING_WINDOW_CACHE_SHA");
});
