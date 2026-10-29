import { describe, expect, it, vi } from "vitest";
import { beginAutoReframeEditV1, autoReframeJobRequestV1 } from "../application/autoReframeEditV1";
import { autoReframeWorkflowFixtureV1 } from "../application/__fixtures__/autoReframeWorkflowV1.fixture";
import { createEngineTaskHostV1 } from "./engineTaskHostV1";
async function fixture() {
  const project = autoReframeWorkflowFixtureV1(false);
  const job = await beginAutoReframeEditV1(project,"selected",{operationId:"host-task-1234", mode:"new_portrait_project", outputWidth:90,outputHeight:160,subject:{kind:"saliency"},
    newProject:{id:"separate-document",name:"Portrait",createdAt:"2026-10-18T00:00:00.000Z"}});
  const request={schema:"editkin.engine-task/v1" as const,kind:"auto_reframe_v1" as const,project,input:autoReframeJobRequestV1(project,job)};
  const reply={schema:"editkin.engine-task-reply/v1",kind:request.kind,operationId:request.input.operationId,result:{schema:"editkin.auto-reframe-reply/v1",request:structuredClone(request.input)}};
  let receive:(v:unknown)=>void=()=>{};
  let resolve!:(v:unknown)=>void;
  const pending=new Promise(r=>{resolve=r;});
  const invoke=vi.fn((command:string,_args:unknown)=>command==="run_engine_task_v1"?pending:Promise.resolve({known:true,cancelRequested:true}));
  const api=createEngineTaskHostV1(invoke as any,fn=>{receive=fn;return {channel:true};});
  const ack=()=>receive({schema:"editkin.engine-task-host/v1",kind:request.kind,operationId:request.input.operationId,stage:"registered"});
  return {request,reply,api,invoke,receive:(v:unknown)=>receive(v),resolve,ack};
}
describe("desktop typed engine task lifetime",()=>{
  it("sends a snapshot with no runtime/path overrides and validates the response binding",async()=>{
    const f=await fixture(), p=f.api.runEngineTaskV1(f.request);
    f.request.project.name="later edit"; expect(f.invoke.mock.calls[0][1]).not.toHaveProperty("runtime");
    expect((f.invoke.mock.calls[0][1] as any).request.project.name).not.toBe("later edit"); f.resolve(f.reply); await expect(p).resolves.toEqual(f.reply);
  });
  it("does not invoke for an already aborted task",async()=>{
    const f=await fixture(), c=new AbortController(); c.abort();
    await expect(f.api.runEngineTaskV1(f.request,{signal:c.signal})).rejects.toThrow(); expect(f.invoke).not.toHaveBeenCalled();
  });
  it.each(["job","sourcePath","runtime"])("rejects renderer %s injection before IPC",async key=>{
    const f=await fixture(); (f.request as any)[key]={}; await expect(f.api.runEngineTaskV1(f.request)).rejects.toThrow(); expect(f.invoke).not.toHaveBeenCalled();
  });
  it("cancels once after registration even when the abort arrived first",async()=>{
    const f=await fixture(), c=new AbortController(), p=f.api.runEngineTaskV1(f.request,{signal:c.signal});
    c.abort(); expect(f.invoke).toHaveBeenCalledTimes(1); f.ack(); f.ack();
    expect(f.invoke).toHaveBeenCalledTimes(2); expect(f.invoke.mock.calls[1]).toEqual(["cancel_engine_task_v1",{operationId:f.request.input.operationId}]);
    f.resolve(f.reply); await expect(p).rejects.toThrow();
  });
  it("ignores foreign, malformed and late progress; removes the abort listener after success",async()=>{
    const f=await fixture(), c=new AbortController(), onProgress=vi.fn(), p=f.api.runEngineTaskV1(f.request,{signal:c.signal,onProgress});
    const event={schema:"editkin.engine-task-progress/v1",kind:f.request.kind,operationId:f.request.input.operationId,progress:{stage:"source",completed:1,total:2}};
    f.receive({...event,operationId:"foreign-job"}); f.receive({...event,progress:{...event.progress,total:0}}); expect(onProgress).not.toHaveBeenCalled();
    f.receive(event); expect(onProgress).toHaveBeenCalledOnce(); f.resolve(f.reply); await p;
    f.receive(event); c.abort(); expect(onProgress).toHaveBeenCalledOnce(); expect(f.invoke).toHaveBeenCalledOnce();
  });
  it.each(["operationId","kind","request"])("rejects mismatched %s reply",async key=>{
    const f=await fixture(), p=f.api.runEngineTaskV1(f.request);
    if(key==="request") f.reply.result.request.clipId="other"; else (f.reply as any)[key]="foreign";
    f.resolve(f.reply); await expect(p).rejects.toThrow("ENGINE_TASK_REPLY_BINDING_CHANGED");
  });
  it("requests cancellation if the progress consumer fails and refuses its eventual result",async()=>{
    const f=await fixture(), p=f.api.runEngineTaskV1(f.request,{onProgress:()=>{throw Error("consumer failed");}});
    f.receive({schema:"editkin.engine-task-progress/v1",kind:f.request.kind,operationId:f.request.input.operationId,progress:{stage:"verify",completed:1,total:1}});
    f.resolve(f.reply); await expect(p).rejects.toThrow("consumer failed"); expect(f.invoke.mock.calls[1][0]).toBe("cancel_engine_task_v1");
  });
});
