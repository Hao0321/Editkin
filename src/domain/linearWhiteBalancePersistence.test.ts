import {describe,expect,it} from "vitest";
import {createDemoProject} from "./demo";
import {migrateProject,validateProject,animatedClipState} from "./editGraph";
import {editorCommandSchema,projectSchema} from "./schema";
import {applyCommand} from "./commands";
import {createHistory,dispatchCommand,undo,redo} from "./history";
import {DEFAULT_COLOR,type ColorAdjustments} from "./types";
const keys=["whiteBalanceRed","whiteBalanceGreen","whiteBalanceBlue"] as const;
const authored={whiteBalanceRed:.4,whiteBalanceGreen:-.3,whiteBalanceBlue:.2};
describe("independent linear WB persistence/partial-command regression",()=>{
  it("accepts legacy full color on external add_clip, add_keyframe and direct old project parsing",()=>{
    const p=createDemoProject(),clip=structuredClone(p.tracks[0].clips[0]);
    clip.keyframes=[{id:"legacy-key",time:1,easing:"linear",transform:{...clip.transform},color:{...clip.color}}];
    for(const color of [clip.color,clip.keyframes[0].color])for(const key of keys)delete (color as Partial<ColorAdjustments>)[key];
    const before=JSON.stringify(clip);
    const added=editorCommandSchema.parse({type:"add_clip",clip});
    expect(added.type).toBe("add_clip");
    if(added.type!=="add_clip")throw Error("wrong command");
    expect(keys.map(k=>added.clip.color[k])).toEqual([0,0,0]);
    expect(keys.map(k=>added.clip.keyframes[0].color[k])).toEqual([0,0,0]);
    const key=editorCommandSchema.parse({type:"add_keyframe",clipId:clip.id,keyframe:clip.keyframes[0]});
    if(key.type!=="add_keyframe")throw Error("wrong command");
    expect(keys.map(k=>key.keyframe.color[k])).toEqual([0,0,0]);
    p.tracks[0].clips[0]=clip;
    expect(keys.map(k=>projectSchema.parse(p).tracks[0].clips[0].color[k])).toEqual([0,0,0]);
    expect(JSON.stringify(clip)).toBe(before);
  });
  it("creates full defaults and accepts authored exact three-field command/JSON roundtrip",()=>{
    const p=createDemoProject(),clip=p.tracks[0].clips[0];
    expect(keys.map(k=>DEFAULT_COLOR[k])).toEqual([0,0,0]);expect(projectSchema.parse(p).tracks[0].clips[0].color).toMatchObject({whiteBalanceRed:0,whiteBalanceGreen:0,whiteBalanceBlue:0});
    const command=editorCommandSchema.parse({type:"set_clip_color",clipId:clip.id,patch:authored});
    expect(command).toEqual({type:"set_clip_color",clipId:clip.id,patch:authored});
    const changed=applyCommand(p,command);expect(projectSchema.parse(JSON.parse(JSON.stringify(changed))).tracks[0].clips[0].color).toMatchObject(authored);
    expect(clip.color.whiteBalanceRed).toBe(0);
  });
  it("migrates old v8 main/nested/keyframe state without mutating original",()=>{
    const p=createDemoProject(),clip=p.tracks[0].clips[0];
    clip.keyframes=[{id:"k",time:1,easing:"linear",transform:{...clip.transform},color:{...clip.color,brightness:.2}}];
    const nested=structuredClone(clip);nested.id="nested-clip";nested.trackId="nested-track";
    p.compositions.push({schema:"editkin.composition/v1",id:"nested",name:"Nested",width:p.width,height:p.height,fps:p.fps,duration:nested.duration,tracks:[{id:nested.trackId,name:"Nested",kind:"video",locked:false,muted:false,clips:[nested]}],captions:[],captionStyle:structuredClone(p.captionStyle),motionTracks:[],motionGraphics:[],director:structuredClone(p.director),updatedAt:p.updatedAt});
    for(const c of [clip,nested])for(const color of [c.color,...c.keyframes.map(k=>k.color)])for(const key of keys)delete (color as Partial<ColorAdjustments>)[key];
    const before=JSON.stringify(p),restored=projectSchema.parse(validateProject(migrateProject(p)));
    expect(JSON.stringify(p)).toBe(before);
    for(const c of [restored.tracks[0].clips[0],restored.compositions[0].tracks[0].clips[0]]){
      expect(keys.map(k=>c.color[k])).toEqual([0,0,0]);expect(keys.map(k=>c.keyframes[0].color[k])).toEqual([0,0,0]);expect(c.keyframes[0].color.brightness).toBe(.2);
    }
  });
  it("partial brightness parser never synthesizes zero WB; history retains user decisions",()=>{
    const p=createDemoProject(),id=p.tracks[0].clips[0].id;
    const h=dispatchCommand(createHistory(p),{type:"set_clip_color",clipId:id,patch:authored});
    const partial=editorCommandSchema.parse({type:"set_clip_color",clipId:id,patch:{brightness:.15}});
    expect(partial).toEqual({type:"set_clip_color",clipId:id,patch:{brightness:.15}});
    const next=dispatchCommand(h,partial);expect(next.present.tracks[0].clips[0].color).toMatchObject({...authored,brightness:.15});
    expect(undo(next).present.tracks[0].clips[0].color).toMatchObject({...authored,brightness:0});
    expect(redo(undo(next)).present.tracks[0].clips[0].color).toMatchObject({...authored,brightness:.15});
  });
  it("rejects nonfinite/overrange commands and invalid keyframe WB",()=>{
    for(const value of [NaN,Infinity,-Infinity,4.001,-4.001]){
      const p=createDemoProject(),c=p.tracks[0].clips[0];
      expect(editorCommandSchema.safeParse({type:"set_clip_color",clipId:c.id,patch:{whiteBalanceRed:value}}).success).toBe(false);
      expect(()=>applyCommand(p,{type:"set_clip_color",clipId:c.id,patch:{whiteBalanceRed:value}})).toThrow();
      c.keyframes=[{id:"invalid",time:1,easing:"linear",transform:{...c.transform},color:{...c.color,whiteBalanceBlue:value}}];
      expect(projectSchema.safeParse(p).success).toBe(false);expect(()=>validateProject(p)).toThrow();
    }
  });
  it("interpolates log2 stops without losing channel identity on persisted keyframes",()=>{
    const p=createDemoProject(),c=p.tracks[0].clips[0];
    c.keyframes=[{id:"gain",time:2,easing:"linear",transform:{...c.transform},color:{...c.color,whiteBalanceRed:2,whiteBalanceGreen:-2,whiteBalanceBlue:1}}];
    const restored=projectSchema.parse(JSON.parse(JSON.stringify(p))).tracks[0].clips[0];
    expect(animatedClipState(restored,1).color).toMatchObject({whiteBalanceRed:1,whiteBalanceGreen:-1,whiteBalanceBlue:.5});
  });
});
