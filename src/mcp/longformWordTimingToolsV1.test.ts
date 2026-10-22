import type { McpServer } from "@modelcontextprotocol/server";
import { expect, it, vi } from "vitest";
import { LONGFORM_WORD_RESPONSE_BYTES_V1, LONGFORM_WORD_TIMING_TOOLS_V1,
  longformWordRuntimeV1, registerLongformWordTimingToolsV1, type LongformWordToolDepsV1 } from "./longformWordTimingToolsV1";
import { PINNED_WHISPER_MODEL } from "../application/automaticCaptions";

const jobId="lw-"+"a".repeat(24), artifactId="b".repeat(64);
const request={schema:"editkin.longform-word-timing-request/v1",narration:{id:"voice",path:"voice.wav",sourceStart:0,duration:10},
  script:{kind:"text",text:"hello"},recordings:[],screenshots:[],language:"en"};
const job={jobId,state:"RUNNING"as const,startedAt:"2026-10-12T00:00:00Z",progress:{completedWindows:0,totalWindows:1,cachedWindows:0}};
function fixture(){
  const registered=new Map<string,{config:{inputSchema:{parse:(value:unknown)=>unknown};annotations:unknown;description:string};
    handler:(value:never)=>Promise<{content:Array<{text:string}>;isError?:boolean}>}>();
  const server={registerTool:vi.fn((name,config,handler)=>registered.set(name,{config,handler}))}as unknown as McpServer;
  const deps:LongformWordToolDepsV1={jobs:{start:vi.fn(()=>job),get:vi.fn(()=>job),cancel:vi.fn(()=>({...job,state:"CANCELLING" as const}))},
    words:vi.fn(async()=>({artifactId,state:"WORDS_AVAILABLE" as const,clock:"narration_local_seconds" as const,total:1,offset:0,
      words:[],nextOffset:null,contentVerified:false})),
    issues:vi.fn(async()=>({artifactId,state:"REVIEW_REQUIRED" as const,total:1,offset:0,issues:[],nextOffset:null,
      contentVerified:false,syntheticTimingUsed:false}))};
  registerLongformWordTimingToolsV1(server,{EDITKIN_WORKSPACE:"D:/owned",APPDATA:"C:/owned-appdata"},deps);
  const call=async(name:string,input:unknown)=>{
    const entry=registered.get(name)!,parsed=entry.config.inputSchema.parse(input);
    return entry.handler(parsed as never);
  };
  return{deps,registered,call};
}
const value=(response:{content:Array<{text:string}>})=>JSON.parse(response.content[0].text);
it("registers separate bounded word-time tools without editing or claiming a completed project",async()=>{
  const f=fixture();expect([...f.registered.keys()]).toEqual([...LONGFORM_WORD_TIMING_TOOLS_V1]);
  expect(value(await f.call("start_longform_word_timing",request))).toMatchObject({jobId,state:"RUNNING"});
  expect(f.deps.jobs.start).toHaveBeenCalledWith(request);
  expect(value(await f.call("get_longform_word_timing_job",{jobId}))).toMatchObject({state:"RUNNING"});
  expect(value(await f.call("cancel_longform_word_timing_job",{jobId}))).toMatchObject({state:"CANCELLING"});
  expect(f.registered.get("start_longform_word_timing")!.config.description).toMatch(/既有模型/);
});
it("supplies bounded page defaults and the environment-owned workspace to readers",async()=>{
  const f=fixture();await f.call("read_longform_words",{artifactId});await f.call("read_longform_word_timing_issues",{artifactId,offset:12,limit:20});
  expect(f.deps.words).toHaveBeenCalledWith(expect.objectContaining({sourceRoot:"D:\\owned"}),artifactId,0,100);
  expect(f.deps.issues).toHaveBeenCalledWith(expect.objectContaining({sourceRoot:"D:\\owned"}),artifactId,12,20);
  await expect(f.call("read_longform_words",{artifactId,limit:201})).rejects.toThrow();
  await expect(f.call("read_longform_words",{artifactId:"../escape",limit:1})).rejects.toThrow();
  await expect(f.call("start_longform_word_timing",{...request,model:"medium"})).rejects.toThrow();
});
it("returns a bounded error when a reader fails or attempts an oversized word page",async()=>{
  const f=fixture();f.deps.words=async()=>{throw new Error("LONGFORM_SOURCE_CHANGED");};
  const missing=await f.call("read_longform_words",{artifactId});expect(missing.isError).toBe(true);
  expect(value(missing).error).toBe("LONGFORM_SOURCE_CHANGED");
  f.deps.words=async()=>({artifactId,state:"WORDS_AVAILABLE",clock:"narration_local_seconds",total:1,offset:0,
    words:[{text:"x".repeat(LONGFORM_WORD_RESPONSE_BYTES_V1),start:0,end:1,confidence:.9,windowIndex:0,segmentIndex:0,
      characterStart:0,characterEnd:1,tokenIndices:[0],sharedTokenRange:false}],nextOffset:null,contentVerified:false});
  const huge=await f.call("read_longform_words",{artifactId});expect(huge.isError).toBe(true);
  expect(value(huge).error).toMatch(/WORD_TIMING_RESPONSE_BUDGET/);expect(Buffer.byteLength(JSON.stringify(huge))).toBeLessThan(1000);
});
it("reuses the installed pinned model and trusted binary paths without accepting model parameters",()=>{
  const runtime=longformWordRuntimeV1({EDITKIN_WORKSPACE:"D:/owned",APPDATA:"C:/roaming",EDITKIN_LONGFORM_THREADS:"8"});
  expect(runtime.modelPath).toBe("C:\\roaming\\studio.hao.editkin\\models\\"+PINNED_WHISPER_MODEL.fileName);
  expect(runtime.threads).toBe(8);expect(runtime.workRoot.startsWith(runtime.cacheRoot)).toBe(true);
  expect(runtime.whisperCliPath.replaceAll("\\","/")).toMatch(/vendor\/whisper\/win32-x64\/whisper-cli\.exe$/);
  expect(()=>longformWordRuntimeV1({EDITKIN_LONGFORM_THREADS:"17"})).toThrow("WORD_TIMING_THREADS");
});
