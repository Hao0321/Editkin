import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
// Controlled effect/await harness. This is not React DOM or installed navigation evidence.
const hooks=vi.hoisted(()=>({values:[] as any[],cursor:0,effectCursor:0,effects:[] as Array<{deps:unknown[];run:()=>void|(()=>void);cleanup?:()=>void}>,pending:[] as Array<()=>void>,writes:[] as unknown[]}));
vi.mock("react",()=>({
  useState:(initial:unknown)=>{const index=hooks.cursor++;if(!(index in hooks.values))hooks.values[index]=initial;return[hooks.values[index],(value:unknown)=>{hooks.values[index]=value;hooks.writes.push(value);}];},
  useRef:(current:unknown)=>{const index=hooks.cursor++;return hooks.values[index]??(hooks.values[index]={current});},
  useMemo:(build:()=>unknown,deps:unknown[])=>{const index=hooks.cursor++,old=hooks.values[index];if(!old||deps.some((value,i)=>!Object.is(value,old.deps[i])))hooks.values[index]={deps,value:build()};return hooks.values[index].value;},
  useEffect:(run:()=>void|(()=>void),deps:unknown[])=>{const index=hooks.effectCursor++,old=hooks.effects[index];if(old&&deps.length===old.deps.length&&deps.every((v,i)=>Object.is(v,old.deps[i])))return;hooks.pending.push(()=>{old?.cleanup?.();const cleanup=run();hooks.effects[index]={deps,run,cleanup:typeof cleanup==="function"?cleanup:undefined};});},
}));
import {createDemoProject} from "../domain/demo";
import {useResidentGpuPreview} from "./useResidentGpuPreview";
import type {ResidentGpuTransport,NativePreviewBounds} from "./useResidentGpuPreview";
import * as presenter from "./residentGpuEngineVideoPresenter";
import type {NativeGpuPlaybackEvent} from "./gpuPreviewApiTypes";
import type {GpuPreviewApi,GpuPreviewOwner} from "./gpuPreviewApiTypes";
import type {EngineRenderGraph} from "../render/engineGraph";
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return{promise,resolve};};
const flush=async()=>{for(let i=0;i<60;i++)await Promise.resolve();};
function fakeOwner(id:string,delayedLoad?:Promise<unknown>):GpuPreviewOwner {
  const api={
    loadGpuEnginePreviewSession:vi.fn(async(_id:string,graph:EngineRenderGraph)=>delayedLoad??{engineGraph:{directExecution:true,blockedNodeIds:[],ignoredNodeIds:[],executedNodeIds:graph.nodes.map(node=>node.id)}}),
    updateGpuEnginePreviewFrame:vi.fn(async()=>({})),
    renderGpuPreviewFrame:vi.fn(async()=>({outputUrl:`${id}.png`,receipt:{}})),
    releaseGpuPreviewSession:vi.fn(async()=>({released:true})),
    releaseGpuPreviewSurface:vi.fn(async()=>({released:true})),
    recoverGpuDevice:vi.fn(async()=>({})),
  } as unknown as GpuPreviewApi;
  return{sessions:{image:`${id}-image`,video:`${id}-video`,engineVideo:`${id}-engine-video`},desktop:api,release:vi.fn(async()=>{})};
}
function fixture(){
  const project=createDemoProject();project.assets[0].kind="image";project.assets[0].uri="C:/fixture/source.png";project.tracks[0].clips[0].volume=0;
  const owners:Array<GpuPreviewOwner|Promise<GpuPreviewOwner>>=[];let calls=0;
  const caps=fakeOwner("caps").desktop;
  const create=vi.fn(()=>Promise.resolve(owners[calls++]));
  vi.stubGlobal("window",{haoDesktop:{...caps,createGpuPreviewOwner:create}});
  const state={project,enabled:true,time:0,bounds:undefined as NativePreviewBounds|undefined,transport:undefined as ResidentGpuTransport|undefined};
  const render=()=>{hooks.cursor=0;hooks.effectCursor=0;hooks.pending=[];const result=useResidentGpuPreview(state.project,state.time,state.enabled,state.bounds,state.transport);for(const run of hooks.pending)run();return result;};
  return{state,owners,create,render};
}
const unmount=()=>{for(const effect of hooks.effects){effect.cleanup?.();effect.cleanup=undefined;}};
beforeEach(()=>{hooks.values=[];hooks.effects=[];hooks.pending=[];hooks.writes=[];hooks.cursor=0;hooks.effectCursor=0;});
afterEach(async()=>{unmount();await flush();vi.unstubAllGlobals();vi.restoreAllMocks();});
describe("production GPU hook ownership across async lifetimes",()=>{
  it("renders the current image and reuses its owner over playhead-only changes",async()=>{
    const f=fixture(),current=fakeOwner("current");f.owners.push(current);f.render();await flush();
    expect(f.render().frameUrl).toBe("current.png");expect(current.desktop.loadGpuEnginePreviewSession).toHaveBeenCalledTimes(1);
    f.state.time=.1;f.render();await flush();expect(f.create).toHaveBeenCalledTimes(1);expect(current.desktop.updateGpuEnginePreviewFrame).toHaveBeenCalledTimes(1);
  });
  it("project replacement during load cannot publish, recover or release the new project's surface",async()=>{
    const f=fixture(),load=deferred<unknown>(),old=fakeOwner("old",load.promise),current=fakeOwner("new");f.owners.push(old,current);f.render();await flush();
    expect(old.desktop.loadGpuEnginePreviewSession).toHaveBeenCalledTimes(1);
    f.state.project={...f.state.project,id:"different",revision:f.state.project.revision+1};f.render();await flush();expect(f.render().frameUrl).toBe("new.png");
    const writes=hooks.writes.length;load.resolve({});await flush();
    expect(hooks.writes).toHaveLength(writes);expect(old.desktop.renderGpuPreviewFrame).not.toHaveBeenCalled();expect(old.desktop.recoverGpuDevice).not.toHaveBeenCalled();
    expect(old.release).toHaveBeenCalledTimes(1);expect(current.release).not.toHaveBeenCalled();expect(f.render().frameUrl).toBe("new.png");
  });
  it("late acquisition after unmount is released without starting a native load",async()=>{
    const f=fixture(),pending=deferred<GpuPreviewOwner>(),old=fakeOwner("old");f.owners.push(pending.promise);f.render();unmount();const writes=hooks.writes.length;
    pending.resolve(old);await flush();expect(old.release).toHaveBeenCalledTimes(1);expect(old.desktop.loadGpuEnginePreviewSession).not.toHaveBeenCalled();expect(hooks.writes).toHaveLength(writes);
  });
  it("disable/re-enable creates a fresh owner and never reuses the disposed cohort",async()=>{
    const f=fixture(),old=fakeOwner("old"),current=fakeOwner("new");f.owners.push(old,current);f.render();await flush();f.state.enabled=false;f.render();await flush();
    expect(old.release).toHaveBeenCalledTimes(1);f.state.enabled=true;f.render();await flush();expect(f.create).toHaveBeenCalledTimes(2);expect(f.render().frameUrl).toBe("new.png");
  });
  it("effect cleanup/setup replay allocates a new owner (StrictMode-shaped control)",async()=>{
    const f=fixture(),pending=deferred<GpuPreviewOwner>(),old=fakeOwner("old"),current=fakeOwner("new");f.owners.push(pending.promise,current);f.render();
    unmount();for(const effect of hooks.effects){const cleanup=effect.run();effect.cleanup=typeof cleanup==="function"?cleanup:undefined;}await flush();
    pending.resolve(old);await flush();expect(old.release).toHaveBeenCalledTimes(1);expect(old.desktop.loadGpuEnginePreviewSession).not.toHaveBeenCalled();expect(f.render().frameUrl).toBe("new.png");
  });
});

