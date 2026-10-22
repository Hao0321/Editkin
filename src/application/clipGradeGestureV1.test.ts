import assert from "node:assert/strict";
import {describe,it} from "vitest";
import {createDemoProject} from "../domain/demo";
import {findClip} from "../domain/editGraph";
import {dispatchCommandSafely,undo,redo} from "../domain/history";
import {createProjectSession} from "./projectSession";
import {createTimelineEditingState} from "./timelineEditingState";
import {createGraphicEditingSelectionV1} from "./graphicEditingSelectionV1";
import {createClipGradeEditsV1} from "./clipGradeEditsV1";
import {createClipParameterGestureV1} from "./clipParameterGestureV1";
import type {EditorCommand} from "../domain/commandTypes";
function fixture(){
 const p=createDemoProject(),clip=p.tracks[0].clips[0];clip.gradeV2={schema:"editkin.color-grade/v2",look:{id:"hfl2_food_warm_appetite",strength:.6},nodes:[{id:"grade1",contrast:1.2}]};
 p.tracks[0].clips.push({...structuredClone(clip),id:"other",timelineStart:20});
 const session=createProjectSession(p),timeline=createTimelineEditingState(session),selection=createGraphicEditingSelectionV1(session,timeline),off=selection.subscribe(()=>{});timeline.setSelectedClipId(clip.id);
 const calls:EditorCommand[]=[],runCommand=(command:EditorCommand)=>{calls.push(command);const r=dispatchCommandSafely(session.getSnapshot().history,command,"g"+calls.length);session.setHistory(r.state);return !r.error;};
 const view={project:p,clipId:clip.id,selection:selection.getSnapshot()},edits=createClipGradeEditsV1({getSnapshot:session.getSnapshot,getSelectionSnapshot:selection.getSnapshot,runCommand,setStatus:()=>{}},view);
 const owner=createClipParameterGestureV1({session,getSelectionSnapshot:selection.getSnapshot,subscribeSelection:selection.subscribe}),release=owner.subscribe(()=>{});
 const begin=()=>owner.begin({clipId:clip.id,selection:view.selection,parameterId:"grade-v2.look.strength",initial:.6,plan:edits.planLookStrength,commit:edits.lookStrength});
 return {p,clip,session,timeline,selection,calls,owner,edits,begin,close:()=>{release();off();}};
}
describe("grade Look strength transient projection",()=>{
 it("projects every sample without canonical mutation and commits exactly one command/Undo",()=>{const f=fixture();try{const history=f.session.getSnapshot().history,lease=f.begin();assert(lease);for(const v of [.4,.2,.8]){assert(lease.update(v));assert.equal(f.owner.getSnapshot().preview?.project.tracks[0].clips[0].gradeV2?.look?.strength,v);assert.equal(f.session.getSnapshot().history,history);}assert.equal(f.calls.length,0);assert(lease.commit());assert.equal(f.calls.length,1);assert.equal(f.session.getSnapshot().history.past.length,1);assert.equal(f.owner.getSnapshot().preview,undefined);f.session.setHistory(undo(f.session.getSnapshot().history));assert.equal(findClip(f.session.getSnapshot().history.present,f.clip.id).gradeV2?.look?.strength,.6);f.session.setHistory(redo(f.session.getSnapshot().history));assert.equal(findClip(f.session.getSnapshot().history.present,f.clip.id).gradeV2?.look?.strength,.8);}finally{f.close();}});
 it("cancel restores the canonical view and creates no history",()=>{const f=fixture();try{const lease=f.begin();assert(lease);assert(lease.update(.2));lease.cancel();assert.equal(f.owner.getSnapshot().preview,undefined);assert.equal(f.calls.length,0);assert.equal(f.clip.gradeV2?.look?.strength,.6);}finally{f.close();}});
 it("returning to the original strength is a no-op",()=>{const f=fixture();try{const lease=f.begin();assert(lease);assert(lease.update(.2));assert(lease.update(.6));assert(lease.commit());assert.equal(f.calls.length,0);}finally{f.close();}});
 it("draft retains exact persisted headers, node settings and other clip fields",()=>{const f=fixture();try{const lease=f.begin();assert(lease);assert(lease.update(.2));const preview=f.owner.getSnapshot().preview!;assert.deepEqual([preview.project.id,preview.project.revision,preview.project.updatedAt],[f.p.id,f.p.revision,f.p.updatedAt]);assert.deepEqual(preview.project.tracks[0].clips[0].gradeV2?.nodes,f.clip.gradeV2?.nodes);assert.equal(f.owner.getSnapshot().epoch>0,true);lease.cancel();}finally{f.close();}});
 it("selection A-B-A invalidates a held Look edit",()=>{const f=fixture();try{const lease=f.begin();assert(lease);assert(lease.update(.2));f.timeline.setSelectedClipId("other");f.timeline.setSelectedClipId(f.clip.id);assert.equal(lease.commit(),false);assert.equal(f.calls.length,0);assert.equal(f.owner.getSnapshot().preview,undefined);}finally{f.close();}});
 it("same-ID reopen cannot receive a held draft",()=>{const f=fixture();try{const lease=f.begin();assert(lease);assert(lease.update(.2));f.session.replaceProject(structuredClone(f.p));assert.equal(lease.commit(),false);assert.equal(f.calls.length,0);}finally{f.close();}});
 it("invalid strength never reaches command history",()=>{const f=fixture();try{const lease=f.begin();assert(lease);for(const v of [-1,2,NaN,Infinity])assert.equal(lease.update(v),false);assert.equal(f.calls.length,0);lease.cancel();}finally{f.close();}});
 it("unmount retires a held draft",()=>{const f=fixture(),lease=f.begin();assert(lease);assert(lease.update(.2));f.close();assert.equal(lease.commit(),false);assert.equal(f.calls.length,0);});
});

