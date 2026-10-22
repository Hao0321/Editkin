import assert from "node:assert/strict";
import { describe, it } from "vitest";
import * as React from "react";
import type { EditorCommand } from "../domain/commandTypes";
import type { NativeEffectInstance } from "../domain/types";
import type { PluginRegistrySummary } from "../desktop/pluginTypes";
import { createDemoProject } from "../domain/demo";
import { dispatchCommandSafely, undo, redo } from "../domain/history";
import { createProjectSession } from "./projectSession";
import { createTimelineEditingState } from "./timelineEditingState";
import { createGraphicEditingSelectionV1 } from "./graphicEditingSelectionV1";
import { createClipNativeEffectEditsV1 } from "./clipNativeEffectEditsV1";
import { createNativeEffectParameterGestureV1 } from "./nativeEffectParameterGestureV1";
import { createNativeEffectRangeGestureInputV1 } from "../ui/nativeEffectRangeGestureInputV1";
import { renderNativeEffectParameterControlsV1 as renderControls } from "../ui/NativeEffectParameterControlsV1";
import { activeMediaLayers } from "./previewMedia";

interface TestTarget { value: string; valueAsNumber: number; held: Set<number>;
 setPointerCapture: (id: number)=>void; hasPointerCapture: (id: number)=>boolean; releasePointerCapture: (id: number)=>void }
interface TestEvent { currentTarget: TestTarget; pointerId: number; button: number; isPrimary: boolean; key?: string; repeat?: boolean;
 nativeEvent: { isComposing?: boolean; keyCode?: number }; preventDefault: ()=>void; stopPropagation: ()=>void }
interface ControlProps { children?: React.ReactNode; type?: string; value?: unknown; "aria-label"?: string; onClick?: ()=>void }
type Control = React.ReactElement<ControlProps>;
function fixture(){
 const p=createDemoProject(),clip=p.tracks[0].clips[0];
 const effect: NativeEffectInstance={id:"e",pluginId:"gesture.fixture",capabilityId:"adjust",pluginVersion:"1.0.0",manifestSha256:"c".repeat(64),runtimeType:"gpu_effect_graph",enabled:true,parameters:{gain:0,mix:.5,legacy_saved:"Keep"}};
 clip.creative={effectPresetIds:[],nativeEffectInstances:[effect]};p.tracks[0].clips.push({...structuredClone(clip),id:"other",timelineStart:20});
 const registry: PluginRegistrySummary={schema:"editkin.plugin-registry/v1",diagnostics:[],plugins:[{id:effect.pluginId,version:effect.pluginVersion,manifestSha256:effect.manifestSha256,name:"Fixture",publisher:"Fixture",permissions:["render.effect"],capabilities:[{
  id:effect.capabilityId,name:"Parameters",description:"Metadata only",kind:"effect",automation:"manual",automationReady:false,planningReady:false,readiness:"RUNTIME_READY",readinessDetail:"Fixture",semanticRoles:[],formats:[],requires:[],avoidWhen:[],runtimeType:"gpu_effect_graph",commandScopes:["clip"],parameters:[
  {id:"gain",name:"Gain",type:"number",default:0,min:0,max:1},{id:"mix",name:"Mix",type:"number",default:.5,min:0,max:1}]}]}]};
 const session=createProjectSession(p),timeline=createTimelineEditingState(session),selection=createGraphicEditingSelectionV1(session,timeline),detachSelection=selection.subscribe(()=>{});timeline.setSelectedClipId(clip.id);
 const calls: EditorCommand[]=[],statuses: string[]=[],graph=()=>session.getSnapshot().history.present,runCommand=(command: EditorCommand)=>{calls.push(command);const result=dispatchCommandSafely(session.getSnapshot().history,command,"c"+calls.length);session.setHistory(result.state);if(result.error)statuses.push(result.error);return !result.error;};
 const host={getSnapshot:session.getSnapshot,getSelectionSnapshot:selection.getSnapshot,getRegistry:()=>registry,runCommand,setStatus:(m: string)=>statuses.push(m)};
 const current=()=>graph().tracks[0].clips.find(c=>c.id===clip.id)!.creative!.nativeEffectInstances![0];
 const owner=createNativeEffectParameterGestureV1({session,getSelectionSnapshot:selection.getSnapshot,subscribeSelection:selection.subscribe,getRegistry:()=>registry});
 const release=owner?.subscribe(()=>{}),interaction=createNativeEffectRangeGestureInputV1();
 function panel(){const expected=current(),bound=selection.getSnapshot(),view=createClipNativeEffectEditsV1(host,{project:graph(),clipId:clip.id,selection:bound});
  const root=renderControls({instance:expected,registry,scopeKey:"1:"+clip.id,onEdit:values=>view.parameters(expected,values),onChange:parameters=>view.update(expected.id,{parameters}),
   preview:owner?.getSnapshot().preview,gestureInput:interaction,onGestureStart:owner?parameterId=>owner.begin({clipId:clip.id,expected,parameterId,selection:bound,commit:values=>view.parameters(expected,values)}):undefined});
  const nodes: Control[]=[];function visit(n: React.ReactNode){if(Array.isArray(n))n.forEach(visit);else if(React.isValidElement<ControlProps>(n)){nodes.push(n);visit(n.props.children);}}visit(root);
  return {range:nodes.find(n=>n.props.type==="range"&&n.props["aria-label"]?.startsWith("Gain"))!,reset:nodes.find(n=>n.type==="button")!};
 }
 const target: TestTarget={value:"0",valueAsNumber:0,held:new Set(),setPointerCapture(id){this.held.add(id);},hasPointerCapture(id){return this.held.has(id);},releasePointerCapture(id){this.held.delete(id);}};
 const fire=(node: Control,name: string,extra: Partial<TestEvent>={})=>((node.props as Record<string,unknown>)[name] as ((event: TestEvent)=>unknown)|undefined)?.({currentTarget:target,pointerId:1,button:0,isPrimary:true,nativeEvent:{},preventDefault(){},stopPropagation(){},...extra});
 const change=(node: Control,value: number)=>{target.value=String(value);target.valueAsNumber=value;fire(node,"onChange");};
 const begin=(node: Control)=>fire(node,"onPointerDown"),end=(node: Control)=>fire(node,"onPointerUp");
 return {p,clipId:clip.id,session,timeline,selection,graph,current,calls,statuses,panel,target,fire,change,begin,end,owner,interaction,runCommand,
  preview:()=>owner?.getSnapshot().preview?.project??graph(),close(){interaction?.cancel();release?.();detachSelection();}};
}

