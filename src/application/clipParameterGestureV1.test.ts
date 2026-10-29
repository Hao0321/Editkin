import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { ColorAdjustments } from "../domain/types";
import type { EditorCommand } from "../domain/commandTypes";
import { createDemoProject } from "../domain/demo";
import { createProjectSession } from "./projectSession";
import { createTimelineEditingState } from "./timelineEditingState";
import { createGraphicEditingSelectionV1 } from "./graphicEditingSelectionV1";
import { dispatchCommandSafely, undo, redo } from "../domain/history";
import { applyCommand } from "../domain/commands";
import { createClipAppearanceEditsV1 } from "./clipAppearanceEditsV1";
import { createClipParameterGestureV1 } from "./clipParameterGestureV1";
import { renderNumberEditFieldV1, createNumberEditDraftV1 } from "../ui/NumberEditFieldV1";
import { projectSchema } from "../domain/schema";
function fixture(){
 const p=createDemoProject(),clip=p.tracks[0].clips[0];clip.transform.x=12;p.tracks[0].clips.push({...structuredClone(clip),id:"other",timelineStart:20});
 const session=createProjectSession(p),timeline=createTimelineEditingState(session),selection=createGraphicEditingSelectionV1(session,timeline),off=selection.subscribe(()=>{});timeline.setSelectedClipId(clip.id);
 const calls: EditorCommand[]=[],transport={playhead:1,seekRevision:0},project=()=>session.getSnapshot().history.present;
 const runCommand=(command: EditorCommand)=>{calls.push(command);const r=dispatchCommandSafely(session.getSnapshot().history,command,"c"+calls.length);session.setHistory(r.state);return !r.error;};
 const host={getSnapshot:session.getSnapshot,getSelectionSnapshot:selection.getSnapshot,getTransport:()=>transport,runCommand,setStatus:()=>{},makeId:(p: string)=>p+"-source"};
 const view=createClipAppearanceEditsV1(host,{project:p,clipId:clip.id,selection:selection.getSnapshot(),transport:{...transport}});
 const volumeCallback=(value:number)=>view.volume(value);
 const owner=createClipParameterGestureV1({session,getSelectionSnapshot:selection.getSnapshot,subscribeSelection:selection.subscribe}),release=owner?.subscribe(()=>{});
 function number(){return renderNumberEditFieldV1({value:clip.transform.x,scope:selection.getSnapshot(),onCommit:value=>view.transform({x:value}),draft:createNumberEditDraftV1()}); }

 function gesture(kind: "base-color" | "volume"="base-color",field: keyof ColorAdjustments="exposure"){
  return owner.begin({clipId:clip.id,selection:selection.getSnapshot(),parameterId:kind+"."+field,initial:kind==="volume"?clip.volume:clip.color[field]??0,
   plan:value=>kind==="volume"?view.planVolume(value):view.planBaseColor({[field]:value}),
   commit:value=>kind==="volume"?view.volume(value):view.baseColor({[field]:value}),
   isCurrent:kind==="volume"?undefined:()=>transport.playhead===1&&transport.seekRevision===0})!;
 }
 return {p,clip,session,timeline,selection,view,calls,project,runCommand,volumeCallback,number,gesture,owner,transport,close(){release?.();off();}};
}

