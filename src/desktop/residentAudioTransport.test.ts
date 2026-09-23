import {describe, expect, it, vi} from "vitest";
import {createDemoProject} from "../domain/demo";
import {ResidentAudioTransport, residentStageMatches, type ResidentAudioIntent, type ResidentAudioView} from "./residentAudioTransport";
import type {ResidentAudioApi, ResidentAudioStage, ResidentAudioStatus} from "./residentAudioTypes";
const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
function deferred<T>(){let resolve!:(v:T)=>void;let reject!:(e:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
function fixture(){
  const project=createDemoProject();const intent:ResidentAudioIntent={project,seekRevision:0,timelineStartSeconds:0,playing:true};
  const views:ResidentAudioView[]=[];let listener!:(s:ResidentAudioStatus)=>void;let generation=0;
  const stage=(start:number,g:number):ResidentAudioStage=>({schema:"editkin.native-audio-project-stage/v1",status:"PREPARED",
    projectId:project.id,projectRevision:project.revision,projectUpdatedAt:project.updatedAt,generation:g,planSha256:"a".repeat(64),
    audioFingerprintSha256:"b".repeat(64),planBytes:240,startFrame:Math.round(start*48000),frameCount:48000*60-Math.round(start*48000),
    sourceCount:41,peakActiveSources:2,pcmStagingFiles:0});
  const api={
    capabilities:vi.fn(async()=>({schema:"editkin.desktop-audio-capabilities/v1" as const,supported:true,gpuClock:false,sampleRate:48000 as const})),
    open:vi.fn(async(cb:(s:ResidentAudioStatus)=>void)=>{listener=cb;return{ownerId:7,status:{} as ResidentAudioStatus};}),
    replace:vi.fn(async(ownerId:number,_project:unknown,start:number)=>{const g=++generation;return{ownerId,generation:g,stage:stage(start,g)};}),
    control:vi.fn(async(ownerId:number,_generation:number,_playing:boolean)=>({ownerId,accepted:true as const,requestId:1})),
    close:vi.fn(async(ownerId:number)=>({ownerId,released:true,retainedStageFiles:0})),
  } satisfies ResidentAudioApi;
  const clock=vi.fn();const transport=new ResidentAudioTransport(api,view=>views.push(view),clock);
  const send=(seq:number,g:number,time:number,ownerId=7,event="progress")=>listener({schema:"editkin.desktop-audio-status/v1",ownerId,sequence:seq,generation:g,ready:true,closing:false,failed:false,
    playback:{schema:"editkin.native-audio-session-event/v1",event,streamGeneration:g,state:event==="ended"?"ended":"playing",timelineStartFrame:0,timelineFrame:time*48000,presentedFrame:time*48000,sampleMasterFrame:time*48000,sampleMasterRate:48000}});
  return{api,intent,views,transport,clock,send,stage};
}
describe("retained resident audio transport",()=>{
  it("retains one owner and plan across pause/resume and telemetry renders",async()=>{
    const f=fixture();f.transport.update(f.intent);await flush();
    for(let i=1;i<40;i++)f.transport.update({...f.intent,timelineStartSeconds:i/10});await flush();
    f.transport.update({...f.intent,playing:false});await flush();f.transport.update(f.intent);await flush();
    expect(f.api.open).toHaveBeenCalledTimes(1);expect(f.api.replace).toHaveBeenCalledTimes(1);
    expect(f.api.control.mock.calls.map(c=>c.slice(1))).toEqual([[1,true],[1,false],[1,true]]);
    expect(f.api.close).not.toHaveBeenCalled();await f.transport.dispose();expect(f.api.close).toHaveBeenCalledWith(7);
  });
  it("does not allocate a native owner while initially paused or on old helpers",async()=>{
    const f=fixture();f.transport.update({...f.intent,playing:false});await flush();expect(f.api.open).not.toHaveBeenCalled();
    f.api.capabilities.mockResolvedValue({schema:"editkin.desktop-audio-capabilities/v1",supported:false,gpuClock:false,sampleRate:48000});
    f.transport.update(f.intent);await flush();expect(f.api.open).not.toHaveBeenCalled();expect(f.views.at(-1)?.mode).toBe("compatible");
    await f.transport.dispose();
  });
  it("coalesces rapid seeks and never resumes an obsolete staged position",async()=>{
    const f=fixture();const pending=deferred<Awaited<ReturnType<ResidentAudioApi["replace"]>>>();f.api.replace.mockReturnValueOnce(pending.promise);
    f.transport.update(f.intent);await flush();
    for(let i=1;i<=10;i++)f.transport.update({...f.intent,seekRevision:i,timelineStartSeconds:i});
    pending.resolve({ownerId:7,generation:1,stage:f.stage(0,1)});
    f.api.replace.mockImplementationOnce(async(ownerId,_project,start)=>({ownerId,generation:2,stage:f.stage(start,2)}));await flush();
    expect(f.api.replace.mock.calls.map(c=>c[2])).toEqual([0,10]);expect(f.api.control.mock.calls.map(c=>c.slice(1))).toEqual([[2,true]]);
    await f.transport.dispose();
  });
  it("a pause during staging leaves the prepared stream paused",async()=>{
    const f=fixture(),pending=deferred<Awaited<ReturnType<ResidentAudioApi["replace"]>>>();f.api.replace.mockReturnValueOnce(pending.promise);
    f.transport.update(f.intent);await flush();f.transport.update({...f.intent,playing:false});pending.resolve({ownerId:7,generation:1,stage:f.stage(0,1)});await flush();
    expect(f.api.control).not.toHaveBeenCalled();expect(f.views.at(-1)?.playing).toBe(false);await f.transport.dispose();
  });
  it("closes a late open after disposal without staging or publishing",async()=>{
    const f=fixture(),pending=deferred<Awaited<ReturnType<ResidentAudioApi["open"]>>>();f.api.open.mockReturnValueOnce(pending.promise);
    f.transport.update(f.intent);await flush();const stop=f.transport.dispose();const count=f.views.length;
    pending.resolve({ownerId:7,status:{} as ResidentAudioStatus});await stop;
    expect(f.api.close).toHaveBeenCalledTimes(1);expect(f.api.replace).not.toHaveBeenCalled();expect(f.views).toHaveLength(count);
  });
  it("ignores wrong owner/generation, regressed sequence and early end",async()=>{
    const f=fixture();f.transport.update(f.intent);await flush();
    f.send(1,1,2,8);f.send(2,9,2);f.send(3,1,2,7,"ended");expect(f.clock).not.toHaveBeenCalled();
    f.send(4,1,35);f.send(3,1,20);expect(f.clock.mock.calls).toEqual([[35,false]]);
    f.send(5,1,60,7,"ended");expect(f.clock).toHaveBeenLastCalledWith(60,true);await f.transport.dispose();
  });
  it("only enters fallback after confirmed native close; refuses close failure",async()=>{
    const f=fixture();const close=deferred<Awaited<ReturnType<ResidentAudioApi["close"]>>>();f.api.close.mockReturnValueOnce(close.promise);
    f.api.replace.mockRejectedValueOnce(new Error("source missing"));f.transport.update(f.intent);await flush();
    expect(f.views.some(v=>v.mode==="compatible")).toBe(false);
    close.resolve({ownerId:7,released:false,retainedStageFiles:1});await flush();expect(f.views.at(-1)?.mode).toBe("failed");
    f.transport.update({...f.intent,seekRevision:1});await flush();expect(f.api.open).toHaveBeenCalledTimes(1);
    await f.transport.dispose();
  });
  it("checks exact project, generation, duration, hash and no PCM staging",()=>{
    const f=fixture(),good=f.stage(0,1);expect(residentStageMatches(good,f.intent,1)).toBe(true);
    for(const bad of [{projectRevision:good.projectRevision+1},{generation:2},{frameCount:4_147_200_001},{planSha256:"bad"},{startFrame:48000},{sourceCount:4097},{peakActiveSources:17}])
      expect(residentStageMatches({...good,...bad},f.intent,1)).toBe(false);
  });
});
