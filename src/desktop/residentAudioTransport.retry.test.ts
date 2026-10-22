import {describe, expect, it, vi} from "vitest";
import {createDemoProject} from "../domain/demo";
import {ResidentAudioTransport, type ResidentAudioIntent, type ResidentAudioView} from "./residentAudioTransport";
import type {ResidentAudioApi, ResidentAudioStage, ResidentAudioStatus} from "./residentAudioTypes";
const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
function fixture(){
  const project=createDemoProject();const intent:ResidentAudioIntent={project,seekRevision:0,timelineStartSeconds:0,playing:true};
  const views:ResidentAudioView[]=[];let owner=6,generation=0;
  const stage=(g:number):ResidentAudioStage=>({schema:"editkin.native-audio-project-stage/v1",status:"PREPARED",projectId:project.id,projectRevision:project.revision,
    projectUpdatedAt:project.updatedAt,generation:g,planSha256:"a".repeat(64),audioFingerprintSha256:"b".repeat(64),planBytes:240,startFrame:0,frameCount:48000*60,
    sourceCount:1,peakActiveSources:1,pcmStagingFiles:0});
  const api={
    capabilities:vi.fn(async()=>({schema:"editkin.desktop-audio-capabilities/v1" as const,supported:true,gpuClock:true,sampleRate:48000 as const})),
    open:vi.fn(async(_cb:(s:ResidentAudioStatus)=>void)=>({ownerId:++owner,status:{} as ResidentAudioStatus})),
    replace:vi.fn(async(ownerId:number)=>{const g=++generation;return{ownerId,generation:g,stage:stage(g)};}),
    control:vi.fn(async(ownerId:number)=>({ownerId,accepted:true as const,requestId:1})),
    close:vi.fn(async(ownerId:number)=>({ownerId,released:true,retainedStageFiles:0})),
  } satisfies ResidentAudioApi;
  const transport=new ResidentAudioTransport(api,view=>views.push(view),vi.fn());
  return{api,intent,views,transport};
}
describe("resident audio retry after an unconfirmed close (U03)",()=>{
  it("re-closes the same owner, then admits a fresh owner only after the close is confirmed",async()=>{
    const f=fixture();
    f.api.replace.mockRejectedValueOnce(new Error("source missing"));
    f.api.close.mockResolvedValueOnce({ownerId:7,released:false,retainedStageFiles:1});
    f.transport.update(f.intent);await flush();
    expect(f.views.at(-1)?.mode).toBe("failed");expect(f.api.close).toHaveBeenCalledTimes(1);
    // Updates alone never reopen a failed owner; the user retry does.
    f.transport.update({...f.intent,playing:false});await flush();expect(f.api.open).toHaveBeenCalledTimes(1);
    f.api.close.mockResolvedValueOnce({ownerId:7,released:false,retainedStageFiles:1});
    // The retry settles with its outcome, so the caller can resume only a re-admitted owner.
    await expect(f.transport.retry()).resolves.toBe(false);await flush();
    expect(f.api.close.mock.calls.map(call=>call[0])).toEqual([7,7]);expect(f.views.at(-1)?.mode).toBe("failed");
    await expect(f.transport.retry()).resolves.toBe(true);await flush();
    expect(f.api.close.mock.calls.map(call=>call[0])).toEqual([7,7,7]);expect(f.views.at(-1)?.mode).toBe("idle");
    expect(f.api.open).toHaveBeenCalledTimes(1);
    f.transport.update(f.intent);await flush();
    expect(f.api.open).toHaveBeenCalledTimes(2);expect(f.views.at(-1)).toMatchObject({mode:"preparing",ownerId:8});
    await f.transport.dispose();expect(f.api.close).toHaveBeenLastCalledWith(8);
  });
  it("a retry racing disposal never closes the same owner twice",async()=>{
    const f=fixture();
    f.api.replace.mockRejectedValueOnce(new Error("source missing"));
    f.api.close.mockResolvedValueOnce({ownerId:7,released:false,retainedStageFiles:1});
    f.transport.update(f.intent);await flush();expect(f.views.at(-1)?.mode).toBe("failed");
    f.transport.retry();const count=f.views.length;await f.transport.dispose();await flush();
    expect(f.api.close.mock.calls.map(call=>call[0])).toEqual([7,7]);expect(f.views).toHaveLength(count);
  });
});
