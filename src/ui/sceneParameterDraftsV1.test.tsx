import assert from "node:assert/strict";
import {isValidElement,type ReactElement,type ReactNode} from "react";
import {describe,it} from "vitest";
import type {MotionGraphic} from "../domain/types";
import {createDemoProject} from "../domain/demo";
import {applyCommand} from "../domain/commands";
import {renderScene25dCameraControlsV1} from "./Scene25dCameraControlsV1";
import {renderScene25dLightControlsV1} from "./Scene25dLightControls";
import {Scene25dPlaneControlsV1,Scene25dLensControlsV1} from "./Scene25dPlaneLensControlsV1";
import {renderEditingGraphicPropertiesV1} from "./EditingGraphicPropertiesV1";
import {NumberEditFieldV1,renderNumberEditFieldV1} from "./NumberEditFieldV1";
type Target={value:string;valueAsNumber:number};
type Control=ReactElement<{children?:ReactNode;type?:string;defaultValue?:number;onChange?:(e:{currentTarget:Target})=>void;onBlur?:(e:{currentTarget:Target})=>void;onKeyDown?:(e:{currentTarget:Target;key:string;preventDefault:()=>void;stopPropagation?:()=>void;nativeEvent?:{isComposing?:boolean}})=>void}>;
function controls(node:ReactNode,result:Control[]=[]):Control[]{if(Array.isArray(node))node.forEach(n=>controls(n,result));else if(isValidElement<Control["props"]>(node)){if(node.type===NumberEditFieldV1)return controls(renderNumberEditFieldV1(node.props as Parameters<typeof renderNumberEditFieldV1>[0]),result);if(node.type==="input"&&node.props.type==="number")result.push(node);controls(node.props.children,result);}return result;}
const counts={camera:12,light:8,plane:9,lens:3,graphic:2};type Family=keyof typeof counts;
function fixture(family:Family,accepted=true){const p=applyCommand(createDemoProject(),{type:"configure_scene_25d",enabled:true}),scene=p.scene25d!,clip=p.tracks[0].clips[0],scope={},calls:unknown[]=[],change=(v:unknown)=>{calls.push(v);return accepted;};
 const tree=family==="camera"?renderScene25dCameraControlsV1({scene,editScope:scope,onChange:change}):family==="light"?renderScene25dLightControlsV1({scene,playhead:0,editScope:scope,onChange:change}):family==="plane"?Scene25dPlaneControlsV1({clip,editScope:scope,onChange:change}):family==="lens"?Scene25dLensControlsV1({scene,editScope:scope,onChange:change}):renderEditingGraphicPropertiesV1({graphic:{id:"g",name:"Title",timelineStart:0,duration:3} as MotionGraphic,editScope:scope,onChange:change});
 return{fields:controls(tree),calls,scope};}
function target(value:number|string):Target{return{value:String(value),valueAsNumber:String(value).trim()?Number(value):NaN};}
function change(input:Control,to:Target){input.props.onChange!({currentTarget:to});}
describe("scene/plane/graphic numeric drafts",()=>{
 for(const family of Object.keys(counts) as Family[]){
  it(family+" retains every field and confirms each edit once",()=>{assert.equal(fixture(family).fields.length,counts[family]);for(let i=0;i<counts[family];i++){const f=fixture(family),input=f.fields[i],initial=input.props.defaultValue!,to=target(initial+.1);change(input,to);to.value=String(initial+.2);to.valueAsNumber=initial+.2;change(input,to);assert.equal(f.calls.length,0);input.props.onKeyDown!({key:"Enter",currentTarget:to,preventDefault(){}});input.props.onBlur!({currentTarget:to});assert.equal(f.calls.length,1);}});
  it(family+" Escape and empty input do not publish",()=>{for(const empty of [false,true]){const f=fixture(family),input=f.fields[0],initial=input.props.defaultValue!,to=target(empty?"":initial+.2);change(input,to);if(!empty)input.props.onKeyDown!({key:"Escape",currentTarget:to,preventDefault(){}});input.props.onBlur!({currentTarget:to});assert.equal(f.calls.length,0);assert.equal(to.value,String(initial));}});
  it(family+" IME Enter stays local until confirmation",()=>{const f=fixture(family),input=f.fields[0],to=target(input.props.defaultValue!+.2);change(input,to);input.props.onKeyDown!({key:"Enter",currentTarget:to,nativeEvent:{isComposing:true},preventDefault(){throw Error("IME");}});assert.equal(f.calls.length,0);input.props.onBlur!({currentTarget:to});assert.equal(f.calls.length,1);});
  it(family+" no-op and runner refusal restore without extra commit",()=>{const f=fixture(family),input=f.fields[0],initial=input.props.defaultValue!,same=target(initial);change(input,same);input.props.onBlur!({currentTarget:same});assert.equal(f.calls.length,0);const no=fixture(family,false),other=no.fields[0],to=target(initial+.2);change(other,to);other.props.onBlur!({currentTarget:to});assert.equal(no.calls.length,1);assert.equal(to.value,String(initial));});
 }
 it("plane callback explicitly identifies its single tuple axis",()=>{const p=applyCommand(createDemoProject(),{type:"configure_scene_25d",enabled:true}),calls:unknown[][]=[];const fields=controls(Scene25dPlaneControlsV1({clip:p.tracks[0].clips[0],onChange:(patch,axis)=>{calls.push([patch,axis]);}}));const to=target(.3);change(fields[1],to);fields[1].props.onBlur!({currentTarget:to});assert.deepEqual(calls,[[{position:[0,.3,0]},{property:"position",index:1}]]);});
 it("managed graphics retain owner-editor routing, not raw time fields",()=>{for(const settings of [{managed:true},{templateId:"owner"}])assert.equal(controls(renderEditingGraphicPropertiesV1({graphic:{id:"g",name:"Title",timelineStart:0,duration:3} as MotionGraphic,...settings,onChange:()=>{throw Error("managed");}})).length,0);});
});
