import { describe, expect, it, vi } from "vitest";
import { ResidentGpuPreviewGeneration, RetiredGpuPreview } from "./residentGpuPreviewGeneration";
import type { GpuPreviewOwner } from "./gpuPreviewApiTypes";
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes,no) => {resolve=yes;reject=no;});return {promise,resolve,reject}; };
const flush = async () => {for(let i=0;i<15;i++)await Promise.resolve();};
function owner(id: string): GpuPreviewOwner {return {sessions:{image:`${id}-image`,video:`${id}-video`,engineVideo:`${id}-engine-video`},
  desktop:{releaseGpuPreviewSurface:vi.fn(async()=>({released:true}))},release:vi.fn(async()=>{})};}
describe("GPU preview committed generation",()=>{
  it("does not deliver a native playback callback after its generation retires",async()=>{
    const current=owner("one");let emit:((event:unknown)=>unknown)|undefined;
    current.desktop.startGpuPreviewPlayback=vi.fn(async(_session,_range,receive)=>{emit=receive as never;return {} as never;});
    const generation=new ResidentGpuPreviewGeneration(async()=>current);const api=await generation.desktop();const receive=vi.fn();
    await api.startGpuPreviewPlayback!("one-engine-video",{startFrame:0,endFrame:30},receive);
    emit!({});expect(receive).toHaveBeenCalledTimes(1);generation.dispose();emit!({});expect(receive).toHaveBeenCalledTimes(1);await flush();
  });
  it("never creates an owner in construction and cannot reactivate after disposal",async()=>{
    const create=vi.fn(async()=>owner("one"));const generation=new ResidentGpuPreviewGeneration(create);
    expect(create).not.toHaveBeenCalled();generation.dispose();expect(()=>generation.desktop()).toThrow(RetiredGpuPreview);expect(create).not.toHaveBeenCalled();
  });
  it("releases exactly once when acquisition completes after disposal",async()=>{
    const pending=deferred<GpuPreviewOwner>();const generation=new ResidentGpuPreviewGeneration(()=>pending.promise);
    const result=generation.desktop().catch(error=>error);generation.dispose();generation.dispose();
    const old=owner("old");pending.resolve(old);expect(await result).toBeInstanceOf(RetiredGpuPreview);await flush();expect(old.release).toHaveBeenCalledTimes(1);
  });
  it("a load finishing after disposal cannot issue the next native call",async()=>{
    const pending=deferred<unknown>();const old=owner("old");old.desktop.loadGpuPreviewSession=vi.fn(()=>pending.promise) as never;
    const generation=new ResidentGpuPreviewGeneration(async()=>old);const api=await generation.desktop();
    const result=api.loadGpuPreviewSession!(generation.imageSessionRef.current,{} as never).then(()=>api.releaseGpuPreviewSurface!()).catch(error=>error);
    generation.dispose();pending.resolve({});expect(await result).toBeInstanceOf(RetiredGpuPreview);await flush();
    expect(old.desktop.releaseGpuPreviewSurface).not.toHaveBeenCalled();expect(old.release).toHaveBeenCalledTimes(1);
  });
  it("a stale release facade cannot reach a newer owner's surface",async()=>{
    const first=owner("first"),second=owner("second");const a=new ResidentGpuPreviewGeneration(async()=>first),b=new ResidentGpuPreviewGeneration(async()=>second);
    const oldApi=await a.desktop();a.dispose();const newApi=await b.desktop();
    await expect(oldApi.releaseGpuPreviewSurface!()).rejects.toBeInstanceOf(RetiredGpuPreview);
    await newApi.releaseGpuPreviewSurface!();expect(second.desktop.releaseGpuPreviewSurface).toHaveBeenCalledTimes(1);expect(first.desktop.releaseGpuPreviewSurface).not.toHaveBeenCalled();b.dispose();await flush();
  });
  it("cleanup errors are reported once, never rewritten as a successful close",async()=>{
    const current=owner("broken");current.release=vi.fn(async()=>{throw new Error("cleanup failed");});const report=vi.fn();
    const generation=new ResidentGpuPreviewGeneration(async()=>current,report);await generation.desktop();generation.dispose();generation.dispose();await flush();
    expect(report).toHaveBeenCalledTimes(1);expect(report.mock.calls[0][0].message).toBe("cleanup failed");
  });
});
