import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import { applyCommand } from "./commands";
import type { EditorCommand } from "./commandTypes";
import { createDemoProject } from "./demo";
import { createEmptyProject } from "./editGraph";
import { applyFastCommand } from "./fastCommands";
import { createHistory, dispatchCommand, redo, undo } from "./history";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type MediaAsset, type TimelineClip } from "./types";

function largeTimeline(trackCount=20,clipsPerTrack=500):EditProject {
  const project=createEmptyProject("add benchmark",{id:"add-bench",width:1920,height:1080,fps:30});
  project.assets=[{id:"video",name:"Video",kind:"video",uri:"video.mp4",duration:1},{id:"audio",name:"Audio",kind:"audio",uri:"audio.wav",duration:1}];
  project.tracks=Array.from({length:trackCount},(_,trackIndex)=>({id:`video-${trackIndex}`,name:`Video ${trackIndex+1}`,kind:"video" as const,locked:false,muted:false,clips:Array.from({length:clipsPerTrack},(_,clipIndex):TimelineClip=>({id:`clip-${trackIndex}-${clipIndex}`,assetId:"video",trackId:`video-${trackIndex}`,timelineStart:clipIndex,sourceStart:0,duration:1,volume:1,transform:{...DEFAULT_TRANSFORM},color:{...DEFAULT_COLOR},keyframes:[],layer:{...DEFAULT_CLIP_LAYER},expressions:{}}))}));
  return project;
}

function appendCommand(id:string):Extract<EditorCommand,{type:"add_clip"}>{return{type:"add_clip",clip:{id,assetId:"video",trackId:"video-19",timelineStart:500,sourceStart:0,duration:1,volume:1,transform:{...DEFAULT_TRANSFORM},color:{...DEFAULT_COLOR},keyframes:[],layer:{...DEFAULT_CLIP_LAYER}}};}

function importAsset(id:string):MediaAsset{return{id,name:`${id}.mov`,kind:"video",uri:`D:/fixture-only/${id}.mov`,duration:1,width:1920,height:1080,derivatives:{sourceSha256:"a".repeat(64),generatedAt:"2026-09-04T00:00:00.000Z"}};}
function importAndAdd(id:string,resolution?:{width:number;height:number}):EditorCommand{const asset=importAsset(id),clip={...appendCommand(`clip-${id}`).clip,assetId:id};return{type:"batch",commands:[...(resolution?[{type:"set_project_resolution" as const,...resolution}]:[]),{type:"import_asset",asset},{type:"add_clip",clip}]};}
function pipBatch(id:string,assetId="video"):EditorCommand{return{type:"batch",commands:[
  {type:"add_track",track:{id:`pip-track-${id}`,name:"畫中畫",kind:"video",locked:false,muted:false,clips:[]}},
  {type:"add_clip",clip:{...appendCommand(`pip-clip-${id}`).clip,assetId,trackId:`pip-track-${id}`,timelineStart:12,layout:{crop:{x:0,y:0,width:1,height:1},viewport:{x:.66,y:.06,width:.29,height:.29}}}},
]};}

