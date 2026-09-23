import {afterEach,describe,expect,it,vi} from "vitest";
const ipc=vi.hoisted(()=>({invoke:vi.fn(async(_command:string,_args?:unknown)=>({}))}));
vi.mock("@tauri-apps/api/core",()=>({invoke:ipc.invoke,convertFileSrc:(path:string)=>`asset://${path}`,Channel:class {onmessage?:unknown}}));
import {createTauriGpuPreviewApi,createTauriGpuPreviewOwner} from "./tauriGpuPreview";
afterEach(()=>ipc.invoke.mockReset());
describe("Tauri preview ownership wire contract",()=>{
  it("tags every preview operation with the native owner while preserving output hydration",async()=>{
    ipc.invoke.mockImplementation(async command=>command==="begin_gpu_preview_owner"
      ?{schema:"editkin.gpu-preview-owner/v1",token:"gpu-owner-42-7",sessions:{image:"gpu-owner-42-7-image",video:"gpu-owner-42-7-video",engineVideo:"gpu-owner-42-7-engine-video"}}
      :command==="end_gpu_preview_owner"?{released:true,superseded:false}:{outputPath:"frame.png",receipt:{outputHash:"hash",frame:{outputHash:"hash"}}});
    const owner=await createTauriGpuPreviewOwner();
    const args:unknown[]=["gpu-owner-42-7-image",{}, {}, 0];
    const entries=Object.entries(owner.desktop).filter(([name])=>!["startGpuPreviewPlayback","stopGpuPreviewPlayback","inspectGpuPreviewPlayback"].includes(name));expect(entries).toHaveLength(20);
    for(const [name,method] of entries){
      const result=await (method as (...values:unknown[])=>Promise<unknown>)(...(name==="bindGpuPreviewSurface"?[{x:0,y:0,width:32,height:32}]:args));
      expect(ipc.invoke.mock.calls.at(-1)?.[1]).toMatchObject({previewOwner:"gpu-owner-42-7"});
      if(name==="renderGpuPreviewFrame"||name==="decodeGpuVideoPreviewAtTime"||name==="decodeGpuVideoPreviewFrame")expect(result).toMatchObject({outputUrl:"asset://frame.png?v=hash"});
    }
    await owner.release();expect(ipc.invoke).toHaveBeenLastCalledWith("end_gpu_preview_owner",{previewOwner:"gpu-owner-42-7"});
  });
  it("rejects malformed or mismatched native session ownership",async()=>{
    ipc.invoke.mockImplementation(async command=>command==="end_gpu_preview_owner"?{released:true,superseded:false}:{schema:"editkin.gpu-preview-owner/v1",token:"gpu-owner-42-1",sessions:{image:"foreign",video:"gpu-owner-42-1-video",engineVideo:"gpu-owner-42-1-engine-video"}});
    await expect(createTauriGpuPreviewOwner()).rejects.toThrow("receipt invalid");
    expect(ipc.invoke).toHaveBeenLastCalledWith("end_gpu_preview_owner",{previewOwner:"gpu-owner-42-1"});
  });
  it("does not treat a malformed release acknowledgement as confirmed cleanup",async()=>{
    ipc.invoke.mockImplementation(async command=>command==="end_gpu_preview_owner"?{released:false,superseded:false}:{schema:"editkin.gpu-preview-owner/v1",token:"gpu-owner-42-2",sessions:{image:"gpu-owner-42-2-image",video:"gpu-owner-42-2-video",engineVideo:"gpu-owner-42-2-engine-video"}});
    const owner=await createTauriGpuPreviewOwner();await expect(owner.release()).rejects.toThrow("cleanup unconfirmed");
  });
  it("keeps explicit unowned calls distinguishable for the native guard",async()=>{
    ipc.invoke.mockResolvedValue({});await createTauriGpuPreviewApi().releaseGpuPreviewSurface!();
    expect(ipc.invoke).toHaveBeenLastCalledWith("release_gpu_preview_surface",{previewOwner:undefined});
  });
});
