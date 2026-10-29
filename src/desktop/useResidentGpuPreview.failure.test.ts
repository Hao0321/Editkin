import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
// Controlled effect/await harness (same shape as the lifecycle suite). This is not
// React DOM or installed-build evidence; it checks the hook's failure surface.
const hooks=vi.hoisted(()=>({values:[] as any[],cursor:0,effectCursor:0,effects:[] as Array<{deps:unknown[];cleanup?:()=>void}>,pending:[] as Array<()=>void>}));
vi.mock("react",()=>({
  useState:(initial:unknown)=>{const index=hooks.cursor++;if(!(index in hooks.values))hooks.values[index]=initial;return[hooks.values[index],(value:unknown)=>{hooks.values[index]=value;}];},
  useRef:(current:unknown)=>{const index=hooks.cursor++;return hooks.values[index]??(hooks.values[index]={current});},
  useMemo:(build:()=>unknown,deps:unknown[])=>{const index=hooks.cursor++,old=hooks.values[index];if(!old||deps.some((value,i)=>!Object.is(value,old.deps[i])))hooks.values[index]={deps,value:build()};return hooks.values[index].value;},
  useEffect:(run:()=>void|(()=>void),deps:unknown[])=>{const index=hooks.effectCursor++,old=hooks.effects[index];if(old&&deps.length===old.deps.length&&deps.every((v,i)=>Object.is(v,old.deps[i])))return;hooks.pending.push(()=>{old?.cleanup?.();const cleanup=run();hooks.effects[index]={deps,cleanup:typeof cleanup==="function"?cleanup:undefined};});},
}));
import {createDemoProject} from "../domain/demo";
import {useResidentGpuPreview} from "./useResidentGpuPreview";
import type {ResidentGpuTransport,NativePreviewBounds} from "./useResidentGpuPreview";
import * as presenter from "./residentGpuEngineVideoPresenter";
import type {GpuPreviewApi,GpuPreviewOwner,NativeGpuPlaybackEvent} from "./gpuPreviewApiTypes";
import type {EngineRenderGraph} from "../render/engineGraph";
import {currentPlaybackNotices} from "../ui/playbackNoticeStore";
const flush=async()=>{for(let i=0;i<60;i++)await Promise.resolve();};
const notice=()=>currentPlaybackNotices().find(item=>item.key==="gpu-preview");
function fakeOwner(id:string):GpuPreviewOwner {
  const api={
    loadGpuEnginePreviewSession:vi.fn(async(_id:string,graph:EngineRenderGraph)=>({engineGraph:{directExecution:true,blockedNodeIds:[],ignoredNodeIds:[],executedNodeIds:graph.nodes.map(node=>node.id)}})),
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
  const owners:Array<()=>Promise<GpuPreviewOwner>>=[];let calls=0;
  const create=vi.fn(()=>owners[calls++]());
  vi.stubGlobal("window",{haoDesktop:{...fakeOwner("caps").desktop,createGpuPreviewOwner:create}});
  const state={project,enabled:true,time:0,bounds:undefined as NativePreviewBounds|undefined,transport:undefined as ResidentGpuTransport|undefined};
  const render=()=>{hooks.cursor=0;hooks.effectCursor=0;hooks.pending=[];const result=useResidentGpuPreview(state.project,state.time,state.enabled,state.bounds,state.transport);for(const run of hooks.pending)run();return result;};
  return{state,owners,create,render};
}
beforeEach(()=>{hooks.values=[];hooks.effects=[];hooks.pending=[];hooks.cursor=0;hooks.effectCursor=0;vi.spyOn(console,"warn").mockImplementation(()=>{});});
afterEach(async()=>{for(const effect of hooks.effects)effect.cleanup?.();await flush();vi.unstubAllGlobals();vi.restoreAllMocks();});
describe("GPU preview failures are visible and retryable (U03)",()=>{
  it("an owner-creation failure is shown with a retry that admits a fresh owner",async()=>{
    const f=fixture();f.owners.push(()=>Promise.reject(new Error("GPU 預覽持有者建立失敗")),async()=>fakeOwner("fresh"));
    f.render();await flush();let state=f.render();
    expect(state).toMatchObject({admission:"compatible",failure:"GPU 預覽持有者建立失敗"});
    // No GPU picture is left, so the notice says the preview moved to 相容預覽.
    expect(notice()).toMatchObject({kind:"gpu",step:"fallback",detail:"GPU 預覽持有者建立失敗"});
    // A seek reuses the cached rejected owner; only the retry creates a new one.
    f.state.time=.1;f.render();await flush();expect(f.create).toHaveBeenCalledTimes(1);expect(f.render().failure).toBe("GPU 預覽持有者建立失敗");
    notice()!.retry!();f.render();await flush();state=f.render();
    expect(f.create).toHaveBeenCalledTimes(2);expect(state.frameUrl).toBe("fresh.png");expect(state.failure).toBeUndefined();expect(notice()).toBeUndefined();
  });
  it("an engine load failure (no device recovery left) is shown and the retry reloads the graph",async()=>{
    const f=fixture(),failing=fakeOwner("failing"),fresh=fakeOwner("fresh");
    vi.mocked(failing.desktop.loadGpuEnginePreviewSession!).mockRejectedValue(new Error("共同 Engine Graph 沒有完整進入 native GPU executor"));
    delete failing.desktop.recoverGpuDevice;f.owners.push(async()=>failing,async()=>fresh);
    f.render();await flush();
    expect(f.render()).toMatchObject({admission:"compatible",failure:"共同 Engine Graph 沒有完整進入 native GPU executor"});
    expect(notice()?.kind).toBe("gpu");
    f.render().retry();f.render();await flush();
    expect(fresh.desktop.loadGpuEnginePreviewSession).toHaveBeenCalledTimes(1);expect(f.render()).toMatchObject({frameUrl:"fresh.png",failure:undefined});
    expect(failing.release).toHaveBeenCalledTimes(1);expect(notice()).toBeUndefined();
  });
  it("an autonomous playback error is visible during GPU 直出 and the retry restarts native playback",async()=>{
    const f=fixture();f.state.project.assets[0].kind="video";f.state.project.assets[0].uri="C:/fixture/source.mp4";
    f.state.project.assets[0].width=1920;f.state.project.assets[0].height=1080;
    f.state.bounds={x:0,y:0,width:960,height:540,revision:1};
    f.state.transport={playing:true,duration:5,seekRevision:0,onClock:vi.fn(),onEnded:vi.fn()};
    let emit!:(event:NativeGpuPlaybackEvent)=>void|Promise<void>;let generation=0;
    const owner=fakeOwner("native");
    Object.assign(owner.desktop,{
      loadGpuEngineVideoPreviewSession:vi.fn(),presentGpuEngineVideoPreviewFrame:vi.fn(),releaseGpuEngineVideoPreviewSession:vi.fn(async()=>({})),bindGpuPreviewSurface:vi.fn(),
      startGpuPreviewPlayback:vi.fn(async(sessionId:string,_range:unknown,receive:typeof emit)=>{emit=receive;return {generation:++generation,sessionId,state:"playing"} as NativeGpuPlaybackEvent;}),
      stopGpuPreviewPlayback:vi.fn(async()=>({stopped:true})),inspectGpuPreviewPlayback:vi.fn(),
    });
    Object.assign(window.haoDesktop!,owner.desktop);f.owners.push(async()=>owner,async()=>owner);
    vi.spyOn(presenter,"presentResidentEngineVideo").mockImplementation(async context=>{
      if(context.next.token===context.tokenRef.current){context.setNativeSurfaceActive(true);context.setFallbackReason(undefined);}
      return {motionGraphicIds:[],captionIds:[]};
    });
    f.render();await flush();expect(f.render().admission).toBe("engine-video-native");expect(owner.desktop.startGpuPreviewPlayback).toHaveBeenCalledTimes(1);
    await emit({schema:"editkin.native-preview-playback/v1",owner:"native",sessionId:"native-engine-video",generation,state:"failed",timelineFrame:4,
      timelineSeconds:4/30,presentedFrames:0,droppedFrames:0,sequence:5,clock:"native-monotonic",reason:"device lost"});await flush();
    expect(f.render()).toMatchObject({admission:"engine-video-native",failure:"device lost",autonomousPlayback:false});
    // GPU 直出 still shows the picture; only its own playback stopped.
    expect(notice()).toMatchObject({kind:"gpu",step:"playback",detail:"device lost"});
    notice()!.retry!();f.render();await flush();
    expect(owner.desktop.startGpuPreviewPlayback).toHaveBeenCalledTimes(2);expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.render()).toMatchObject({failure:undefined,autonomousPlayback:true});expect(notice()).toBeUndefined();
  });
  it("a retry whose fresh owner fails leaves no empty GPU 直出 slot: the picture moves to 相容預覽",async()=>{
    const f=fixture();f.state.project.assets[0].kind="video";f.state.project.assets[0].uri="C:/fixture/source.mp4";
    f.state.project.assets[0].width=1920;f.state.project.assets[0].height=1080;
    f.state.bounds={x:0,y:0,width:960,height:540,revision:1};
    f.state.transport={playing:true,duration:5,seekRevision:0,onClock:vi.fn(),onEnded:vi.fn()};
    let emit!:(event:NativeGpuPlaybackEvent)=>void|Promise<void>;let generation=0;
    const owner=fakeOwner("native");
    Object.assign(owner.desktop,{
      loadGpuEngineVideoPreviewSession:vi.fn(),presentGpuEngineVideoPreviewFrame:vi.fn(),releaseGpuEngineVideoPreviewSession:vi.fn(async()=>({})),bindGpuPreviewSurface:vi.fn(),
      startGpuPreviewPlayback:vi.fn(async(sessionId:string,_range:unknown,receive:typeof emit)=>{emit=receive;return {generation:++generation,sessionId,state:"playing"} as NativeGpuPlaybackEvent;}),
      stopGpuPreviewPlayback:vi.fn(async()=>({stopped:true})),inspectGpuPreviewPlayback:vi.fn(),
    });
    Object.assign(window.haoDesktop!,owner.desktop);f.owners.push(async()=>owner,()=>Promise.reject(new Error("GPU 預覽持有者建立失敗")));
    vi.spyOn(presenter,"presentResidentEngineVideo").mockImplementation(async context=>{
      if(context.next.token===context.tokenRef.current){context.setNativeSurfaceActive(true);context.setFallbackReason(undefined);}
      return {motionGraphicIds:[],captionIds:[]};
    });
    f.render();await flush();expect(f.render()).toMatchObject({admission:"engine-video-native",nativeSurfaceActive:true,fullComposition:true});
    await emit({schema:"editkin.native-preview-playback/v1",owner:"native",sessionId:"native-engine-video",generation,state:"failed",timelineFrame:4,
      timelineSeconds:4/30,presentedFrames:0,droppedFrames:0,sequence:5,clock:"native-monotonic",reason:"device lost"});await flush();
    expect(f.render()).toMatchObject({nativeSurfaceActive:true,failure:"device lost"});expect(notice()).toMatchObject({kind:"gpu",step:"playback"});
    // The retry releases the only presenting owner; its replacement never starts.
    notice()!.retry!();f.render();await flush();
    expect(owner.release).toHaveBeenCalledTimes(1);expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.render()).toMatchObject({admission:"compatible",nativeSurfaceActive:false,fullComposition:false,frameUrl:undefined,
      failure:"GPU 預覽持有者建立失敗",autonomousPlayback:false,nativePlaybackPreparing:false,presentedTimelineFrame:undefined,bakedMotionGraphicIds:[],bakedCaptionIds:[]});
    // Nothing presents any more, so the notice says the preview moved to 相容預覽.
    expect(notice()).toMatchObject({kind:"gpu",step:"fallback",detail:"GPU 預覽持有者建立失敗"});
  });
});
