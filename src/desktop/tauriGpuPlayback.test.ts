import {afterEach,describe,expect,it,vi} from "vitest";
import type {NativeGpuPlaybackEvent} from "./gpuPreviewApiTypes";
const ipc=vi.hoisted(()=>({invoke:vi.fn(async(_command:string,_args?:unknown):Promise<unknown>=>({}))}));
vi.mock("@tauri-apps/api/core",()=>({invoke:ipc.invoke,convertFileSrc:(path:string)=>path,Channel:class{onmessage?:unknown}}));
import {createTauriGpuPreviewApi,validNativeGpuPlaybackEvent} from "./tauriGpuPreview";
const owner="gpu-owner-42-7",session=owner+"-engine-video";
const event=(patch:Partial<NativeGpuPlaybackEvent>={}):NativeGpuPlaybackEvent=>({schema:"editkin.native-preview-playback/v1",owner,generation:1,sessionId:session,state:"playing",timelineFrame:0,timelineSeconds:0,presentedFrames:0,droppedFrames:0,sequence:0,clock:"native-monotonic",...patch});
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return{promise,resolve};};
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
function startChannel(){return (ipc.invoke.mock.calls.find(([name])=>name==="start_gpu_preview_playback")![1] as {onEvent:{onmessage:(event:NativeGpuPlaybackEvent)=>void}}).onEvent;}
afterEach(()=>{ipc.invoke.mockReset();vi.restoreAllMocks();});
describe("native playback bridge",()=>{
  it("buffers an early event, then acknowledges only after the consumer finishes",async()=>{
    const start=deferred<NativeGpuPlaybackEvent>(),consumer=deferred<void>();
    ipc.invoke.mockImplementation(async name=>name==="start_gpu_preview_playback"?start.promise:{acknowledged:true});
    const receive=vi.fn(()=>consumer.promise);const api=createTauriGpuPreviewApi(owner);
    expect(Object.keys(api)).toHaveLength(23);
    const result=api.startGpuPreviewPlayback!(session,{startFrame:0,endFrame:90},receive);
    startChannel().onmessage(event({sequence:1,presentedFrames:1}));await flush();expect(receive).not.toHaveBeenCalled();
    start.resolve(event());await flush();expect(receive).toHaveBeenCalledTimes(1);
    expect(ipc.invoke.mock.calls.some(([name])=>name==="acknowledge_gpu_preview_playback")).toBe(false);
    consumer.resolve();await result;expect(ipc.invoke).toHaveBeenLastCalledWith("acknowledge_gpu_preview_playback",{previewOwner:owner,generation:1,sequence:1});
    expect(ipc.invoke.mock.calls.some(([name])=>name.includes("present_frame"))).toBe(false);
  });
  it("discards duplicate and wrong-generation events without acknowledging a successor",async()=>{
    ipc.invoke.mockImplementation(async name=>name==="start_gpu_preview_playback"?event():{});
    const receive=vi.fn();await createTauriGpuPreviewApi(owner).startGpuPreviewPlayback!(session,{startFrame:0,endFrame:30},receive);
    const channel=startChannel();channel.onmessage(event({generation:2,sequence:1}));await flush();expect(receive).not.toHaveBeenCalled();
    channel.onmessage(event({sequence:1}));await flush();channel.onmessage(event({sequence:1}));await flush();
    expect(receive).toHaveBeenCalledTimes(1);expect(ipc.invoke.mock.calls.filter(([name])=>name==="acknowledge_gpu_preview_playback")).toHaveLength(1);
  });
  it("stops an exact generation if its consumer rejects the event",async()=>{
    vi.spyOn(console,"warn").mockImplementation(()=>{});
    ipc.invoke.mockImplementation(async name=>name==="start_gpu_preview_playback"?event():{});
    await createTauriGpuPreviewApi(owner).startGpuPreviewPlayback!(session,{startFrame:0,endFrame:30},()=>{throw new Error("consumer failure");});
    startChannel().onmessage(event({sequence:1}));await flush();
    expect(ipc.invoke).toHaveBeenCalledWith("stop_gpu_preview_playback",{previewOwner:owner,generation:1});
    expect(ipc.invoke).toHaveBeenCalledWith("acknowledge_gpu_preview_playback",{previewOwner:owner,generation:1,sequence:1});
  });
  it("does not turn a malformed early event into successful startup",async()=>{
    vi.spyOn(console,"warn").mockImplementation(()=>{});
    const start=deferred<NativeGpuPlaybackEvent>();ipc.invoke.mockImplementation(async name=>name==="start_gpu_preview_playback"?start.promise:{});
    const result=createTauriGpuPreviewApi(owner).startGpuPreviewPlayback!(session,{startFrame:0,endFrame:30},()=>{}).catch(error=>error);
    startChannel().onmessage(event({owner:"foreign"}));await flush();start.resolve(event());
    expect(await result).toBeInstanceOf(Error);expect(ipc.invoke).toHaveBeenCalledWith("stop_gpu_preview_playback",{previewOwner:owner,generation:1});
  });
  it("fails invalid receipts, rejects unowned start, and keeps diagnostics on demand",async()=>{
    expect(validNativeGpuPlaybackEvent(event(),owner,session)).toBe(true);
    for(const bad of [event({timelineSeconds:NaN}),event({timelineFrame:-1}),event({generation:0}),event({sequence:1.5}),event({reason:"x".repeat(2049)})])expect(validNativeGpuPlaybackEvent(bad,owner,session)).toBe(false);
    await expect(createTauriGpuPreviewApi().startGpuPreviewPlayback!(session,{startFrame:0,endFrame:1})).rejects.toThrow("持有者");expect(ipc.invoke).not.toHaveBeenCalled();
    ipc.invoke.mockImplementation(async name=>name==="start_gpu_preview_playback"?event({owner:"wrong"}):{});
    const api=createTauriGpuPreviewApi(owner);await expect(api.startGpuPreviewPlayback!(session,{startFrame:0,endFrame:30})).rejects.toThrow("回應不合法");
    await api.inspectGpuPreviewPlayback!(1,true);expect(ipc.invoke).toHaveBeenLastCalledWith("inspect_gpu_preview_playback",{previewOwner:owner,generation:1,diagnostic:true});
  });
});
