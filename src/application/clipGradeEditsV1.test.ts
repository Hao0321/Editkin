import assert from "node:assert/strict";
import {describe,it} from "vitest";
import {createDemoProject} from "../domain/demo";
import {findClip} from "../domain/editGraph";
import {dispatchCommandSafely,undo,redo} from "../domain/history";
import {createProjectSession} from "./projectSession";
import {createTimelineEditingState} from "./timelineEditingState";
import {createGraphicEditingSelectionV1} from "./graphicEditingSelectionV1";
import {createClipGradeEditsV1} from "./clipGradeEditsV1";
import type {ColorGradeV2} from "../domain/types";
import type {EditorCommand} from "../domain/commandTypes";
function fixture(){
 const p=createDemoProject(),clip=p.tracks[0].clips[0];clip.gradeV2={schema:"editkin.color-grade/v2",look:{id:"hfl2_food_warm_appetite",strength:.6},nodes:[{id:"grade1",contrast:1.2}]};
 p.tracks[0].clips.push({...structuredClone(clip),id:"other",timelineStart:20});
 const session=createProjectSession(p),timeline=createTimelineEditingState(session),selection=createGraphicEditingSelectionV1(session,timeline),off=selection.subscribe(()=>{});
 timeline.setSelectedClipId(clip.id);
 const calls:EditorCommand[]=[],notices:string[]=[],behavior={ack:true,reply:true};
 const runCommand=(command:EditorCommand)=>{calls.push(command);if(!behavior.ack)return behavior.reply;const r=dispatchCommandSafely(session.getSnapshot().history,command,"g"+calls.length);session.setHistory(r.state);return !r.error&&behavior.reply;};
 const host={getSnapshot:session.getSnapshot,getSelectionSnapshot:selection.getSnapshot,runCommand,setStatus:(s:string)=>notices.push(s)};
 const make=()=>createClipGradeEditsV1(host,{project:session.getSnapshot().history.present,clipId:clip.id,selection:selection.getSnapshot()});
 const action=make(),project=()=>session.getSnapshot().history.present,current=()=>findClip(project(),clip.id);
 const grade=(strength:number):ColorGradeV2=>({...structuredClone(clip.gradeV2!),look:{id:"hfl2_food_warm_appetite",strength}});
 const external=(command:EditorCommand)=>{const r=dispatchCommandSafely(session.getSnapshot().history,command,"external");assert(!r.error,r.error);session.setHistory(r.state);};
 return {p,clip,session,timeline,selection,off,calls,notices,behavior,action,make,project,current,grade,external};
}
describe("canonical clip grade v2 action owner",()=>{
 it("applies the exact original command, preserves other fields and has one Undo",()=>{const f=fixture(),before=structuredClone(f.clip);try{assert.equal(f.action.set(f.grade(.3)),true);assert.equal(f.calls.length,1);assert.equal(f.calls[0].type,"set_clip_grade_v2");assert.deepEqual({...f.current(),gradeV2:before.gradeV2},before);f.session.setHistory(undo(f.session.getSnapshot().history));assert.deepEqual(f.current().gradeV2,before.gradeV2);}finally{f.off();}});
 it("unchanged grade emits no command or dirty history",()=>{const f=fixture();try{const h=f.session.getSnapshot().history;assert.equal(f.action.set(f.grade(.6)),true);assert.equal(f.calls.length,0);assert.equal(f.session.getSnapshot().history,h);}finally{f.off();}});
 it("the same acknowledged callback advances its own expected grade",()=>{const f=fixture();try{assert(f.action.set(f.grade(.3)));assert(f.action.set(f.grade(.8)));assert.equal(f.current().gradeV2?.look?.strength,.8);assert.equal(f.calls.length,2);}finally{f.off();}});
 it("repeated acknowledged identical grade is a no-op",()=>{const f=fixture();try{assert(f.action.set(f.grade(.3)));assert(f.action.set(f.grade(.3)));assert.equal(f.calls.length,1);}finally{f.off();}});
 it("old selection never writes its former clip",()=>{const f=fixture();try{f.timeline.setSelectedClipId("other");assert.equal(f.action.set(f.grade(.3)),false);assert.equal(f.calls.length,0);}finally{f.off();}});
 it("selection A-B-A retires the old occurrence",()=>{const f=fixture();try{f.timeline.setSelectedClipId("other");f.timeline.setSelectedClipId(f.clip.id);assert.equal(f.action.set(f.grade(.3)),false);assert.equal(f.calls.length,0);}finally{f.off();}});
 it("same-ID reopened project rejects old writes and old status publication",()=>{const f=fixture();try{f.session.replaceProject(structuredClone(f.p));assert.equal(f.action.set(f.grade(.3)),false);assert.equal(f.calls.length,0);assert.equal(f.notices.length,0);}finally{f.off();}});
 it("Undo-Redo does not re-admit an old callback",()=>{const f=fixture();try{f.external({type:"set_clip_volume",clipId:f.clip.id,volume:.4});f.session.setHistory(undo(f.session.getSnapshot().history));f.session.setHistory(redo(f.session.getSnapshot().history));assert.equal(f.action.set(f.grade(.3)),false);assert.equal(f.calls.length,0);}finally{f.off();}});
 it("external grade conflict is never overwritten",()=>{const f=fixture();try{f.external({type:"set_clip_grade_v2",clipId:f.clip.id,grade:f.grade(.9)});assert.equal(f.action.set(f.grade(.3)),false);assert.equal(f.calls.length,0);assert.equal(f.current().gradeV2?.look?.strength,.9);}finally{f.off();}});
 it("external disjoint transform is preserved by a valid grade edit",()=>{const f=fixture();try{f.external({type:"update_clip_transform",clipId:f.clip.id,patch:{x:42}});assert(f.action.set(f.grade(.3)));assert.equal(f.current().transform.x,42);}finally{f.off();}});
 it("locked track is rejected before invoking the runner",()=>{const f=fixture();try{const p=structuredClone(f.project());p.tracks[0].locked=true;f.session.setHistory({...f.session.getSnapshot().history,present:p});assert.equal(f.action.set(f.grade(.3)),false);assert.equal(f.calls.length,0);}finally{f.off();}});
 it("same-ID source identity changes invalidate the rendered grade target",()=>{const f=fixture();try{const p=structuredClone(f.project());p.assets[0].uri="replacement-source.mp4";f.session.setHistory({...f.session.getSnapshot().history,present:p});assert.equal(f.action.set(f.grade(.3)),false);assert.equal(f.calls.length,0);}finally{f.off();}});
 it("external node edits cannot be lost by stale full-grade payload",()=>{const f=fixture();try{f.external({type:"set_clip_grade_v2",clipId:f.clip.id,grade:{...f.grade(.6),nodes:[{id:"grade1",contrast:2}]}});assert.equal(f.action.set(f.grade(.3)),false);assert.equal(f.calls.length,0);assert.equal(f.current().gradeV2?.nodes?.[0].contrast,2);}finally{f.off();}});
 it("invalid strength is rejected before invoking the runner",()=>{const f=fixture();try{for(const v of [NaN,Infinity,-.1,1.1])assert.equal(f.action.set(f.grade(v)),false);assert.equal(f.calls.length,0);}finally{f.off();}});
 it("missing Look ID is rejected before invoking the runner",()=>{const f=fixture();try{assert.equal(f.action.set({...f.grade(.3),look:{id:"hfl2_not_installed",strength:.3}}),false);assert.equal(f.calls.length,0);}finally{f.off();}});
 it("unacknowledged runner cannot advance expected grade",()=>{const f=fixture();try{f.behavior.ack=false;assert.equal(f.action.set(f.grade(.3)),false);f.behavior.ack=true;assert(f.action.set(f.grade(.8)));assert.equal(f.current().gradeV2?.look?.strength,.8);}finally{f.off();}});
 it("null removes a grade once and repeated null is a no-op",()=>{const f=fixture();try{assert(f.action.set(null));assert.equal(f.current().gradeV2,undefined);assert(f.action.set(null));assert.equal(f.calls.length,1);}finally{f.off();}});
 it("Look strength planning is pure and retains nodes",()=>{const f=fixture();try{const h=f.session.getSnapshot().history,plan=f.action.planLookStrength(.25);assert(plan?.command);assert.equal(plan.command.type,"set_clip_grade_v2");if(plan.command.type==="set_clip_grade_v2")assert.deepEqual(plan.command.grade,{...f.grade(.25)});assert.equal(f.session.getSnapshot().history,h);assert.equal(f.calls.length,0);}finally{f.off();}});
});