describe("native parameter draft gesture through actual control functions",()=>{
const test=(id:string,run:()=>void)=>it(id,run);
test("pointer-drafts-are-not-canonical-commands",()=>{const f=fixture(),node=f.panel().range,before=f.session.getSnapshot();f.begin(node);for(const n of [.1,.4,.8]){f.change(node,n);assert.equal(f.session.getSnapshot(),before);assert.equal(f.preview().tracks[0].clips[0].creative!.nativeEffectInstances![0].parameters.gain,n);}f.close();});
test("release-commits-once-and-one-undo-redo",()=>{const f=fixture(),node=f.panel().range;f.begin(node);for(const n of [.1,.4,.8])f.change(node,n);f.end(node);assert.equal(f.current().parameters.gain,.8);assert.equal(f.calls.length,1);assert.equal(f.session.getSnapshot().history.past.length,1);assert.equal(f.session.getSnapshot().history.journal.length,1);f.session.setHistory(undo(f.session.getSnapshot().history));assert.equal(f.current().parameters.gain,0);f.session.setHistory(redo(f.session.getSnapshot().history));assert.equal(f.current().parameters.gain,.8);f.close();});
for(const [id,event] of [["pointer-cancel","onPointerCancel"],["lost-capture","onLostPointerCapture"]])test(id+"-discards-draft",()=>{const f=fixture(),node=f.panel().range;f.begin(node);f.change(node,.7);f.fire(node,event);f.end(node);assert.equal(f.calls.length,0);assert.equal(f.current().parameters.gain,0);f.close();});
test("escape-discards-without-undo-step",()=>{const f=fixture(),node=f.panel().range;f.begin(node);f.change(node,.8);f.fire(node,"onKeyDown",{key:"Escape"});f.end(node);assert.equal(f.calls.length,0);assert.equal(f.current().parameters.gain,0);f.close();});
test("keyboard-repeat-is-one-release-command",()=>{const f=fixture(),node=f.panel().range;for(const n of [.1,.2,.3]){f.fire(node,"onKeyDown",{key:"ArrowRight",repeat:n>.1});f.change(node,n);}assert.equal(f.calls.length,0);f.fire(node,"onKeyUp",{key:"ArrowRight"});assert.equal(f.calls.length,1);assert.equal(f.current().parameters.gain,.3);f.close();});
test("keyboard-blur-finishes-one-gesture",()=>{const f=fixture(),node=f.panel().range;f.fire(node,"onKeyDown",{key:"Home"});f.change(node,.3);f.change(node,.4);f.fire(node,"onBlur");assert.equal(f.calls.length,1);f.close();});
test("return-to-original-is-no-op-no-history",()=>{const f=fixture(),node=f.panel().range;f.begin(node);f.change(node,.7);f.change(node,0);f.end(node);assert.equal(f.current().parameters.gain,0);assert.equal(f.calls.length,0);f.close();});
test("gesture-survives-rerender-with-latest-number",()=>{const f=fixture(),node=f.panel().range;f.begin(node);f.change(node,.4);const next=f.panel().range;assert.equal(next.props.value,.4);f.change(next,.7);f.end(next);assert.equal(f.calls.length,1);assert.equal(f.current().parameters.gain,.7);f.close();});
for(const action of ["other-selection","same-id-reopen","undo-redo","external-field"]){test(action+"-retires-live-draft",()=>{const f=fixture(),node=f.panel().range;f.begin(node);f.change(node,.7);if(action==="other-selection")f.timeline.setSelectedClipId("other");else if(action==="same-id-reopen")f.session.replaceProject(structuredClone(f.graph()));else if(action==="external-field")f.runCommand({type:"set_clip_volume",clipId:f.clipId,volume:.4});else{f.runCommand({type:"set_clip_volume",clipId:f.clipId,volume:.4});f.session.setHistory(undo(f.session.getSnapshot().history));f.session.setHistory(redo(f.session.getSnapshot().history));}const n=f.calls.length;f.end(node);assert.equal(f.calls.length,n);assert.equal(f.current().parameters.gain,0);f.close();});}
test("save-during-draft-snapshots-only-canonical-values",()=>{const f=fixture(),node=f.panel().range;f.begin(node);f.change(node,.7);const request=f.session.beginSave()!;assert.equal(request.project.tracks[0].clips[0].creative!.nativeEffectInstances![0].parameters.gain,0);f.session.completeSave(request,{canceled:true});f.session.finishSave(request);f.end(node);assert.equal(f.current().parameters.gain,.7);assert.equal(f.calls.length,1);f.close();});
test("unmount-cancels-draft",()=>{const f=fixture(),node=f.panel().range;f.begin(node);f.change(node,.7);f.close();f.end(node);assert.equal(f.calls.length,0);assert.equal(f.current().parameters.gain,0);});
test("reset-cancels-draft-before-no-op-reset",()=>{const f=fixture(),panel=f.panel();f.begin(panel.range);f.change(panel.range,.7);panel.reset.props.onClick!();f.end(panel.range);assert.equal(f.calls.length,0);assert.equal(f.current().parameters.gain,0);f.close();});
test("duplicate-pointer-up-does-not-double-submit",()=>{const f=fixture(),node=f.panel().range;f.begin(node);f.change(node,.7);f.end(node);f.end(node);assert.equal(f.calls.length,1);f.close();});
test("empty-gesture-adds-no-command",()=>{const f=fixture(),node=f.panel().range;f.begin(node);f.end(node);assert.equal(f.calls.length,0);f.close();});

test("draft-project-is-structurally-shared-and-never-serialized-as-canonical",()=>{const f=fixture(),node=f.panel().range,base=f.graph(),text=JSON.stringify(base);f.begin(node);f.change(node,.6);const project=f.preview();assert.notEqual(project,base);assert.equal(project.id,base.id);assert.equal(project.revision,base.revision);assert.equal(project.updatedAt,base.updatedAt);assert.equal(project.assets,base.assets);assert.equal(project.tracks[1],base.tracks[1]);assert.equal(f.graph(),base);assert.equal(JSON.stringify(base),text);const layers=activeMediaLayers(project,1,{},"video");assert.equal(layers[0].clip.creative!.nativeEffectInstances![0].parameters.gain,.6);f.close();});
test("invalid-value-is-rejected-and-later-events-stay-consumed-until-release",()=>{const f=fixture(),node=f.panel().range;f.begin(node);f.change(node,NaN);f.change(node,.7);f.change(node,.8);f.end(node);assert.equal(f.calls.length,0);assert.equal(f.current().parameters.gain,0);f.close();});
test("external-invalidation-cannot-fall-back-to-direct-edit-on-later-moves",()=>{const f=fixture(),node=f.panel().range;f.begin(node);f.change(node,.3);f.runCommand({type:"set_clip_volume",clipId:f.clipId,volume:.4});const n=f.calls.length;f.change(node,.5);f.change(node,.9);f.end(node);assert.equal(f.calls.length,n);assert.equal(f.current().parameters.gain,0);f.close();});
test("old-input-handler-is-refused-after-a-b-a-selection",()=>{const f=fixture(),node=f.panel().range;f.timeline.setSelectedClipId("other");f.timeline.setSelectedClipId(f.clipId);f.begin(node);f.change(node,.5);f.end(node);assert.equal(f.calls.length,0);f.close();});
test("old-lease-cannot-cancel-or-submit-new-lease",()=>{const f=fixture(),expected=f.current(),selection=f.selection.getSnapshot(),commit=(values:NativeEffectInstance["parameters"])=>{throw Error(JSON.stringify(values));};const a=f.owner.begin({clipId:f.clipId,expected,selection,parameterId:"gain",commit})!;assert(a.update(.3));const b=f.owner.begin({clipId:f.clipId,expected,selection,parameterId:"mix",commit})!;assert(b.update(.8));a.cancel();assert.equal(a.update(.5),false);assert.equal(a.commit(),false);assert.equal(f.owner.getSnapshot().preview!.parameters.mix,.8);b.cancel();f.close();});
test("locked-track-refuses-start-and-does-not-build-draft",()=>{const f=fixture();f.runCommand({type:"toggle_track_lock",trackId:f.graph().tracks[0].id});const node=f.panel().range,n=f.calls.length;f.begin(node);f.change(node,.5);f.end(node);assert.equal(f.calls.length,n);assert.equal(f.owner.getSnapshot().preview,undefined);f.close();});
test("reentrant-selection-on-preview-retirement-prevents-submit",()=>{const f=fixture(),node=f.panel().range;let seen=false;const off=f.owner.subscribe(()=>{if(f.owner.getSnapshot().preview)seen=true;else if(seen)f.timeline.setSelectedClipId("other");});f.begin(node);f.change(node,.7);f.end(node);assert.equal(f.calls.length,0);off();f.close();});
test("same-draft-value-preserves-snapshot-identity",()=>{const f=fixture(),node=f.panel().range;f.begin(node);f.change(node,.5);const snapshot=f.owner.getSnapshot();f.change(node,.5);assert.equal(f.owner.getSnapshot(),snapshot);f.close();});
test("pointer-capture-is-retained-during-gesture-and-released-after-commit",()=>{const f=fixture(),node=f.panel().range;f.begin(node);assert(f.target.held.has(1));f.change(node,.6);assert(f.target.held.has(1));assert.equal(f.calls.length,0);f.end(node);assert(!f.target.held.has(1));assert.equal(f.calls.length,1);f.close();});
test("new-gesture-after-completion-is-a-separate-undo",()=>{const f=fixture();for(const value of [.4,.8]){const node=f.panel().range;f.begin(node);f.change(node,value);f.end(node);}assert.equal(f.calls.length,2);f.session.setHistory(undo(f.session.getSnapshot().history));assert.equal(f.current().parameters.gain,.4);f.session.setHistory(undo(f.session.getSnapshot().history));assert.equal(f.current().parameters.gain,0);f.close();});
test("missing-parameter-and-forged-record-refuse-start",()=>{const f=fixture(),base={clipId:f.clipId,expected:f.current(),selection:f.selection.getSnapshot(),parameterId:"not-saved",commit:()=>true};assert.equal(f.owner.begin(base),undefined);assert.equal(f.owner.begin({...base,parameterId:"gain",expected:{...base.expected,parameters:{...base.expected.parameters,gain:.2}}}),undefined);f.close();});
test("refused-commit-clears-preview-and-lease",()=>{const f=fixture(),lease=f.owner.begin({clipId:f.clipId,expected:f.current(),selection:f.selection.getSnapshot(),parameterId:"gain",commit:()=>false})!;assert(lease.update(.6));assert.equal(lease.commit(),false);assert.equal(f.owner.getSnapshot().preview,undefined);assert.equal(lease.update(.8),false);assert.equal(f.calls.length,0);f.close();});
test("metadata-only-begin-save-does-not-retire-lease",()=>{const f=fixture(),node=f.panel().range;f.begin(node);f.change(node,.6);const request=f.session.beginSave()!;assert.equal(f.owner.getSnapshot().preview!.parameters.gain,.6);f.session.completeSave(request,{canceled:true});f.session.finishSave(request);f.end(node);assert.equal(f.calls.length,1);f.close();});
test("unrelated-clip-and-unknown-parameters-survive-commit",()=>{const f=fixture(),other=structuredClone(f.graph().tracks[0].clips[1]),node=f.panel().range;f.begin(node);f.change(node,.7);f.end(node);assert.deepEqual(f.graph().tracks[0].clips[1],other);assert.equal(f.current().parameters.legacy_saved,"Keep");assert.equal(f.current().parameters.mix,.5);f.close();});

});

