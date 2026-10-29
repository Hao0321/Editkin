import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEngineTaskHostV1 } from "./engineTaskHostV1";
import { engineTaskRequestSchemaV1 } from "../application/engineTaskContractV1";
import { dispatchEngineTaskV1 } from "../service/engineTaskRegistryV1";
import { runBatchAutoEditItem } from "../application/batchAutoEdit";
import { createProjectSession } from "../application/projectSession";
import { createDemoProject } from "../domain/demo";
import { useBatchAutoEdit } from "./useBatchAutoEdit";
import type { BatchAutoEditSession, HaoDesktopApi } from "./types";

const slots=vi.hoisted(()=>({values:[] as unknown[],index:0}));
vi.mock("react",()=>({useEffect:()=>undefined,useCallback:(fn:unknown)=>fn,useMemo:(fn:()=>unknown)=>fn(),
  useRef:(value:unknown)=>{const i=slots.index++;return slots.values[i]??=( {current:value} );},
  useState:(initial:unknown)=>{const i=slots.index++;if(!(i in slots.values))slots.values[i]=initial;return[slots.values[i],(v:unknown)=>{slots.values[i]=v;}];}}));
afterEach(()=>{slots.values=[];slots.index=0;});
const input={operationId:"batch-bridge-0001",sessionId:"batch-123",jobId:"job-001"};
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}
function nativeSession(root:string):BatchAutoEditSession{return{schemaVersion:1,id:input.sessionId,editorialProfile:"auto",outputRoot:root,createdAt:"2026-10-18T00:00:00Z",updatedAt:"2026-10-18T00:00:00Z",
  jobs:[{id:"job-001",sourceName:"owned source",sourcePath:join(root,"source.mp4"),status:"queued",warnings:[]},{id:"job-002",sourceName:"second",sourcePath:join(root,"second.mp4"),status:"queued",warnings:[]}]};}
function completedReply(session:BatchAutoEditSession){const copy=structuredClone(session);copy.jobs[0].status="completed";return{schema:"editkin.engine-task-reply/v1" as const,kind:"desktop_batch_item_v1" as const,
  operationId:input.operationId,result:{schema:"editkin.desktop-batch-result/v1" as const,request:input,result:{status:"completed" as const,jobId:input.jobId,sourceName:"owned source",receiptPath:join(session.outputRoot,"receipt.json"),warnings:[]},session:copy}};}

describe("trusted desktop engine caller",()=>{
  it.each(["sourcePath","runtime","job","hostInput","project","plan"])("rejects renderer %s before IPC",async key=>{
    const invoke=vi.fn();const api=createEngineTaskHostV1(invoke as never,()=>({}));
    expect(engineTaskRequestSchemaV1.safeParse({schema:"editkin.engine-task/v1",kind:"desktop_batch_item_v1",input,[key]:{}}).success).toBe(false);
    await expect(api.runDesktopBatchTaskV1({...input,[key]:"forged"})).rejects.toThrow();expect(invoke).not.toHaveBeenCalled();
  });
  it("delivers a queued abort only after registration and only once",async()=>{
    let receive:(v:unknown)=>void=()=>{};const held=deferred<unknown>(),invoke=vi.fn((command:string)=>command==="run_engine_task_v1"?held.promise:Promise.resolve({known:true,cancelRequested:true}));
    const api=createEngineTaskHostV1(invoke as never,fn=>{receive=fn;return{};}),controller=new AbortController();
    const running=api.runDesktopBatchTaskV1(input,{signal:controller.signal});controller.abort(new Error("queued-cancel"));
    expect(invoke).toHaveBeenCalledTimes(1);
    const ack={schema:"editkin.engine-task-host/v1",kind:"desktop_batch_item_v1",operationId:input.operationId,stage:"registered"};receive(ack);receive(ack);
    expect(invoke).toHaveBeenCalledTimes(2);expect(invoke.mock.calls[1][0]).toBe("cancel_engine_task_v1");
    held.resolve(completedReply(nativeSession(tmpdir())));await expect(running).rejects.toThrow("queued-cancel");
  });
  it.each(["session","job","kind","operation"])("rejects a foreign %s reply",async bad=>{
    const reply=completedReply(nativeSession(tmpdir()));if(bad==="session")reply.result.session.id="foreign";if(bad==="job")reply.result.result.jobId="wrong";
    if(bad==="kind")(reply as {kind:string}).kind="auto_reframe_v1";if(bad==="operation")reply.operationId="foreign-job";
    const api=createEngineTaskHostV1((async()=>reply) as never,()=>({}));await expect(api.runDesktopBatchTaskV1(input)).rejects.toThrow("BINDING_CHANGED");
  });
  it("ignores a foreign item progress event and accepts a native-persisted result",async()=>{
    let receive:(v:unknown)=>void=()=>{};const held=deferred<unknown>(),observer=vi.fn();
    const api=createEngineTaskHostV1((async()=>held.promise) as never,fn=>{receive=fn;return{};});const pending=api.runDesktopBatchTaskV1(input,{onProgress:observer});
    const event={schema:"editkin.engine-task-progress/v1",kind:"desktop_batch_item_v1",operationId:input.operationId,progress:{stage:"executing",completed:0,total:1,sessionId:input.sessionId,jobId:input.jobId}};
    receive({...event,progress:{...event.progress,jobId:"foreign"}});expect(observer).not.toHaveBeenCalled();receive(event);expect(observer).toHaveBeenCalledOnce();
    held.resolve(completedReply(nativeSession(tmpdir())));await expect(pending).resolves.toMatchObject({result:{session:{id:input.sessionId}}});
  });
});

