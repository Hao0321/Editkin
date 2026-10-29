import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { EditorCommand } from "../domain/commandTypes";
import type { ColorAdjustments } from "../domain/types";
import { createDemoProject } from "../domain/demo";
import { DEFAULT_TRANSFORM, DEFAULT_COLOR } from "../domain/types";
import { animatedClipState, findClip } from "../domain/editGraph";
import { dispatchCommandSafely, undo, redo } from "../domain/history";
import { projectSchema } from "../domain/schema";
import { createProjectSession } from "./projectSession";
import { createTimelineEditingState } from "./timelineEditingState";
import { createGraphicEditingSelectionV1 } from "./graphicEditingSelectionV1";
import { createClipAppearanceEditsV1 } from "./clipAppearanceEditsV1";

function fixture({animated=false,between=false,outside=false}: {animated?:boolean;between?:boolean;outside?:boolean}={}) {
  const p=createDemoProject(),clip=p.tracks.flatMap(t=>t.clips)[0],track=p.tracks.find(t=>t.id===clip.trackId)!;
  clip.transform={...DEFAULT_TRANSFORM};clip.color={...DEFAULT_COLOR};clip.keyframes=[];
  if(animated)clip.keyframes=[{id:"k0",time:0,transform:{...clip.transform},color:{...clip.color},easing:"linear"},{id:"k1",time:1,transform:{...clip.transform,x:12},color:{...clip.color,brightness:.1},easing:"linear"},{id:"k2",time:4,transform:{...clip.transform,x:24},color:{...clip.color,brightness:.2},easing:"ease_out"}];
  track.clips.push({...structuredClone(clip),id:"second",timelineStart:clip.timelineStart+clip.duration+1});
  const session=createProjectSession(p),timeline=createTimelineEditingState(session),state=createGraphicEditingSelectionV1(session,timeline);
  const detach=state.subscribe(()=>{});timeline.setSelectedClipId(clip.id);
  const calls: EditorCommand[]=[],statuses: string[]=[];
  let transport={playhead:outside?clip.timelineStart+clip.duration+1:clip.timelineStart+(between?2:1),seekRevision:1};
  const runCommand=(command: EditorCommand)=>{
    calls.push(command);const result=dispatchCommandSafely(session.getSnapshot().history,command,"c"+calls.length);
    if(result.error)statuses.push(result.error);session.setHistory(result.state);return !result.error;
  };
  const graph=()=>session.getSnapshot().history.present,readClip=()=>findClip(graph(),clip.id);
  const host={getSnapshot:session.getSnapshot,getSelectionSnapshot:state.getSnapshot,getTransport:()=>transport,runCommand,
    setStatus:(message: string)=>statuses.push(message),makeId:(prefix: string)=>prefix+"-"+calls.length};
  const view=(overrides: Partial<Parameters<typeof createClipAppearanceEditsV1>[0]>={})=>createClipAppearanceEditsV1(
    {...host,...overrides},{project:graph(),clipId:clip.id,selection:state.getSnapshot(),transport:{...transport}});
  return {session,timeline,state,detach,calls,statuses,host,graph,clip:readClip,clipId:clip.id,view,runCommand,
    transport:()=>transport,setTransport:(value: typeof transport)=>{transport=value;},
    animated:()=>animatedClipState(readClip(),transport.playhead-readClip().timelineStart,graph().fps)};
}
type Fixture = ReturnType<typeof fixture>;
function reject(f: Fixture,fn:()=>boolean) {
  const before=JSON.stringify(f.session.getSnapshot().history),n=f.calls.length;
  assert.equal(fn(),false);assert.equal(JSON.stringify(f.session.getSnapshot().history),before);assert.equal(f.calls.length,n);
}
describe("current-owner clip appearance edits",()=>{
  const test = (name: string, run: ()=>void)=>it(name,run);
test("base-transform-one-undo-redo-json",()=>{const f=fixture();assert(f.view().transform({x:20}));assert.equal(f.clip().transform.x,20);assert.equal(f.session.getSnapshot().history.past.length,1);f.session.setHistory(undo(f.session.getSnapshot().history));assert.equal(f.clip().transform.x,0);f.session.setHistory(redo(f.session.getSnapshot().history));assert.equal(projectSchema.parse(JSON.parse(JSON.stringify(f.graph()))).tracks[0].clips[0].transform.x,20);f.detach();});
test("base-color-preserves-other-fields",()=>{const f=fixture(),v=f.view();assert(f.runCommand({type:"set_clip_color",clipId:f.clipId,patch:{contrast:1.8}}));assert(v.color({saturation:1.4}));assert.equal(f.clip().color.contrast,1.8);assert.equal(f.clip().color.saturation,1.4);f.detach();});
test("animated-transform-preserves-concurrent-color",()=>{const f=fixture({animated:true}),v=f.view(),k=f.clip().keyframes[1];assert(f.runCommand({type:"update_keyframe",clipId:f.clipId,keyframeId:k.id,patch:{color:{...k.color,saturation:1.7}}}));assert(v.transform({x:40}));assert.equal(f.clip().keyframes[1].color.saturation,1.7);assert.equal(f.clip().keyframes[1].transform.x,40);f.detach();});
test("animated-color-preserves-concurrent-transform",()=>{const f=fixture({animated:true}),v=f.view(),k=f.clip().keyframes[1];assert(f.runCommand({type:"update_keyframe",clipId:f.clipId,keyframeId:k.id,patch:{transform:{...k.transform,y:72}}}));assert(v.color({brightness:.4}));assert.equal(f.clip().keyframes[1].transform.y,72);f.detach();});
test("animated-disjoint-transform-field-preserved",()=>{const f=fixture({animated:true}),v=f.view(),k=f.clip().keyframes[1];assert(f.runCommand({type:"update_keyframe",clipId:f.clipId,keyframeId:k.id,patch:{transform:{...k.transform,y:35}}}));assert(v.transform({x:42}));assert.equal(f.clip().keyframes[1].transform.y,35);f.detach();});
test("same-field-external-conflict-refused",()=>{const f=fixture({animated:true}),v=f.view(),k=f.clip().keyframes[1];assert(f.runCommand({type:"update_keyframe",clipId:f.clipId,keyframeId:k.id,patch:{transform:{...k.transform,x:77}}}));reject(f,()=>v.transform({x:42}));f.detach();});
test("same-callback-continuous-values-accepted",()=>{const f=fixture({animated:true}),v=f.view();assert(v.transform({x:41}));assert(v.transform({x:42}));assert.equal(f.clip().keyframes[1].transform.x,42);f.detach();});
test("own-write-then-external-conflict-refused",()=>{const f=fixture({animated:true}),v=f.view();assert(v.transform({x:41}));const k=f.clip().keyframes[1];f.runCommand({type:"update_keyframe",clipId:f.clipId,keyframeId:k.id,patch:{transform:{...k.transform,x:99}}});reject(f,()=>v.transform({x:42}));f.detach();});
test("interpolated-insert-preserves-live-other-property",()=>{const f=fixture({animated:true,between:true}),v=f.view();assert(v.color({saturation:1.7}));assert(v.transform({x:54}));const k=f.clip().keyframes.find(k=>k.time===2)!;assert.equal(k.color.saturation,1.7);assert.equal(k.transform.x,54);assert.equal(f.clip().keyframes.length,4);assert.equal(f.calls.length,2);f.detach();});
test("outside-clip-retains-base-edit-policy",()=>{const f=fixture({animated:true,outside:true});assert(f.view().transform({x:9}));assert.equal(f.clip().transform.x,9);assert.equal(f.clip().keyframes.length,3);f.detach();});
test("base-color-workspace-does-not-add-keyframe",()=>{const f=fixture({animated:true}),v=f.view();assert(v.baseColor({exposure:.5}));assert.equal(f.clip().color.exposure,.5);assert.equal(f.clip().keyframes.length,3);f.detach();});
test("different-selected-clip-refused",()=>{const f=fixture(),v=f.view();f.timeline.setSelectedClipId("second");reject(f,()=>v.transform({x:20}));f.detach();});
test("selection-a-b-a-refused",()=>{const f=fixture(),v=f.view();f.timeline.setSelectedClipId("second");f.timeline.setSelectedClipId(f.clipId);reject(f,()=>v.color({saturation:1.5}));f.detach();});
test("same-id-reopen-refused-without-status-leak",()=>{const f=fixture(),v=f.view();f.session.replaceProject(structuredClone(f.graph()));f.timeline.setSelectedClipId(f.clipId);const n=f.statuses.length;reject(f,()=>v.transform({x:20}));assert.equal(f.statuses.length,n);f.detach();});
test("undo-redo-retires-old-view",()=>{const f=fixture(),v=f.view();f.runCommand({type:"set_clip_volume",clipId:f.clipId,volume:.5});f.session.setHistory(undo(f.session.getSnapshot().history));f.session.setHistory(redo(f.session.getSnapshot().history));reject(f,()=>v.transform({x:20}));f.detach();});
test("undo-keeps-fresh-selection-editable",()=>{const f=fixture();f.runCommand({type:"update_clip_transform",clipId:f.clipId,patch:{x:99}});f.session.setHistory(undo(f.session.getSnapshot().history));assert(f.view().transform({x:20}));assert.equal(f.clip().transform.x,20);f.detach();});
test("unmounted-view-refused",()=>{const f=fixture(),v=f.view();f.detach();reject(f,()=>v.color({saturation:1.5}));});
test("transport-seek-retires-old-view",()=>{const f=fixture({animated:true}),v=f.view();f.setTransport({playhead:3,seekRevision:2});reject(f,()=>v.transform({x:20}));f.detach();});
test("transport-a-b-a-revision-refused",()=>{const f=fixture({animated:true}),v=f.view();f.setTransport({...f.transport(),seekRevision:3});reject(f,()=>v.color({saturation:1.5}));f.detach();});
test("moved-clip-refused",()=>{const f=fixture(),v=f.view();assert(f.runCommand({type:"move_clip",clipId:f.clipId,timelineStart:1}));reject(f,()=>v.transform({x:20}));f.detach();});
test("mirror-uses-base-not-keyframe",()=>{const f=fixture({animated:true}),v=f.view();assert(v.transform({flipX:true}));assert.equal(f.clip().transform.flipX,true);assert.equal(f.clip().keyframes[1].transform.flipX,undefined);f.detach();});
test("mixed-mirror-numeric-uses-one-undo-correct-targets",()=>{const f=fixture({animated:true}),v=f.view();assert(v.transform({flipX:true,x:44}));assert.equal(f.clip().transform.flipX,true);assert.equal(f.clip().transform.x,0);assert.equal(f.clip().keyframes[1].transform.x,44);assert.equal(f.session.getSnapshot().history.past.length,1);f.detach();});
test("noop-does-not-create-undo",()=>{const f=fixture({animated:true}),v=f.view(),n=f.calls.length;assert(v.transform({x:12}));assert.equal(f.calls.length,n);f.detach();});
test("unknown-field-refused-before-runner",()=>{const f=fixture();reject(f,()=>f.view().color({madeUp:1} as unknown as Partial<ColorAdjustments>));f.detach();});
test("invalid-number-refused-before-runner",()=>{const f=fixture();reject(f,()=>f.view().transform({x:Infinity}));f.detach();});
test("locked-track-keeps-original-command-guard",()=>{const f=fixture(),track=f.graph().tracks.find(t=>t.id===f.clip().trackId)!;assert(f.runCommand({type:"toggle_track_lock",trackId:track.id}));const before=JSON.stringify(f.graph());assert.equal(f.view().transform({x:20}),false);assert.equal(JSON.stringify(f.graph()),before);f.detach();});
test("base-color-same-field-conflict-refused",()=>{const f=fixture(),v=f.view();f.runCommand({type:"set_clip_color",clipId:f.clipId,patch:{brightness:.6}});reject(f,()=>v.baseColor({brightness:.4}));f.detach();});

test("same-id-delete-readd-retires-callback",()=>{const f=fixture(),v=f.view(),clip=structuredClone(f.clip());assert(f.runCommand({type:"batch",commands:[{type:"delete_clip",clipId:f.clipId},{type:"add_clip",clip}]}));f.timeline.setSelectedClipId(f.clipId);reject(f,()=>v.transform({x:14}));f.detach();});
test("keyframe-delete-readd-retires-callback",()=>{const f=fixture({animated:true}),v=f.view(),keyframe=structuredClone(f.clip().keyframes[1]);assert(f.runCommand({type:"batch",commands:[{type:"delete_keyframe",clipId:f.clipId,keyframeId:keyframe.id},{type:"add_keyframe",clipId:f.clipId,keyframe}]}));reject(f,()=>v.color({saturation:1.2}));f.detach();});
test("expression-controlled-field-is-not-silently-written",()=>{const f=fixture();assert(f.runCommand({type:"set_clip_expression",clipId:f.clipId,property:"x",expression:"hao.expression/v1:value + 10"}));reject(f,()=>f.view().transform({x:40}));f.detach();});
test("other-fields-remain-editable-next-to-expression",()=>{const f=fixture();assert(f.runCommand({type:"set_clip_expression",clipId:f.clipId,property:"x",expression:"hao.expression/v1:value + 10"}));assert(f.view().transform({y:40}));assert.equal(f.clip().transform.y,40);f.detach();});
// 2026-10-23 (P6/P7 pack): an auto-key stored the other fields' post-expression values, so playback applied their
// expressions a second time (opacity `value * 0.5` on 1 stored 0.5 and then played 0.25). It now stores authored values.
for(const between of [true,false]) test(`auto-key-transform-stores-pre-expression-values-${between?"insert":"update"}`,()=>{
  const f=fixture({animated:true,between});assert(f.runCommand({type:"set_clip_expression",clipId:f.clipId,property:"opacity",expression:"hao.expression/v1:value * 0.5"}));
  assert.equal(f.animated().transform.opacity,.5);assert(f.view().transform({x:54}));
  const key=f.clip().keyframes.find(k=>Math.abs(k.time-(between?2:1))<1e-9)!;assert.equal(key.transform.x,54);assert.equal(key.transform.opacity,1);
  assert.equal(f.animated().transform.opacity,.5);assert.equal(f.animated().transform.x,54);f.detach();});
test("auto-key-color-stores-pre-expression-transform",()=>{
  const f=fixture({animated:true,between:true});assert(f.runCommand({type:"set_clip_expression",clipId:f.clipId,property:"scale",expression:"hao.expression/v1:value * 2"}));
  assert(f.view().color({saturation:1.6}));const key=f.clip().keyframes.find(k=>k.time===2)!;
  assert.equal(key.color.saturation,1.6);assert.equal(key.transform.scale,1);assert.equal(f.animated().transform.scale,2);f.detach();});
test("null-or-array-patches-are-refused",()=>{const f=fixture(),v=f.view();reject(f,()=>v.color(null as unknown as Partial<ColorAdjustments>));reject(f,()=>v.color([] as unknown as Partial<ColorAdjustments>));f.detach();});
test("runner-refusal-keeps-own-write-expectations",()=>{const f=fixture();let refused=true;const v=f.view({runCommand:command=>refused?false:f.runCommand(command)});reject(f,()=>v.transform({x:10}));refused=false;assert(v.transform({x:11}));assert.equal(f.clip().transform.x,11);f.detach();});
test("runner-exception-is-not-acknowledged",()=>{const f=fixture(),v=f.view({runCommand:()=>{throw Error("refused");}});reject(f,()=>v.color({brightness:.2}));f.detach();});
test("void-without-commit-is-not-a-success",()=>{const f=fixture(),v=f.view({runCommand:()=>{}});reject(f,()=>v.transform({x:7}));f.detach();});
test("canceled-save-keeps-view-valid",()=>{const f=fixture(),v=f.view(),request=f.session.beginSave();assert(request);f.session.completeSave(request,{canceled:true});f.session.finishSave(request);assert(v.transform({x:8}));assert.equal(f.clip().transform.x,8);f.detach();});
test("successful-save-acknowledgement-keeps-view-valid",()=>{const f=fixture(),v=f.view(),request=f.session.beginSave();assert(request);const project={...structuredClone(request.submittedProject),revision:request.project.revision+1};assert(f.session.completeSave(request,{path:"D:/fixture.editkin",project}));f.session.finishSave(request);assert(v.transform({x:8}));assert.equal(f.clip().transform.x,8);f.detach();});
test("fractional-clock-is-committed-to-nearest-project-frame",()=>{const f=fixture({animated:true});f.setTransport({playhead:1+.25/f.graph().fps,seekRevision:2});assert(f.view().transform({x:40}));assert.equal(f.clip().keyframes[1].time,1);assert.equal(f.clip().keyframes[1].transform.x,40);assert.equal(f.clip().keyframes.length,3);f.detach();});
test("fresh-view-after-reattach-not-old-view",()=>{const f=fixture(),old=f.view();f.detach();const release=f.state.subscribe(()=>{});reject(f,()=>old.transform({x:8}));assert(f.view().transform({x:9}));release();});
test("base-grade-retains-authored-channel-gains",()=>{const f=fixture();assert(f.runCommand({type:"set_clip_color",clipId:f.clipId,patch:{whiteBalanceGreen:.6}}));assert(f.view().baseColor({saturation:1.8}));assert.equal(f.clip().color.whiteBalanceGreen,.6);f.detach();});
test("animated-grade-retains-authored-channel-gains",()=>{const f=fixture({animated:true}),v=f.view(),keyframe=f.clip().keyframes[1];assert(f.runCommand({type:"update_keyframe",clipId:f.clipId,keyframeId:keyframe.id,patch:{color:{...keyframe.color,whiteBalanceGreen:.6}}}));assert(v.color({saturation:1.8}));assert.equal(f.clip().keyframes[1].color.whiteBalanceGreen,.6);f.detach();});
test("precommit-reentrant-selection-change-is-refused",()=>{const f=fixture();let n=0;const v=f.view({getSnapshot:()=>{if(++n===3)f.timeline.setSelectedClipId("second");return f.session.getSnapshot();}});reject(f,()=>v.transform({x:18}));f.detach();});
test("callback-construction-does-not-walk-project-collections",()=>{const f=fixture(),p=f.graph(),tracks=p.tracks,assets=p.assets;let reads=0;Object.defineProperty(p,"tracks",{configurable:true,get(){++reads;return tracks;}});Object.defineProperty(p,"assets",{configurable:true,get(){++reads;return assets;}});const selection=f.state.getSnapshot();reads=0;createClipAppearanceEditsV1(f.host,{project:p,clipId:f.clipId,selection,transport:f.transport()});assert.equal(reads,0);f.detach();});
});
