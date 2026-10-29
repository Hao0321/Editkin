import assert from "node:assert/strict";
import {describe,it} from "vitest";
import type {EditorCommand} from "../domain/commandTypes";
import type {Transform3D} from "../domain/types";
import {createDemoProject} from "../domain/demo";
import {applyCommand} from "../domain/commands";
import {findClip} from "../domain/editGraph";
import {dispatchCommandSafely,undo,redo} from "../domain/history";
import {projectSchema} from "../domain/schema";
import {createProjectSession} from "./projectSession";
import {createTimelineEditingState} from "./timelineEditingState";
import {createGraphicEditingSelectionV1} from "./graphicEditingSelectionV1";
import {createClipAppearanceEditsV1} from "./clipAppearanceEditsV1";
function fixture(){
 let p=createDemoProject(),clip=p.tracks[0].clips[0];p.tracks[0].clips.push({...structuredClone(clip),id:"other",timelineStart:20});p=applyCommand(p,{type:"configure_scene_25d",enabled:true});clip=p.tracks[0].clips[0];
 const session=createProjectSession(p),timeline=createTimelineEditingState(session),selection=createGraphicEditingSelectionV1(session,timeline),off=selection.subscribe(()=>{});timeline.setSelectedClipId(clip.id);const calls:EditorCommand[]=[],statuses:string[]=[];
 const run=(command:EditorCommand)=>{calls.push(command);const result=dispatchCommandSafely(session.getSnapshot().history,command);if(result.error)return false;session.setHistory(result.state);return true;};
 const host={getSnapshot:session.getSnapshot,getSelectionSnapshot:selection.getSnapshot,getTransport:()=>({playhead:0,seekRevision:0}),runCommand:run,setStatus:(s:string)=>statuses.push(s),makeId:()=>"unused"};
 const make=(override:Partial<Parameters<typeof createClipAppearanceEditsV1>[0]>={})=>createClipAppearanceEditsV1({...host,...override},{project:session.getSnapshot().history.present,clipId:clip.id,selection:selection.getSnapshot(),transport:{playhead:0,seekRevision:0}}),view=make();
 const edit=(property:keyof Transform3D,index:0|1|2,value:number)=>view.transform3d({[property]:clip.transform3d![property].map((v,i)=>i===index?value:v) as [number,number,number]},{property,index});
 return{p,clip,session,timeline,selection,off,calls,statuses,run,host,make,view,edit,read:()=>findClip(session.getSnapshot().history.present,clip.id)};
}
type F=ReturnType<typeof fixture>;
function rejects(f:F,action:()=>boolean){const before=f.session.getSnapshot().history,n=f.calls.length;assert.equal(action(),false);assert.equal(f.session.getSnapshot().history,before);assert.equal(f.calls.length,n);}
describe("3D clip numeric edits use the canonical appearance owner",()=>{
 const test=(name:string,fn:(f:F)=>void)=>it(name,()=>{const f=fixture();try{fn(f);}finally{f.off();}});
 test("all nine axes persist with one command and Undo/Redo",f=>{for(const key of ["position","rotationDegrees","scale"] as const)for(const index of [0,1,2] as const)assert(f.edit(key,index,f.clip.transform3d![key][index]+.1));assert.equal(f.calls.length,9);const h=f.session.getSnapshot().history;assert.equal(h.past.length,9);assert.deepEqual(redo(undo(h)).present,h.present);assert.deepEqual(projectSchema.parse(JSON.parse(JSON.stringify(h.present))),h.present);assert.deepEqual(f.p.tracks[0].clips[0].transform3d,f.clip.transform3d);});
 test("one axis preserves a concurrent other-axis edit",f=>{f.run({type:"update_clip_transform_3d",clipId:f.clip.id,patch:{position:[.8,0,0]}});assert(f.edit("position",1,.4));assert.deepEqual(f.read().transform3d!.position,[.8,.4,0]);});
 test("own acknowledged values can advance and return to original",f=>{assert(f.edit("position",0,.2));assert(f.edit("position",0,.4));assert(f.edit("position",0,0));assert.deepEqual(f.read().transform3d!.position,[0,0,0]);});
 test("same-axis external conflict is atomic",f=>{f.run({type:"update_clip_transform_3d",clipId:f.clip.id,patch:{position:[.8,0,0]}});rejects(f,()=>f.edit("position",0,.4));});
 test("no-op does not dirty history",f=>{const h=f.session.getSnapshot().history;assert(f.edit("position",0,0));assert.equal(f.calls.length,0);assert.equal(f.session.getSnapshot().history,h);});
 test("selection and A-B-A retire the old view",f=>{f.timeline.setSelectedClipId("other");rejects(f,()=>f.edit("position",0,.2));f.timeline.setSelectedClipId(f.clip.id);rejects(f,()=>f.edit("position",0,.2));});
 test("same-ID reopen refuses old view without status leakage",f=>{f.session.replaceProject(structuredClone(f.p));f.timeline.setSelectedClipId(f.clip.id);const n=f.statuses.length;rejects(f,()=>f.edit("position",0,.2));assert.equal(f.statuses.length,n);});
 test("Undo-Redo retires old view but a new one works",f=>{f.run({type:"set_clip_volume",clipId:f.clip.id,volume:.5});f.session.setHistory(undo(f.session.getSnapshot().history));f.session.setHistory(redo(f.session.getSnapshot().history));rejects(f,()=>f.edit("position",0,.2));assert(f.make().transform3d({position:[.2,0,0]},{property:"position",index:0}));});
 test("scene disable/re-enable retires the occurrence",f=>{f.run({type:"batch",commands:[{type:"configure_scene_25d",enabled:false},{type:"configure_scene_25d",enabled:true}]});rejects(f,()=>f.edit("position",0,.2));});
 test("unmount retires callback",f=>{f.off();rejects(f,()=>f.edit("position",0,.2));});
 test("unknown, absent and malformed values never reach runner",f=>{for(const value of [null,[],{bad:1},{position:undefined},{position:[0,0]},{position:[NaN,0,0]},{position:[Infinity,0,0]}])rejects(f,()=>f.view.transform3d(value as Partial<Transform3D>));});
 test("axis metadata cannot admit other fields or out-of-range indices",f=>{rejects(f,()=>f.view.transform3d({position:[.2,0,0]},{property:"position",index:3 as 0}));rejects(f,()=>f.view.transform3d({position:[.2,0,0]},{property:"scale",index:0}));rejects(f,()=>f.view.transform3d({position:[.2,0,0],scale:[1,1,1]},{property:"position",index:0}));});
 test("same-ID delete/re-add does not revive a view",f=>{f.run({type:"batch",commands:[{type:"delete_clip",clipId:f.clip.id},{type:"add_clip",clip:structuredClone(f.clip)}]});f.timeline.setSelectedClipId(f.clip.id);rejects(f,()=>f.edit("position",0,.2));});
 test("source geometry mutation retires the old view",f=>{f.run({type:"move_clip",clipId:f.clip.id,timelineStart:1});rejects(f,()=>f.edit("position",0,.2));});
 test("original locked-track refusal is preserved",f=>{f.run({type:"toggle_track_lock",trackId:f.clip.trackId});const h=f.session.getSnapshot().history;assert.equal(f.edit("position",0,.2),false);assert.equal(f.session.getSnapshot().history,h);});
 test("runner refusal does not advance own expectations",f=>{let refused=true;const v=f.make({runCommand:c=>refused?false:f.run(c)});assert.equal(v.transform3d({position:[.2,0,0]},{property:"position",index:0}),false);refused=false;assert(v.transform3d({position:[.3,0,0]},{property:"position",index:0}));});
 test("void or throwing runner is not acknowledged",f=>{for(const runCommand of [()=>{},()=>{throw Error("refused");}])assert.equal(f.make({runCommand}).transform3d({position:[.2,0,0]},{property:"position",index:0}),false);assert.equal(f.calls.length,0);});
 test("precommit selection change cannot publish",f=>{let reads=0;const v=f.make({getSnapshot:()=>{if(++reads===3)f.timeline.setSelectedClipId("other");return f.session.getSnapshot();}});rejects(f,()=>v.transform3d({position:[.2,0,0]},{property:"position",index:0}));});
});