describe("existing native-session/CLI registry seam (native invocation controlled)",()=>{
  it("runs a concrete editable batch through the real host, registry and canonical file writer; no invented v4 plan",async()=>{
    const root=await mkdtemp(join(tmpdir(),"desktop-batch-chain-")),session=nativeSession(root),cache=join(root,"cache");
    await writeFile(session.jobs[0].sourcePath,"owned immutable source bytes");await mkdir(cache);
    const directory=join(cache,"engine-jobs-v1",input.operationId);await mkdir(directory,{recursive:true});
    const nativeStore=join(root,"native-session.json");await writeFile(nativeStore,JSON.stringify(session));
    let receive:(v:unknown)=>void=()=>{};let producerCalls=0;
    const invoke=async(command:string,args:Record<string,unknown>)=>{
      expect(command).toBe("run_engine_task_v1");const request=args.request as {input:typeof input};
      expect(Object.keys(request).sort()).toEqual(["input","kind","schema"]);
      receive({schema:"editkin.engine-task-host/v1",kind:"desktop_batch_item_v1",operationId:input.operationId,stage:"registered"});
      const hostInput={jobId:input.jobId,sourcePath:session.jobs[0].sourcePath,outputRoot:root,language:"auto",targetRatio:.65,addMusic:false,editorialProfile:"auto"};
      const reply=await dispatchEngineTaskV1({...request,hostInput,job:{progressPath:join(directory,"progress.json"),cancelPath:join(directory,"cancel.request")}},
        {assetBase:root,cacheRoot:cache,ffmpeg:join(root,"ffmpeg.exe"),ffprobe:join(root,"ffprobe.exe"),modelRoot:join(root,"models")},
        {onProgress:event=>receive(event),runDesktopBatch:async(req,runtime)=>{producerCalls++;return runBatchAutoEditItem(req,runtime,{
          inspect:async()=>({hasVideo:true,hasAudio:true,duration:12,width:1920,height:1080}),
          transcribe:async()=>({cues:[{start:.5,end:4,text:"第一個關鍵方法"},{start:6,end:10,text:"最後總結結果"}],engine:"fixture",modelId:"fixture",modelSha256:"a".repeat(64),language:"zh",analyzedSeconds:12,elapsedMs:1,modelDownloaded:false,cacheHit:false,acceleration:"cpu"}),
          detectScenes:async()=>({cuts:[],engine:"ffmpeg-scdet-8",threshold:10,minSceneDuration:.5,analyzedSeconds:12,elapsedMs:1,cacheHit:false}),smartCut:async()=>{throw new Error("No synthetic audio evidence");},
          render:async({outputPath})=>{await writeFile(outputPath,"fixture-only-video");return{outputPath,duration:12,encoder:"libx264",planner:"fixture",ffmpegVersion:"fixture"};},
        });}});
      if(reply.kind!=="desktop_batch_item_v1")throw new Error("wrong kind");
      const stored=JSON.parse(await readFile(nativeStore,"utf8")) as BatchAutoEditSession;Object.assign(stored.jobs[0],{status:reply.result.result.status,projectPath:reply.result.result.projectPath,outputPath:reply.result.result.outputPath});
      await writeFile(nativeStore,JSON.stringify(stored));reply.result.session=JSON.parse(await readFile(nativeStore,"utf8"));return reply;
    };
    const host=createEngineTaskHostV1(invoke as never,fn=>{receive=fn;return{};}),events:unknown[]=[];
    const reply=await host.runDesktopBatchTaskV1(input,{onProgress:event=>events.push(event)});
    expect(producerCalls).toBe(1);expect(reply.result.result.status).toBe("completed");
    expect(JSON.parse(await readFile(reply.result.result.projectPath!,"utf8")).captions.length).toBeGreaterThan(0);
    expect(await readFile(session.jobs[0].sourcePath,"utf8")).toBe("owned immutable source bytes");
    expect(JSON.parse(await readFile(join(directory,"progress.json"),"utf8"))).toMatchObject({kind:"desktop_batch_item_v1",progress:{stage:"completed",completed:1,total:1}});
    expect(events.length).toBeGreaterThan(1);expect(reply.result).not.toHaveProperty("planSha256");
  });
  it("rejects a cancel already in the native job directory before calling its producer",async()=>{
    const root=await mkdtemp(join(tmpdir(),"desktop-batch-cancel-")),directory=join(root,"engine-jobs-v1",input.operationId);await mkdir(directory,{recursive:true});
    const cancelPath=join(directory,"cancel.request");await writeFile(cancelPath,"cancel\n");const producer=vi.fn();
    await expect(dispatchEngineTaskV1({schema:"editkin.engine-task/v1",kind:"desktop_batch_item_v1",input,hostInput:{jobId:input.jobId,sourcePath:join(root,"source"),outputRoot:root,language:"auto",targetRatio:.65,addMusic:false,editorialProfile:"auto"},job:{progressPath:join(directory,"progress.json"),cancelPath}},
      {assetBase:root,cacheRoot:root,ffmpeg:join(root,"ffmpeg.exe"),ffprobe:join(root,"ffprobe.exe"),modelRoot:root},{runDesktopBatch:producer})).rejects.toThrow("ENGINE_TASK_CANCELLED");expect(producer).not.toHaveBeenCalled();
  });
});