describe("structural-sharing timeline commands", () => {
  it("changes only the touched clip path and preserves the input", () => {
    const input = createDemoProject();
    const originalClip = structuredClone(input.tracks[0].clips[0]);
    const result = applyCommand(input, { type: "set_clip_color", clipId: "clip-demo", patch: { exposure: 1.25 } });
    expect(input.tracks[0].clips[0]).toEqual(originalClip);
    expect(result).not.toBe(input);
    expect(result.assets).toBe(input.assets);
    expect(result.tracks).not.toBe(input.tracks);
    expect(result.tracks[0]).not.toBe(input.tracks[0]);
    expect(result.tracks[1]).toBe(input.tracks[1]);
    expect(result.tracks[0].clips[0].color.exposure).toBe(1.25);
  });

  it("rejects overlap after a fast move", () => {
    let project = applyCommand(createDemoProject(), { type: "split_clip", clipId: "clip-demo", at: 4, newClipId: "right" });
    expect(() => applyCommand(project, { type: "move_clip", clipId: "right", timelineStart: 2 })).toThrow(/重疊/);
  });

  it("undoes and redoes a fast property edit exactly", () => {
    const initial = createHistory(createDemoProject());
    const changed = dispatchCommand(initial, { type: "set_clip_volume", clipId: "clip-demo", volume: 0.42 }, "fast-volume");
    expect(undo(changed).present.tracks[0].clips[0].volume).toBe(1);
    expect(redo(undo(changed)).present.tracks[0].clips[0].volume).toBe(0.42);
  });

  it("uses immutable structural sharing for the UI-shaped single add-clip batch",()=>{
    const input=largeTimeline(),command:EditorCommand={type:"batch",commands:[appendCommand("new-clip")]},commandBefore=structuredClone(command);
    const changed=applyCommand(input,command);
    expect(changed.assets).toBe(input.assets);expect(changed.tracks).not.toBe(input.tracks);expect(changed.tracks[19]).not.toBe(input.tracks[19]);expect(changed.tracks[0]).toBe(input.tracks[0]);
    expect(changed.tracks[19].clips.at(-1)?.id).toBe("new-clip");expect(input.tracks[19].clips).toHaveLength(500);expect(command).toEqual(commandBefore);
  });

  it("keeps add-clip validation closed while routing rich clips through full validation",()=>{
    const input=largeTimeline();
    expect(()=>applyCommand(input,appendCommand("clip-0-0"))).toThrow(/重複片段/);
    expect(()=>applyCommand(input,{...appendCommand("overlap"),clip:{...appendCommand("overlap").clip,timelineStart:499.5}})).toThrow(/重疊/);
    expect(()=>applyCommand(input,{...appendCommand("wrong-kind"),clip:{...appendCommand("wrong-kind").clip,assetId:"audio"}})).toThrow(/視訊軌/);
    const rich=appendCommand("rich");rich.clip.layout={crop:{x:0,y:0,width:1,height:1},viewport:{x:0,y:0,width:1,height:1}};
    const changed=applyCommand(input,rich);expect(changed.assets).not.toBe(input.assets);expect(changed.tracks[19].clips.at(-1)?.layout).toBeDefined();
  });

  it("adds to a 10,000-clip timeline within one 60 Hz frame at p95 on this host",()=>{
    const input=largeTimeline(),samples:number[]=[];
    for(let index=0;index<5;index++)applyCommand(input,{type:"batch",commands:[appendCommand(`warm-${index}`)]});
    for(let index=0;index<24;index++){const started=performance.now();applyCommand(input,{type:"batch",commands:[appendCommand(`sample-${index}`)]});samples.push(performance.now()-started);}
    samples.sort((left,right)=>left-right);const p95=samples[Math.ceil(samples.length*.95)-1]!;
    expect(p95).toBeLessThanOrEqual(16.7);
  });

  it("imports one prepared asset and appends its clip without cloning unrelated graph branches",()=>{
    const input=largeTimeline(),command=importAndAdd("prepared"),before=structuredClone(command);
    const changed=applyCommand(input,command);
    expect(changed).not.toBe(input);expect(changed.assets).not.toBe(input.assets);expect(changed.assets[0]).toBe(input.assets[0]);
    expect(changed.assets.at(-1)).toEqual(importAsset("prepared"));expect(changed.tracks).not.toBe(input.tracks);expect(changed.tracks[0]).toBe(input.tracks[0]);expect(changed.tracks[19]).not.toBe(input.tracks[19]);
    expect(changed.tracks[19].clips.at(-1)?.id).toBe("clip-prepared");expect(input.assets).toHaveLength(2);expect(input.tracks[19].clips).toHaveLength(500);expect(command).toEqual(before);
    expect(changed.compositions).toBe(input.compositions);expect(changed.captions).toBe(input.captions);expect(changed.motionTracks).toBe(input.motionTracks);expect(changed.motionGraphics).toBe(input.motionGraphics);expect(changed.director).toBe(input.director);
  });

  it("keeps import plus add as one exact undo and redo step",()=>{
    const initial=createHistory(largeTimeline()),changed=dispatchCommand(initial,importAndAdd("history"),"import-history");
    expect(changed.past).toHaveLength(1);expect(changed.journal).toHaveLength(1);expect(changed.present.assets.some(asset=>asset.id==="history")).toBe(true);expect(changed.present.tracks[19].clips.some(clip=>clip.id==="clip-history")).toBe(true);
    const undone=undo(changed);expect(undone.present.assets.some(asset=>asset.id==="history")).toBe(false);expect(undone.present.tracks[19].clips).toHaveLength(500);
    const redone=redo(undone);expect(redone.present.assets.some(asset=>asset.id==="history")).toBe(true);expect(redone.present.tracks[19].clips.at(-1)?.id).toBe("clip-history");
  });

  it("supports the bounded orientation-plus-import batch only when no graphic scaling is required",()=>{
    const input=largeTimeline(),command=importAndAdd("portrait",{width:1080,height:1920}),changed=applyCommand(input,command);
    expect(changed).toMatchObject({width:1080,height:1920});expect(changed.assets[0]).toBe(input.assets[0]);expect(changed.tracks[0]).toBe(input.tracks[0]);expect(changed.tracks[19].clips.at(-1)?.assetId).toBe("portrait");
    const withGraphic=applyCommand(createDemoProject(),{type:"add_motion_graphic",graphic:{schema:"hao.motion-composition/v1",id:"graphic",name:"Graphic",kind:"title",text:"Title",timelineStart:0,duration:1,x:.1,y:.1,width:.4,fontSize:40,textColor:"#ffffff",backgroundColor:"#000000",accentColor:"#ffffff",animation:"fade",offsetX:0,offsetY:0}});
    const richCommand:EditorCommand={type:"batch",commands:[{type:"set_project_resolution",width:1080,height:1920},{type:"import_asset",asset:{...importAsset("graphic-import"),duration:12}},{type:"add_clip",clip:{...withGraphic.tracks[0].clips[0],id:"graphic-import-clip",assetId:"graphic-import",timelineStart:12}}]};
    expect(applyFastCommand(withGraphic,richCommand)).toBeUndefined();
    const fullyValidated=applyCommand(withGraphic,richCommand);expect(fullyValidated.motionGraphics[0].fontSize).toBeCloseTo(40*1920/1080);expect(fullyValidated.assets).not.toBe(withGraphic.assets);
  });

  it("rejects adversarial import batches and falls back for mismatched or rich shapes",()=>{
    const input=largeTimeline();
    expect(()=>applyCommand(input,importAndAdd("video"))).toThrow(/素材 id 已存在/);
    const duplicateClip=importAndAdd("duplicate-clip");if(duplicateClip.type!=="batch"||duplicateClip.commands[1]?.type!=="add_clip")throw Error("fixture");duplicateClip.commands[1].clip.id="clip-0-0";
    expect(()=>applyCommand(input,duplicateClip)).toThrow(/重複片段/);
    const overlap=importAndAdd("overlap-import");if(overlap.type!=="batch"||overlap.commands[1]?.type!=="add_clip")throw Error("fixture");overlap.commands[1].clip.timelineStart=499.5;
    expect(()=>applyCommand(input,overlap)).toThrow(/重疊/);
    const wrongKind=importAndAdd("wrong-kind-import");if(wrongKind.type!=="batch"||wrongKind.commands[0]?.type!=="import_asset")throw Error("fixture");wrongKind.commands[0].asset.kind="audio";
    expect(()=>applyCommand(input,wrongKind)).toThrow(/視訊軌/);
    const invalidMetadata=importAndAdd("bad-metadata");if(invalidMetadata.type!=="batch"||invalidMetadata.commands[0]?.type!=="import_asset")throw Error("fixture");invalidMetadata.commands[0].asset.derivatives!.sourceSha256="bad";
    expect(()=>applyCommand(input,invalidMetadata)).toThrow(/衍生檔 metadata/);
    const mismatched=importAndAdd("unused");if(mismatched.type!=="batch"||mismatched.commands[1]?.type!=="add_clip")throw Error("fixture");mismatched.commands[1].clip.assetId="video";
    expect(applyFastCommand(input,mismatched)).toBeUndefined();const full=applyCommand(input,mismatched);expect(full.assets).not.toBe(input.assets);expect(full.assets.some(asset=>asset.id==="unused")).toBe(true);expect(full.tracks[19].clips.at(-1)?.assetId).toBe("video");
    const extra=importAndAdd("extra");if(extra.type!=="batch")throw Error("fixture");extra.commands.push({type:"rename_project",name:input.name});expect(applyFastCommand(input,extra)).toBeUndefined();expect(applyCommand(input,extra).assets).not.toBe(input.assets);
  });

  it("adds the exact UI picture-in-picture track shape with immutable structural sharing",()=>{
    const input=largeTimeline(),command=pipBatch("bounded"),before=structuredClone(command),changed=applyCommand(input,command);
    expect(changed.assets).toBe(input.assets);expect(changed.tracks).not.toBe(input.tracks);expect(changed.tracks.slice(0,-1).every((track,index)=>track===input.tracks[index])).toBe(true);
    expect(changed.tracks.at(-1)).toMatchObject({id:"pip-track-bounded",kind:"video",clips:[{id:"pip-clip-bounded",assetId:"video",layout:{viewport:{x:.66,y:.06,width:.29,height:.29}}}]});
    expect(input.tracks).toHaveLength(20);expect(command).toEqual(before);
    const history=dispatchCommand(createHistory(input),command,"pip");expect(undo(history).present.tracks).toHaveLength(20);expect(redo(undo(history)).present.tracks.at(-1)?.id).toBe("pip-track-bounded");
  });

  it("keeps rich or malformed PIP batches on full validation and rejects collisions",()=>{
    const input=largeTimeline(),rich=pipBatch("rich");if(rich.type!=="batch"||rich.commands[1]?.type!=="add_clip")throw Error("fixture");rich.commands[1].clip.creative={effectPresetIds:[]};
    expect(applyFastCommand(input,rich)).toBeUndefined();const full=applyCommand(input,rich);expect(full.assets).not.toBe(input.assets);expect(full.tracks.at(-1)?.clips[0].creative).toEqual({effectPresetIds:[]});
    const invalid=pipBatch("invalid");if(invalid.type!=="batch"||invalid.commands[1]?.type!=="add_clip")throw Error("fixture");invalid.commands[1].clip.layout!.viewport.width=.5;
    expect(()=>applyCommand(input,invalid)).toThrow(/viewport/);
    const duplicateTrack=pipBatch("duplicate-track");if(duplicateTrack.type!=="batch"||duplicateTrack.commands[0]?.type!=="add_track")throw Error("fixture");duplicateTrack.commands[0].track.id="video-0";if(duplicateTrack.commands[1]?.type==="add_clip")duplicateTrack.commands[1].clip.trackId="video-0";
    expect(()=>applyCommand(input,duplicateTrack)).toThrow(/軌道 id 已存在/);
    const duplicateClip=pipBatch("duplicate-clip");if(duplicateClip.type!=="batch"||duplicateClip.commands[1]?.type!=="add_clip")throw Error("fixture");duplicateClip.commands[1].clip.id="clip-0-0";
    expect(()=>applyCommand(input,duplicateClip)).toThrow(/重複片段/);
  });

  it("matches the whole-project validator for bounded import and PIP batches",()=>{
    const input=largeTimeline(20,2);
    for(const candidate of [importAndAdd("differential"),pipBatch("differential")]){
      if(candidate.type!=="batch")throw Error("fixture");
      const fast=applyCommand(input,candidate);
      const forced=applyCommand(input,{type:"batch",commands:[...candidate.commands,{type:"rename_project",name:input.name}]});
      expect({...fast,updatedAt:"normalized"}).toEqual({...forced,updatedAt:"normalized"});
    }
  });

  it("imports and adds on a 10,000-clip timeline within one 60 Hz frame at p95 on this host",()=>{
    const input=largeTimeline(),samples:number[]=[];
    for(let index=0;index<5;index++)applyCommand(input,importAndAdd(`import-warm-${index}`));
    for(let index=0;index<24;index++){const started=performance.now();applyCommand(input,importAndAdd(`import-sample-${index}`));samples.push(performance.now()-started);}
    samples.sort((left,right)=>left-right);const p95=samples[Math.ceil(samples.length*.95)-1]!;
    expect(p95).toBeLessThanOrEqual(16.7);
  });
});
