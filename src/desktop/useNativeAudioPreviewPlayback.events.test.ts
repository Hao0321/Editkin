import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
const react=vi.hoisted(()=>({values:[] as any[],cursor:0,effectCursor:0,effects:[] as Array<{deps:unknown[];cleanup?:()=>void}>,pending:[] as Array<()=>void>}));
vi.mock("react",()=>({
  useState:(initial:unknown)=>{const index=react.cursor++;if(!(index in react.values))react.values[index]=initial;return[react.values[index],(value:any)=>{react.values[index]=typeof value==="function"?value(react.values[index]):value;}];},
  useRef:(current:unknown)=>{const index=react.cursor++;return react.values[index]??(react.values[index]={current});},
  useEffect:(effect:()=>void|(()=>void),deps:unknown[])=>{const index=react.effectCursor++,old=react.effects[index];if(old&&deps.length===old.deps.length&&deps.every((v,i)=>Object.is(v,old.deps[i])))return;react.pending.push(()=>{old?.cleanup?.();const cleanup=effect();react.effects[index]={deps,cleanup:typeof cleanup==="function"?cleanup:undefined};});},
}));
import {createDemoProject} from "../domain/demo";
import {useNativeAudioPreviewPlayback} from "./useNativeAudioPreviewPlayback";
import type {HaoDesktopApi,NativeAudioPreviewStartResult,NativeAudioPreviewStatus} from "./types";
import type {ResidentAudioApi,ResidentAudioStage,ResidentAudioStatus} from "./residentAudioTypes";
function deferred<T>(){let resolve!:(value:T)=>void;let reject!:(reason:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function fixture(push=true){
  const project=createDemoProject();
  const starts:Array<ReturnType<typeof deferred<NativeAudioPreviewStartResult>>&{onStatus?: (status:NativeAudioPreviewStatus)=>void;origin:number}>=[];
  const stop=vi.fn(async(_generation?:number)=>({active:false,stopped:true}));
  const status=vi.fn(async()=>({active:true,playback:{schema:"editkin.native-audio-preview-event/v1",event:"progress",timelineSeconds:0.5}} as NativeAudioPreviewStatus));
  const api={nativeAudioPreviewPushEvents:push,startNativeAudioPreview:vi.fn((_project:unknown,origin:number,onStatus?: (status:NativeAudioPreviewStatus)=>void)=>{
    const pending={...deferred<NativeAudioPreviewStartResult>(),onStatus,origin};starts.push(pending);return pending.promise;
  }),nativeAudioPreviewStatus:status,stopNativeAudioPreview:stop} as unknown as HaoDesktopApi;
  const options={api,project,layers:[],audioLayers:[],mediaRefs:{current:new Map()},playhead:0,projectDuration:5,projectFps:30,playing:true,seekRevision:undefined as number|undefined,externalVideoClock:false,
    onPlayingChange:vi.fn(),onPlayheadChange:vi.fn((time:number)=>{options.playhead=time;})};
  const render=()=>{react.cursor=0;react.effectCursor=0;react.pending=[];const result=useNativeAudioPreviewPlayback(options);for(const commit of react.pending)commit();return result;};
  const started=(index:number,generation=index+1)=>{
    const origin=starts[index].origin;
    const result:NativeAudioPreviewStartResult={native:true,generation,playback:{schema:"editkin.native-audio-preview-event/v1",event:"started",timelineStartSeconds:origin,timelineSeconds:origin},
      stage:{schema:"editkin.native-audio-preview-stage/v2",status:"GREEN",manifestBytes:100,manifestSha256:"a".repeat(64),projectId:project.id,projectRevision:project.revision,projectUpdatedAt:project.updatedAt,
        audioFingerprintSha256:"b".repeat(64),timelineStartSeconds:origin,durationSeconds:5-origin,sampleRate:48000,channels:2,clipCount:1,voiceClipCount:1,musicClipCount:0,sourceIds:["a"],sourcePcm:[{id:"a",clipId:"c",assetId:"a",role:"voice",bytes:100,sha256:"c".repeat(64),startFrame:0,gainDb:0,gainAutomation:[]}],decoderExecutor:"ffmpeg-source-decode/v1",decodeMode:"independent-source-pcm",mixExecutor:"hao-core-native-dag/v1",nativeGraphExecution:true,claimBoundary:"test"}};
    starts[index].resolve(result);
  };
  const send=(index:number,generation:number,time:number,event="progress",failed=false)=>starts[index].onStatus?.({generation,active:event!=="ended"&&!failed,failed,error:failed?"device lost":undefined,
    playback:{schema:event==="ended"?"editkin.native-audio-preview-receipt/v1":"editkin.native-audio-preview-event/v1",event:event as "progress",timelineStartSeconds:starts[index].origin,timelineSeconds:time}});
  return{options,starts,started,send,stop,status,render};
}
beforeEach(()=>{vi.useFakeTimers();react.values=[];react.effects=[];react.pending=[];react.cursor=0;react.effectCursor=0;vi.stubGlobal("window",{setTimeout,clearTimeout,queueMicrotask:(work:()=>void)=>{void Promise.resolve().then(work);}});vi.stubGlobal("requestAnimationFrame",vi.fn(()=>1));vi.stubGlobal("cancelAnimationFrame",vi.fn());});
afterEach(()=>{for(const effect of react.effects)effect.cleanup?.();vi.unstubAllGlobals();vi.useRealTimers();});
describe("native audio pushed lifecycle",()=>{
  it("activates retained audio only with a versioned native GPU clock; pause keeps the owner",async()=>{
    const f=fixture();f.options.seekRevision=0;
    let listener!:(value:ResidentAudioStatus)=>void;let generation=0;
    const api={capabilities:vi.fn(async()=>({schema:"editkin.desktop-audio-capabilities/v1" as const,supported:true,gpuClock:true,clockSchema:"editkin.resident-audio-clock/v1" as const,sampleRate:48000 as const})),
      open:vi.fn(async(cb:typeof listener)=>{listener=cb;return{ownerId:7,status:{} as ResidentAudioStatus};}),
      replace:vi.fn(async(_owner:number,project:typeof f.options.project,start:number)=>{
        const gen=++generation;const stage:ResidentAudioStage={schema:"editkin.native-audio-project-stage/v1",status:"PREPARED",projectId:project.id,projectRevision:project.revision,
          projectUpdatedAt:project.updatedAt,generation:gen,planSha256:"a".repeat(64),audioFingerprintSha256:"b".repeat(64),planBytes:200,startFrame:start*48000,frameCount:(5-start)*48000,sourceCount:1,peakActiveSources:1,pcmStagingFiles:0};
        listener({schema:"editkin.desktop-audio-status/v1",ownerId:7,generation:gen,sequence:gen*10,ready:true,failed:false,closing:false,
          playback:{schema:"editkin.native-audio-session-event/v1",event:"prepared",state:"paused",streamGeneration:gen,sampleMasterRate:48000,timelineStartFrame:start*48000,timelineFrame:start*48000,presentedFrame:0,sampleMasterFrame:960}});
        return{ownerId:7,generation:gen,stage};}),
      control:vi.fn(async()=>({ownerId:7,requestId:1,accepted:true as const})),close:vi.fn(async()=>({ownerId:7,released:true,retainedStageFiles:0}))} satisfies ResidentAudioApi;
    f.options.api.residentAudio=api;f.render();expect(f.starts).toHaveLength(0);await flush();f.render();await flush();
    expect(f.render()).toMatchObject({mode:"native",ownerId:7,generation:1,transportSeekRevision:0});
    f.options.playing=false;f.render();await flush();f.options.playing=true;f.render();await flush();
    expect(api.open).toHaveBeenCalledTimes(1);expect(api.replace).toHaveBeenCalledTimes(1);expect(api.close).not.toHaveBeenCalled();
    f.options.playhead=3;f.options.seekRevision=1;
    expect(f.render().mode).toBe("starting");await flush();expect(f.render()).toMatchObject({mode:"native",generation:2,transportSeekRevision:1,stage:{startFrame:144000}});
    expect(api.replace.mock.calls.map(call=>call[2])).toEqual([0,3]);
    expect(f.starts).toHaveLength(0);
    for(const effect of react.effects)effect.cleanup?.();react.effects=[];await flush();expect(api.close).toHaveBeenCalledTimes(1);
  });
  it("does not activate resident audio when the desktop has not connected its GPU clock",async()=>{
    const f=fixture();const open=vi.fn();f.options.api.residentAudio={capabilities:async()=>({schema:"editkin.desktop-audio-capabilities/v1",supported:true,gpuClock:false,sampleRate:48000}),open} as unknown as ResidentAudioApi;
    f.render();expect(f.starts).toHaveLength(0);await flush();f.render();expect(f.starts).toHaveLength(1);expect(open).not.toHaveBeenCalled();
    f.started(0);await flush();
  });
  it("does not restart audio for native video clock updates, but restarts once for an explicit seek",async()=>{
    const f=fixture();f.options.seekRevision=0;f.render();f.started(0);await flush();
    expect(f.render().transportSeekRevision).toBe(0);expect(f.render().generation).toBe(1);
    f.options.externalVideoClock=true;f.render();f.options.onPlayheadChange.mockClear();
    for(let i=1;i<20;i++){f.options.playhead=i/10;f.render();f.send(0,1,i/10);await flush();}
    expect(f.starts).toHaveLength(1);expect(f.options.onPlayheadChange).not.toHaveBeenCalled();
    f.options.seekRevision=1;f.options.playhead=3;f.render();await flush();expect(f.starts).toHaveLength(2);expect(f.starts[1].origin).toBe(3);
    f.started(1,2);await flush();expect(f.render().transportSeekRevision).toBe(1);expect(f.render().generation).toBe(2);
    f.send(0,1,5,"ended");await flush();expect(f.options.onPlayingChange).not.toHaveBeenCalled();
  });
  it("silent projects stop JavaScript animation-frame clocks while native video owns progress",async()=>{
    const f=fixture();f.options.project.tracks.forEach(track=>{track.muted=true;});f.options.seekRevision=0;f.options.externalVideoClock=true;
    f.render();await flush();f.render();expect(requestAnimationFrame).not.toHaveBeenCalled();
    f.options.externalVideoClock=false;f.render();expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
  });
  it("uses pushed clocks without any status polling and stops only its generation",async()=>{
    const f=fixture();f.render();f.started(0);await flush();
    f.send(0,99,2);await flush();expect(f.options.onPlayheadChange).not.toHaveBeenCalledWith(2);
    f.send(0,1,0.8);await flush();expect(f.options.onPlayheadChange).toHaveBeenLastCalledWith(0.8);
    await vi.advanceTimersByTimeAsync(1000);expect(f.status).not.toHaveBeenCalled();
    f.send(0,1,5,"ended");await flush();expect(f.options.onPlayingChange).toHaveBeenLastCalledWith(false);expect(f.stop).toHaveBeenCalledWith(1);
  });
  it("late completion after pause cannot issue an unscoped stop against newer playback",async()=>{
    const f=fixture();f.render();f.options.playing=false;f.render();f.options.playing=true;f.render();
    f.started(1,2);await flush();f.started(0,1);await flush();
    expect(f.stop.mock.calls).toEqual([[1]]);f.send(0,1,4);f.send(1,2,1);await flush();expect(f.options.onPlayheadChange).toHaveBeenLastCalledWith(1);
  });
  it("buffers an early terminal event until start identity is available",async()=>{
    const f=fixture();f.render();f.send(0,1,5,"ended");f.started(0);await flush();expect(f.stop).toHaveBeenCalledWith(1);expect(f.options.onPlayingChange).toHaveBeenCalledWith(false);
  });
  it("restarts each ended window once and ignores the retired stream",async()=>{
    const f=fixture();f.render();f.started(0);await flush();f.send(0,1,2,"ended");f.send(0,1,2,"ended");await flush();expect(f.starts).toHaveLength(2);
    f.started(1);await flush();f.send(0,1,4);await flush();expect(f.options.onPlayheadChange).toHaveBeenLastCalledWith(2);
    f.options.playing=false;f.render();await flush();expect(f.stop).toHaveBeenLastCalledWith(2);
  });
  it("device failure stops its own generation and enters visible compatible mode",async()=>{
    const f=fixture();f.render();f.started(0);await flush();f.send(0,1,1,"progress",true);await flush();const state=f.render();expect(state.mode).toBe("compatible");expect(state.error).toBe("device lost");expect(f.stop).toHaveBeenCalledWith(1);
  });
  it("keeps the non-event legacy adapter explicit",async()=>{
    const f=fixture(false);f.render();f.started(0);await flush();expect(f.starts[0].onStatus).toBeUndefined();await vi.advanceTimersByTimeAsync(25);expect(f.status).toHaveBeenCalledTimes(1);
  });
  it.each([true,false])("recovers when a next-window start fails (push=%s)",async(push)=>{
    const f=fixture(push);f.render();f.started(0);await flush();
    if(push)f.send(0,1,2,"ended");
    else {
      f.status.mockResolvedValueOnce({active:false,playback:{schema:"editkin.native-audio-preview-receipt/v1",event:"ended",timelineSeconds:2}} as NativeAudioPreviewStatus);
      await vi.advanceTimersByTimeAsync(24);
    }
    await flush();expect(f.starts).toHaveLength(2);
    f.starts[1].reject(new Error("next window failed"));await flush();
    const state=f.render();expect(state.mode).toBe("compatible");expect(state.error).toBe("next window failed");
    expect(f.stop.mock.calls.every(([generation])=>generation!==undefined)).toBe(true);
  });
  it("unmount rejects late events and stops only the returned generation",async()=>{
    const f=fixture();f.render();
    for(const effect of react.effects)effect.cleanup?.();react.effects=[];
    f.started(0,7);await flush();f.send(0,7,4);await flush();
    expect(f.stop.mock.calls).toEqual([[7]]);expect(f.options.onPlayheadChange).not.toHaveBeenCalled();
  });
});