describe("desktop hook queue ownership",()=>{
  it("does not apply the old next item to a replacement session after one failure",async()=>{
    const session=nativeSession(tmpdir()),replacement={...session,id:"replacement-session"};
    const run=vi.fn(async(_sessionId:string,_jobId:string,_options?:unknown)=>{throw new Error("item failed");});
    const api={pickBatchMedia:async()=>({canceled:false,session}),runBatchAutoEditItem:run,getBatchSession:async()=>({session:replacement})} as unknown as HaoDesktopApi;
    const onStatus=vi.fn();const hook=useBatchAutoEdit({api,projectSession:createProjectSession(createDemoProject()),onOpenProject:()=>{},onStatus});
    await hook.start("auto");expect(run).toHaveBeenCalledTimes(1);expect(run.mock.calls[0][0]).toBe(session.id);expect(onStatus).toHaveBeenCalledWith(expect.stringContaining("替換"));
  });
  it("passes actual cancellation and suppresses a late foreign-session result",async()=>{
    const session=nativeSession(tmpdir()),held=deferred<{session:BatchAutoEditSession}>();
    let signal:AbortSignal|undefined;const run=vi.fn((_session:string,_job:string,options?:{signal?:AbortSignal})=>{signal=options?.signal;return held.promise;});
    const api={pickBatchMedia:async()=>({canceled:false,session}),runBatchAutoEditItem:run,getBatchSession:async()=>({session})} as unknown as HaoDesktopApi;
    const options={api,projectSession:createProjectSession(createDemoProject()),onOpenProject:()=>{},onStatus:vi.fn()};const render=()=>{slots.index=0;return useBatchAutoEdit(options);};
    const pending=render().start("auto");await Promise.resolve();await Promise.resolve();render().cancel();expect(signal?.aborted).toBe(true);
    held.resolve({session:{...session,id:"foreign"}});await pending;expect(run).toHaveBeenCalledTimes(1);
    expect(render().session?.id).toBe(session.id);
  });
});
