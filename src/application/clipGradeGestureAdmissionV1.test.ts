import assert from "node:assert/strict";
import {describe,it} from "vitest";
import {createDemoProject} from "../domain/demo";
import {createProjectSession} from "./projectSession";
import {createTimelineEditingState} from "./timelineEditingState";
import {createGraphicEditingSelectionV1} from "./graphicEditingSelectionV1";
import {createClipParameterGestureV1} from "./clipParameterGestureV1";
import {dispatchCommandSafely} from "../domain/history";
function fixture(){
 const p=createDemoProject(),clip=p.tracks[0].clips[0];clip.gradeV2={schema:"editkin.color-grade/v2",nodes:[{id:"grade1",contrast:1}]};
 p.tracks[0].clips.push({...structuredClone(clip),id:"other",timelineStart:20});
 const session=createProjectSession(p),timeline=createTimelineEditingState(session),selection=createGraphicEditingSelectionV1(session,timeline),off=selection.subscribe(()=>{});timeline.setSelectedClipId(clip.id);
 const owner=createClipParameterGestureV1({session,getSelectionSnapshot:selection.getSnapshot,subscribeSelection:selection.subscribe}),release=owner.subscribe(()=>{});
 const start=selection.getSnapshot(),begin=(initial=clip.gradeV2!)=>owner.beginGrade({clipId:clip.id,selection:start,parameterId:"grade-v2",initial,plan:g=>({command:{type:"set_clip_grade_v2",clipId:clip.id,grade:g}}),commit:()=>true});
 const volume=()=>owner.begin({clipId:clip.id,selection:selection.getSnapshot(),parameterId:"volume",initial:1,plan:v=>({command:{type:"set_clip_volume",clipId:clip.id,volume:v}}),commit:()=>true});
 return {p,clip,session,timeline,selection,owner,begin,volume,start,close:()=>{release();off();}};
}
describe("canonical grade gesture admission before retirement",()=>{
 it("matching canonical grade can begin without history writes",()=>{const f=fixture();try{const h=f.session.getSnapshot().history,lease=f.begin();assert(lease);assert(lease.update({...f.clip.gradeV2!,nodes:[{id:"grade1",contrast:2}]}));assert.equal(f.session.getSnapshot().history,h);lease.cancel();}finally{f.close();}});
 it("old grade initial is refused after a canonical grade commit",()=>{const f=fixture();try{const r=dispatchCommandSafely(f.session.getSnapshot().history,{type:"set_clip_grade_v2",clipId:f.clip.id,grade:{...f.clip.gradeV2!,nodes:[{id:"grade1",contrast:2}]}},"forward");assert(!r.error);f.session.setHistory(r.state);assert.equal(f.begin(),undefined);}finally{f.close();}});
 it("stale initial cannot cancel the active scalar projection",()=>{const f=fixture();try{const r=dispatchCommandSafely(f.session.getSnapshot().history,{type:"set_clip_grade_v2",clipId:f.clip.id,grade:{...f.clip.gradeV2!,nodes:[{id:"grade1",contrast:2}]}},"forward");assert(!r.error);f.session.setHistory(r.state);const lease=f.volume();assert(lease?.update(.3));const current=f.owner.getSnapshot();assert.equal(f.begin(),undefined);assert.equal(f.owner.getSnapshot(),current);}finally{f.close();}});
 it("invalid full-grade initial cannot retire another valid held input",()=>{const f=fixture();try{const scalar=f.volume();assert(scalar?.update(.3));const current=f.owner.getSnapshot();assert.equal(f.begin({...f.clip.gradeV2!,nodes:[{id:"grade1",contrast:NaN}]}),undefined);assert.equal(f.owner.getSnapshot(),current);}finally{f.close();}});
 it("old selection begin does not cancel the new selection's active projection",()=>{const f=fixture();try{f.timeline.setSelectedClipId("other");const active=f.owner.begin({clipId:"other",selection:f.selection.getSnapshot(),parameterId:"volume",initial:1,plan:v=>({command:{type:"set_clip_volume",clipId:"other",volume:v}}),commit:()=>true});assert(active?.update(.2));const current=f.owner.getSnapshot();assert.equal(f.begin(),undefined);assert.equal(f.owner.getSnapshot(),current);}finally{f.close();}});
 it("schema-equivalent field insertion order is admitted",()=>{const f=fixture();try{const lease=f.begin({nodes:structuredClone(f.clip.gradeV2!.nodes!),schema:"editkin.color-grade/v2"});assert(lease);lease.cancel();}finally{f.close();}});
});