describe("basic clip parameter planning and current-owner gestures",()=>{
const test=(id:string,run:()=>void)=>it(id,run);
function events(f: ReturnType<typeof fixture>){const node=f.number(),target={value:"12",valueAsNumber:12};return {node,target,change:(value:string)=>{target.value=value;target.valueAsNumber=Number(value);node.props.onChange?.({target,currentTarget:target});},blur:()=>node.props.onBlur?.({currentTarget:target}),key:(key:string,nativeEvent: {isComposing?:boolean;keyCode?:number}={})=>node.props.onKeyDown?.({key,nativeEvent,currentTarget:target,preventDefault(){},stopPropagation(){}})};}
test("number-empty-does-not-write-zero",()=>{const f=fixture(),e=events(f);e.change("");assert.equal(f.project().tracks[0].clips[0].transform.x,12);assert.equal(f.calls.length,0);f.close();});
test("number-edit-is-one-blur-command",()=>{const f=fixture(),e=events(f);e.change("2");e.change("24");assert.equal(f.calls.length,0);e.blur();assert.equal(f.calls.length,1);assert.equal(f.project().tracks[0].clips[0].transform.x,24);f.close();});
test("number-escape-discards-draft",()=>{const f=fixture(),e=events(f);e.change("24");e.key("Escape");e.blur();assert.equal(f.calls.length,0);assert.equal(f.project().tracks[0].clips[0].transform.x,12);f.close();});
test("number-IME-enter-does-not-submit",()=>{const f=fixture(),e=events(f);e.change("24");e.key("Enter",{isComposing:true});assert.equal(f.calls.length,0);e.key("Enter",{keyCode:229});assert.equal(f.calls.length,0);f.close();});
for(const state of ["other-selection","a-b-a","same-id-reopen"]){test("volume-"+state+"-refused",()=>{const f=fixture();if(state==="same-id-reopen")f.session.replaceProject(structuredClone(f.project()));else f.timeline.setSelectedClipId("other");if(state==="a-b-a"||state==="same-id-reopen")f.timeline.setSelectedClipId(f.clip.id);f.volumeCallback(.4);assert.equal(f.calls.length,0);assert.equal(f.project().tracks[0].clips[0].volume,1);f.close();});}
test("volume-current-command-and-undo",()=>{const f=fixture();f.volumeCallback(.5);assert.equal(f.calls.length,1);assert.equal(f.project().tracks[0].clips[0].volume,.5);f.session.setHistory(undo(f.session.getSnapshot().history));assert.equal(f.project().tracks[0].clips[0].volume,1);f.close();});
test("volume-no-op-does-not-add-undo",()=>{const f=fixture();f.volumeCallback(1);assert.equal(f.calls.length,0);f.close();});
test("volume-external-same-field-conflict-refused",()=>{const f=fixture();f.runCommand({type:"set_clip_volume",clipId:f.clip.id,volume:.4});f.volumeCallback(.7);assert.equal(f.calls.length,1);assert.equal(f.project().tracks[0].clips[0].volume,.4);f.close();});
for(const kind of ["base-color","volume"] as const){
 test(kind+"-samples-are-only-drafts",()=>{const f=fixture(),lease=f.gesture(kind);assert(lease);for(const value of [.3,.5,.8])assert(lease.update(value));assert.equal(f.calls.length,0);assert.equal(kind==="volume"?f.owner.getSnapshot().preview!.project.tracks[0].clips[0].volume:f.owner.getSnapshot().preview!.project.tracks[0].clips[0].color.exposure,.8);f.close();});
 test(kind+"-release-one-command-one-undo",()=>{const f=fixture(),lease=f.gesture(kind);assert(lease);for(const value of [.3,.5,.8])lease.update(value);assert(lease.commit());assert.equal(f.calls.length,1);assert.equal(f.session.getSnapshot().history.past.length,1);f.close();});
 test(kind+"-cancel-discards",()=>{const f=fixture(),lease=f.gesture(kind);assert(lease);lease.update(.8);lease.cancel();assert.equal(f.calls.length,0);f.close();});
}

for(const kind of ["base-color","volume"] as const){
 for(const state of ["select","a-b-a","reopen","undo-redo","external"]){
 test(kind+"-lease-retires-"+state,()=>{const f=fixture(),lease=f.gesture(kind);assert(lease.update(.8));if(state==="reopen")f.session.replaceProject(structuredClone(f.project()));else if(state==="select"||state==="a-b-a"){f.timeline.setSelectedClipId("other");if(state==="a-b-a")f.timeline.setSelectedClipId(f.clip.id);}else{f.runCommand({type:"set_clip_volume",clipId:"other",volume:.5});if(state==="undo-redo"){f.session.setHistory(undo(f.session.getSnapshot().history));f.session.setHistory(redo(f.session.getSnapshot().history));}}const count=f.calls.length;assert.equal(lease.update(.9),false);assert.equal(lease.commit(),false);assert.equal(f.calls.length,count);f.close();});
 }
 test(kind+"-save-does-not-contain-draft",()=>{const f=fixture(),lease=f.gesture(kind);assert(lease.update(.7));const request=f.session.beginSave()!;assert.equal(request.project.tracks[0].clips[0].color.exposure,0);assert.equal(request.project.tracks[0].clips[0].volume,1);f.session.completeSave(request,{canceled:true});f.session.finishSave(request);assert(lease.commit());assert.equal(f.calls.length,1);f.close();});
 test(kind+"-last-detach-retires",()=>{const f=fixture(),lease=f.gesture(kind);lease.update(.7);f.close();assert.equal(lease.update(.8),false);assert.equal(lease.commit(),false);assert.equal(f.calls.length,0);});
 test(kind+"-unchanged-release-no-history",()=>{const f=fixture(),lease=f.gesture(kind);assert(lease.update(kind==="volume"?1:0));assert(lease.commit());assert.equal(f.calls.length,0);f.close();});
}
test("volume-uses-same-field-ack-and-can-return-to-original-before-rerender",()=>{const f=fixture();assert(f.view.volume(.3));assert(f.view.volume(.6));assert(f.view.volume(1));assert.equal(f.calls.length,3);assert.equal(f.project().tracks[0].clips[0].volume,1);f.close();});
test("volume-continues-after-transport-only-change",()=>{const f=fixture();f.transport.playhead=2;f.transport.seekRevision++;assert(f.view.volume(.5));assert.equal(f.view.transform({x:2}),false);assert.equal(f.calls.length,1);f.close();});
test("volume-plan-does-not-advance-own-write-expectation",()=>{const f=fixture(),snapshot=f.session.getSnapshot();assert(f.view.planVolume(.3)?.command);assert(f.view.planVolume(.7)?.command);assert.equal(f.session.getSnapshot(),snapshot);assert(f.view.volume(.7));assert.equal(f.calls.length,1);f.close();});
test("volume-invalid-values-never-reach-runner",()=>{const f=fixture();for(const value of [NaN,Infinity,-1,2.1])assert.equal(f.view.volume(value),false);assert.equal(f.calls.length,0);f.close();});
test("volume-preserves-disjoint-color-change",()=>{const f=fixture();f.runCommand({type:"set_clip_color",clipId:f.clip.id,patch:{exposure:1}});assert(f.view.volume(.4));assert.equal(f.project().tracks[0].clips[0].color.exposure,1);f.close();});
test("volume-lock-remains-domain-owned",()=>{const f=fixture();f.runCommand({type:"toggle_track_lock",trackId:f.clip.trackId});const before=JSON.stringify(f.project());assert.equal(f.view.volume(.7),false);assert.equal(JSON.stringify(f.project()),before);f.close();});
test("Primary-all-thirteen-controls-can-plan-without-canonical-writes",()=>{const f=fixture();for(const key of ["exposure","temperature","tint","contrast","pivot","saturation","shadows","highlights","blacks","whites","whiteBalanceRed","whiteBalanceGreen","whiteBalanceBlue"] as const){const value=["contrast","saturation"].includes(key)?1.2:key==="pivot"?.6:.3;const plan=f.view.planBaseColor({[key]:value});assert(plan?.command);const projected=applyCommand(f.project(),plan.command);assert.equal(projected.tracks[0].clips[0].color[key],value);}assert.equal(f.calls.length,0);f.close();});
test("base-primary-plan-does-not-create-animation",()=>{const f=fixture();f.runCommand({type:"add_keyframe",clipId:f.clip.id,keyframe:{id:"k",time:0,transform:{...f.clip.transform},color:{...f.clip.color},easing:"linear"}});const clip=f.project().tracks[0].clips[0],view=createClipAppearanceEditsV1({getSnapshot:f.session.getSnapshot,getSelectionSnapshot:f.selection.getSnapshot,getTransport:()=>f.transport,runCommand:f.runCommand,setStatus:()=>{},makeId:()=>{throw Error("base must not need ID");}},{project:f.project(),clipId:clip.id,selection:f.selection.getSnapshot(),transport:{...f.transport}});const plan=view.planBaseColor({exposure:.4})!;assert.equal(plan.command!.type,"set_clip_color");const before=JSON.stringify(clip.keyframes);const projected=applyCommand(f.project(),plan.command!);assert.equal(JSON.stringify(projected.tracks[0].clips[0].keyframes),before);f.close();});
test("animated-transform-plan-keeps-canonical-frame-unmodified",()=>{const f=fixture();f.runCommand({type:"add_keyframe",clipId:f.clip.id,keyframe:{id:"k",time:0,transform:{...f.clip.transform},color:{...f.clip.color},easing:"linear"}});const project=f.project(),view=createClipAppearanceEditsV1({getSnapshot:f.session.getSnapshot,getSelectionSnapshot:f.selection.getSnapshot,getTransport:()=>f.transport,runCommand:f.runCommand,setStatus:()=>{},makeId:()=>"preview-frame"},{project,clipId:f.clip.id,selection:f.selection.getSnapshot(),transport:{...f.transport}});const plan=view.planTransform({scale:1.5});assert.equal(plan?.command?.type,"add_keyframe");assert.equal(f.project(),project);assert.equal(f.project().tracks[0].clips[0].keyframes.length,1);const projected=applyCommand(project,plan!.command!);assert.equal(projected.tracks[0].clips[0].keyframes.at(-1)!.transform.scale,1.5);f.close();});
test("projection-keeps-durable-identity-and-schema-while-canonical-is-exact",()=>{const f=fixture(),before=JSON.stringify(f.project()),lease=f.gesture("base-color");lease.update(.7);const p=f.owner.getSnapshot().preview!.project;assert.equal(p.updatedAt,f.project().updatedAt);assert.equal(p.revision,f.project().revision);assert.equal(p.id,f.project().id);assert.deepEqual(projectSchema.parse(JSON.parse(JSON.stringify(p))),JSON.parse(JSON.stringify(p)));assert.equal(JSON.stringify(f.project()),before);f.close();});
test("transport-invalidation-retires-color-not-a-stale-keyframe",()=>{const f=fixture(),lease=f.gesture("base-color");lease.update(.7);f.transport.seekRevision++;assert.equal(lease.commit(),false);assert.equal(f.calls.length,0);f.close();});
for(const command of [{type:"set_project_color_management",patch:{mode:"aces2"}},{type:"set_clip_volume",clipId:"other",volume:.5}] as EditorCommand[]){
 test("forged-plan-outside-selected-clip-is-refused-"+command.type,()=>{const f=fixture(),lease=f.owner.begin({clipId:f.clip.id,selection:f.selection.getSnapshot(),parameterId:"volume",initial:1,plan:()=>({command}),commit:()=>true})!;assert.equal(lease.update(.5),false);assert.equal(f.calls.length,0);assert.equal(f.owner.getSnapshot().preview,undefined);f.close();});
}
test("invalid-plan-cannot-mutate-any-canonical-data",()=>{const f=fixture(),before=JSON.stringify(f.project()),lease=f.owner.begin({clipId:f.clip.id,selection:f.selection.getSnapshot(),parameterId:"volume",initial:1,plan:()=>({command:{type:"set_clip_volume",clipId:f.clip.id,volume:99}}),commit:()=>true})!;assert.equal(lease.update(.5),false);assert.equal(JSON.stringify(f.project()),before);f.close();});
test("reentrant-selection-during-retirement-refuses-release",()=>{const f=fixture(),lease=f.gesture("volume");let seen=false;const off=f.owner.subscribe(()=>{if(f.owner.getSnapshot().preview)seen=true;else if(seen)f.timeline.setSelectedClipId("other");});lease.update(.6);assert.equal(lease.commit(),false);assert.equal(f.calls.length,0);off();f.close();});

});