function nativeVideoFixture(prepare?:Promise<void>){
  const f=fixture();f.state.project.assets[0].kind="video";f.state.project.assets[0].uri="C:/fixture/source.mp4";
  f.state.project.assets[0].width=1920;f.state.project.assets[0].height=1080;
  f.state.bounds={x:0,y:0,width:960,height:540,revision:1};
  f.state.transport={playing:true,duration:5,seekRevision:0,onClock:vi.fn(time=>{f.state.time=time;}),onEnded:vi.fn()};
  let emit!:(event:NativeGpuPlaybackEvent)=>void|Promise<void>;let generation=0;
  const owner=fakeOwner("native");
  Object.assign(owner.desktop,{
    loadGpuEngineVideoPreviewSession:vi.fn(),presentGpuEngineVideoPreviewFrame:vi.fn(),releaseGpuEngineVideoPreviewSession:vi.fn(async()=>({})),bindGpuPreviewSurface:vi.fn(),
    startGpuPreviewPlayback:vi.fn(async(sessionId:string,_range:unknown,receive:typeof emit)=>{emit=receive;return {generation:++generation,sessionId,state:"playing"} as NativeGpuPlaybackEvent;}),
    stopGpuPreviewPlayback:vi.fn(async()=>({stopped:true})),inspectGpuPreviewPlayback:vi.fn(),
  });
  Object.assign(window.haoDesktop!,owner.desktop);f.owners.push(owner);
  const prepareFrame=vi.spyOn(presenter,"presentResidentEngineVideo").mockImplementation(async context=>{
    if(prepare)await prepare;
    if(context.next.token===context.tokenRef.current){context.setNativeSurfaceActive(true);context.setFallbackReason(undefined);}
  });
  const send=async(frame:number,state:NativeGpuPlaybackEvent["state"]="playing")=>{await emit({schema:"editkin.native-preview-playback/v1",owner:"native",sessionId:"native-engine-video",generation,
    state,timelineFrame:frame,timelineSeconds:frame/30,presentedFrames:0,droppedFrames:0,sequence:frame+1,clock:"native-monotonic",reason:state==="failed"?"device lost":undefined});};
  return {...f,owner,prepareFrame,send};
}
describe("production GPU hook autonomous intent routing (mock native boundary)",()=>{
  it("loads once, then native clock changes enqueue neither frame presentation nor repeated start",async()=>{
    const f=nativeVideoFixture();f.render();await flush();expect(f.render().admission).toBe("engine-video-native");
    expect(f.owner.desktop.startGpuPreviewPlayback).toHaveBeenCalledTimes(1);expect(f.render().autonomousPlayback).toBe(true);
    for(let frame=1;frame<120;frame+=3){await f.send(frame);f.render();await flush();}
    expect(f.prepareFrame).toHaveBeenCalledTimes(1);expect(f.owner.desktop.startGpuPreviewPlayback).toHaveBeenCalledTimes(1);
    expect(f.state.time).toBe(118/30);
  });
  it("pause, seek and bounds changes stop exact generations; resume uses the requested frame",async()=>{
    const f=nativeVideoFixture();f.render();await flush();f.state.transport!.playing=false;f.render();await flush();
    expect(f.owner.desktop.stopGpuPreviewPlayback).toHaveBeenCalledWith(1);expect(f.render().autonomousPlayback).toBe(false);
    f.state.time=2;f.state.transport!.seekRevision++;f.state.transport!.playing=true;f.render();await flush();
    expect(f.owner.desktop.startGpuPreviewPlayback).toHaveBeenLastCalledWith("native-engine-video",{startFrame:60,endFrame:150,audioGeneration:undefined},expect.any(Function));
    f.state.bounds={...f.state.bounds!,x:20,revision:2};f.render();await flush();
    expect(f.owner.desktop.stopGpuPreviewPlayback).toHaveBeenCalledWith(2);expect(f.owner.desktop.startGpuPreviewPlayback).toHaveBeenCalledTimes(3);
  });
  it("native playback selects the current frame rather than rounding ahead of its audio clock",async()=>{
    const f=nativeVideoFixture();f.state.time=.05;f.render();await flush();
    expect(f.prepareFrame.mock.calls[0][0].next.preview.timelineFrame).toBe(1);
    expect(f.owner.desktop.startGpuPreviewPlayback).toHaveBeenLastCalledWith("native-engine-video",expect.objectContaining({startFrame:1}),expect.any(Function));
  });
  it("pause uses native's frozen frame, while an explicit seek supersedes a delayed pause result",async()=>{
    const f=nativeVideoFixture();vi.spyOn(presenter,"validateResidentEngineVideoFrame").mockImplementation(()=>{});
    f.render();await flush();const paused=deferred<any>();vi.mocked(f.owner.desktop.inspectGpuPreviewPlayback!).mockReturnValueOnce(paused.promise);
    f.state.transport!.playing=false;f.render();await flush();
    paused.resolve({generation:1,sessionId:"native-engine-video",state:"stopped",timelineFrame:12,frameReceipt:{sessionId:"native-engine-video",timelineFrame:12}});await flush();
    expect(f.state.time).toBe(.4);expect(f.prepareFrame.mock.calls.at(-1)![0].next.preview.timelineFrame).toBe(12);
    f.state.transport!.playing=true;f.render();await flush();const delayed=deferred<any>();vi.mocked(f.owner.desktop.inspectGpuPreviewPlayback!).mockReturnValueOnce(delayed.promise);
    f.state.transport!.playing=false;f.render();await flush();f.state.time=3;f.state.transport!.seekRevision++;f.render();
    delayed.resolve({generation:2,sessionId:"native-engine-video",state:"stopped",timelineFrame:20,frameReceipt:{sessionId:"native-engine-video",timelineFrame:20}});await flush();
    expect(f.state.time).toBe(3);expect(f.prepareFrame.mock.calls.at(-1)![0].next.preview.timelineFrame).toBe(90);
  });
  it("pending first-frame preparation holds the clock but pause prevents a late producer",async()=>{
    const delayed=deferred<void>(),f=nativeVideoFixture(delayed.promise);f.render();await flush();expect(f.render().nativePlaybackPreparing).toBe(true);
    f.state.time=.1;f.render();await flush();expect(f.prepareFrame).toHaveBeenCalledTimes(1);
    f.state.transport!.playing=false;f.render();delayed.resolve();await flush();
    expect(f.owner.desktop.startGpuPreviewPlayback).not.toHaveBeenCalled();expect(f.render().nativePlaybackPreparing).toBe(false);
  });
  it("native audio must match both project and explicit seek; window replacement changes the exact generation",async()=>{
    const f=nativeVideoFixture();f.state.project.tracks[0].clips[0].volume=1;
    f.state.transport!.audio={mode:"native",generation:8,seekRevision:99,projectId:f.state.project.id,projectRevision:f.state.project.revision,projectUpdatedAt:f.state.project.updatedAt};
    f.render();await flush();expect(f.owner.desktop.startGpuPreviewPlayback).not.toHaveBeenCalled();
    f.state.transport!.audio={...f.state.transport!.audio!,seekRevision:0};f.render();await flush();
    expect(f.owner.desktop.startGpuPreviewPlayback).toHaveBeenLastCalledWith("native-engine-video",expect.objectContaining({audioGeneration:8}),expect.any(Function));
    f.state.transport!.audio={...f.state.transport!.audio!,generation:9};f.render();await flush();
    expect(f.owner.desktop.startGpuPreviewPlayback).toHaveBeenLastCalledWith("native-engine-video",expect.objectContaining({audioGeneration:9}),expect.any(Function));
    expect(f.owner.desktop.startGpuPreviewPlayback).toHaveBeenCalledTimes(2);
  });
  it("a native failure falls back without repeatedly starting the same failed intent",async()=>{
    const f=nativeVideoFixture();f.render();await flush();await f.send(4,"failed");await flush();
    for(const time of [.3,.6,.9]){f.state.time=time;f.render();await flush();}
    expect(f.owner.desktop.startGpuPreviewPlayback).toHaveBeenCalledTimes(1);expect(f.render().autonomousPlayback).toBe(false);
    expect(f.prepareFrame.mock.calls.length).toBeGreaterThan(1);
  });
  it("binds resident owner plus stream generation, including a new owner reusing generation one",async()=>{
    const f=nativeVideoFixture();f.state.project.tracks[0].clips[0].volume=1;
    f.state.transport!.audio={mode:"native",ownerId:21,generation:1,seekRevision:0,projectId:f.state.project.id,projectRevision:f.state.project.revision,projectUpdatedAt:f.state.project.updatedAt};
    f.render();await flush();expect(f.owner.desktop.startGpuPreviewPlayback).toHaveBeenLastCalledWith("native-engine-video",expect.objectContaining({audioGeneration:1,audioOwnerId:21}),expect.any(Function));
    f.state.transport!.audio={...f.state.transport!.audio,ownerId:22};f.render();await flush();
    expect(f.owner.desktop.startGpuPreviewPlayback).toHaveBeenLastCalledWith("native-engine-video",expect.objectContaining({audioGeneration:1,audioOwnerId:22}),expect.any(Function));
    expect(f.owner.desktop.startGpuPreviewPlayback).toHaveBeenCalledTimes(2);
  });
});
